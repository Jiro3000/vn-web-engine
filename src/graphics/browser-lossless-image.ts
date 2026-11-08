import {decodePng, type DecodedPng} from '../formats/png/decode.js';
import {decodeWebp, type WebpImage} from '../formats/webp/webp.js';
import {swapRedBlue, swapRedBlueInPlace} from './pixel-order.js';
import {crc32} from '../core/crc32.js';

/** The WebCodecs `ImageDecoder` surface this module uses. */
interface ImageDecoderLike {
  decode(): Promise<{image: VideoFrameLike}>;
  close(): void;
}
type PixelFormat = 'BGRA' | 'RGBA';
interface VideoFrameLike {
  readonly format: string | null;
  readonly displayWidth: number;
  readonly displayHeight: number;
  allocationSize(options: {format: PixelFormat}): number;
  copyTo(destination: Uint8Array, options: {format: PixelFormat}): Promise<unknown>;
  close(): void;
}
type ImageDecoderConstructor = new (init: {
  data: Uint8Array;
  type: string;
  premultiplyAlpha: 'none';
  colorSpaceConversion: 'none';
}) => ImageDecoderLike;

type ImageType = 'image/webp' | 'image/png';
type Kind = 'opaque' | 'alpha';

const u32le = (d: Uint8Array, p: number) =>
  (d[p]! | (d[p + 1]! << 8) | (d[p + 2]! << 16) | (d[p + 3]! << 24)) >>> 0;
const u32be = (d: Uint8Array, p: number) =>
  ((d[p]! << 24) | (d[p + 1]! << 16) | (d[p + 2]! << 8) | d[p + 3]!) >>> 0;
const tag = (d: Uint8Array, p: number) =>
  String.fromCharCode(d[p]!, d[p + 1]!, d[p + 2]!, d[p + 3]!);

/** Width and height of a simple-format lossless WebP (one `VP8L` chunk), else null. */
export function losslessWebpSize(d: Uint8Array): {width: number; height: number} | null {
  if (d.length < 25) return null;
  if (tag(d, 0) !== 'RIFF' || tag(d, 8) !== 'WEBP' || tag(d, 12) !== 'VP8L' || d[20] !== 0x2f)
    return null;
  if (u32le(d, 16) + 20 > d.length) return null;
  const bits = u32le(d, 21);
  return {width: (bits & 0x3fff) + 1, height: ((bits >>> 14) & 0x3fff) + 1};
}

/** Chunks before IDAT that change how a PNG's samples map to output colours or alpha. */
const COLOUR_CHUNKS = new Set(['PLTE', 'tRNS', 'gAMA', 'cHRM', 'iCCP', 'sRGB', 'sBIT', 'cICP']);

/**
 * The header of an 8-bit truecolour PNG (colour type 2 or 6) without colour, gamma,
 * transparency or significant-bit chunks, whose samples are its output; else null. Every
 * chunk CRC must hold and IEND must end the file, as `decodePng`'s strict defaults require.
 */
export function simplePngHeader(
  d: Uint8Array,
): {width: number; height: number; colorType: 2 | 6} | null {
  if (d.length < 33 || u32be(d, 0) !== 0x89504e47 || u32be(d, 4) !== 0x0d0a1a0a) return null;
  if (u32be(d, 8) !== 13 || tag(d, 12) !== 'IHDR') return null;
  const width = u32be(d, 16),
    height = u32be(d, 20),
    depth = d[24],
    colorType = d[25];
  if (depth !== 8 || (colorType !== 2 && colorType !== 6) || !width || !height) return null;
  let data = false;
  for (let p = 8; p + 12 <= d.length;) {
    const length = u32be(d, p),
      type = tag(d, p + 4),
      end = p + 12 + length;
    if (end > d.length || crc32(d.subarray(p + 4, end - 4)) !== u32be(d, end - 4)) return null;
    if (type === 'IEND') return data && end === d.length ? {width, height, colorType} : null;
    if (type === 'IDAT') data = true;
    else if (!data && COLOUR_CHUNKS.has(type)) return null;
    p = end;
  }
  return null;
}

