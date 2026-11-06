import {decodePng} from '../formats/png/decode.js';
import {decodeWebp} from '../formats/webp/webp.js';
import {decodeBmp} from '../formats/bmp.js';
import {BrowserGdiImageCodec} from './browser-gdi-image.js';
import {decodeImageOffThread} from './image-decode-offload.js';

interface DecodedImage {
  width: number;
  height: number;
  pixels: Uint8Array;
}

const IMAGE_CACHE_BYTES = 96 * 1024 * 1024;
const PRELOAD_CACHE_BYTES = 128 * 1024 * 1024;
const PRELOAD_WEBP_BYTES = 56 * 1024 * 1024;
const littleEndian = new Uint8Array(new Uint32Array([1]).buffer)[0] === 1;

interface CachedImage {
  encoded: Uint8Array;
  image: DecodedImage;
  size: number;
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

  put(key: string, entry: CachedImage): void {
    this.take(key);
    if (entry.size > this.limit) return;
    for (const old of this.entries.keys()) {
      if (this.used + entry.size <= this.limit) break;
      this.take(old);
    }
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
  private readonly prepared = new ImageCache(PRELOAD_CACHE_BYTES - PRELOAD_WEBP_BYTES);
  // The more expensive legacy WebP decodes survive bursts of PNG sprite preloads.
  private readonly preparedWebp = new ImageCache(PRELOAD_WEBP_BYTES);
  private readonly warming = new Map<string, {encoded: Uint8Array; ready: Promise<void>}>();

  private key(mime: string, legacyWebpColor: boolean, path: string): string {
    return `${Number(legacyWebpColor)}:${mime}:${path}`;
  }

  /** Preload the exact PNG or legacy WebP decode while the caller is doing other work. */
  async preload(bytes: Uint8Array, mime: string, path: string): Promise<void> {
    const key = this.key(mime, true, path);
    const cache = mime === 'image/webp' ? this.preparedWebp : this.prepared;
    const existing = cache.entries.get(key) ?? this.recent.entries.get(key);
    if (existing && sameBytes(bytes, existing.encoded)) {
      this.recent.take(key);
      cache.put(key, existing);
      return;
    }
    const pending = this.warming.get(key);
    if (pending) return pending.ready;
    const format = mime === 'image/webp' ? 'legacy-webp' : mime === 'image/png' ? 'png' : null;
    if (!format) return;
    const encoded = bytes.slice();
    const ready = (async () => {
      const decoded =
        format === 'png'
          ? await decodeImageOffThread(encoded, 'png')
          : await decodeImageOffThread(encoded, 'legacy-webp');
      if (!decoded) return;
      const pixels = format === 'png' ? swap(decoded.pixels) : decoded.pixels;
      cache.put(key, {
        encoded,
        image: {width: decoded.width, height: decoded.height, pixels},
        size: encoded.length + pixels.length,
      });
    })();
    this.warming.set(key, {encoded, ready});
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
    const cache = mime === 'image/webp' ? this.preparedWebp : this.prepared;
    const pending = this.warming.get(key);
    if (pending && sameBytes(bytes, pending.encoded)) await pending.ready.catch(() => {});
    const prepared = cache.entries.get(key);
    if (prepared && sameBytes(bytes, prepared.encoded)) {
      // Keep explicitly queued art insulated from foreground decode churn after use.
      cache.put(key, prepared);
      return {...prepared.image, pixels: prepared.image.pixels.slice()};
    }
    const existing = this.recent.take(key);
    if (existing && sameBytes(bytes, existing.encoded)) {
      this.recent.put(key, existing);
      return {...existing.image, pixels: existing.image.pixels.slice()};
    }
    const image = await this.decode(bytes, mime, legacyWebpColor);
    const size = bytes.length + image.pixels.length;
    if (size >= 65536 && size <= IMAGE_CACHE_BYTES) {
      this.recent.put(key, {
        encoded: bytes.slice(),
        image: {...image, pixels: image.pixels.slice()},
        size,
      });
    }
    return image;
  }

  async decode(bytes: Uint8Array, mime: string, legacyWebpColor = false): Promise<DecodedImage> {
    if (mime === 'image/webp') return decodeWebp(bytes, legacyWebpColor);
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
export function swap(pixels: Uint8Array): Uint8Array {
  if (littleEndian && ((pixels.byteOffset | pixels.byteLength) & 3) === 0) {
    const words = new Uint32Array(pixels.buffer, pixels.byteOffset, pixels.byteLength / 4);
    for (let i = 0; i < words.length; i++) {
      const color = words[i]!;
      words[i] = (color & 0xff00ff00) | ((color & 255) << 16) | ((color >>> 16) & 255);
    }
    return pixels;
  }
  for (let i = 0; i < pixels.length; i += 4) {
    const b = pixels[i]!;
    pixels[i] = pixels[i + 2]!;
    pixels[i + 2] = b;
  }
  return pixels;
}
