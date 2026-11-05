/**
 * The VP8L lossless bitstream (RFC 9649 section 3 onward) as libwebp 0.4 decodes it: an
 * LSB-first bit reader, canonical prefix codes, a colour cache, LZ77 backward references
 * with 2-D distance codes, and the predictor, cross-colour, subtract-green and
 * colour-indexing transforms undone in reverse order of their appearance.
 *
 * Pixels are 32-bit ARGB. On a little-endian host their bytes are B, G, R, A, the layout
 * the libwebp MODE_BGRA output of YSWBP.DLL (FUN_10001040) produces.
 */

import {CODE_LENGTH_ORDER, CODE_TO_PLANE} from './tables.js';

export class WebpError extends Error {}

const fail = (message: string): never => {
  throw new WebpError(message);
};

/** LSB-first bit reader. Reads past the end yield zero bits and mark the stream as overrun. */
export class LosslessBits {
  private value = 0;
  private count = 0;
  private position: number;
  private consumed = 0;
  private readonly bitLength: number;

  constructor(
    private readonly data: Uint8Array,
    start = 0,
    private readonly end = data.length,
  ) {
    this.position = start;
    this.bitLength = (end - start) * 8;
  }

  get overrun(): boolean {
    return this.consumed > this.bitLength;
  }

  private fill(): void {
    while (this.count <= 24) {
      const byte = this.position < this.end ? this.data[this.position]! : 0;
      this.position++;
      this.value = (this.value | (byte << this.count)) >>> 0;
      this.count += 8;
    }
  }

  /** The next `n` (at most 24) bits without consuming them. */
  peek(n: number): number {
    if (this.count < n) this.fill();
    return this.value & ((1 << n) - 1);
  }

  skip(n: number): void {
    this.value >>>= n;
    this.count -= n;
    this.consumed += n;
  }

  read(n: number): number {
    if (n === 0) return 0;
    const v = this.peek(n);
    this.skip(n);
    return v;
  }
}

const ROOT_BITS = 8;
const LEAF = 0,
  LINK = 1;

/**
 * A canonical prefix code (RFC 9649 3.7.2.1) as a two-level lookup table. Each entry packs
 * kind (bit 0), code length or second-level width (bits 1..4) and symbol or offset (bits 5..).
 * A code with a single used symbol decodes it without reading bits.
 */
export class PrefixCode {
  private readonly table: Int32Array;
  private readonly single: number;

  constructor(lengths: Uint8Array) {
    const alphabet = lengths.length;
    let used = 0,
      last = 0;
    const counts = new Int32Array(16);
    for (let s = 0; s < alphabet; s++) {
      if (lengths[s]! > 0) {
        used++;
        last = s;
        counts[lengths[s]!]!++;
      }
    }
    if (used === 0) fail('VP8L: empty prefix code');
    if (used === 1) {
      this.single = last;
      this.table = new Int32Array(0);
      return;
    }
    this.single = -1;
    // Kraft equality: an incomplete or over-subscribed code is invalid.
    let left = 1;
    for (let l = 1; l < 16; l++) {
      left = left * 2 - counts[l]!;
      if (left < 0) fail('VP8L: over-subscribed prefix code');
    }
    if (left !== 0) fail('VP8L: incomplete prefix code');
    // First canonical code of each length.
    const next = new Int32Array(16);
    for (let l = 1, code = 0; l < 16; l++) {
      next[l] = code;
      code = (code + counts[l]!) << 1;
    }
    const reversed = new Int32Array(alphabet);
    for (let s = 0; s < alphabet; s++) {
      const l = lengths[s]!;
      if (l === 0) continue;
      let c = next[l]!++,
        r = 0;
      for (let i = 0; i < l; i++, c >>>= 1) r = (r << 1) | (c & 1);
      reversed[s] = r;
    }
    // Second-level widths per root slot.
    const width = new Int32Array(1 << ROOT_BITS);
    for (let s = 0; s < alphabet; s++) {
      const l = lengths[s]!;
      if (l > ROOT_BITS) {
        const slot = reversed[s]! & ((1 << ROOT_BITS) - 1);
        width[slot] = Math.max(width[slot]!, l - ROOT_BITS);
      }
    }
    let size = 1 << ROOT_BITS;
    const offsets = new Int32Array(1 << ROOT_BITS);
    for (let slot = 0; slot < 1 << ROOT_BITS; slot++) {
      if (width[slot]! > 0) {
        offsets[slot] = size;
        size += 1 << width[slot]!;
      }
    }
    const table = new Int32Array(size);
    for (let slot = 0; slot < 1 << ROOT_BITS; slot++) {
      if (width[slot]! > 0) table[slot] = LINK | (width[slot]! << 1) | (offsets[slot]! << 5);
    }
    for (let s = 0; s < alphabet; s++) {
      const l = lengths[s]!;
      if (l === 0) continue;
      const r = reversed[s]!;
      const entry = LEAF | (l << 1) | (s << 5);
      if (l <= ROOT_BITS) {
        for (let k = r; k < 1 << ROOT_BITS; k += 1 << l) table[k] = entry;
      } else {
        const slot = r & ((1 << ROOT_BITS) - 1);
        const w = width[slot]!,
          base = offsets[slot]!;
        for (let k = r >>> ROOT_BITS; k < 1 << w; k += 1 << (l - ROOT_BITS))
          table[base + k] = entry;
      }
    }
    this.table = table;
  }

