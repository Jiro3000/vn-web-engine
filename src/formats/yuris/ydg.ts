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

type StripDecoder = (
  strip: Uint8Array,
) => {width: number; height: number; pixels: Uint8Array} | null;

/** One strip's own BGRA pixels, or null when the decode failed or no decoder handles it. */
function decodeStrip(codec: number, bytes: Uint8Array, jxl?: StripDecoder): Uint8Array | null {
  try {
    if (codec === YdgCodec.Webp) return decodeWebp(bytes).pixels;
    if (codec === YdgCodec.Qoi) return decodeQoi(bytes).pixels;
    if (codec === YdgCodec.Jxl) return jxl?.(bytes)?.pixels ?? null;
  } catch {
    // The native shows a message box and stops this strip.
  }
  return null;
}

function stackStrips(
  data: Uint8Array,
  decode: (strip: YdgStrip, bytes: Uint8Array) => Uint8Array | null,
): YdgImage;
function stackStrips(
  data: Uint8Array,
  decode: (strip: YdgStrip, bytes: Uint8Array) => Promise<Uint8Array | null>,
): Promise<YdgImage>;
function stackStrips(
  data: Uint8Array,
  decode: (strip: YdgStrip, bytes: Uint8Array) => Uint8Array | null | Promise<Uint8Array | null>,
): YdgImage | Promise<YdgImage> {
  // A bad signature only shows "File Check Error." (0x4399EC); the native decodes on.
  const {width, height, strips} = ydgHeader(data);
  const pixels = new Uint8Array(width * height * 4);
  const used = strips.filter(
    (strip) => strip.row * width * 4 < pixels.length && strip.codec !== YdgCodec.None,
  );
  const results = used.map((strip) =>
    decode(strip, data.subarray(strip.offset, strip.offset + strip.size)),
  );
  const finish = (decoded: readonly (Uint8Array | null)[]): YdgImage => {
    let failedStrips = 0;
    decoded.forEach((strip, i) => {
      const start = used[i]!.row * width * 4;
      if (strip) pixels.set(strip.subarray(0, pixels.length - start), start);
      else failedStrips++;
    });
    return {width, height, pixels, failedStrips};
  };
  return results.some((result) => result instanceof Promise)
    ? Promise.all(results).then(finish)
    : finish(results as (Uint8Array | null)[]);
}

/**
 * Decodes a YDG image. `jxl` decodes a JPEG XL strip to BGRA when the host has a decoder
 * (the native calls YSJXL.DLL only when it is loaded, 0x893EAC). A failing strip decode
 * leaves its rows as they are, like the native message box and early stop.
 */
export function decodeYdg(data: Uint8Array, jxl?: StripDecoder): YdgImage {
  return stackStrips(data, (strip, bytes) => decodeStrip(strip.codec, bytes, jxl));
}

/**
 * Decodes the strips concurrently, as the native strip workers 0x44C370 do. `offThread`
 * resolves a strip's pixels, or null to decode it in this thread instead (which reports a
 * failed strip as `decodeYdg` does).
 */
export function decodeYdgConcurrently(
  data: Uint8Array,
  offThread: (codec: number, strip: Uint8Array) => Promise<Uint8Array | null>,
  jxl?: StripDecoder,
): Promise<YdgImage> {
  return stackStrips(data, async (strip, bytes) => {
    const pixels =
      strip.codec === YdgCodec.Webp || strip.codec === YdgCodec.Qoi
        ? await offThread(strip.codec, bytes).catch(() => null)
        : null;
    return pixels ?? decodeStrip(strip.codec, bytes, jxl);
  });
}
