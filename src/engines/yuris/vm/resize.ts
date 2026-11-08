import {bilinearBgra, type LanczosTaps, lanczosBgra} from '../../../graphics/bgra-effects-wasm.js';
import type {Rect} from './compose.js';

/**
 * The CGACT SIZE family: scaling a region of a layer into a new buffer of FSX/100 x FSY/100
 * pixels (0x4344C8 and its workers).
 *
 * Pixels are straight BGRA bytes; `stride` arguments are source widths in pixels. The region
 * is given in hundredths of a pixel (FX, FY, FX2, FY2) and the output size in hundredths
 * (FSX, FSY). Output pixels whose source lies outside the source texture are cleared. The
 * native workers split the rows across the job threads 0x41F550; the rows are independent,
 * so they run here in one loop. Source taps that the native loops read past the end of the
 * buffer (the padding a native allocation carries) read as zero.
 */

/** The interpolation fraction a column weight passes through first (0x822120, 0x822220). */
const SHARPEN = sharpenTable();

/**
 * 0x46145C / 0x462044: the weight table both bilinear setups build once when 0x59B7E0 is set
 * (always): round(1.25 * (f - 128) + 128) clamped to 0..255, which steepens the transition
 * between neighbouring source pixels. x87 rounding is to nearest even.
 */
function sharpenTable(): Uint8Array {
  const table = new Uint8Array(256);
  for (let f = 0; f < 256; f++)
    table[f] = Math.min(Math.max(roundEven(1.25 * (f - 128) + 128), 0), 255);
  return table;
}

function roundEven(value: number): number {
  const floor = Math.floor(value),
    rest = value - floor;
  if (rest > 0.5) return floor + 1;
  if (rest < 0.5) return floor;
  return floor % 2 === 0 ? floor : floor + 1;
}

/** `__alldiv`: the 64-bit quotient of a * b / c truncated toward zero, kept to its low dword. */
function mulDiv(a: number, b: number, c: number): number {
  const n = a * b;
  if (Number.isSafeInteger(n)) {
    const sign = n < 0 !== c < 0 ? -1 : 1,
      x = Math.abs(n),
      y = Math.abs(c);
    let q = Math.floor(x / y);
    while (q * y > x) q--;
    while ((q + 1) * y <= x) q++;
    return (sign * q) | 0;
  }
  return Number(BigInt.asIntN(32, (BigInt(a) * BigInt(b)) / BigInt(c)));
}

/** C `/` and `%` on 32-bit ints. */
const div = (a: number, b: number): number => Math.trunc(a / b) | 0;
const mod = (a: number, b: number): number => (a % b) | 0;

/**
 * The first output index whose source coordinate is not negative, and the first after it
 * that reaches `limit` (the scans of 0x4610B0 and the other setups): [start, end).
 */
function validRange(count: number, at: (index: number) => number, limit: number): [number, number] {
  let start = 0;
  for (let i = 0; i < count; i++) {
    const v = at(i);
    if (v < 0) start = i + 1;
    if (v >= limit) return [start, i];
  }
  return [start, count];
}

/** The native memset 0x4034B8 on pixels [from, to) of `buffer`. */
function clear(buffer: Uint8Array, from: number, to: number): void {
  if (to > from) buffer.fill(0, Math.max(from, 0) * 4, Math.min(to * 4, buffer.length));
}

/** Clears the output rows outside [start, end), and in each row inside, the columns outside [left, right). */
function clearOutside(
  dst: Uint8Array,
  width: number,
  height: number,
  start: number,
  end: number,
  left: number,
  right: number,
): void {
  clear(dst, 0, start * width);
  clear(dst, end * width, height * width);
  for (let y = start; y < end; y++) {
    clear(dst, y * width, y * width + left);
    clear(dst, y * width + right, (y + 1) * width);
  }
}

/** A source byte; reads past the end of the buffer give 0. */
const at = (src: Uint8Array, index: number): number => src[index] ?? 0;

