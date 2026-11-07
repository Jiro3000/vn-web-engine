import {ByteView} from '../../core/binary.js';
import {decodeQoi} from '../qoi.js';
import {decodeWebp} from '../webp/webp.js';

/**
 * YDG, the YU-RIS version 500 image container (Relirium.exe loader 0x4499FC, strip worker
 * 0x44C370). The 0x34-byte header holds "YDG\0YU-RIS\0\0", a u16 width at 0x20 and height at
 * 0x22 (each at most 0x2000, else error 0x186FB) and a u16 strip count at 0x30 (at most 16).
 * Each 16-byte strip record from 0x34 holds a u32 data offset, a u32 data size, a u8 codec
 * at +8 and a u16 row count at +10; the strips stack from the top. Codec 2 is a WebP image
 * (libwebp incremental decode, MODE_BGRA, linked into the EXE), 0 a QOI image (0x44C614), 3 a
 * JPEG XL image through YSJXL.DLL and 1 leaves the strip untouched. Each decode writes its own
 * width x height BGRA pixels contiguously from its first row.
 */
export interface YdgImage {
  readonly width: number;
  readonly height: number;
  /** Straight alpha BGRA. Rows no strip writes are zero (the native buffer is uninitialised). */
  readonly pixels: Uint8Array;
  /** Strips whose decode failed or that no decoder handled; their rows stay as they were. */
  readonly failedStrips: number;
}

export interface YdgStrip {
  readonly offset: number;
  readonly size: number;
  readonly codec: number;
  readonly row: number;
  readonly rows: number;
}

export const enum YdgCodec {
  Qoi = 0,
  None = 1,
  Webp = 2,
  Jxl = 3,
}

export class YdgError extends Error {
  constructor(
    message: string,
    /** The YU-RIS error number, when the native raises one. */
    readonly code?: number,
  ) {
    super(message);
  }
}

const MAX_STRIPS = 16;
const MAX_SIZE = 0x2000;

export function isYdg(data: Uint8Array): boolean {
  if (data.length < 0x34) return false;
  const view = new ByteView(data, {littleEndian: true});
  return view.u32(0) === 0x474459 && view.u32(4) === 0x522d5559 && view.u32(8) === 0x5349;
}

export function ydgHeader(data: Uint8Array): {
  width: number;
  height: number;
  strips: YdgStrip[];
} {
  if (data.length < 0x34) throw new YdgError('YDG: truncated header');
  const view = new ByteView(data, {littleEndian: true});
  const width = view.u16(0x20);
  const height = view.u16(0x22);
  if (width > MAX_SIZE || height > MAX_SIZE) throw new YdgError('YDG: image too large', 0x186fb);
  const count = view.u16(0x30);
  if (count > MAX_STRIPS) throw new YdgError('YDG: too many strips');
  if (0x34 + count * 16 > data.length) throw new YdgError('YDG: truncated strip table');
  const strips: YdgStrip[] = [];
  let row = 0;
  for (let i = 0; i < count; i++) {
    const at = 0x34 + i * 16;
    const rows = view.u16(at + 10);
    strips.push({offset: view.u32(at), size: view.u32(at + 4), codec: view.u8(at + 8), row, rows});
    row += rows;
  }
  return {width, height, strips};
}

/**
 * Decodes a YDG image. `jxl` decodes a JPEG XL strip to BGRA when the host has a decoder
 * (the native calls YSJXL.DLL only when it is loaded, 0x893EAC). A failing strip decode
 * leaves its rows as they are, like the native message box and early stop.
 */
export function decodeYdg(
  data: Uint8Array,
  jxl?: (strip: Uint8Array) => {width: number; height: number; pixels: Uint8Array} | null,
): YdgImage {
  // A bad signature only shows "File Check Error." (0x4399EC); the native decodes on.
  const {width, height, strips} = ydgHeader(data);
  const pixels = new Uint8Array(width * height * 4);
  let failedStrips = 0;
  for (const strip of strips) {
    const start = strip.row * width * 4;
    if (start >= pixels.length || strip.codec === YdgCodec.None) continue;
    const bytes = data.subarray(strip.offset, strip.offset + strip.size);
    let decoded: Uint8Array | null = null;
    try {
      if (strip.codec === YdgCodec.Webp) decoded = decodeWebp(bytes).pixels;
      else if (strip.codec === YdgCodec.Qoi) decoded = decodeQoi(bytes).pixels;
      else if (strip.codec === YdgCodec.Jxl) decoded = jxl?.(bytes)?.pixels ?? null;
    } catch {
      decoded = null;
    }
    if (decoded) pixels.set(decoded.subarray(0, pixels.length - start), start);
    else failedStrips++;
  }
  return {width, height, pixels, failedStrips};
}