const base64 = (text: string) => Uint8Array.from(atob(text), (c) => c.charCodeAt(0));
/**
 * 13x7 verification images: opaque and transparent ones with every alpha level class (0, 1,
 * 77, 128, 200, 254, 255) under colours brighter than their alpha. The PNGs use all five
 * filter types; the WebPs are `cwebp -lossless -exact` encodes of them.
 */
const SAMPLES: Record<ImageType, readonly Uint8Array[]> = {
  'image/png': [
    'iVBORw0KGgoAAAANSUhEUgAAAA0AAAAHCAIAAABcElBNAAABI0lEQVR42gEYAef+AAAAACUFAUoKBG8PCZQUELkZGd4eJAMjMSgoQE0tUXIyZJc3ebw8kAELRx0wTB5VUSF6ViafWy3EYDbpZUEOak4zb11YdG59eYGifpbHg60CFo46O5M7YJg+hZ1DqqJKz6dT9KxeGbFrPrZ6Y7uLiMCercWz0srKAyHVV0baWGvfW5DkYLXpZ9rucP/zeyT4iEn9l24CqJMHu7gM0N0R5wQsHHRRIXV2JnibK33AMITlNY0KOpgvP6VURLR5ScWeTtjDU+3oWAQAN2ORXGiSgW2VpnKay3eh8HyqFYG1OobCX4vRhJDiqZX1zpoK858hAUKqrmevr4y0srG5t9a+vvvDxyDI0kXN32rS7o/X/7TcEtnhJ/7mPubdg8UqJ49zAAAAAElFTkSuQmCC',
    'iVBORw0KGgoAAAANSUhEUgAAAA0AAAAHCAYAAADTcMcaAAABfklEQVR42gFzAYz+AAAAAAAlBQEBSgoETW8PCYCUFBDIuRkZ/t4eJP8DIzEAKChAAU0tUU1yMmSAlzd5yLw8kP4BC0cdATBMHk1VUSGAelYmyJ9bLf7EYDb/6WVBAA5qTgEzb11NWHRugH15gciifpb+x4Ot/wIWjjpNO5M7gGCYPsiFnUP+qqJK/8+nUwD0rF4BGbFrTT62eoBju4vIiMCe/q3Fs//SysoAAyHVV4BG2ljIa99b/pDkYP+16WcA2u5wAf/ze00k+IiASf2XyG4CqP6TB7v/uAzQAN0R5wEELBx0yFEhdf52Jnj/myt9AMAwhAHlNY1NCjqYgC8/pchURLT+eUnF/55O2ADDU+0B6FgETQA3Y5H+XGiS/4FtlQCmcpoBy3ehTfB8qoAVgbXIOobC/l+L0f+EkOIAqZX1Ac6aCk3znyGAAUKqrv9nr68AjLSyAbG5t03Wvr6A+8PHyCDI0v5Fzd//atLuAI/X/wG03BJN2eEngP7mPsgYSLI8Wq6HtQAAAABJRU5ErkJggg==',
  ].map(base64),
  'image/webp': [
    'UklGRp4BAABXRUJQVlA4TJEBAAAvDIABANfiRgBAU/m2la3JU3PX7D5ttVmTbT5dw1Vt26py3n3uuDucPxpQgnrUoAEB+HJ3d4fnjgMAIJSzbffqZW7Sr7FaoDH6uwls2+b8BwVAHkGSj+MBhjG/eCMMjI7A6OxmPCnLDzC6A6MnMHori1d56YsYUYIW1H/efX8EHmVPRmLnYTdxri5+nbUdcKqjRwMN6IrxsCQhbIo0HlU86iTb88nqFkSleD6AC7AonSgZTh8UjU088oavJ0GqAqO/mXkEBoDifCnORVAgCBFZz+GQ1UPI6AGjJzB6C1X27EtAa6vxYoTME1dyv06dvT7lN2+1jMhemSk4ZWDp8kLX3DjUDz4eLDuc8AMNzgf1YzNuQ0jUQMmLrSbkbcJD32RNZ2Fqr1KYJ2dZVZixrHVtYNnMWTfS4CAAALLNz7bt27ZtM6L/AYAMTZE4hkqy+n1vV5X+lF+Ow0l0PSq1Abv525fC+TUsj5Cm+IGtRrzLzLhqsk6f7sLit7+1SsVup11P5fKO5wdzHXr0DOLgZp+mBgA=',
    'UklGRuwBAABXRUJQVlA4TOABAAAvDIABEM/iVgBAQzlrM7Ptmv3nrTdmTJrsevoNpwEAKNFxuBNpro1OpjMLA7Dju7u7C+5Itm3T+bZt/9aPhpChpDJpq2Wbt+LEtq1l+f6RCA7VobuNQKsTyTqB3yKZn+xWHbK7O11f8BaKSZIEBqDWTAZ5Pm3EwegMYHSFW/pmlOUvBEbPHhi9K2D0HZbpuynFwJykLdEK5L/vj2nylq58YppL1fD3jV766zSMzsKBA6denx7NUQNMEj6J4xHIUEeDj/GW6eAtWykV0eaj2K0tNEGpY9N7oSgooFxtqOewKRufdSjR2S/VIHWkfcjIIs3po+NGPzVeDzx7Kv3bIzD6wzo782CAvDLz9YjGOyRZvQ52Op2C0bsARl+wg+NQvVTt/tZChsxQ8SftzlbgO3WOlglSBjetIT2Hx8n6bwBvydjs9VY8G4tA8UlqRg0108eiiXuKUff9qjFPybSLjNki0UVjssYH2S6rD2syfQkUHi1ktyEW9lIyIi/2BtvvghD2VJ1YCMJBAABkm59t27dt22ZE/+MP0BRJYCgiiPLvVLrU+1PuNvYnwf4hxQOm+DXfq9dxWBvBTX4NGamwkJ2xjeiafn7K93Nu16pWup12slksLcf15iq47Wl43s4cdAU=',
  ].map(base64),
};