/**
 * SIZE 0x4610B0 and its job 0xB (0x4208A0): nearest-neighbour sampling of the pixel region
 * x0..x1, y0..y1. Output column i reads source column x0 + (i * ((x1 - x0 + 1) << 16) / width
 * accumulated) >> 16, and rows likewise.
 */
export function sizeNearest(
  dst: Uint8Array,
  width: number,
  height: number,
  src: Uint8Array,
  stride: number,
  rows: number,
  x0: number,
  y0: number,
  x1: number,
  y1: number,
): void {
  const columns = new Int32Array(Math.max(width, 0)),
    lines = new Int32Array(Math.max(height, 0));
  for (
    let i = 0, step = div(Math.imul(x1 - x0 + 1, 0x10000), width), acc = 0;
    i < width;
    i++, acc = (acc + step) >>> 0
  )
    columns[i] = acc >>> 16;
  for (
    let i = 0, step = div(Math.imul(y1 - y0 + 1, 0x10000), height), acc = 0;
    i < height;
    i++, acc = (acc + step) >>> 0
  )
    lines[i] = acc >>> 16;
  const [top, bottom] = validRange(height, (i) => lines[i]! + y0, rows);
  const [left, right] = validRange(width, (i) => columns[i]! + x0, stride);
  clearOutside(dst, width, height, top, bottom, left, right);
  const out = new Uint32Array(dst.buffer, dst.byteOffset, dst.byteLength >> 2);
  const from = new Uint32Array(src.buffer, src.byteOffset, src.byteLength >> 2);
  if (
    dst.buffer !== src.buffer &&
    width <= 0x7fff &&
    x1 - x0 + 1 === width &&
    left < right &&
    top < bottom
  ) {
    const count = right - left;
    if (
      from.length >= stride * rows &&
      out.length >= width * height &&
      y0 >= 0 &&
      y1 >= y0 &&
      y1 < rows
    ) {
      for (let y = top; y < bottom; y++) {
        const start = (lines[y]! + y0) * stride + x0 + left;
        out.set(from.subarray(start, start + count), y * width + left);
      }
      return;
    }
  }
  if (dst.buffer !== src.buffer && left < right && from.length >= stride * rows) {
    // Every tap inside [left, right) x [top, bottom) lies in the source, and an output row
    // whose source row repeats the previous one's is the same row of pixels.
    const count = right - left,
      taps = new Int32Array(count);
    for (let x = 0; x < count; x++) taps[x] = columns[left + x]! + x0;
    let previous = -1;
    for (let y = top; y < bottom; y++) {
      const line = lines[y]! + y0,
        o = y * width + left;
      if (line === previous) {
        out.copyWithin(o, o - width, o - width + count);
        continue;
      }
      previous = line;
      const row = line * stride;
      for (let x = 0; x < count; x++) out[o + x] = from[row + taps[x]!]!;
    }
    return;
  }
  for (let y = top; y < bottom; y++) {
    const row = (lines[y]! + y0) * stride + x0;
    for (let x = left, o = y * width + left; x < right; x++, o++)
      out[o] = from[row + columns[x]!] ?? 0;
  }
}

/**
 * The per-axis setup the bilinear routines share (0x46145C, 0x462044): output index i maps
 * to source position (base + 256 i) * span / (size - 100) + add in 1/256 pixels, where span
 * is the region extent in hundredths. The hundredths of the region's start become a 1/256
 * offset that is added before the division when the axis shrinks (size < span) and after it
 * otherwise. A size of 100 divides by 100.
 */
interface BilinearAxis {
  readonly span: number;
  readonly base: number;
  readonly add: number;
  readonly divisor: number;
}

function bilinearAxis(start: number, end: number, size: number): BilinearAxis {
  const offset = div(Math.imul(mod(start, 100), 0x100), 100);
  const span = end - start;
  const shrink = size < span;
  return {span, base: shrink ? offset : 0, add: shrink ? 0 : offset, divisor: size - 100 || 100};
}

const position = (axis: BilinearAxis, i: number): number =>
  (mulDiv(axis.span, axis.base + i * 0x100, axis.divisor) + axis.add) | 0;