  read(bits: LosslessBits): number {
    if (this.single >= 0) return this.single;
    const v = bits.peek(15);
    let e = this.table[v & ((1 << ROOT_BITS) - 1)]!;
    if ((e & 1) === LINK) {
      const w = (e >>> 1) & 15;
      e = this.table[(e >>> 5) + ((v >>> ROOT_BITS) & ((1 << w) - 1))]!;
    }
    bits.skip((e >>> 1) & 15);
    return e >>> 5;
  }
}

/** RFC 9649 3.7.2.1: a simple (one or two symbols) or normal code-length coded prefix code. */
function readPrefixCode(bits: LosslessBits, alphabet: number): PrefixCode {
  const lengths = new Uint8Array(alphabet);
  if (bits.read(1)) {
    const symbols = bits.read(1) + 1;
    const first = bits.read(bits.read(1) === 0 ? 1 : 8);
    if (first >= alphabet) fail('VP8L: symbol outside alphabet');
    lengths[first] = 1;
    if (symbols === 2) {
      const second = bits.read(8);
      if (second >= alphabet) fail('VP8L: symbol outside alphabet');
      lengths[second] = 1;
    }
    return new PrefixCode(lengths);
  }
  const codeLengthLengths = new Uint8Array(19);
  const count = bits.read(4) + 4;
  for (let i = 0; i < count; i++) codeLengthLengths[CODE_LENGTH_ORDER[i]!] = bits.read(3);
  const lengthCode = new PrefixCode(codeLengthLengths);
  let max = alphabet;
  if (bits.read(1)) {
    const n = 2 + 2 * bits.read(3);
    max = 2 + bits.read(n);
    if (max > alphabet) fail('VP8L: code length count exceeds alphabet');
  }
  let previous = 8;
  for (let symbol = 0; symbol < alphabet;) {
    if (max-- === 0) break;
    const code = lengthCode.read(bits);
    if (code < 16) {
      lengths[symbol++] = code;
      if (code !== 0) previous = code;
      continue;
    }
    const slot = code - 16;
    const repeat = bits.read([2, 3, 7][slot]!) + [3, 3, 11][slot]!;
    if (symbol + repeat > alphabet) fail('VP8L: code length repeat overflows');
    const value = code === 16 ? previous : 0;
    for (let k = 0; k < repeat; k++) lengths[symbol++] = value;
  }
  return new PrefixCode(lengths);
}

interface Group {
  green: PrefixCode;
  red: PrefixCode;
  blue: PrefixCode;
  alpha: PrefixCode;
  distance: PrefixCode;
}

const enum TransformType {
  Predictor,
  CrossColor,
  SubtractGreen,
  ColorIndexing,
}

interface Transform {
  type: TransformType;
  /** Width of the image the transform produces. */
  width: number;
  bits: number;
  data: Uint32Array;
}

const subSample = (size: number, bits: number): number => (size + (1 << bits) - 1) >>> bits;

