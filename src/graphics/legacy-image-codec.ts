import {decodePng} from '../formats/png/decode.js';
import {decodeWebp} from '../formats/webp/webp.js';
import {decodeBmp} from '../formats/bmp.js';
import {decodeQoi} from '../formats/qoi.js';
import {decodeYdgConcurrently} from '../formats/yuris/ydg.js';
import {BrowserGdiImageCodec} from './browser-gdi-image.js';
import {decodeImageOffThread} from './image-decode-offload.js';
import {swapRedBlueInPlace} from './pixel-order.js';

/** Each YDG strip decodes on its own worker; without workers it decodes in this thread. */
const decodeYdgStrips = (bytes: Uint8Array) =>
  decodeYdgConcurrently(
    bytes,
    async (codec, strip) =>
      // Strip codec 0 is QOI, 2 WebP.
      (await decodeImageOffThread(strip, codec === 0 ? 'qoi' : 'webp'))?.pixels ?? null,
  );

interface DecodedImage {
  width: number;
  height: number;
  pixels: Uint8Array;
}

/** MIME types of the byte decoders without a registered type: YU-RIS YDG and QOI. */
export const YDG_MIME = 'image/x-yuris-ydg';
export const QOI_MIME = 'image/x-qoi';

const IMAGE_CACHE_BYTES = 96 * 1024 * 1024;
const PRELOAD_CACHE_BYTES = 160 * 1024 * 1024;
const PRELOAD_WEBP_BYTES = 56 * 1024 * 1024;
const PRELOAD_LARGE_PNG_BYTES = 68 * 1024 * 1024;
const LARGE_PNG_BYTES = 2 * 1024 * 1024;

interface CachedImage {
  encoded: Uint8Array;
  image: DecodedImage | {width: number; height: number; word: number};
  size: number;
}

function cacheImage(encoded: Uint8Array, image: DecodedImage, copy: boolean): CachedImage {
  const {width, height, pixels} = image;
  if (
    pixels.length >= 65536 &&
    ((pixels.byteOffset | pixels.byteLength) & 3) === 0 &&
    pixels.length === width * height * 4
  ) {
    const words = new Uint32Array(pixels.buffer, pixels.byteOffset, pixels.length / 4);
    const word = words[0]!;
    let i = 1;
    while (i < words.length && words[i] === word) i++;
    if (i === words.length)
      return {encoded, image: {width, height, word}, size: encoded.length + 4};
  }
  return {
    encoded,
    image: {width, height, pixels: copy ? pixels.slice() : pixels},
    size: encoded.length + pixels.length,
  };
}

function copyCached(image: CachedImage['image']): DecodedImage {
  const {width, height} = image;
  if ('pixels' in image) return {width, height, pixels: image.pixels.slice()};
  const words = new Uint32Array(width * height);
  if (image.word !== 0) words.fill(image.word);
  return {width, height, pixels: new Uint8Array(words.buffer)};
}

class ImageCache {
  readonly entries = new Map<string, CachedImage>();
  private used = 0;
  constructor(private readonly limit: number) {}

  take(key: string): CachedImage | undefined {
    const existing = this.entries.get(key);
    if (existing) {
      this.entries.delete(key);
      this.used -= existing.size;
    }
    return existing;
  }

  put(key: string, entry: CachedImage, priority?: ReadonlySet<string>): void {
    this.take(key);
    if (entry.size > this.limit) return;
    if (this.used + entry.size > this.limit && priority?.size && !priority.has(key)) {
      let available = this.limit - this.used;
      for (const [old, value] of this.entries) {
        if (!priority.has(old)) available += value.size;
        if (available >= entry.size) break;
      }
      if (available < entry.size) return;
    }
    for (const old of this.entries.keys()) {
      if (this.used + entry.size <= this.limit) break;
      if (!priority?.has(old)) this.take(old);
    }
    if (priority?.has(key)) {
      for (const old of this.entries.keys()) {
        if (this.used + entry.size <= this.limit) break;
        this.take(old);
      }
    }
    if (this.used + entry.size > this.limit) return;
    this.entries.set(key, entry);
    this.used += entry.size;
  }
}

