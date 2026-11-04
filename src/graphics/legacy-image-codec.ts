import {decodePng} from '../formats/png/decode.js';
import {decodeWebp} from '../formats/webp/webp.js';
import {decodeBmp} from '../formats/bmp.js';
import {BrowserGdiImageCodec} from './browser-gdi-image.js';

/** Straight BGRA codec boundary for legacy engines. */
export class LegacyImageCodec {
  private readonly gdi = new BrowserGdiImageCodec();
  async decode(
    bytes: Uint8Array,
    mime: string,
    legacyWebpColor = false,
  ): Promise<{width: number; height: number; pixels: Uint8Array}> {
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