/** The TS decoders' output in both byte orders. */
async function referencePixels(
  type: ImageType,
  bytes: Uint8Array,
): Promise<Record<PixelFormat, Uint8Array>> {
  if (type === 'image/webp') {
    const bgra = decodeWebp(bytes).pixels;
    return {BGRA: bgra, RGBA: swapRedBlue(bgra) as Uint8Array};
  }
  const rgba = (await decodePng(bytes)).pixels;
  return {RGBA: rgba, BGRA: swapRedBlue(rgba) as Uint8Array};
}

const same = (a: Uint8Array, b: Uint8Array) => {
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) return false;
  return true;
};

/**
 * Lossless images through the browser's WebCodecs `ImageDecoder` with straight alpha and no
 * colour conversion, about three times faster than the TS decoders: simple-format lossless
 * WebP (VP8L) and 8-bit truecolour PNG without colour, gamma or transparency chunks. Both
 * formats define their samples exactly, so a conforming decoder returns what `decodeWebp` and
 * `decodePng` return. Pixels are copied out in the frame's own byte order: a `copyTo` that
 * converts BGRA to RGBA goes through premultiplied alpha in Chromium, so another order is a
 * swap here. Before the first use of a format, the decoder decodes the built-in verification
 * images and trusts each frame format (`BGRX`, `BGRA`, `RGBX`, `RGBA`) only when it matches
 * the TS decoder. An opaque frame also needs every alpha byte at 255. Other files, a missing
 * `ImageDecoder`, a browser error or an untrusted frame format return null; the caller then
 * decodes with the TS decoder, which also reports malformed files.
 */
