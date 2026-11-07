/**
 * libyuv's planar YUV to ARGB conversions with the limited-range BT.601 constants
 * (`kYuvI601Constants`: YG 18997, YB -1160, UB 128, UG 25, VG 52, VR 102). The fixed-point
 * arithmetic is the C reference `YuvPixel`; libyuv's SSSE3 and AVX2 rows compute the same
 * values. "ARGB" is libyuv's name for little-endian words, so the bytes are B, G, R, A with
 * A = 255. Chroma is sampled without interpolation: a 4:2:0 sample covers two columns and two
 * rows.
 */

const YG = 18997;
const YB = -1160;
const UB = 128;
const UG = 25;
const VG = 52;
const VR = 102;

function clamp(value: number): number {
  return value < 0 ? 0 : value > 255 ? 255 : value;
}

/**
 * `YuvPixel` written to `out` at `o`. `y16` is the luma scaled to 16 bits (`y * 0x0101` for
 * 8-bit samples); `u` and `v` are 8-bit.
 */
function yuvPixel(y16: number, u: number, v: number, out: Uint8Array, o: number): void {
  const y1 = Math.floor((y16 * YG) / 65536) + YB;
  out[o] = clamp((y1 + UB * (u - 128)) >> 6);
  out[o + 1] = clamp((y1 - UG * (u - 128) - VG * (v - 128)) >> 6);
  out[o + 2] = clamp((y1 + VR * (v - 128)) >> 6);
  out[o + 3] = 255;
}

/** A plane: its samples, the offset of the first row and the distance between rows. */
export interface YuvPlane {
  readonly data: Uint8Array | Uint16Array;
  readonly offset: number;
  readonly stride: number;
}

/** The destination rows: `stride` bytes apart, written while they fit in `out`. */
export interface ArgbTarget {
  readonly out: Uint8Array;
  readonly stride: number;
  readonly width: number;
  readonly height: number;
}

/**
 * The chroma layout of a planar picture: 4:2:0 (I420, I010) and 4:4:4 (I444) planes, or
 * NV12 with interleaved U and V in the second plane.
 */
export type YuvLayout = 'i420' | 'i444' | 'nv12';

/**
 * `I420ToARGB`, `I444ToARGB`, `NV12ToARGB` and, for 16-bit planes holding 10-bit samples,
 * `I010ToARGB` (each sample becomes `y << 6 | y >> 4` for luma and `min(255, c >> 2)` for
 * chroma, as in `YuvPixel10_16`).
 */
export function yuvToArgb(
  layout: YuvLayout,
  y: YuvPlane,
  u: YuvPlane,
  v: YuvPlane | null,
  target: ArgbTarget,
): void {
  const {out, stride, width, height} = target;
  const wide = y.data instanceof Uint16Array;
  if (!wide && layout === 'i420' && v) {
    i420ToArgb(y, u, v, target);
    return;
  }
  const luma = (value: number): number => (wide ? (value << 6) | (value >> 4) : value * 0x0101);
  const chroma = (value: number): number => (wide ? Math.min(255, value >> 2) : value);
  for (let row = 0; row < height; row++) {
    const o = row * stride;
    if (o + width * 4 > out.length) break;
    const yRow = y.offset + row * y.stride;
    const cRow = layout === 'i444' ? row : row >> 1;
    const uRow = u.offset + cRow * u.stride;
    const vRow = v ? v.offset + cRow * v.stride : 0;
    for (let x = 0; x < width; x++) {
      let cu: number, cv: number;
      if (layout === 'nv12') {
        const c = uRow + (x >> 1) * 2;
        cu = u.data[c]!;
        cv = u.data[c + 1]!;
      } else {
        const c = layout === 'i444' ? x : x >> 1;
        cu = u.data[uRow + c]!;
        cv = v!.data[vRow + c]!;
      }
      yuvPixel(luma(y.data[yRow + x]!), chroma(cu), chroma(cv), out, o + x * 4);
    }
  }
}

/** Per-sample terms of `YuvPixel` for 8-bit input. */
const Y_TERM = new Int32Array(256);
const UB_TERM = new Int32Array(256);
const UG_TERM = new Int32Array(256);
const VG_TERM = new Int32Array(256);
const VR_TERM = new Int32Array(256);
for (let i = 0; i < 256; i++) {
  Y_TERM[i] = Math.floor((i * 0x0101 * YG) / 65536) + YB;
  UB_TERM[i] = UB * (i - 128);
  UG_TERM[i] = UG * (i - 128);
  VG_TERM[i] = VG * (i - 128);
  VR_TERM[i] = VR * (i - 128);
}

/** The 8-bit 4:2:0 path of `yuvToArgb`, with the same arithmetic. */
function i420ToArgb(y: YuvPlane, u: YuvPlane, v: YuvPlane, target: ArgbTarget): void {
  const {out, stride, width, height} = target;
  const yd = y.data,
    ud = u.data,
    vd = v.data;
  for (let row = 0; row < height; row++) {
    let o = row * stride;
    if (o + width * 4 > out.length) break;
    const yRow = y.offset + row * y.stride;
    const uRow = u.offset + (row >> 1) * u.stride;
    const vRow = v.offset + (row >> 1) * v.stride;
    for (let x = 0; x < width; x++, o += 4) {
      const y1 = Y_TERM[yd[yRow + x]!]!;
      const cu = ud[uRow + (x >> 1)]!,
        cv = vd[vRow + (x >> 1)]!;
      const b = (y1 + UB_TERM[cu]!) >> 6,
        g = (y1 - UG_TERM[cu]! - VG_TERM[cv]!) >> 6,
        r = (y1 + VR_TERM[cv]!) >> 6;
      out[o] = b < 0 ? 0 : b > 255 ? 255 : b;
      out[o + 1] = g < 0 ? 0 : g > 255 ? 255 : g;
      out[o + 2] = r < 0 ? 0 : r > 255 ? 255 : r;
      out[o + 3] = 255;
    }
  }
}