function sameBytes(a: Uint8Array, b: Uint8Array): boolean {
  if (a.length !== b.length) return false;
  if (a === b) return true;
  let tail = 0;
  if (((a.byteOffset | b.byteOffset) & 3) === 0) {
    const aa = new Uint32Array(a.buffer, a.byteOffset, a.length >>> 2);
    const bb = new Uint32Array(b.buffer, b.byteOffset, b.length >>> 2);
    for (let i = 0; i < aa.length; i++) if (aa[i] !== bb[i]) return false;
    tail = aa.length * 4;
  }
  for (let i = tail; i < a.length; i++) if (a[i] !== b[i]) return false;
  return true;
}

/** Straight BGRA codec boundary for legacy engines. */
export class LegacyImageCodec {
  private readonly gdi = new BrowserGdiImageCodec();
  private readonly recent = new ImageCache(IMAGE_CACHE_BYTES);
  // Unrelated foreground decodes cannot evict art queued for a future script line.
  private readonly prepared = new ImageCache(
    PRELOAD_CACHE_BYTES - PRELOAD_WEBP_BYTES - PRELOAD_LARGE_PNG_BYTES,
  );
  // The more expensive legacy WebP decodes survive bursts of PNG sprite preloads.
  private readonly preparedWebp = new ImageCache(PRELOAD_WEBP_BYTES);
  private readonly preparedLargePng = new ImageCache(PRELOAD_LARGE_PNG_BYTES);
  private nextClick = new Set<string>();
  private readonly warming = new Map<
    string,
    {encoded: Uint8Array; ready: Promise<void>; urgent: boolean}
  >();

  /** Keeps the decodes of `images` (path to MIME type) for the next click. */
  prioritize(images: ReadonlyMap<string, string>): void {
    this.nextClick = new Set(Array.from(images, ([path, mime]) => this.key(mime, true, path)));
  }

  private key(mime: string, legacyWebpColor: boolean, path: string): string {
    return `${Number(legacyWebpColor)}:${mime}:${path}`;
  }

  private preparedFor(mime: string, byteLength: number): ImageCache {
    if (mime === 'image/webp') return this.preparedWebp;
    if (
      (mime === 'image/png' || mime === YDG_MIME || mime === QOI_MIME) &&
      byteLength >= LARGE_PNG_BYTES
    )
      return this.preparedLargePng;
    return this.prepared;
  }

  /** Preload the exact PNG, YDG, QOI or legacy WebP decode while the caller is doing other work. */
  async preload(bytes: Uint8Array, mime: string, path: string): Promise<void> {
    const key = this.key(mime, true, path);
    const cache = this.preparedFor(mime, bytes.length);
    const existing = cache.entries.get(key) ?? this.recent.entries.get(key);
    if (existing && sameBytes(bytes, existing.encoded)) {
      this.recent.take(key);
      cache.put(key, existing, this.nextClick);
      return;
    }
    const pending = this.warming.get(key);
    if (pending) return pending.ready;
    const format =
      mime === 'image/webp'
        ? 'legacy-webp'
        : mime === 'image/png'
          ? 'png'
          : mime === YDG_MIME
            ? 'yuris-ydg'
            : mime === QOI_MIME
              ? 'qoi'
              : null;
    if (!format) return;
    const encoded = bytes.slice();
    const ready = (async () => {
      const decoded =
        format === 'png'
          ? await decodeImageOffThread(encoded, 'png', undefined, 'bgra')
          : format === 'yuris-ydg'
            ? await decodeYdgStrips(encoded)
            : await decodeImageOffThread(encoded, format);
      if (!decoded) return;
      // The worker returns PNG pixels already in BGRA order.
      const pixels = decoded.pixels;
      cache.put(
        key,
        cacheImage(encoded, {width: decoded.width, height: decoded.height, pixels}, false),
        this.nextClick,
      );
    })();
    this.warming.set(key, {encoded, ready, urgent: this.nextClick.has(key)});
    try {
      await ready;
    } finally {
      this.warming.delete(key);
    }
  }

