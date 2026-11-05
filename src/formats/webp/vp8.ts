/**
 * The VP8 key-frame bitstream (RFC 6386) as libwebp 0.4 decodes it: the boolean entropy
 * decoder, segment, loop-filter and quantizer headers, token probabilities, intra modes and
 * DCT/WHT residuals, intra prediction from unfiltered neighbours, and the simple or normal
 * in-loop filter applied in macroblock raster order.
 *
 * The result is the Y, U and V planes cropped to the frame size; `yuvToBgra` converts them
 * with the fancy upsampler and 14-bit fixed-point matrix of libwebp 0.4 (YSWBP.DLL,
 * FUN_10001040 leaves `no_fancy_upsampling` clear and requests MODE_BGRA).
 */

import {AC_TABLE, BMODE_PROBS, COEFF_PROBS, COEFF_UPDATE_PROBS, DC_TABLE} from './tables.js';
import {WebpError} from './vp8l.js';

const fail = (message: string): never => {
  throw new WebpError(message);
};

/** RFC 6386 7: the boolean decoder, range kept as range - 1 like libwebp. */
class BoolDecoder {
  private value = 0;
  private bits = -8;
  private range = 254;
  private position: number;

  constructor(
    private readonly data: Uint8Array,
    start: number,
    private readonly end: number,
  ) {
    this.position = start;
  }

  bit(probability: number): number {
    if (this.bits < 0) {
      while (this.bits < 0) {
        const byte = this.position < this.end ? this.data[this.position]! : 0;
        this.position++;
        this.value = (this.value << 8) | byte;
        this.bits += 8;
      }
    }
    let range = this.range;
    const split = (range * probability) >>> 8;
    const value = this.value >>> this.bits;
    let bit: number;
    if (value > split) {
      range -= split + 1;
      this.value -= (split + 1) << this.bits;
      bit = 1;
    } else {
      range = split;
      bit = 0;
    }
    if (range <= 0x7e) {
      const shift = Math.clz32(range + 1) - 24;
      range = ((range + 1) << shift) - 1;
      this.bits -= shift;
    }
    this.range = range;
    return bit;
  }

  literal(n: number): number {
    let v = 0;
    while (n-- > 0) v |= this.bit(0x80) << n;
    return v;
  }

  signed(n: number): number {
    const v = this.literal(n);
    return this.bit(0x80) ? -v : v;
  }

  /** An optional signed field: a flag, then the magnitude and sign. */
  optionalSigned(n: number): number {
    return this.bit(0x80) ? this.signed(n) : 0;
  }
}

const enum Mode {
  DC,
  TM,
  VE,
  HE,
  RD,
  VR,
  LD,
  VL,
  HD,
  HU,
}

/** kYModesIntra4: the 4x4 intra mode tree, leaves as negated modes. */
const B_MODE_TREE = Int8Array.of(
  -Mode.DC,
  1,
  -Mode.TM,
  2,
  -Mode.VE,
  3,
  4,
  6,
  -Mode.HE,
  5,
  -Mode.RD,
  -Mode.VR,
  -Mode.LD,
  7,
  -Mode.VL,
  8,
  -Mode.HD,
  -Mode.HU,
);
const ZIGZAG = Uint8Array.of(0, 1, 4, 8, 5, 2, 3, 6, 9, 12, 13, 10, 7, 11, 14, 15);
const BANDS = Uint8Array.of(0, 1, 2, 3, 6, 4, 5, 6, 6, 6, 6, 6, 6, 6, 6, 7, 0);
const CATEGORY_PROBS = [
  Uint8Array.of(173, 148, 140),
  Uint8Array.of(176, 155, 140, 135),
  Uint8Array.of(180, 157, 141, 134, 130),
  Uint8Array.of(254, 254, 243, 230, 196, 177, 153, 140, 133, 130, 129),
];

interface Quant {
  y1: [number, number];
  y2: [number, number];
  uv: [number, number];
}

interface FilterInfo {
  limit: number;
  interior: number;
  hevThreshold: number;
  inner: boolean;
}

export interface YuvImage {
  width: number;
  height: number;
  y: Uint8Array;
  u: Uint8Array;
  v: Uint8Array;
  /** Row strides of the planes. */
  yStride: number;
  uvStride: number;
}

/** Reads the 10-byte key-frame header and returns the frame size. */
export function vp8Size(data: Uint8Array): {width: number; height: number} {
  if (data.length < 10) fail('VP8: truncated frame header');
  if (data[0]! & 1) fail('VP8: not a key frame');
  if (data[3] !== 0x9d || data[4] !== 0x01 || data[5] !== 0x2a) fail('VP8: bad start code');
  return {
    width: (data[6]! | (data[7]! << 8)) & 0x3fff,
    height: (data[8]! | (data[9]! << 8)) & 0x3fff,
  };
}

