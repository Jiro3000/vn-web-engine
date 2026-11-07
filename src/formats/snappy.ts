/**
 * The Snappy raw block format (google/snappy `format_description.txt`): a little-endian
 * base-128 varint with the uncompressed length, then elements tagged by their low two bits.
 * Tag 0 is a literal (length - 1 in the upper six bits, or in the 1..4 bytes that follow for
 * 60..63), tags 1, 2 and 3 copy from earlier output with a length of 4..11 and an 11-bit
 * offset, a length of 1..64 and a 16-bit offset, or a length of 1..64 and a 32-bit offset.
 *
 * The compressor is a greedy hash matcher. Its output is a valid stream for every decoder,
 * not the byte sequence of the reference implementation.
 */

/** The decoded bytes, or null when the stream is malformed or its length does not match. */
export function snappyUncompress(input: Uint8Array): Uint8Array | null {
  let p = 0,
    length = 0;
  for (let shift = 0; ; shift += 7) {
    if (p >= input.length || shift > 28) return null;
    const b = input[p++]!;
    length += (b & 0x7f) * 2 ** shift;
    if (b < 0x80) break;
  }
  if (length > 0xffffffff) return null;
  const out = new Uint8Array(length);
  let o = 0;
  while (p < input.length) {
    const tag = input[p++]!;
    if ((tag & 3) === 0) {
      let n = tag >>> 2;
      if (n >= 60) {
        const bytes = n - 59;
        if (p + bytes > input.length) return null;
        n = 0;
        for (let i = 0; i < bytes; i++) n += input[p + i]! * 2 ** (8 * i);
        p += bytes;
      }
      n += 1;
      if (p + n > input.length || o + n > length) return null;
      out.set(input.subarray(p, p + n), o);
      p += n;
      o += n;
      continue;
    }
    let n: number, offset: number;
    if ((tag & 3) === 1) {
      if (p + 1 > input.length) return null;
      n = ((tag >>> 2) & 7) + 4;
      offset = ((tag >>> 5) << 8) | input[p++]!;
    } else if ((tag & 3) === 2) {
      if (p + 2 > input.length) return null;
      n = (tag >>> 2) + 1;
      offset = input[p]! | (input[p + 1]! << 8);
      p += 2;
    } else {
      if (p + 4 > input.length) return null;
      n = (tag >>> 2) + 1;
      offset =
        (input[p]! | (input[p + 1]! << 8) | (input[p + 2]! << 16) | (input[p + 3]! << 24)) >>> 0;
      p += 4;
    }
    if (offset === 0 || offset > o || o + n > length) return null;
    // Copies may overlap their own output (offset < length repeats a pattern).
    for (let i = 0; i < n; i++, o++) out[o] = out[o - offset]!;
  }
  return o === length ? out : null;
}

/** A Snappy stream that decodes to `input`. */
/**
 * The match table shared by every call. Entries hold `base + position`; an entry below the
 * current call's base is empty, so the table is not cleared per call.
 */
const matchTable = new Int32Array(1 << 14);
let matchBase = 0;

export function snappyCompress(input: Uint8Array): Uint8Array {
  // Snappy's MaxCompressedLength bound.
  const out = new Uint8Array(32 + input.length + Math.ceil(input.length / 6));
  let o = 0;
  for (let n = input.length; ; n = Math.floor(n / 128)) {
    if (n < 0x80) {
      out[o++] = n;
      break;
    }
    out[o++] = (n & 0x7f) | 0x80;
  }
  const table = matchTable;
  if (matchBase + input.length + 1 > 0x7fff0000) {
    table.fill(0);
    matchBase = 0;
  }
  const base = matchBase + 1;
  matchBase = base + input.length;
  const hash = (i: number): number =>
    (Math.imul(
      input[i]! | (input[i + 1]! << 8) | (input[i + 2]! << 16) | (input[i + 3]! << 24),
      0x1e35a7bd,
    ) >>>
      18) &
    0x3fff;
  let literal = 0,
    i = 0;
  const emitLiteral = (end: number): void => {
    for (let start = literal; start < end;) {
      const n = Math.min(end - start, 0x10000);
      if (n <= 60) out[o++] = (n - 1) << 2;
      else if (n <= 0x100) {
        out[o++] = 60 << 2;
        out[o++] = n - 1;
      } else {
        out[o++] = 61 << 2;
        out[o++] = (n - 1) & 0xff;
        out[o++] = (n - 1) >>> 8;
      }
      out.set(input.subarray(start, start + n), o);
      o += n;
      start += n;
    }
  };
  const emitCopy = (offset: number, n: number): void => {
    while (n > 0) {
      // Keep at least 4 bytes for a final tag-1 copy when the rest is short.
      const take = n > 64 ? (n - 64 < 4 ? 60 : 64) : n;
      if (take >= 4 && take <= 11 && offset < 2048) {
        out[o++] = 1 | ((take - 4) << 2) | ((offset >>> 8) << 5);
        out[o++] = offset & 0xff;
      } else {
        out[o++] = 2 | ((take - 1) << 2);
        out[o++] = offset & 0xff;
        out[o++] = offset >>> 8;
      }
      n -= take;
    }
  };
  while (i + 4 <= input.length) {
    const h = hash(i),
      candidate = table[h]! - base;
    table[h] = base + i;
    if (
      candidate >= 0 &&
      i - candidate <= 0xffff &&
      input[candidate] === input[i] &&
      input[candidate + 1] === input[i + 1] &&
      input[candidate + 2] === input[i + 2] &&
      input[candidate + 3] === input[i + 3]
    ) {
      emitLiteral(i);
      let n = 4;
      while (i + n < input.length && input[candidate + n] === input[i + n]) n++;
      emitCopy(i - candidate, n);
      i += n;
      literal = i;
    } else i++;
  }
  emitLiteral(input.length);
  return out.slice(0, o);
}
