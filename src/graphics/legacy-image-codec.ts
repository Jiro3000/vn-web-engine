import {decodePng} from '../formats/png/decode.js';
import {decodeWebp} from '../formats/webp/webp.js';
import {decodeBmp} from '../formats/bmp.js';
import {BrowserGdiImageCodec} from './browser-gdi-image.js';

interface DecodedImage {
  width: number;
  height: number;
  pixels: Uint8Array;
}

const IMAGE_CACHE_BYTES = 96 * 1024 * 1024;

function sameBytes(a: Uint8Array, b: Uint8Array): boolean {
  if (a.length !== b.length) return false;
  if ((a.byteOffset | b.byteOffset | a.length) & 3) {
    for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) return false;
  } else {
    const aa = new Uint32Array(a.buffer, a.byteOffset, a.length >>> 2);
    const bb = new Uint32Array(b.buffer, b.byteOffset, b.length >>> 2);
    for (let i = 0; i < aa.length; i++) if (aa[i] !== bb[i]) return false;
  }
  return true;
}

/** Straight BGRA codec boundary for legacy engines. */
export class LegacyImageCodec {
  private readonly gdi = new BrowserGdiImageCodec();
  private readonly recent = new Map<
    string,
    {encoded: Uint8Array; image: DecodedImage; size: number}
  >();
  private recentBytes = 0;

  /** Repeated loads share only the immutable decode. The script owns each returned buffer. */
  async decodeCached(
    bytes: Uint8Array,
    mime: string,
    legacyWebpColor: boolean,
    path: string,
  ): Promise<DecodedImage> {
    const key = `${Number(legacyWebpColor)}:${mime}:${path}`;
    const existing = this.recent.get(key);
    if (existing && sameBytes(bytes, existing.encoded)) {
      this.recent.delete(key);
      this.recent.set(key, existing);
      return {...existing.image, pixels: existing.image.pixels.slice()};
    }
    const image = await this.decode(bytes, mime, legacyWebpColor);
    const previous = this.recent.get(key);
    if (previous) {
      this.recent.delete(key);
      this.recentBytes -= previous.size;
    }
    const size = bytes.length + image.pixels.length;
    if (size >= 65536 && size <= IMAGE_CACHE_BYTES) {
      for (const [old, item] of this.recent) {
        if (this.recentBytes + size <= IMAGE_CACHE_BYTES) break;
        this.recent.delete(old);
        this.recentBytes -= item.size;
      }
      this.recent.set(key, {
        encoded: bytes.slice(),
        image: {...image, pixels: image.pixels.slice()},
        size,
      });
      this.recentBytes += size;
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
  for (let i = 0; i < pixels.length; i += 4) {
    const b = pixels[i]!;
    pixels[i] = pixels[i + 2]!;
    pixels[i + 2] = b;
  }
  return pixels;
}