function copyLength(bits: LosslessBits, symbol: number): number {
  if (symbol < 4) return symbol + 1;
  const extra = (symbol - 2) >>> 1;
  const offset = (2 + (symbol & 1)) << extra;
  return offset + bits.read(extra) + 1;
}

function planeDistance(width: number, code: number): number {
  if (code > 120) return code - 120;
  const v = CODE_TO_PLANE[code - 1]!;
  const distance = (v >>> 4) * width + (8 - (v & 0xf));
  return distance >= 1 ? distance : 1;
}

/** RFC 9649 5: the entropy-coded image of `width` x `height` pixels. */
function decodeImageStream(
  bits: LosslessBits,
  width: number,
  height: number,
  top: boolean,
): Uint32Array {
  const transforms: Transform[] = [];
  let codedWidth = width;
  if (top) {
    const seen = new Set<number>();
    while (bits.read(1)) {
      const type = bits.read(2) as TransformType;
      if (seen.has(type)) fail('VP8L: repeated transform');
      seen.add(type);
      const transform: Transform = {type, width: codedWidth, bits: 0, data: new Uint32Array(0)};
      if (type === TransformType.Predictor || type === TransformType.CrossColor) {
        transform.bits = bits.read(3) + 2;
        transform.data = decodeImageStream(
          bits,
          subSample(codedWidth, transform.bits),
          subSample(height, transform.bits),
          false,
        );
      } else if (type === TransformType.ColorIndexing) {
        const colors = bits.read(8) + 1;
        transform.bits = colors > 16 ? 0 : colors > 4 ? 1 : colors > 2 ? 2 : 3;
        const palette = decodeImageStream(bits, colors, 1, false);
        // The palette is delta coded; entries past it are transparent black.
        const expanded = new Uint32Array(256);
        expanded[0] = palette[0]!;
        for (let i = 1; i < colors; i++) expanded[i] = addPixels(palette[i]!, expanded[i - 1]!);
        transform.data = expanded;
        codedWidth = subSample(codedWidth, transform.bits);
      }
      transforms.push(transform);
    }
  }

  let cacheBits = 0;
  if (bits.read(1)) {
    cacheBits = bits.read(4);
    if (cacheBits < 1 || cacheBits > 11) fail('VP8L: invalid colour cache size');
  }

  let metaBits = 0,
    meta: Uint32Array | null = null,
    groupCount = 1;
  if (top && bits.read(1)) {
    metaBits = bits.read(3) + 2;
    meta = decodeImageStream(
      bits,
      subSample(codedWidth, metaBits),
      subSample(height, metaBits),
      false,
    );
    for (let i = 0; i < meta.length; i++) {
      const g = (meta[i]! >>> 8) & 0xffff;
      meta[i] = g;
      if (g >= groupCount) groupCount = g + 1;
    }
  }
  const cacheSize = cacheBits > 0 ? 1 << cacheBits : 0;
  const groups: Group[] = [];
  for (let i = 0; i < groupCount; i++) {
    groups.push({
      green: readPrefixCode(bits, 256 + 24 + cacheSize),
      red: readPrefixCode(bits, 256),
      blue: readPrefixCode(bits, 256),
      alpha: readPrefixCode(bits, 256),
      distance: readPrefixCode(bits, 40),
    });
  }

  const pixels = decodePixels(bits, codedWidth, height, groups, meta, metaBits, cacheBits);
  if (bits.overrun) fail('VP8L: truncated stream');

  let data = pixels;
  for (let i = transforms.length - 1; i >= 0; i--)
    data = inverseTransform(transforms[i]!, data, height);
  return data;
}

