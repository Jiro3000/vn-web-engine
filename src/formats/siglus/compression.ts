import {byteDataView, checkRange} from '../../core/binary.js';

export function xorCycle(bytes: Uint8Array, key: Uint8Array, start = 0): void {
  const keyLen = key.length;
  if (!keyLen) return;
  if (keyLen === 1) {
    xorByteInPlace(bytes, key[0]!);
    return;
  }
  let k = start % keyLen;
  for (let i = 0; i < bytes.length; i++) {
    bytes[i] = bytes[i]! ^ key[k]!;
    if (++k === keyLen) k = 0;
  }
}

/** Fast 32-bit wordwise in-place XOR with a single byte key. */
export function xorByteInPlace(bytes: Uint8Array, key: number): void {
  const k = key & 0xff;
  if (!k) return;
  const len = bytes.length;
  let i = 0;
  const align = (4 - (bytes.byteOffset & 3)) & 3;
  const prefix = Math.min(align, len);
  for (; i < prefix; i++) bytes[i] = bytes[i]! ^ k;
  const words = (len - i) >>> 2;
  if (words > 0) {
    const key32 = (k | (k << 8) | (k << 16) | (k << 24)) >>> 0;
    const view32 = new Uint32Array(bytes.buffer, bytes.byteOffset + i, words);
    for (let w = 0; w < words; w++) view32[w] = (view32[w]! ^ key32) >>> 0;
    i += words << 2;
  }
  for (; i < len; i++) bytes[i] = bytes[i]! ^ k;
}

/** G00 type 0 encodes runs in pixels, storing only BGR for literal pixels. */
export function unpackSiglusLz(bytes: Uint8Array, pixelMode = false): Uint8Array<ArrayBuffer> {
  const view = byteDataView(bytes);
  const packed = view.getUint32(0, true);
  const size = view.getUint32(4, true);
  const unit = pixelMode ? 4 : 1;
  if (packed !== bytes.length || size > 128 * 1024 * 1024 || size % unit)
    throw new Error('Invalid Siglus LZSS header');
  const output = new Uint8Array(size);
  let input = 8;
  let dest = 0;
  if (pixelMode) {
    while (dest < size) {
      if (input >= packed) throw new Error('Truncated Siglus LZSS stream');
      const flags = bytes[input++]!;
      for (let bit = 1; bit < 256 && dest < size; bit <<= 1) {
        if (flags & bit) {
          if (input + 3 > packed) throw new Error('Truncated Siglus LZSS literal');
          output[dest] = bytes[input]!;
          output[dest + 1] = bytes[input + 1]!;
          output[dest + 2] = bytes[input + 2]!;
          output[dest + 3] = 255;
          input += 3;
          dest += 4;
        } else {
          if (input + 2 > packed) throw new Error('Truncated Siglus LZSS reference');
          const word = bytes[input]! | (bytes[input + 1]! << 8);
          input += 2;
          const distance = (word >>> 4) << 2;
          let count = ((word & 15) + 1) << 2;
          if (dest + count > size) count = size - dest;
          if (!distance || distance > dest) throw new Error('Invalid Siglus LZSS reference');
          const src = dest - distance;
          if (distance >= count) {
            output.copyWithin(dest, src, src + count);
            dest += count;
          } else {
            const end = dest + count;
            for (; dest < end; dest++) output[dest] = output[dest - distance]!;
          }
        }
      }
    }
  } else {
    while (dest < size) {
      if (input >= packed) throw new Error('Truncated Siglus LZSS stream');
      const flags = bytes[input++]!;
      for (let bit = 1; bit < 256 && dest < size; bit <<= 1) {
        if (flags & bit) {
          if (input >= packed) throw new Error('Truncated Siglus LZSS literal');
          output[dest++] = bytes[input++]!;
        } else {
          if (input + 2 > packed) throw new Error('Truncated Siglus LZSS reference');
          const word = bytes[input]! | (bytes[input + 1]! << 8);
          input += 2;
          const distance = word >>> 4;
          let count = (word & 15) + 2;
          if (dest + count > size) count = size - dest;
          if (!distance || distance > dest) throw new Error('Invalid Siglus LZSS reference');
          const src = dest - distance;
          if (distance >= count) {
            output.copyWithin(dest, src, src + count);
            dest += count;
          } else if (distance === 1) {
            output.fill(output[src]!, dest, dest + count);
            dest += count;
          } else {
            const end = dest + count;
            for (; dest < end; dest++) output[dest] = output[dest - distance]!;
          }
        }
      }
    }
  }
  return output;
}