/** SIZE2 coordinate and weight tables for integer graphics backends. */
export function bilinearCoordinates(
  start: number,
  end: number,
  size: number,
  sourceSize: number,
  sharpen: boolean,
): Int32Array {
  const count = div(size, 100);
  const axis = bilinearAxis(start, end, size);
  const origin = div(start, 100);
  const coordinates = new Int32Array(count * 2);
  const [first, last] = validRange(count, (i) => (position(axis, i) >> 8) + origin, sourceSize);
  for (let i = 0; i < count; i++) {
    const fixed = position(axis, i);
    coordinates[i * 2] = i < first || i >= last ? -1 : (fixed >> 8) + origin;
    coordinates[i * 2 + 1] = sharpen ? SHARPEN[fixed & 255]! : fixed & 255;
  }
  return coordinates;
}

/** One BGRA pixel of the 2x2 blend, as the MMX bodies of 0x46145C and 0x41FD88 compute it. */
function blendMmx(
  out: Uint8Array,
  o: number,
  src: Uint8Array,
  i: number,
  below: number,
  wx: number,
  wy: number,
): void {
  const ix = 256 - wx,
    iy = 256 - wy;
  for (let c = 0; c < 4; c++) {
    const top = Math.min(at(src, i + c) * ix + at(src, i + 4 + c) * wx, 0xffff) >> 8;
    const bottom =
      ((Math.min(at(src, below + c) * ix + at(src, below + 4 + c) * wx, 0xffff) >> 8) * wy) &
      0xffff;
    out[o + c] = Math.min(top * iy + bottom, 0xffff) >> 8;
  }
}

/** One BGRA pixel of the 2x2 blend of the SSE body 0x4205AC (PMULHUW, PADDUSB). */
function blendSse(
  out: Uint8Array,
  o: number,
  src: Uint8Array,
  i: number,
  below: number,
  wx: number,
  wy: number,
): void {
  const ix = 256 - wx,
    iy = 256 - wy;
  for (let c = 0; c < 4; c++) {
    const top = Math.min(at(src, i + c) * ix + at(src, i + 4 + c) * wx, 0xffff);
    const bottom = Math.min(at(src, below + c) * ix + at(src, below + 4 + c) * wx, 0xffff);
    out[o + c] = Math.min(((top * iy) >>> 16) + ((bottom * wy) >>> 16), 0xff);
  }
}

const evenChannels = 0x00ff00ff;

/** Horizontal products, two independent unsigned 16-bit channel lanes per word. */
function horizontalRow(
  result: Uint32Array,
  source: Uint32Array,
  row: number,
  columns: Int32Array,
  weights: Uint8Array,
  left: number,
  right: number,
): void {
  for (let x = left; x < right; x++) {
    const at = row + columns[x]!,
      a = source[at] ?? 0,
      b = source[at + 1] ?? 0,
      w = weights[x]!,
      rest = 256 - w;
    result[x * 2] = Math.imul(a & evenChannels, rest) + Math.imul(b & evenChannels, w);
    result[x * 2 + 1] =
      Math.imul((a >>> 8) & evenChannels, rest) + Math.imul((b >>> 8) & evenChannels, w);
  }
}

const verticalMmx = (top: number, bottom: number, wy: number, iy: number): number =>
  ((top >>> 8) * iy + (bottom >>> 8) * wy) >>> 8;
const verticalSse = (top: number, bottom: number, wy: number, iy: number): number =>
  ((top * iy) >>> 16) + ((bottom * wy) >>> 16);

/**
 * SIZE2: bilinear scaling of the region FX..FX2, FY..FY2 (hundredths) to FSX/100 x FSY/100.
 *
 * With `simd` it is 0x462044 and its job 0x15 (0x4205AC); otherwise the MMX routine
 * 0x46145C. Both weight the two columns by the SHARPEN-mapped fraction and the two rows by
 * the plain fraction; they differ in where they round. The SSE routine clears the whole
 * output when no source row or column is inside the texture.
 */