export function decodeLossy(data: Uint8Array): YuvImage {
  const {width, height} = vp8Size(data);
  if (width === 0 || height === 0) fail('VP8: empty frame');
  const tag = data[0]! | (data[1]! << 8) | (data[2]! << 16);
  const firstSize = tag >>> 5;
  if (((tag >>> 1) & 7) > 3) fail('VP8: unknown profile');
  if (10 + firstSize > data.length) fail('VP8: truncated first partition');
  const br = new BoolDecoder(data, 10, 10 + firstSize);
  br.bit(0x80); // colour space
  br.bit(0x80); // clamping type

  // Segment header.
  const useSegment = br.bit(0x80) === 1;
  let updateMap = false,
    absoluteDelta = false;
  const segmentQuant = new Int32Array(4),
    segmentFilter = new Int32Array(4);
  const segmentProbs = Uint8Array.of(255, 255, 255);
  if (useSegment) {
    updateMap = br.bit(0x80) === 1;
    if (br.bit(0x80)) {
      absoluteDelta = br.bit(0x80) === 1;
      for (let s = 0; s < 4; s++) segmentQuant[s] = br.optionalSigned(7);
      for (let s = 0; s < 4; s++) segmentFilter[s] = br.optionalSigned(6);
    }
    if (updateMap) for (let s = 0; s < 3; s++) segmentProbs[s] = br.bit(0x80) ? br.literal(8) : 255;
  }

  // Filter header.
  const simple = br.bit(0x80) === 1;
  const level = br.literal(6);
  const sharpness = br.literal(3);
  const useLfDelta = br.bit(0x80) === 1;
  const refDelta = new Int32Array(4),
    modeDelta = new Int32Array(4);
  if (useLfDelta && br.bit(0x80)) {
    for (let i = 0; i < 4; i++) refDelta[i] = br.optionalSigned(6);
    for (let i = 0; i < 4; i++) modeDelta[i] = br.optionalSigned(6);
  }
  const filterType = level === 0 ? 0 : simple ? 1 : 2;

  // Token partitions.
  const partitionCount = 1 << br.literal(2);
  const sizes = 10 + firstSize;
  let partStart = sizes + 3 * (partitionCount - 1);
  if (partStart > data.length) fail('VP8: truncated partition table');
  const partitions: BoolDecoder[] = [];
  for (let p = 0; p < partitionCount; p++) {
    let size: number;
    if (p < partitionCount - 1) {
      const o = sizes + 3 * p;
      size = data[o]! | (data[o + 1]! << 8) | (data[o + 2]! << 16);
    } else size = data.length - partStart;
    const end = Math.min(partStart + size, data.length);
    partitions.push(new BoolDecoder(data, partStart, end));
    partStart = end;
  }

  // Quantizers.
  const baseQ = br.literal(7);
  const dqY1Dc = br.optionalSigned(4),
    dqY2Dc = br.optionalSigned(4),
    dqY2Ac = br.optionalSigned(4),
    dqUvDc = br.optionalSigned(4),
    dqUvAc = br.optionalSigned(4);
  const clip = (v: number, max: number): number => (v < 0 ? 0 : v > max ? max : v);
  const quants: Quant[] = [];
  for (let s = 0; s < 4; s++) {
    if (!useSegment && s > 0) {
      quants.push(quants[0]!);
      continue;
    }
    const q = useSegment ? segmentQuant[s]! + (absoluteDelta ? 0 : baseQ) : baseQ;
    const y2Ac = (AC_TABLE[clip(q + dqY2Ac, 127)]! * 101581) >> 16;
    quants.push({
      y1: [DC_TABLE[clip(q + dqY1Dc, 127)]!, AC_TABLE[clip(q, 127)]!],
      y2: [DC_TABLE[clip(q + dqY2Dc, 127)]! * 2, y2Ac < 8 ? 8 : y2Ac],
      uv: [DC_TABLE[clip(q + dqUvDc, 117)]!, AC_TABLE[clip(q + dqUvAc, 127)]!],
    });
  }

  br.bit(0x80); // refresh entropy probabilities: ignored for a still image.
  const probs = new Uint8Array(COEFF_PROBS.length);
  for (let i = 0; i < probs.length; i++)
    probs[i] = br.bit(COEFF_UPDATE_PROBS[i]!) ? br.literal(8) : COEFF_PROBS[i]!;
  const useSkip = br.bit(0x80) === 1;
  const skipProb = useSkip ? br.literal(8) : 0;

  // Loop-filter strengths per segment and 4x4 flag (PrecomputeFilterStrengths).
  const strengths: FilterInfo[][] = [];
  for (let s = 0; s < 4; s++) {
    let base = level;
    if (useSegment) base = segmentFilter[s]! + (absoluteDelta ? 0 : level);
    const row: FilterInfo[] = [];
    for (let i4 = 0; i4 <= 1; i4++) {
      let l = base;
      if (useLfDelta) {
        l += refDelta[0]!;
        if (i4) l += modeDelta[0]!;
      }
      l = l < 0 ? 0 : l > 63 ? 63 : l;
      const info: FilterInfo = {limit: 0, interior: 0, hevThreshold: 0, inner: i4 === 1};
      if (l > 0) {
        let interior = l;
        if (sharpness > 0) {
          interior >>= sharpness > 4 ? 2 : 1;
          if (interior > 9 - sharpness) interior = 9 - sharpness;
        }
        if (interior < 1) interior = 1;
        info.interior = interior;
        info.limit = 2 * l + interior;
        info.hevThreshold = l >= 40 ? 2 : l >= 15 ? 1 : 0;
      }
      row.push(info);
    }
    strengths.push(row);
  }

  const mbW = (width + 15) >> 4,
    mbH = (height + 15) >> 4;
  const yStride = mbW * 16,
    uvStride = mbW * 8;
  const Y = new Uint8Array(yStride * mbH * 16);
  const U = new Uint8Array(uvStride * mbH * 8);
  const V = new Uint8Array(uvStride * mbH * 8);
  const filters: FilterInfo[] = new Array(mbW * mbH);

  // Contexts: 4x4 modes and non-zero flags of the row above and of the left macroblock.
  const topModes = new Uint8Array(mbW * 4);
  const leftModes = new Uint8Array(4);
  const topNz = new Uint8Array(mbW * 9);
  const leftNz = new Uint8Array(9);
  const coeffs = new Int16Array(384);
  const blockModes = new Uint8Array(16);
  const nonZero = new Uint8Array(24);
  const work = new Work();

  for (let mbY = 0; mbY < mbH; mbY++) {
    leftModes.fill(Mode.DC);
    leftNz.fill(0);
    const tokens = partitions[mbY & (partitionCount - 1)]!;
    for (let mbX = 0; mbX < mbW; mbX++) {
      // Intra modes (ParseIntraMode).
      const segment = updateMap
        ? !br.bit(segmentProbs[0]!)
          ? br.bit(segmentProbs[1]!)
          : br.bit(segmentProbs[2]!) + 2
        : 0;
      const skip = useSkip ? br.bit(skipProb) === 1 : false;
      const isI4 = !br.bit(145);
      let yMode: number = Mode.DC;
      const top = mbX * 4;
      if (!isI4) {
        yMode = br.bit(156) ? (br.bit(128) ? Mode.TM : Mode.HE) : br.bit(163) ? Mode.VE : Mode.DC;
        topModes.fill(yMode, top, top + 4);
        leftModes.fill(yMode);
      } else {
        for (let y = 0; y < 4; y++) {
          let m = leftModes[y]!;
          for (let x = 0; x < 4; x++) {
            const base = (topModes[top + x]! * 10 + m) * 9;
            let i = B_MODE_TREE[br.bit(BMODE_PROBS[base]!)]!;
            while (i > 0) i = B_MODE_TREE[2 * i + br.bit(BMODE_PROBS[base + i]!)]!;
            m = -i;
            topModes[top + x] = m;
            blockModes[y * 4 + x] = m;
          }
          leftModes[y] = m;
        }
      }
      const uvMode = !br.bit(142)
        ? Mode.DC
        : !br.bit(114)
          ? Mode.VE
          : br.bit(183)
            ? Mode.TM
            : Mode.HE;

      // Residuals.
      coeffs.fill(0);
      nonZero.fill(0);
      let empty = true;
      const tnz = mbX * 9;
      if (!skip) {
        empty = parseResiduals(
          tokens,
          probs,
          quants[segment]!,
          isI4,
          topNz,
          tnz,
          leftNz,
          coeffs,
          nonZero,
        );
      } else {
        topNz.fill(0, tnz, tnz + 8);
        leftNz.fill(0, 0, 8);
        if (!isI4) {
          topNz[tnz + 8] = 0;
          leftNz[8] = 0;
        }
      }
      if (filterType > 0) {
        const f = strengths[segment]![isI4 ? 1 : 0]!;
        filters[mbY * mbW + mbX] = empty ? f : {...f, inner: true};
      }

      work.reconstruct(
        Y,
        U,
        V,
        yStride,
        uvStride,
        mbX,
        mbY,
        mbW,
        isI4,
        yMode,
        blockModes,
        uvMode,
        coeffs,
        nonZero,
      );
    }
  }

  if (filterType > 0) {
    for (let mbY = 0; mbY < mbH; mbY++)
      for (let mbX = 0; mbX < mbW; mbX++)
        filterMacroblock(
          filterType,
          filters[mbY * mbW + mbX]!,
          Y,
          U,
          V,
          yStride,
          uvStride,
          mbX,
          mbY,
        );
  }
  return {width, height, y: Y, u: U, v: V, yStride, uvStride};
}

