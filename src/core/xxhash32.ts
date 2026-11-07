const P1 = 0x9e3779b1;
const P2 = 0x85ebca77;
const P3 = 0xc2b2ae3d;
const P4 = 0x27d4eb2f;
const P5 = 0x165667b1;

const rotl = (x: number, r: number): number => (x << r) | (x >>> (32 - r));
const u32 = (d: Uint8Array, p: number): number =>
  (d[p]! | (d[p + 1]! << 8) | (d[p + 2]! << 16) | (d[p + 3]! << 24)) >>> 0;
const round = (acc: number, input: number): number =>
  Math.imul(rotl((acc + Math.imul(input, P2)) | 0, 13), P1);

/** xxHash32 (XXH32) of `data`, little-endian input words. */
export function xxHash32(data: Uint8Array, seed = 0): number {
  const length = data.length;
  let p = 0;
  let h: number;
  if (length >= 16) {
    let v1 = (seed + P1 + P2) | 0;
    let v2 = (seed + P2) | 0;
    let v3 = seed | 0;
    let v4 = (seed - P1) | 0;
    const limit = length - 16;
    do {
      v1 = round(v1, u32(data, p));
      v2 = round(v2, u32(data, p + 4));
      v3 = round(v3, u32(data, p + 8));
      v4 = round(v4, u32(data, p + 12));
      p += 16;
    } while (p <= limit);
    h = (rotl(v1, 1) + rotl(v2, 7) + rotl(v3, 12) + rotl(v4, 18)) | 0;
  } else h = (seed + P5) | 0;
  h = (h + length) | 0;
  for (; p + 4 <= length; p += 4)
    h = Math.imul(rotl((h + Math.imul(u32(data, p), P3)) | 0, 17), P4);
  for (; p < length; p++) h = Math.imul(rotl((h + Math.imul(data[p]!, P5)) | 0, 11), P1);
  h ^= h >>> 15;
  h = Math.imul(h, P2);
  h ^= h >>> 13;
  h = Math.imul(h, P3);
  h ^= h >>> 16;
  return h >>> 0;
}