export function sizeBilinear(
  dst: Uint8Array,
  src: Uint8Array,
  stride: number,
  rows: number,
  fx: number,
  fy: number,
  fx2: number,
  fy2: number,
  fsx: number,
  fsy: number,
  simd: boolean,
  sourceRevision?: number,
  clip?: Rect,
  destination?: {stride: number; x: number; y: number},
): boolean | void {
  const width = div(fsx, 100),
    height = div(fsy, 100);
  const ax = bilinearAxis(fx, fx2, fsx),
    ay = bilinearAxis(fy, fy2, fsy);
  const columns = new Int32Array(Math.max(width, 0)),
    weights = new Uint8Array(Math.max(width, 0));
  for (let i = 0; i < width; i++) {
    const p = position(ax, i);
    columns[i] = p >> 8;
    weights[i] = SHARPEN[p & 0xff]!;
  }
  const originX = div(fx, 100),
    originY = div(fy, 100);
  const rowPositions = new Int32Array(Math.max(height, 0));
  for (let y = 0; y < height; y++) rowPositions[y] = position(ay, y);
  let [top, bottom] = validRange(height, (i) => (rowPositions[i]! >> 8) + originY, rows);
  let [left, right] = validRange(width, (i) => columns[i]! + originX, stride);
  if (
    destination &&
    (!clip || clip[0] < left || clip[1] < top || clip[2] >= right || clip[3] >= bottom)
  )
    return false;
  if (clip) {
    const [firstX, firstY, lastX, lastY] = clip;
    top = Math.max(top, firstY);
    left = Math.max(left, firstX);
    bottom = Math.min(bottom, lastY + 1);
    right = Math.min(right, lastX + 1);
    for (let y = firstY; !destination && y <= lastY; y++) {
      const row = y * width;
      if (y < top || y >= bottom || left >= right) clear(dst, row + firstX, row + lastX + 1);
      else {
        clear(dst, row + firstX, row + left);
        clear(dst, row + right, row + lastX + 1);
      }
    }
  } else if (simd && !(top < bottom && left < right)) {
    clear(dst, 0, width * height);
    return;
  } else clearOutside(dst, width, height, top, bottom, left, right);
  if (
    top < bottom &&
    left < right &&
    dst.buffer !== src.buffer &&
    (src.byteLength & 3) === 0 &&
    bilinearBgra(
      src,
      stride,
      rows,
      dst,
      width,
      left,
      top,
      right,
      bottom,
      originX,
      originY,
      columns,
      weights,
      rowPositions,
      simd,
      sourceRevision,
      sourceRevision === undefined ? undefined : [fx, fx2, fsx],
      destination,
    )
  )
    return true;
  if (destination) return false;
  if (
    top < bottom &&
    left < right &&
    dst.buffer !== src.buffer &&
    ((src.byteOffset | dst.byteOffset | src.byteLength | dst.byteLength) & 3) === 0
  ) {
    const source = new Uint32Array(src.buffer, src.byteOffset, src.byteLength >>> 2),
      output = new Uint32Array(dst.buffer, dst.byteOffset, dst.byteLength >>> 2);
    let first = new Uint32Array(width * 2),
      second = new Uint32Array(width * 2);
    let firstY = NaN,
      secondY = NaN;
    const mix = simd ? verticalSse : verticalMmx;
    for (let y = top; y < bottom; y++) {
      const p = rowPositions[y]!,
        row = (p >> 8) + originY,
        wy = p & 0xff;
      if (row === secondY) {
        [first, second] = [second, first];
        [firstY, secondY] = [secondY, firstY];
      }
      if (row !== firstY) {
        horizontalRow(first, source, row * stride + originX, columns, weights, left, right);
        firstY = row;
      }
      const base = y * width;
      if (wy === 0) {
        for (let x = left; x < right; x++)
          output[base + x] =
            ((first[x * 2]! >>> 8) & evenChannels) | (first[x * 2 + 1]! & 0xff00ff00);
        continue;
      }
      if (row + 1 !== secondY) {
        horizontalRow(second, source, (row + 1) * stride + originX, columns, weights, left, right);
        secondY = row + 1;
      }
      const iy = 256 - wy;
      for (let x = left; x < right; x++) {
        const evenTop = first[x * 2]!,
          evenBottom = second[x * 2]!,
          oddTop = first[x * 2 + 1]!,
          oddBottom = second[x * 2 + 1]!;
        output[base + x] =
          mix(evenTop & 0xffff, evenBottom & 0xffff, wy, iy) |
          (mix(oddTop & 0xffff, oddBottom & 0xffff, wy, iy) << 8) |
          (mix(evenTop >>> 16, evenBottom >>> 16, wy, iy) << 16) |
          (mix(oddTop >>> 16, oddBottom >>> 16, wy, iy) << 24);
      }
    }
    return;
  }
  const blend = simd ? blendSse : blendMmx;
  const pitch = stride * 4;
  for (let y = top; y < bottom; y++) {
    const p = rowPositions[y]!;
    const row = originY * pitch + (p >> 8) * pitch + originX * 4,
      wy = p & 0xff;
    for (let x = left, o = (y * width + left) * 4; x < right; x++, o += 4) {
      const i = row + columns[x]! * 4;
      blend(dst, o, src, i, i + pitch, weights[x]!, wy);
    }
  }
}