function largeValue(br: BoolDecoder, probs: Uint8Array, p: number): number {
  if (!br.bit(probs[p + 3]!)) {
    if (!br.bit(probs[p + 4]!)) return 2;
    return 3 + br.bit(probs[p + 5]!);
  }
  if (!br.bit(probs[p + 6]!)) {
    if (!br.bit(probs[p + 7]!)) return 5 + br.bit(159);
    return 7 + 2 * br.bit(165) + br.bit(145);
  }
  const bit1 = br.bit(probs[p + 8]!);
  const bit0 = br.bit(probs[p + 9 + bit1]!);
  const category = 2 * bit1 + bit0;
  let v = 0;
  for (const prob of CATEGORY_PROBS[category]!) v += v + br.bit(prob);
  return v + 3 + (8 << category);
}

/** GetCoeffs: tokens of one 4x4 block from position `n`; returns the end position. */
function readCoefficients(
  br: BoolDecoder,
  probs: Uint8Array,
  type: number,
  context: number,
  dq: [number, number],
  n: number,
  out: Int16Array,
  offset: number,
): number {
  const at = (position: number, ctx: number): number =>
    ((type * 8 + BANDS[position]!) * 3 + ctx) * 11;
  let p = at(n, context);
  for (; n < 16; n++) {
    if (!br.bit(probs[p]!)) return n;
    while (!br.bit(probs[p + 1]!)) {
      p = at(++n, 0);
      if (n === 16) return 16;
    }
    let v: number;
    if (!br.bit(probs[p + 2]!)) {
      v = 1;
      p = at(n + 1, 1);
    } else {
      v = largeValue(br, probs, p);
      p = at(n + 1, 2);
    }
    out[offset + ZIGZAG[n]!] = (br.bit(0x80) ? -v : v) * dq[n > 0 ? 1 : 0];
  }
  return 16;
}

/**
 * ParseResiduals: block tokens with contexts from the row above (`top[t..t+8]`, the last the
 * Y2 flag) and the left macroblock. Returns true when the macroblock has no coefficients.
 */