function decodePixels(
  bits: LosslessBits,
  width: number,
  height: number,
  groups: Group[],
  meta: Uint32Array | null,
  metaBits: number,
  cacheBits: number,
): Uint32Array {
  const total = width * height;
  const data = new Uint32Array(total);
  const cache = cacheBits > 0 ? new Uint32Array(1 << cacheBits) : null;
  const cacheShift = 32 - cacheBits;
  const metaWidth = subSample(width, metaBits);
  const mask = meta === null ? -1 : (1 << metaBits) - 1;
  let cached = 0;
  const insertCached = (end: number): void => {
    if (cache === null) return;
    for (; cached < end; cached++) {
      const argb = data[cached]!;
      cache[Math.imul(argb, 0x1e35a7bd) >>> cacheShift] = argb;
    }
  };
  const groupAt = (x: number, y: number): Group =>
    meta === null ? groups[0]! : groups[meta[metaWidth * (y >>> metaBits) + (x >>> metaBits)]!]!;

  let x = 0,
    y = 0,
    p = 0;
  let group = groupAt(0, 0);
  while (p < total) {
    if ((x & mask) === 0) group = groupAt(x, y);
    const code = group.green.read(bits);
    if (code < 256) {
      const red = group.red.read(bits);
      const blue = group.blue.read(bits);
      const alpha = group.alpha.read(bits);
      data[p++] = ((alpha << 24) | (red << 16) | (code << 8) | blue) >>> 0;
      if (++x >= width) {
        x = 0;
        y++;
      }
    } else if (code < 256 + 24) {
      const length = copyLength(bits, code - 256);
      const distance = planeDistance(width, copyLength(bits, group.distance.read(bits)));
      if (p < distance || total - p < length) fail('VP8L: backward reference out of range');
      for (let k = 0; k < length; k++, p++) data[p] = data[p - distance]!;
      x += length;
      while (x >= width) {
        x -= width;
        y++;
      }
      if (p < total && (x & mask) !== 0) group = groupAt(x, y);
    } else {
      if (cache === null) fail('VP8L: colour cache symbol without a cache');
      insertCached(p);
      data[p++] = cache![code - 280]!;
      if (++x >= width) {
        x = 0;
        y++;
      }
    }
    if (bits.overrun) fail('VP8L: truncated stream');
    insertCached(p);
  }
  return data;
}

function addPixels(a: number, b: number): number {
  const ag = ((a & 0xff00ff00) >>> 0) + ((b & 0xff00ff00) >>> 0);
  const rb = (a & 0x00ff00ff) + (b & 0x00ff00ff);
  return ((ag & 0xff00ff00) | (rb & 0x00ff00ff)) >>> 0;
}

const average2 = (a: number, b: number): number =>
  ((((a ^ b) & 0xfefefefe) >>> 1) + ((a & b) >>> 0)) >>> 0;

const clip255 = (v: number): number => (v < 0 ? 0 : v > 255 ? 255 : v);

function select(top: number, left: number, topLeft: number): number {
  let distance = 0;
  for (let s = 0; s < 32; s += 8) {
    const a = (top >>> s) & 0xff,
      b = (left >>> s) & 0xff,
      c = (topLeft >>> s) & 0xff;
    distance += Math.abs(b - c) - Math.abs(a - c);
  }
  return distance <= 0 ? top : left;
}

function clampedAddSubtractFull(a: number, b: number, c: number): number {
  let out = 0;
  for (let s = 0; s < 32; s += 8)
    out |= clip255(((a >>> s) & 0xff) + ((b >>> s) & 0xff) - ((c >>> s) & 0xff)) << s;
  return out >>> 0;
}

function clampedAddSubtractHalf(a: number, b: number): number {
  let out = 0;
  for (let s = 0; s < 32; s += 8) {
    const x = (a >>> s) & 0xff,
      y = (b >>> s) & 0xff;
    out |= clip255(x + Math.trunc((x - y) / 2)) << s;
  }
  return out >>> 0;
}

/** The 14 predictors of RFC 9649 4.1; modes 14 and 15 predict opaque black as libwebp does. */
function predict(mode: number, data: Uint32Array, p: number, width: number): number {
  const left = data[p - 1]!,
    top = data[p - width]!,
    topLeft = data[p - width - 1]!,
    topRight = data[p - width + 1]!;
  switch (mode) {
    case 1:
      return left;
    case 2:
      return top;
    case 3:
      return topRight;
    case 4:
      return topLeft;
    case 5:
      return average2(average2(left, topRight), top);
    case 6:
      return average2(left, topLeft);
    case 7:
      return average2(left, top);
    case 8:
      return average2(topLeft, top);
    case 9:
      return average2(top, topRight);
    case 10:
      return average2(average2(left, topLeft), average2(top, topRight));
    case 11:
      return select(top, left, topLeft);
    case 12:
      return clampedAddSubtractFull(left, top, topLeft);
    case 13:
      return clampedAddSubtractHalf(average2(left, top), topLeft);
    default:
      return 0xff000000;
  }
}