/**
 * SIZE4 0x434F18 and its job 0x29 (0x41FD88): bilinear samples at the output pixel and half
 * a pixel to its right, averaged (PAVGB, rounding up). The region's hundredths only scale the
 * span; the start is truncated to whole pixels. The job also computes the samples half a row
 * down, but its averaging pass reads the first sample row twice (0x42024A), so they never
 * reach the output.
 */
export function sizeSupersampled(
  dst: Uint8Array,
  src: Uint8Array,
  stride: number,
  rows: number,
  fx: number,
  fy: number,
  fx2: number,
  fy2: number,
  fsx: number,
  fsy: number,
): void {
  const width = div(fsx, 100),
    height = div(fsy, 100);
  const spanX = fx2 - fx,
    spanY = fy2 - fy;
  const divX = fsx - 100 || 100,
    divY = fsy - 100 || 100;
  const originX = div(fx, 100),
    originY = div(fy, 100);
  const [top, bottom] = validRange(
    height,
    (i) => (mulDiv(spanY, i * 0x100, divY) >> 8) + originY,
    rows,
  );
  const [left, right] = validRange(
    width,
    (i) => (mulDiv(spanX, i * 0x100, divX) >> 8) + originX,
    stride,
  );
  clearOutside(dst, width, height, top, bottom, left, right);
  if (left >= right) return;
  const half = new Int32Array(right * 2);
  for (let k = left * 2; k < right * 2; k++)
    half[k] = mulDiv(spanX, (k >> 1) * 0x100 + (k & 1) * 0x80, divX);
  const pitch = stride * 4;
  const sample = new Uint8Array(8);
  for (let y = top; y < bottom; y++) {
    const p = mulDiv(spanY, y * 0x100, divY);
    const row = originY * pitch + (p >>> 8) * pitch + originX * 4,
      wy = p & 0xff;
    for (let x = left, o = (y * width + left) * 4; x < right; x++, o += 4) {
      for (let s = 0; s < 2; s++) {
        const c = half[x * 2 + s]!;
        const i = row + (c >>> 8) * 4;
        blendMmx(sample, s * 4, src, i, i + pitch, c & 0xff, wy);
      }
      for (let c = 0; c < 4; c++) dst[o + c] = (sample[c]! + sample[4 + c]! + 1) >> 1;
    }
  }
}

/** 0x435358: the cubic convolution weights (a = -1) for distances 0..512 in 1/256 pixels, times 256, truncated. */
const CUBIC = cubicTable();

