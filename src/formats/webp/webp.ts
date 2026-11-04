import {decodeLossy, yuvToBgra} from './vp8.js';
import {decodeLossless, decodeLosslessAlpha, WebpError} from './vp8l.js';

export interface WebpImage {
  width: number;
  height: number;
  /** Straight alpha BGRA, as requested by YSWBP.DLL FUN_10001040. */
  pixels: Uint8Array;
}

const fail = (message: string): never => {
  throw new WebpError(message);
};
const tag = (d: Uint8Array, p: number): string => String.fromCharCode(...d.subarray(p, p + 4));
const u24 = (d: Uint8Array, p: number): number => d[p]! | (d[p + 1]! << 8) | (d[p + 2]! << 16);

/** YSWBP.DLL FUN_1001d1f0 / FUN_1001d280: decode and unfilter ALPH. */
export function decodeAlpha(data: Uint8Array, width: number, height: number): Uint8Array {
  if (data.length < 2) fail('WebP: truncated ALPH');
  const header = data[0]!;
  const compression = header & 3,
    filter = (header >> 2) & 3;
  if (compression > 1 || ((header >> 4) & 3) > 1 || header & 0xc0)
    fail('WebP: invalid ALPH header');
  const size = width * height;
  if (!compression && data.length < size + 1) fail('WebP: truncated alpha plane');
  const alpha = compression ? decodeLosslessAlpha(data, 1, width, height) : data.slice(1, size + 1);
  // The first row predicts from the left for all three filters; the first
  // column of later rows predicts from above. Arithmetic wraps modulo 256.
  if (filter)
    for (let y = 0, p = 0; y < height; y++)
      for (let x = 0; x < width; x++, p++) {
        let predictor = 0;
        if (y === 0) predictor = x ? alpha[p - 1]! : 0;
        else if (x === 0 || filter === 2) predictor = alpha[p - width]!;
        else if (filter === 1) predictor = alpha[p - 1]!;
        else
          predictor = Math.max(
            0,
            Math.min(255, alpha[p - 1]! + alpha[p - width]! - alpha[p - width - 1]!),
          );
        alpha[p] = alpha[p]! + predictor;
      }
  // Preprocessing 1 signals quantized levels. Native default alpha dithering
  // strength is zero (FUN_1001d330), so there is no additional processing.
  return alpha;
}

/** RIFF parsing follows YSWBP.DLL FUN_10001750; still images only. */
export function decodeWebp(data: Uint8Array, legacyColor = false): WebpImage {
  if (data.length < 20 || tag(data, 0) !== 'RIFF' || tag(data, 8) !== 'WEBP')
    fail('WebP: bad RIFF header');
  const view = new DataView(data.buffer, data.byteOffset, data.byteLength);
  const end = view.getUint32(4, true) + 8;
  if (end > data.length || end < 20) fail('WebP: truncated RIFF');
  let canvas: {width: number; height: number} | undefined;
  let alpha: Uint8Array | undefined, image: WebpImage | undefined;
  for (let p = 12; p < end;) {
    if (p + 8 > end) fail('WebP: truncated chunk header');
    const id = tag(data, p),
      size = view.getUint32(p + 4, true);
    const next = p + 8 + size + (size & 1);
    if (next > end) fail('WebP: truncated chunk');
    const chunk = data.subarray(p + 8, p + 8 + size);
    if (id === 'VP8X') {
      if (size !== 10 || canvas || image) fail('WebP: invalid VP8X');
      if (chunk[0]! & 2) fail('WebP: animation is unsupported');
      canvas = {width: u24(chunk, 4) + 1, height: u24(chunk, 7) + 1};
    } else if (id === 'ALPH') {
      if (alpha || image) fail('WebP: unexpected ALPH');
      alpha = chunk;
    } else if (id === 'VP8L') {
      if (image || alpha) fail('WebP: unexpected VP8L');
      const lossless = decodeLossless(chunk);
      const pixels = new Uint8Array(lossless.argb.length * 4);
      for (let i = 0; i < lossless.argb.length; i++) {
        const v = lossless.argb[i]!;
        pixels[i * 4] = v;
        pixels[i * 4 + 1] = v >>> 8;
        pixels[i * 4 + 2] = v >>> 16;
        pixels[i * 4 + 3] = v >>> 24;
      }
      image = {width: lossless.width, height: lossless.height, pixels};
    } else if (id === 'VP8 ') {
      if (image) fail('WebP: repeated image');
      const yuv = decodeLossy(chunk),
        pixels = yuvToBgra(yuv, legacyColor);
      if (alpha) {
        const a = decodeAlpha(alpha, yuv.width, yuv.height);
        for (let i = 0; i < a.length; i++) pixels[i * 4 + 3] = a[i]!;
      }
      image = {width: yuv.width, height: yuv.height, pixels};
    }
    p = next;
  }
  if (!image) return fail('WebP: missing image');
  if (canvas && (canvas.width !== image.width || canvas.height !== image.height))
    fail('WebP: canvas size mismatch');
  return image;
}
