/**
 * Swaps bytes 0 and 2 of every 4-byte texel: BGRA (Direct3D `D3DFMT_A8R8G8B8` and Kirikiri
 * layer memory) to RGBA (WebGL `RGBA`/`UNSIGNED_BYTE`, canvas `ImageData`), or back. `output`
 * may be `source` for an in-place swap.
 */
export function swapRedBlue(
  source: Uint8Array,
  output: Uint8Array | Uint8ClampedArray = new Uint8Array(source.length),
): Uint8Array | Uint8ClampedArray {
  if (source.length % 4 !== 0) throw new RangeError('Texel data is not a multiple of 4 bytes');
  if (output.length < source.length) throw new RangeError('Output is too small');
  for (let i = 0; i < source.length; i += 4) {
    const first = source[i]!;
    output[i] = source[i + 2]!;
    output[i + 1] = source[i + 1]!;
    output[i + 2] = first;
    output[i + 3] = source[i + 3]!;
  }
  return output;
}

const littleEndian = new Uint8Array(new Uint32Array([1]).buffer)[0] === 1;

/** Swaps bytes 0 and 2 of every texel in place (RGBA to BGRA or back), a word at a time. */
export function swapRedBlueInPlace(pixels: Uint8Array): Uint8Array {
  if (littleEndian && ((pixels.byteOffset | pixels.byteLength) & 3) === 0) {
    const words = new Uint32Array(pixels.buffer, pixels.byteOffset, pixels.byteLength / 4);
    for (let i = 0; i < words.length; i++) {
      const color = words[i]!;
      words[i] = (color & 0xff00ff00) | ((color & 255) << 16) | ((color >>> 16) & 255);
    }
    return pixels;
  }
  for (let i = 0; i + 3 < pixels.length; i += 4) {
    const b = pixels[i]!;
    pixels[i] = pixels[i + 2]!;
    pixels[i + 2] = b;
  }
  return pixels;
}