function cubicTable(): Int32Array {
  const table = new Int32Array(0x201);
  for (let d = 0; d < 0x201; d++) {
    const t = d / 256;
    const w = t > 1 ? 4 - 8 * t + 5 * t * t - t * t * t : 1 - 2 * t * t + t * t * t;
    table[d] = Math.trunc(w * 256);
  }
  return table;
}

/**
 * SIZE3 0x435358: bicubic scaling of the pixel region x0..x1, y0..y1 over the 4x4 source
 * pixels around each position (1/256 pixel steps). A tap is used when its byte offset lies
 * inside the source buffer, so taps beyond a row's ends wrap to the neighbouring row; the sum
 * is divided by the used weights (1 when they cancel) and clamped to 0..255.
 */
export function sizeBicubic(
  dst: Uint8Array,
  width: number,
  height: number,
  src: Uint8Array,
  stride: number,
  rows: number,
  x0: number,
  y0: number,
  x1: number,
  y1: number,
): void {
  const columns = new Int32Array(Math.max(width, 0)),
    lines = new Int32Array(Math.max(height, 0));
  for (let i = 0; i < height; i++) lines[i] = Math.imul(div(i * 0x10000, height), y1 - y0 + 1) >> 8;
  for (let i = 0; i < width; i++) columns[i] = Math.imul(div(i * 0x10000, width), x1 - x0 + 1) >> 8;
  const [top, bottom] = validRange(height, (i) => (lines[i]! >> 8) + y0, rows);
  const [left, right] = validRange(width, (i) => (columns[i]! >> 8) + x0, stride);
  clearOutside(dst, width, height, top, bottom, left, right);
  const pitch = stride * 4,
    limit = rows * pitch - 1;
  const sum = new Int32Array(4);
  for (let y = top; y < bottom; y++) {
    const ly = lines[y]!,
      fy = ly & 0xff;
    for (let x = left, o = (y * width + left) * 4; x < right; x++, o += 4) {
      const cx = columns[x]!,
        fxr = cx & 0xff;
      sum.fill(0);
      let total = 0;
      let row = -pitch + (ly >> 8) * pitch + y0 * pitch;
      for (let ty = 0; ty < 4; ty++, row += pitch) {
        const wy = CUBIC[Math.abs((ty - 1) * 256 - fy)]!;
        for (let tx = 0, column = x0 - 1 + (cx >> 8); tx < 4; tx++, column++) {
          const i = column * 4 + row;
          if (i >>> 0 > limit >>> 0) continue;
          const w = div(wy * CUBIC[Math.abs((tx - 1) * 256 - fxr)]!, 256);
          total += w;
          for (let c = 0; c < 4; c++) sum[c]! += src[i + c]! * w;
        }
      }
      if (total === 0) total = 1;
      for (let c = 0; c < 4; c++) dst[o + c] = Math.min(Math.max(div(sum[c]!, total), 0), 0xff);
    }
  }
}

/**
 * The taps of one Lanczos-2 axis (0x46A03C and 0x465D11) from `source` to `target` samples:
 * the scale s is (target - 1) / (source - 1) (target when source is 1). Output i is centred on
 * c = i / s and reads source samples floor(c - 2/s)..ceil(c + 2/s), weighted
 * trunc(L((c - k) * s) * s * 65536) with L(x) = sinc(x) sinc(x / 2) for |x| < 2.
 */
function lanczosTaps(source: number, target: number): {first: Int32Array; weights: Int32Array[]} {
  const scale = source === 1 ? target / 1 : (target - 1) / (source - 1);
  const radius = 2 / scale,
    inverse = 1 / scale;
  const first = new Int32Array(target + 1),
    weights: Int32Array[] = [];
  for (let i = 0; i <= target; i++) {
    const c = i / scale;
    const lo = Math.floor(c - radius),
      hi = Math.ceil(c + radius);
    first[i] = lo;
    const taps = new Int32Array(Math.max(hi - lo + 1, 0));
    for (let k = lo; k <= hi; k++)
      taps[k - lo] = Math.trunc((lanczos((c - k) / inverse) / inverse) * 65536);
    weights.push(taps);
  }
  return {first, weights};
}