function parseResiduals(
  br: BoolDecoder,
  probs: Uint8Array,
  q: Quant,
  isI4: boolean,
  top: Uint8Array,
  t: number,
  left: Uint8Array,
  coeffs: Int16Array,
  nonZero: Uint8Array,
): boolean {
  let any = false;
  let first: number, type: number;
  if (!isI4) {
    const dc = new Int16Array(16);
    const nz = readCoefficients(br, probs, 1, top[t + 8]! + left[8]!, q.y2, 0, dc, 0);
    top[t + 8] = left[8] = nz > 0 ? 1 : 0;
    if (nz > 1) transformWht(dc, coeffs);
    else {
      const dc0 = (dc[0]! + 3) >> 3;
      for (let i = 0; i < 256; i += 16) coeffs[i] = dc0;
    }
    first = 1;
    type = 0;
  } else {
    first = 0;
    type = 3;
  }
  for (let y = 0; y < 4; y++) {
    let l = left[y]!;
    for (let x = 0; x < 4; x++) {
      const b = y * 4 + x;
      const nz = readCoefficients(br, probs, type, l + top[t + x]!, q.y1, first, coeffs, b * 16);
      l = nz > first ? 1 : 0;
      top[t + x] = l;
      if (nz > 0 || coeffs[b * 16] !== 0) nonZero[b] = 1;
    }
    left[y] = l;
  }
  for (let c = 0; c < 2; c++) {
    for (let y = 0; y < 2; y++) {
      let l = left[4 + c * 2 + y]!;
      for (let x = 0; x < 2; x++) {
        const b = 16 + c * 4 + y * 2 + x;
        const nz = readCoefficients(
          br,
          probs,
          2,
          l + top[t + 4 + c * 2 + x]!,
          q.uv,
          0,
          coeffs,
          b * 16,
        );
        l = nz > 0 ? 1 : 0;
        top[t + 4 + c * 2 + x] = l;
        if (nz > 0) nonZero[b] = 1;
      }
      left[4 + c * 2 + y] = l;
    }
  }
  for (let b = 0; b < 24; b++) if (nonZero[b]) any = true;
  return !any;
}

function transformWht(input: Int16Array, out: Int16Array): void {
  const tmp = new Int32Array(16);
  for (let i = 0; i < 4; i++) {
    const a0 = input[i]! + input[12 + i]!;
    const a1 = input[4 + i]! + input[8 + i]!;
    const a2 = input[4 + i]! - input[8 + i]!;
    const a3 = input[i]! - input[12 + i]!;
    tmp[i] = a0 + a1;
    tmp[8 + i] = a0 - a1;
    tmp[4 + i] = a3 + a2;
    tmp[12 + i] = a3 - a2;
  }
  for (let i = 0; i < 4; i++) {
    const dc = tmp[i * 4]! + 3;
    const a0 = dc + tmp[3 + i * 4]!;
    const a1 = tmp[1 + i * 4]! + tmp[2 + i * 4]!;
    const a2 = tmp[1 + i * 4]! - tmp[2 + i * 4]!;
    const a3 = dc - tmp[3 + i * 4]!;
    const o = i * 64;
    out[o] = (a0 + a1) >> 3;
    out[o + 16] = (a3 + a2) >> 3;
    out[o + 32] = (a0 - a1) >> 3;
    out[o + 48] = (a3 - a2) >> 3;
  }
}

const clip8 = (v: number): number => (v < 0 ? 0 : v > 255 ? 255 : v);
const C1 = 20091 + (1 << 16),
  C2 = 35468;
const mul = (a: number, b: number): number => (a * b) >> 16;

/** TransformOne: inverse DCT of `input[o..o+16]` added onto `dst` at `d` with row stride `s`. */
function inverseDct(input: Int16Array, o: number, dst: Uint8Array, d: number, s: number): void {
  const tmp = new Int32Array(16);
  for (let i = 0; i < 4; i++) {
    const a = input[o + i]! + input[o + 8 + i]!;
    const b = input[o + i]! - input[o + 8 + i]!;
    const c = mul(input[o + 4 + i]!, C2) - mul(input[o + 12 + i]!, C1);
    const e = mul(input[o + 4 + i]!, C1) + mul(input[o + 12 + i]!, C2);
    tmp[i * 4] = a + e;
    tmp[i * 4 + 1] = b + c;
    tmp[i * 4 + 2] = b - c;
    tmp[i * 4 + 3] = a - e;
  }
  for (let i = 0; i < 4; i++) {
    const dc = tmp[i]! + 4;
    const a = dc + tmp[8 + i]!;
    const b = dc - tmp[8 + i]!;
    const c = mul(tmp[4 + i]!, C2) - mul(tmp[12 + i]!, C1);
    const e = mul(tmp[4 + i]!, C1) + mul(tmp[12 + i]!, C2);
    const r = d + i * s;
    dst[r] = clip8(dst[r]! + ((a + e) >> 3));
    dst[r + 1] = clip8(dst[r + 1]! + ((b + c) >> 3));
    dst[r + 2] = clip8(dst[r + 2]! + ((b - c) >> 3));
    dst[r + 3] = clip8(dst[r + 3]! + ((a - e) >> 3));
  }
}

const BPS = 32;
/** Offsets in the work buffer: one row and column of neighbours before each block. */
const Y_OFF = BPS + 8,
  U_OFF = Y_OFF + 16 * BPS + BPS,
  V_OFF = U_OFF + 16;

/**
 * The per-macroblock reconstruction buffer (libwebp `yuv_b_`): row -1 holds the top
 * neighbours and 4 top-right samples, column -1 the left neighbours.
 */
class Work {
  private readonly b = new Uint8Array(BPS * 17 + BPS * 9 + 8);