const colorDelta = (t: number, c: number): number => (((t << 24) >> 24) * ((c << 24) >> 24)) >> 5;

function inverseTransform(t: Transform, input: Uint32Array, height: number): Uint32Array {
  const width = t.width;
  switch (t.type) {
    case TransformType.SubtractGreen: {
      for (let i = 0; i < input.length; i++) {
        const argb = input[i]!;
        const green = (argb >>> 8) & 0xff;
        const rb = ((argb & 0x00ff00ff) + ((green << 16) | green)) & 0x00ff00ff;
        input[i] = ((argb & 0xff00ff00) | rb) >>> 0;
      }
      return input;
    }
    case TransformType.Predictor: {
      const data = input;
      const tiles = subSample(width, t.bits);
      data[0] = addPixels(data[0]!, 0xff000000);
      for (let x = 1; x < width; x++) data[x] = addPixels(data[x]!, data[x - 1]!);
      for (let y = 1; y < height; y++) {
        const row = y * width;
        data[row] = addPixels(data[row]!, data[row - width]!);
        const modes = (y >>> t.bits) * tiles;
        for (let x = 1; x < width; x++) {
          const mode = (t.data[modes + (x >>> t.bits)]! >>> 8) & 0xf;
          const p = row + x;
          data[p] = addPixels(data[p]!, predict(mode, data, p, width));
        }
      }
      return data;
    }
    case TransformType.CrossColor: {
      const tiles = subSample(width, t.bits);
      for (let y = 0; y < height; y++) {
        const row = y * width,
          modes = (y >>> t.bits) * tiles;
        for (let x = 0; x < width; x++) {
          const m = t.data[modes + (x >>> t.bits)]!;
          const argb = input[row + x]!;
          const green = (argb >>> 8) & 0xff;
          let red = (argb >>> 16) & 0xff;
          let blue = argb & 0xff;
          red = (red + colorDelta(m & 0xff, green)) & 0xff;
          blue =
            (blue + colorDelta((m >>> 8) & 0xff, green) + colorDelta((m >>> 16) & 0xff, red)) &
            0xff;
          input[row + x] = ((argb & 0xff00ff00) | (red << 16) | blue) >>> 0;
        }
      }
      return input;
    }
    case TransformType.ColorIndexing: {
      const out = new Uint32Array(width * height);
      const packedWidth = subSample(width, t.bits);
      const perPixel = 8 >>> t.bits;
      const indexMask = (1 << perPixel) - 1;
      const xMask = (1 << t.bits) - 1;
      for (let y = 0; y < height; y++) {
        for (let x = 0; x < width; x++) {
          const packed = (input[y * packedWidth + (x >>> t.bits)]! >>> 8) & 0xff;
          out[y * width + x] = t.data[(packed >>> (perPixel * (x & xMask))) & indexMask]!;
        }
      }
      return out;
    }
  }
}

export interface LosslessImage {
  width: number;
  height: number;
  /** ARGB words. */
  argb: Uint32Array;
}

/** A complete VP8L chunk payload: signature 0x2F, 14-bit sizes, alpha hint, version 0. */
export function decodeLossless(data: Uint8Array): LosslessImage {
  if (data.length < 5 || data[0] !== 0x2f) fail('VP8L: bad signature');
  const bits = new LosslessBits(data, 1);
  const width = bits.read(14) + 1;
  const height = bits.read(14) + 1;
  bits.read(1);
  if (bits.read(3) !== 0) fail('VP8L: unsupported version');
  return {width, height, argb: decodeImageStream(bits, width, height, true)};
}

/** An ALPH chunk's lossless stream: an image stream without header whose green channel is alpha. */
export function decodeLosslessAlpha(
  data: Uint8Array,
  start: number,
  width: number,
  height: number,
): Uint8Array {
  const argb = decodeImageStream(new LosslessBits(data, start), width, height, true);
  const alpha = new Uint8Array(width * height);
  for (let i = 0; i < alpha.length; i++) alpha[i] = (argb[i]! >>> 8) & 0xff;
  return alpha;
}