/** 0x465FD0 with the sinc 0x423820. */
function lanczos(x: number): number {
  const a = Math.abs(x);
  return a < 2 ? sinc(a) * sinc(a * 0.5) : 0;
}

function sinc(x: number): number {
  if (x === 0) return 1;
  const v = x * Math.PI;
  return Math.sin(v) / v;
}

/** The source index of tap k on an axis of n samples: mirrored at both ends. */
const mirror = (k: number, n: number): number => (k >= n ? n * 2 - k - 1 : Math.abs(k));

/**
 * SIZE5 0x434A14: Lanczos-2 scaling of the whole source texture (the region is not used),
 * horizontally into a buffer of the source's rows, then vertically. Each channel is the
 * weighted sum divided by 1 plus the weights, clamped to 0..255; an alpha above 252 becomes
 * 255.
 */
export function sizeLanczos(
  dst: Uint8Array,
  width: number,
  height: number,
  src: Uint8Array,
  stride: number,
  rows: number,
): void {
  // Horizontal pass: rows of the source to rows of `middle`.
  const horizontal = lanczosTaps(stride, width);
  const columns = mirroredTaps(horizontal, width, stride);
  const vertical = lanczosTaps(rows, height);
  const lines = mirroredTaps(vertical, height, rows);
  if (columns && lines && src.length >= rows * stride * 4) {
    const across = flatTaps(horizontal.weights, columns, width),
      down = flatTaps(vertical.weights, lines, height);
    if (across && down && lanczosBgra(dst, width, height, src, stride, rows, across, down)) return;
  }
  const middle = new Uint8Array(Math.max(width, 0) * Math.max(rows, 0) * 4);
  if (columns && src.length >= rows * stride * 4)
    lanczosRows(middle, src, rows, stride, width, horizontal.weights, columns);
  else
    resample(
      middle,
      src,
      rows,
      width,
      horizontal,
      (line, k) => (line * stride + mirror(k, stride)) * 4,
      (line, i) => (line * width + i) * 4,
    );
  // Vertical pass: columns of `middle` to the output.
  if (lines) lanczosColumns(dst, middle, width, height, vertical.weights, lines);
  else
    resample(
      dst,
      middle,
      width,
      height,
      vertical,
      (column, k) => (mirror(k, rows) * width + column) * 4,
      (column, i) => (i * width + column) * 4,
    );
}

/**
 * The taps of outputs 0..count-1 for the linear-memory kernel, or null when a divisor
 * (1 plus the weights) leaves the 32-bit range the kernel divides in.
 */
function flatTaps(weights: Int32Array[], samples: Int32Array[], count: number): LanczosTaps | null {
  let length = 0;
  for (let i = 0; i < count; i++) length += weights[i]!.length;
  const starts = new Uint32Array(count + 1),
    flat = new Uint32Array(length),
    flatWeights = new Int32Array(length),
    totals = new Int32Array(count);
  for (let i = 0, at = 0; i < count; i++) {
    const w = weights[i]!;
    let total = 1;
    starts[i] = at;
    flat.set(samples[i]!, at);
    flatWeights.set(w, at);
    for (let t = 0; t < w.length; t++) total += w[t]!;
    if ((total | 0) !== total) return null;
    totals[i] = total;
    at += w.length;
  }
  starts[count] = length;
  return {starts, samples: flat, weights: flatWeights, totals};
}

/**
 * The mirrored sample index of every tap of outputs 0..count-1, or null when a tap mirrors
 * outside 0..n-1. Those reads cross into a neighbouring line or past the buffer, which only
 * the generic pass reproduces.
 */
function mirroredTaps(
  taps: {first: Int32Array; weights: Int32Array[]},
  count: number,
  n: number,
): Int32Array[] | null {
  const samples: Int32Array[] = [];
  for (let i = 0; i < count; i++) {
    const lo = taps.first[i]!,
      w = taps.weights[i]!,
      at = new Int32Array(w.length);
    for (let t = 0; t < w.length; t++) {
      const m = mirror(lo + t, n);
      if (m < 0 || m >= n) return null;
      at[t] = m;
    }
    samples.push(at);
  }
  return samples;
}