  reconstruct(
    Y: Uint8Array,
    U: Uint8Array,
    V: Uint8Array,
    ys: number,
    uvs: number,
    mbX: number,
    mbY: number,
    mbW: number,
    isI4: boolean,
    yMode: number,
    blockModes: Uint8Array,
    uvMode: number,
    coeffs: Int16Array,
    nonZero: Uint8Array,
  ): void {
    const b = this.b;
    const x0 = mbX * 16,
      y0 = mbY * 16;
    // Neighbours: 127 above the first row (corner included), 129 left of the first column.
    for (let j = 0; j < 16; j++)
      b[Y_OFF - 1 + j * BPS] = mbX > 0 ? Y[(y0 + j) * ys + x0 - 1]! : 129;
    for (let j = 0; j < 8; j++) {
      b[U_OFF - 1 + j * BPS] = mbX > 0 ? U[(mbY * 8 + j) * uvs + mbX * 8 - 1]! : 129;
      b[V_OFF - 1 + j * BPS] = mbX > 0 ? V[(mbY * 8 + j) * uvs + mbX * 8 - 1]! : 129;
    }
    if (mbY === 0) {
      b.fill(127, Y_OFF - BPS - 1, Y_OFF - BPS + 20);
      b.fill(127, U_OFF - BPS - 1, U_OFF - BPS + 8);
      b.fill(127, V_OFF - BPS - 1, V_OFF - BPS + 8);
    } else {
      const above = (y0 - 1) * ys;
      for (let i = 0; i < 16; i++) b[Y_OFF - BPS + i] = Y[above + x0 + i]!;
      const uvAbove = (mbY * 8 - 1) * uvs + mbX * 8;
      for (let i = 0; i < 8; i++) {
        b[U_OFF - BPS + i] = U[uvAbove + i]!;
        b[V_OFF - BPS + i] = V[uvAbove + i]!;
      }
      b[Y_OFF - BPS - 1] = mbX > 0 ? Y[above + x0 - 1]! : 129;
      b[U_OFF - BPS - 1] = mbX > 0 ? U[uvAbove - 1]! : 129;
      b[V_OFF - BPS - 1] = mbX > 0 ? V[uvAbove - 1]! : 129;
      for (let i = 0; i < 4; i++)
        b[Y_OFF - BPS + 16 + i] = mbX < mbW - 1 ? Y[above + x0 + 16 + i]! : Y[above + x0 + 15]!;
    }
    // Top-right samples repeat for the right column of 4x4 blocks below the first row.
    for (let r = 1; r < 4; r++)
      for (let i = 0; i < 4; i++) b[Y_OFF + (r * 4 - 1) * BPS + 16 + i] = b[Y_OFF - BPS + 16 + i]!;

    if (isI4) {
      for (let n = 0; n < 16; n++) {
        const d = Y_OFF + (n >> 2) * 4 * BPS + (n & 3) * 4;
        predict4(b, d, blockModes[n]!);
        if (nonZero[n]) inverseDct(coeffs, n * 16, b, d, BPS);
      }
    } else {
      predict(b, Y_OFF, 16, checkMode(mbX, mbY, yMode));
      for (let n = 0; n < 16; n++)
        if (nonZero[n])
          inverseDct(coeffs, n * 16, b, Y_OFF + (n >> 2) * 4 * BPS + (n & 3) * 4, BPS);
    }
    const uvM = checkMode(mbX, mbY, uvMode);
    predict(b, U_OFF, 8, uvM);
    predict(b, V_OFF, 8, uvM);
    for (let n = 0; n < 4; n++) {
      const d = (n >> 1) * 4 * BPS + (n & 1) * 4;
      if (nonZero[16 + n]) inverseDct(coeffs, (16 + n) * 16, b, U_OFF + d, BPS);
      if (nonZero[20 + n]) inverseDct(coeffs, (20 + n) * 16, b, V_OFF + d, BPS);
    }

    for (let j = 0; j < 16; j++)
      Y.set(b.subarray(Y_OFF + j * BPS, Y_OFF + j * BPS + 16), (y0 + j) * ys + x0);
    for (let j = 0; j < 8; j++) {
      const o = (mbY * 8 + j) * uvs + mbX * 8;
      U.set(b.subarray(U_OFF + j * BPS, U_OFF + j * BPS + 8), o);
      V.set(b.subarray(V_OFF + j * BPS, V_OFF + j * BPS + 8), o);
    }
  }
}

const DC_NO_TOP = 10,
  DC_NO_LEFT = 11,
  DC_NO_TOP_LEFT = 12;

function checkMode(mbX: number, mbY: number, mode: number): number {
  if (mode !== Mode.DC) return mode;
  if (mbX === 0) return mbY === 0 ? DC_NO_TOP_LEFT : DC_NO_LEFT;
  return mbY === 0 ? DC_NO_TOP : Mode.DC;
}

/** 16x16 luma or 8x8 chroma prediction at `d`. */
function predict(b: Uint8Array, d: number, size: number, mode: number): void {
  const shift = size === 16 ? 4 : 3;
  let value = -1;
  switch (mode) {
    case Mode.VE:
      for (let j = 0; j < size; j++) b.copyWithin(d + j * BPS, d - BPS, d - BPS + size);
      return;
    case Mode.HE:
      for (let j = 0; j < size; j++) b.fill(b[d + j * BPS - 1]!, d + j * BPS, d + j * BPS + size);
      return;
    case Mode.TM:
      trueMotion(b, d, size);
      return;
    case Mode.DC: {
      let sum = size;
      for (let i = 0; i < size; i++) sum += b[d - BPS + i]! + b[d + i * BPS - 1]!;
      value = sum >> (shift + 1);
      break;
    }
    case DC_NO_TOP: {
      let sum = size >> 1;
      for (let i = 0; i < size; i++) sum += b[d + i * BPS - 1]!;
      value = sum >> shift;
      break;
    }
    case DC_NO_LEFT: {
      let sum = size >> 1;
      for (let i = 0; i < size; i++) sum += b[d - BPS + i]!;
      value = sum >> shift;
      break;
    }
    default:
      value = 0x80;
  }
  for (let j = 0; j < size; j++) b.fill(value, d + j * BPS, d + j * BPS + size);
}

function trueMotion(b: Uint8Array, d: number, size: number): void {
  const corner = b[d - BPS - 1]!;
  for (let j = 0; j < size; j++) {
    const left = b[d + j * BPS - 1]! - corner;
    for (let i = 0; i < size; i++) b[d + j * BPS + i] = clip8(left + b[d - BPS + i]!);
  }
}

const avg3 = (a: number, b: number, c: number): number => (a + 2 * b + c + 2) >> 2;
const avg2 = (a: number, b: number): number => (a + b + 1) >> 1;