  /** Repeated loads share only the immutable decode. The script owns each returned buffer. */
  async decodeCached(
    bytes: Uint8Array,
    mime: string,
    legacyWebpColor: boolean,
    path: string,
  ): Promise<DecodedImage> {
    const key = this.key(mime, legacyWebpColor, path);
    const cache = this.preparedFor(mime, bytes.length);
    const pending = this.warming.get(key);
    if (pending && !pending.urgent && !this.nextClick.has(key) && sameBytes(bytes, pending.encoded))
      await pending.ready.catch(() => {});
    const prepared = cache.entries.get(key);
    if (prepared && sameBytes(bytes, prepared.encoded)) {
      // Keep explicitly queued art insulated from foreground decode churn after use.
      cache.put(key, prepared, this.nextClick);
      return copyCached(prepared.image);
    }
    const existing = this.recent.take(key);
    if (existing && sameBytes(bytes, existing.encoded)) {
      this.recent.put(key, existing);
      return copyCached(existing.image);
    }
    const image = await this.decode(bytes, mime, legacyWebpColor);
    const size = bytes.length + image.pixels.length;
    if (size >= 65536 && size <= IMAGE_CACHE_BYTES) {
      this.recent.put(key, cacheImage(bytes.slice(), image, true));
    }
    return image;
  }

  async decode(bytes: Uint8Array, mime: string, legacyWebpColor = false): Promise<DecodedImage> {
    if (mime === 'image/webp') return decodeWebp(bytes, legacyWebpColor);
    if (mime === YDG_MIME) return decodeYdgStrips(bytes);
    if (mime === QOI_MIME) return decodeQoi(bytes);
    if (mime === 'image/png') {
      const d = await decodePng(bytes);
      return {...d, pixels: swap(d.pixels)};
    }
    if (mime === 'image/bmp') {
      const d = decodeBmp(bytes),
        pixels = new Uint8Array(d.width * d.height * 4);
      for (let i = 0; i < d.colors.length; i++) {
        const c = d.colors[i]!;
        pixels[i * 4] = c;
        pixels[i * 4 + 1] = c >>> 8;
        pixels[i * 4 + 2] = c >>> 16;
        pixels[i * 4 + 3] = 255;
      }
      return {width: d.width, height: d.height, pixels};
    }
    const d = await this.gdi.decode(bytes);
    if (!d) throw new Error(`Cannot decode ${mime}`);
    try {
      const locked = d.lockBits(0x26200a);
      if (!locked) throw new Error('Image BGRA conversion failed');
      const pixels = new Uint8Array(d.width * d.height * 4);
      for (let y = 0; y < d.height; y++) {
        const start = locked.scan0Offset + y * locked.stride;
        pixels.set(locked.bytes.subarray(start, start + d.width * 4), y * d.width * 4);
      }
      return {width: d.width, height: d.height, pixels};
    } finally {
      d.dispose();
    }
  }
  async encode(
    format: 'png' | 'jpeg' | 'webp',
    pixels: Uint8Array,
    width: number,
    height: number,
    alpha: boolean,
    quality: number,
  ): Promise<Uint8Array> {
    const rgba = swap(pixels.slice());
    if (!alpha) for (let i = 3; i < rgba.length; i += 4) rgba[i] = 255;
    const canvas = new OffscreenCanvas(width, height),
      c = canvas.getContext('2d');
    if (!c) throw new Error('Image encoder unavailable');
    c.putImageData(new ImageData(new Uint8ClampedArray(rgba), width, height), 0, 0);
    const blob = await canvas.convertToBlob({type: 'image/' + format, quality: quality / 100});
    if (blob.type !== 'image/' + format) throw new Error(`Image encoder unavailable: ${format}`);
    return new Uint8Array(await blob.arrayBuffer());
  }
}
/** RGBA to BGRA in place. */
export const swap = swapRedBlueInPlace;