export function createLosslessImageDecoder(samples = SAMPLES) {
  const Decoder = () => (globalThis as {ImageDecoder?: ImageDecoderConstructor}).ImageDecoder;
  const trust = new Map<ImageType, Promise<ReadonlySet<string>>>();

  /** The browser's pixels in the frame's byte order, with the frame format, or null. */
  const browserDecode = async (
    type: ImageType,
    bytes: Uint8Array,
    width: number,
    height: number,
  ): Promise<{format: string; order: PixelFormat; pixels: Uint8Array} | null> => {
    const ImageDecoder = Decoder();
    if (!ImageDecoder) return null;
    let decoder: ImageDecoderLike | undefined, frame: VideoFrameLike | undefined;
    try {
      decoder = new ImageDecoder({
        data: bytes,
        type,
        premultiplyAlpha: 'none',
        colorSpaceConversion: 'none',
      });
      frame = (await decoder.decode()).image;
      const format = frame.format ?? '';
      const order: PixelFormat | null = /^BGR[AX]$/.test(format)
        ? 'BGRA'
        : /^RGB[AX]$/.test(format)
          ? 'RGBA'
          : null;
      const length = width * height * 4;
      if (!order || frame.displayWidth !== width || frame.displayHeight !== height) return null;
      if (frame.allocationSize({format: order}) !== length) return null;
      const pixels = new Uint8Array(length);
      await frame.copyTo(pixels, {format: order});
      if (format.endsWith('X'))
        for (let i = 3; i < length; i += 4) if (pixels[i] !== 255) return null;
      return {format, order, pixels};
    } catch {
      return null;
    } finally {
      frame?.close();
      decoder?.close();
    }
  };

  const size = (type: ImageType, bytes: Uint8Array) =>
    type === 'image/webp' ? losslessWebpSize(bytes) : simplePngHeader(bytes);

  const trusted = (type: ImageType) => {
    let formats = trust.get(type);
    if (!formats) {
      formats = (async () => {
        const good = new Set<string>(),
          bad = new Set<string>();
        for (const sample of samples[type]) {
          const header = size(type, sample);
          const decoded =
            header && (await browserDecode(type, sample, header.width, header.height));
          if (!decoded) continue;
          const reference = await referencePixels(type, sample);
          (same(decoded.pixels, reference[decoded.order]) ? good : bad).add(decoded.format);
        }
        for (const format of bad) good.delete(format);
        return good;
      })();
      trust.set(type, formats);
    }
    return formats;
  };

  const decode = async (type: ImageType, bytes: Uint8Array, order: PixelFormat) => {
    const header = size(type, bytes);
    if (!header || !Decoder()) return null;
    const formats = await trusted(type);
    if (!formats.size) return null;
    const decoded = await browserDecode(type, bytes, header.width, header.height);
    if (!decoded || !formats.has(decoded.format)) return null;
    if (decoded.order !== order) swapRedBlueInPlace(decoded.pixels);
    return {header, pixels: decoded.pixels};
  };

  return {
    /** A lossless WebP as straight BGRA, as `decodeWebp` returns it. */
    async webp(bytes: Uint8Array): Promise<WebpImage | null> {
      const result = await decode('image/webp', bytes, 'BGRA');
      return (
        result && {width: result.header.width, height: result.header.height, pixels: result.pixels}
      );
    },
    /** A simple truecolour PNG as `decodePng` returns it, in `order`. */
    async png(bytes: Uint8Array, order: 'rgba' | 'bgra'): Promise<DecodedPng | null> {
      const result = await decode('image/png', bytes, order === 'bgra' ? 'BGRA' : 'RGBA');
      if (!result) return null;
      const {width, height, colorType} = result.header as {
        width: number;
        height: number;
        colorType: number;
      };
      return {width, height, colorType, bitDepth: 8, pixels: result.pixels};
    },
  };
}