/** The ten 4x4 intra predictors (libwebp dec.c). */
function predict4(b: Uint8Array, d: number, mode: number): void {
  const T = d - BPS;
  const set = (x: number, y: number, v: number): void => {
    b[d + x + y * BPS] = v;
  };
  const top = (i: number): number => b[T + i]!;
  const I = b[d - 1]!,
    J = b[d - 1 + BPS]!,
    K = b[d - 1 + 2 * BPS]!,
    L = b[d - 1 + 3 * BPS]!,
    X = b[T - 1]!;
  const A = top(0),
    B = top(1),
    C = top(2),
    D = top(3),
    E = top(4),
    F = top(5),
    G = top(6),
    H = top(7);
  switch (mode) {
    case Mode.DC: {
      let dc = 4;
      for (let i = 0; i < 4; i++) dc += top(i) + b[d - 1 + i * BPS]!;
      dc >>= 3;
      for (let y = 0; y < 4; y++) for (let x = 0; x < 4; x++) set(x, y, dc);
      return;
    }
    case Mode.TM:
      trueMotion(b, d, 4);
      return;
    case Mode.VE: {
      const v = [avg3(X, A, B), avg3(A, B, C), avg3(B, C, D), avg3(C, D, E)];
      for (let y = 0; y < 4; y++) for (let x = 0; x < 4; x++) set(x, y, v[x]!);
      return;
    }
    case Mode.HE: {
      const v = [avg3(X, I, J), avg3(I, J, K), avg3(J, K, L), avg3(K, L, L)];
      for (let y = 0; y < 4; y++) for (let x = 0; x < 4; x++) set(x, y, v[y]!);
      return;
    }
    case Mode.RD:
      set(0, 3, avg3(J, K, L));
      (set(0, 2, avg3(I, J, K)), set(1, 3, avg3(I, J, K)));
      (set(0, 1, avg3(X, I, J)), set(1, 2, avg3(X, I, J)), set(2, 3, avg3(X, I, J)));
      (set(0, 0, avg3(A, X, I)),
        set(1, 1, avg3(A, X, I)),
        set(2, 2, avg3(A, X, I)),
        set(3, 3, avg3(A, X, I)));
      (set(1, 0, avg3(B, A, X)), set(2, 1, avg3(B, A, X)), set(3, 2, avg3(B, A, X)));
      (set(2, 0, avg3(C, B, A)), set(3, 1, avg3(C, B, A)));
      set(3, 0, avg3(D, C, B));
      return;
    case Mode.LD:
      set(0, 0, avg3(A, B, C));
      (set(1, 0, avg3(B, C, D)), set(0, 1, avg3(B, C, D)));
      (set(2, 0, avg3(C, D, E)), set(1, 1, avg3(C, D, E)), set(0, 2, avg3(C, D, E)));
      (set(3, 0, avg3(D, E, F)),
        set(2, 1, avg3(D, E, F)),
        set(1, 2, avg3(D, E, F)),
        set(0, 3, avg3(D, E, F)));
      (set(3, 1, avg3(E, F, G)), set(2, 2, avg3(E, F, G)), set(1, 3, avg3(E, F, G)));
      (set(3, 2, avg3(F, G, H)), set(2, 3, avg3(F, G, H)));
      set(3, 3, avg3(G, H, H));
      return;
    case Mode.VR:
      (set(0, 0, avg2(X, A)), set(1, 2, avg2(X, A)));
      (set(1, 0, avg2(A, B)), set(2, 2, avg2(A, B)));
      (set(2, 0, avg2(B, C)), set(3, 2, avg2(B, C)));
      set(3, 0, avg2(C, D));
      set(0, 3, avg3(K, J, I));
      set(0, 2, avg3(J, I, X));
      (set(0, 1, avg3(I, X, A)), set(1, 3, avg3(I, X, A)));
      (set(1, 1, avg3(X, A, B)), set(2, 3, avg3(X, A, B)));
      (set(2, 1, avg3(A, B, C)), set(3, 3, avg3(A, B, C)));
      set(3, 1, avg3(B, C, D));
      return;
    case Mode.VL:
      set(0, 0, avg2(A, B));
      (set(1, 0, avg2(B, C)), set(0, 2, avg2(B, C)));
      (set(2, 0, avg2(C, D)), set(1, 2, avg2(C, D)));
      (set(3, 0, avg2(D, E)), set(2, 2, avg2(D, E)));
      set(0, 1, avg3(A, B, C));
      (set(1, 1, avg3(B, C, D)), set(0, 3, avg3(B, C, D)));
      (set(2, 1, avg3(C, D, E)), set(1, 3, avg3(C, D, E)));
      (set(3, 1, avg3(D, E, F)), set(2, 3, avg3(D, E, F)));
      set(3, 2, avg3(E, F, G));
      set(3, 3, avg3(F, G, H));
      return;
    case Mode.HD:
      (set(0, 0, avg2(I, X)), set(2, 1, avg2(I, X)));
      (set(0, 1, avg2(J, I)), set(2, 2, avg2(J, I)));
      (set(0, 2, avg2(K, J)), set(2, 3, avg2(K, J)));
      set(0, 3, avg2(L, K));
      set(3, 0, avg3(A, B, C));
      set(2, 0, avg3(X, A, B));
      (set(1, 0, avg3(I, X, A)), set(3, 1, avg3(I, X, A)));
      (set(1, 1, avg3(J, I, X)), set(3, 2, avg3(J, I, X)));
      (set(1, 2, avg3(K, J, I)), set(3, 3, avg3(K, J, I)));
      set(1, 3, avg3(L, K, J));
      return;
    default:
      // HU
      set(0, 0, avg2(I, J));
      (set(2, 0, avg2(J, K)), set(0, 1, avg2(J, K)));
      (set(2, 1, avg2(K, L)), set(0, 2, avg2(K, L)));
      set(1, 0, avg3(I, J, K));
      (set(3, 0, avg3(J, K, L)), set(1, 1, avg3(J, K, L)));
      (set(3, 1, avg3(K, L, L)), set(1, 2, avg3(K, L, L)));
      (set(3, 2, L), set(2, 2, L), set(0, 3, L), set(1, 3, L), set(2, 3, L), set(3, 3, L));
  }
}