/** Stores one output pixel of `resample`: the sums over 1 plus the weights, clamped. */
function storeLanczos(
  to: Uint8Array,
  o: number,
  b: number,
  g: number,
  r: number,
  a: number,
  total: number,
): void {
  to[o] = Math.min(Math.max(div(b, total), 0), 0xff);
  to[o + 1] = Math.min(Math.max(div(g, total), 0), 0xff);
  to[o + 2] = Math.min(Math.max(div(r, total), 0), 0xff);
  let alpha = div(a, total);
  if (alpha > 0xfc) alpha = 0xff;
  to[o + 3] = Math.min(Math.max(alpha, 0), 0xff);
}

/**
 * The horizontal pass of `resample` with in-range taps. Each sum wraps to 32 bits after every
 * tap, as the Int32Array accumulator of the generic pass does.
 */
function lanczosRows(
  to: Uint8Array,
  from: Uint8Array,
  rows: number,
  stride: number,
  width: number,
  weights: Int32Array[],
  samples: Int32Array[],
): void {
  for (let line = 0, o = 0; line < rows; line++) {
    const base = line * stride * 4;
    for (let i = 0; i < width; i++, o += 4) {
      const w = weights[i]!,
        m = samples[i]!;
      let b = 0,
        g = 0,
        r = 0,
        a = 0,
        total = 1;
      for (let t = 0; t < w.length; t++) {
        const p = base + m[t]! * 4,
          k = w[t]!;
        b = (b + from[p]! * k) | 0;
        g = (g + from[p + 1]! * k) | 0;
        r = (r + from[p + 2]! * k) | 0;
        a = (a + from[p + 3]! * k) | 0;
        total += k;
      }
      storeLanczos(to, o, b, g, r, a, total);
    }
  }
}

/** The vertical pass of `resample` with in-range taps, one output row at a time. */
function lanczosColumns(
  to: Uint8Array,
  from: Uint8Array,
  width: number,
  height: number,
  weights: Int32Array[],
  samples: Int32Array[],
): void {
  const pitch = width * 4,
    sums = new Int32Array(pitch);
  for (let i = 0; i < height; i++) {
    const w = weights[i]!,
      m = samples[i]!;
    sums.fill(0);
    let total = 1;
    for (let t = 0; t < w.length; t++) {
      const row = m[t]! * pitch,
        k = w[t]!;
      for (let j = 0; j < pitch; j++) sums[j] = sums[j]! + from[row + j]! * k;
      total += k;
    }
    for (let j = 0, o = i * pitch; j < pitch; j += 4)
      storeLanczos(to, o + j, sums[j]!, sums[j + 1]!, sums[j + 2]!, sums[j + 3]!, total);
  }
}

/** One pass of 0x434A14: `lines` independent lines of `count` outputs each. */
function resample(
  to: Uint8Array,
  from: Uint8Array,
  lines: number,
  count: number,
  taps: {first: Int32Array; weights: Int32Array[]},
  read: (line: number, tap: number) => number,
  write: (line: number, index: number) => number,
): void {
  const sum = new Int32Array(4);
  for (let line = 0; line < lines; line++)
    for (let i = 0; i < count; i++) {
      const lo = taps.first[i]!,
        weights = taps.weights[i]!;
      sum.fill(0);
      let total = 1;
      for (let t = 0; t < weights.length; t++) {
        const s = read(line, lo + t),
          w = weights[t]!;
        for (let c = 0; c < 4; c++) sum[c]! += at(from, s + c) * w;
        total += w;
      }
      const o = write(line, i);
      for (let c = 0; c < 4; c++) {
        let v = div(sum[c]!, total);
        if (c === 3 && v > 0xfc) v = 0xff;
        to[o + c] = Math.min(Math.max(v, 0), 0xff);
      }
    }
}
