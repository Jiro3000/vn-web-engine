/**
 * MurmurHash2 with seed 0, as YU-RIS inlines it: entry names (0x440858) and stored entry data
 * (0x41BCA8) are both hashed this way. Addresses refer to `hajiron.exe` (see the engine README).
 */
export function murmurHash2(bytes: Uint8Array): number {
  const m = 0x5bd1e995;
  let length = bytes.length,
    h = length >>> 0,
    p = 0;
  while (length >= 4) {
    let k = bytes[p]! | (bytes[p + 1]! << 8) | (bytes[p + 2]! << 16) | (bytes[p + 3]! << 24);
    k = Math.imul(k, m);
    k ^= k >>> 24;
    k = Math.imul(k, m);
    h = Math.imul(h, m) ^ k;
    p += 4;
    length -= 4;
  }
  switch (length) {
    case 3:
      h ^= bytes[p + 2]! << 16;
    // falls through
    case 2:
      h ^= bytes[p + 1]! << 8;
    // falls through
    case 1:
      h ^= bytes[p]!;
      h = Math.imul(h, m);
  }
  h ^= h >>> 13;
  h = Math.imul(h, m);
  h ^= h >>> 15;
  return h >>> 0;
}
