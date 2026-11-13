import {byteDataView, checkRange} from '../../core/binary.js';

export function xorCycle(bytes: Uint8Array, key: Uint8Array, start = 0): void {
  for (let i = 0; i < bytes.length; i++) bytes[i] = bytes[i]! ^ key[(start + i) % key.length]!;
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
  while (dest < size) {
    checkRange(packed, input, 1);
    const flags = bytes[input++]!;
    for (let bit = 1; bit < 256 && dest < size; bit <<= 1) {
      if (flags & bit) {
        const length = pixelMode ? 3 : 1;
        checkRange(packed, input, length);
        output.set(bytes.subarray(input, input + length), dest);
        input += length;
        if (pixelMode) output[dest + 3] = 255;
        dest += unit;
      } else {
        const word = view.getUint16(input, true);
        input += 2;
        const distance = (word >>> 4) * unit;
        const end = Math.min(size, dest + ((word & 15) + (pixelMode ? 1 : 2)) * unit);
        if (!distance || distance > dest) throw new Error('Invalid Siglus LZSS reference');
        for (; dest < end; dest++) output[dest] = output[dest - distance]!;
      }
    }
  }
  return output;
}