// In-loop filter (RFC 6386 15, libwebp dsp/dec.c).
const sclip1 = (v: number): number => (v < -128 ? -128 : v > 127 ? 127 : v);
const sclip2 = (v: number): number => (v < -16 ? -16 : v > 15 ? 15 : v);

function filter2(p: Uint8Array, i: number, step: number): void {
  const p1 = p[i - 2 * step]!,
    p0 = p[i - step]!,
    q0 = p[i]!,
    q1 = p[i + step]!;
  const a = 3 * (q0 - p0) + sclip1(p1 - q1);
  const a1 = sclip2((a + 4) >> 3);
  const a2 = sclip2((a + 3) >> 3);
  p[i - step] = clip8(p0 + a2);
  p[i] = clip8(q0 - a1);
}

function filter4(p: Uint8Array, i: number, step: number): void {
  const p1 = p[i - 2 * step]!,
    p0 = p[i - step]!,
    q0 = p[i]!,
    q1 = p[i + step]!;
  const a = 3 * (q0 - p0);
  const a1 = sclip2((a + 4) >> 3);
  const a2 = sclip2((a + 3) >> 3);
  const a3 = (a1 + 1) >> 1;
  p[i - 2 * step] = clip8(p1 + a3);
  p[i - step] = clip8(p0 + a2);
  p[i] = clip8(q0 - a1);
  p[i + step] = clip8(q1 - a3);
}

function filter6(p: Uint8Array, i: number, step: number): void {
  const p2 = p[i - 3 * step]!,
    p1 = p[i - 2 * step]!,
    p0 = p[i - step]!,
    q0 = p[i]!,
    q1 = p[i + step]!,
    q2 = p[i + 2 * step]!;
  const a = sclip1(3 * (q0 - p0) + sclip1(p1 - q1));
  const a1 = (27 * a + 63) >> 7;
  const a2 = (18 * a + 63) >> 7;
  const a3 = (9 * a + 63) >> 7;
  p[i - 3 * step] = clip8(p2 + a3);
  p[i - 2 * step] = clip8(p1 + a2);
  p[i - step] = clip8(p0 + a1);
  p[i] = clip8(q0 - a1);
  p[i + step] = clip8(q1 - a2);
  p[i + 2 * step] = clip8(q2 - a3);
}

function needsFilter(p: Uint8Array, i: number, step: number, t: number): boolean {
  return 2 * Math.abs(p[i - step]! - p[i]!) + (Math.abs(p[i - 2 * step]! - p[i + step]!) >> 1) <= t;
}

function needsFilter2(p: Uint8Array, i: number, step: number, t: number, it: number): boolean {
  const p3 = p[i - 4 * step]!,
    p2 = p[i - 3 * step]!,
    p1 = p[i - 2 * step]!,
    p0 = p[i - step]!,
    q0 = p[i]!,
    q1 = p[i + step]!,
    q2 = p[i + 2 * step]!,
    q3 = p[i + 3 * step]!;
  if (2 * Math.abs(p0 - q0) + (Math.abs(p1 - q1) >> 1) > t) return false;
  return (
    Math.abs(p3 - p2) <= it &&
    Math.abs(p2 - p1) <= it &&
    Math.abs(p1 - p0) <= it &&
    Math.abs(q3 - q2) <= it &&
    Math.abs(q2 - q1) <= it &&
    Math.abs(q1 - q0) <= it
  );
}

const hev = (p: Uint8Array, i: number, step: number, t: number): boolean =>
  Math.abs(p[i - 2 * step]! - p[i - step]!) > t || Math.abs(p[i + step]! - p[i]!) > t;

function simpleEdge(p: Uint8Array, i: number, step: number, along: number, t: number): void {
  for (let k = 0; k < 16; k++, i += along) if (needsFilter(p, i, step, t)) filter2(p, i, step);
}

function edge(
  p: Uint8Array,
  i: number,
  step: number,
  along: number,
  size: number,
  t: number,
  it: number,
  hevT: number,
  outer: boolean,
): void {
  for (let k = 0; k < size; k++, i += along) {
    if (!needsFilter2(p, i, step, t, it)) continue;
    if (hev(p, i, step, hevT)) filter2(p, i, step);
    else if (outer) filter6(p, i, step);
    else filter4(p, i, step);
  }
}

/** DoFilter: left edge, inner vertical edges, top edge, inner horizontal edges. */
function filterMacroblock(
  type: number,
  f: FilterInfo,
  Y: Uint8Array,
  U: Uint8Array,
  V: Uint8Array,
  ys: number,
  uvs: number,
  mbX: number,
  mbY: number,
): void {
  const limit = f.limit;
  if (limit === 0) return;
  const y = mbY * 16 * ys + mbX * 16;
  if (type === 1) {
    if (mbX > 0) simpleEdge(Y, y, 1, ys, limit + 4);
    if (f.inner) for (let k = 4; k < 16; k += 4) simpleEdge(Y, y + k, 1, ys, limit);
    if (mbY > 0) simpleEdge(Y, y, ys, 1, limit + 4);
    if (f.inner) for (let k = 4; k < 16; k += 4) simpleEdge(Y, y + k * ys, ys, 1, limit);
    return;
  }
  const uv = mbY * 8 * uvs + mbX * 8;
  const it = f.interior,
    h = f.hevThreshold;
  if (mbX > 0) {
    edge(Y, y, 1, ys, 16, limit + 4, it, h, true);
    edge(U, uv, 1, uvs, 8, limit + 4, it, h, true);
    edge(V, uv, 1, uvs, 8, limit + 4, it, h, true);
  }
  if (f.inner) {
    for (let k = 4; k < 16; k += 4) edge(Y, y + k, 1, ys, 16, limit, it, h, false);
    edge(U, uv + 4, 1, uvs, 8, limit, it, h, false);
    edge(V, uv + 4, 1, uvs, 8, limit, it, h, false);
  }
  if (mbY > 0) {
    edge(Y, y, ys, 1, 16, limit + 4, it, h, true);
    edge(U, uv, uvs, 1, 8, limit + 4, it, h, true);
    edge(V, uv, uvs, 1, 8, limit + 4, it, h, true);
  }
  if (f.inner) {
    for (let k = 4; k < 16; k += 4) edge(Y, y + k * ys, ys, 1, 16, limit, it, h, false);
    edge(U, uv + 4 * uvs, uvs, 1, 8, limit, it, h, false);
    edge(V, uv + 4 * uvs, uvs, 1, 8, limit, it, h, false);
  }
}

