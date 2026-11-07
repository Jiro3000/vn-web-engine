/**
 * QOI ("Quite OK Image") decoder. It follows the reference `qoi.h` decoder that YU-RIS
 * version 500 links statically (Relirium.exe 0x44C664): the header is checked like
 * `qoi_decode` (magic "qoif", non-zero size below 400,000,000 pixels, 3 or 4 channels,
 * colorspace 0 or 1, at least 22 bytes), the chunk stream ends 8 bytes before the end of the
 * data and the last pixel repeats after it. The end marker is not checked.
 */

export interface QoiImage {
  readonly width: number;
  readonly height: number;
  /** The channel count from the header. */
  readonly channels: number;
  readonly colorspace: number;
  /** Straight alpha, B, G, R, A per pixel (the native writes blue first). */
  readonly pixels: Uint8Array;
}

const HEADER = 14;
const PADDING = 8;
const PIXELS_MAX = 400_000_000;

export class QoiError extends Error {}

export function qoiSize(data: Uint8Array): {width: number; height: number} | null {
  if (data.length < HEADER + PADDING) return null;
  if (data[0] !== 0x71 || data[1] !== 0x6f || data[2] !== 0x69 || data[3] !== 0x66) return null;
  const view = new DataView(data.buffer, data.byteOffset, data.byteLength);
  return {width: view.getUint32(4), height: view.getUint32(8)};
}

/** Decodes `data` to four-channel BGRA, as 0x44C614 requests it. */
export function decodeQoi(data: Uint8Array): QoiImage {
  const size = qoiSize(data);
  if (!size) throw new QoiError('QOI: bad header');
  const {width, height} = size;
  const channels = data[12]!;
  const colorspace = data[13]!;
  if (
    width === 0 ||
    height === 0 ||
    channels < 3 ||
    channels > 4 ||
    colorspace > 1 ||
    height >= Math.floor(PIXELS_MAX / width)
  )
    throw new QoiError('QOI: bad header');
  const pixels = new Uint8Array(width * height * 4);
  const index = new Uint32Array(64);
  const end = data.length - PADDING;
  // A pixel is held as R | G << 8 | B << 16 | A << 24, starting opaque black.
  let px = 0xff000000;
  let run = 0;
  let p = HEADER;
  for (let o = 0; o < pixels.length; o += 4) {
    if (run > 0) run--;
    else if (p < end) {
      const b1 = data[p++]!;
      if (b1 === 0xfe) {
        px = ((px & 0xff000000) | data[p]! | (data[p + 1]! << 8) | (data[p + 2]! << 16)) >>> 0;
        p += 3;
      } else if (b1 === 0xff) {
        px = (data[p]! | (data[p + 1]! << 8) | (data[p + 2]! << 16) | (data[p + 3]! << 24)) >>> 0;
        p += 4;
      } else if ((b1 & 0xc0) === 0x00) {
        px = index[b1]!;
      } else if ((b1 & 0xc0) === 0x40) {
        const r = (px + ((b1 >> 4) & 3) - 2) & 0xff;
        const g = ((px >>> 8) + ((b1 >> 2) & 3) - 2) & 0xff;
        const b = ((px >>> 16) + (b1 & 3) - 2) & 0xff;
        px = ((px & 0xff000000) | r | (g << 8) | (b << 16)) >>> 0;
      } else if ((b1 & 0xc0) === 0x80) {
        const b2 = data[p++]!;
        const vg = (b1 & 0x3f) - 32;
        const r = (px + vg - 8 + (b2 >> 4)) & 0xff;
        const g = ((px >>> 8) + vg) & 0xff;
        const b = ((px >>> 16) + vg - 8 + (b2 & 0xf)) & 0xff;
        px = ((px & 0xff000000) | r | (g << 8) | (b << 16)) >>> 0;
      } else {
        run = b1 & 0x3f;
      }
      const r = px & 0xff;
      const g = (px >>> 8) & 0xff;
      const b = (px >>> 16) & 0xff;
      const a = px >>> 24;
      index[(r * 3 + g * 5 + b * 7 + a * 11) & 0x3f] = px;
    }
    pixels[o] = (px >>> 16) & 0xff;
    pixels[o + 1] = (px >>> 8) & 0xff;
    pixels[o + 2] = px & 0xff;
    pixels[o + 3] = px >>> 24;
  }
  return {width, height, channels, colorspace, pixels};
}