// YUV to BGRA (libwebp 0.4 yuv.h, 14-bit fixed point).
const clipYuv = (v: number): number => ((v & 0xffc00000) === 0 ? v >> 14 : v < 0 ? 0 : 255);

function storeLegacy(out: Uint8Array, o: number, y: number, u: number, v: number): void {
  const yy = 19077 * y;
  out[o] = clipYuv(yy + 33050 * u - 4527440);
  out[o + 1] = clipYuv(yy - 6419 * u - 13320 * v + 2229552);
  out[o + 2] = clipYuv(yy + 26149 * v - 3644112);
  out[o + 3] = 255;
}

// Current libwebp yuv.h: intermediate products truncate to eight fractional
// bits, matching its SIMD implementations. The 0.4 scalar path above keeps 14.
function store(out: Uint8Array, o: number, y: number, u: number, v: number): void {
  const yy = (19077 * y) >> 8;
  const clip = (v: number): number => Math.max(0, Math.min(255, v >> 6));
  out[o] = clip(yy + ((33050 * u) >> 8) - 17685);
  out[o + 1] = clip(yy - ((6419 * u) >> 8) - ((13320 * v) >> 8) + 8708);
  out[o + 2] = clip(yy + ((26149 * v) >> 8) - 14234);
  out[o + 3] = 255;
}

/** UpsampleBgraLinePair: one or two output rows from two chroma rows. */
function upsamplePair(
  img: YuvImage,
  out: Uint8Array,
  topRow: number,
  bottomRow: number,
  topUv: number,
  curUv: number,
  store: typeof storeLegacy,
): void {
  const {width: len, y: Y, u: U, v: V, yStride, uvStride} = img;
  const ty = topRow * yStride,
    by = bottomRow * yStride;
  const tu = topUv * uvStride,
    cu = curUv * uvStride;
  const to = topRow * len * 4,
    bo = bottomRow * len * 4;
  const hasBottom = bottomRow >= 0;
  const last = (len - 1) >> 1;
  const load = (o: number): number => U[o]! | (V[o]! << 16);
  let tl = load(tu),
    l = load(cu);
  {
    const uv = (3 * tl + l + 0x00020002) >> 2;
    store(out, to, Y[ty]!, uv & 0xff, uv >>> 16);
  }
  if (hasBottom) {
    const uv = (3 * l + tl + 0x00020002) >> 2;
    store(out, bo, Y[by]!, uv & 0xff, uv >>> 16);
  }
  for (let x = 1; x <= last; x++) {
    const t = load(tu + x),
      c = load(cu + x);
    const avg = tl + t + l + c + 0x00080008;
    const diag12 = (avg + 2 * (t + l)) >> 3;
    const diag03 = (avg + 2 * (tl + c)) >> 3;
    {
      const uv0 = (diag12 + tl) >> 1,
        uv1 = (diag03 + t) >> 1;
      store(out, to + (2 * x - 1) * 4, Y[ty + 2 * x - 1]!, uv0 & 0xff, uv0 >>> 16);
      store(out, to + 2 * x * 4, Y[ty + 2 * x]!, uv1 & 0xff, uv1 >>> 16);
    }
    if (hasBottom) {
      const uv0 = (diag03 + l) >> 1,
        uv1 = (diag12 + c) >> 1;
      store(out, bo + (2 * x - 1) * 4, Y[by + 2 * x - 1]!, uv0 & 0xff, uv0 >>> 16);
      store(out, bo + 2 * x * 4, Y[by + 2 * x]!, uv1 & 0xff, uv1 >>> 16);
    }
    tl = t;
    l = c;
  }
  if (!(len & 1)) {
    const uv = (3 * tl + l + 0x00020002) >> 2;
    store(out, to + (len - 1) * 4, Y[ty + len - 1]!, uv & 0xff, uv >>> 16);
    if (hasBottom) {
      const uv2 = (3 * l + tl + 0x00020002) >> 2;
      store(out, bo + (len - 1) * 4, Y[by + len - 1]!, uv2 & 0xff, uv2 >>> 16);
    }
  }
}

/** EmitFancyRGB over the whole frame: opaque BGRA, `width * height * 4` bytes. */
export function yuvToBgra(img: YuvImage, legacyColor = false): Uint8Array {
  const out = new Uint8Array(img.width * img.height * 4);
  const h = img.height;
  const convert = legacyColor ? storeLegacy : store;
  upsamplePair(img, out, 0, -1, 0, 0, convert);
  let y = 1;
  for (; y + 1 < h; y += 2) upsamplePair(img, out, y, y + 1, (y - 1) >> 1, (y + 1) >> 1, convert);
  if (!(h & 1)) upsamplePair(img, out, h - 1, -1, (h >> 1) - 1, (h >> 1) - 1, convert);
  return out;
}
