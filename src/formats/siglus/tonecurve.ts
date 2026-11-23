import {byteDataView} from '../../core/binary.js';

const curveCount = 256;
const tableEnd = 8 + curveCount * 4;
const colorBytes = 256;
const recordHeader = 0x40;
const plainSize = recordHeader + 3 * colorBytes;

export interface SiglusToneCurve {
  readonly channels: readonly [Uint8Array, Uint8Array, Uint8Array];
  readonly monochrome: number;
}

/** Indexed RGB tables consumed by Siglus 1.1.102.1 at 0x67a030. */
export function readSiglusToneCurves(bytes: Uint8Array): Map<number, SiglusToneCurve> {
  if (bytes.length < tableEnd) throw new Error('Truncated Siglus tone curve table');
  const view = byteDataView(bytes);
  const curves = new Map<number, SiglusToneCurve>();
  for (let index = 0; index < curveCount; index++) {
    const offset = view.getUint32(8 + index * 4, true);
    if (!offset) continue;
    if (offset < tableEnd || offset + plainSize > bytes.length)
      throw new Error(`Invalid Siglus tone curve ${index}`);
    const mode = view.getUint32(offset, true);
    const size = view.getUint32(offset + 4, true);
    if (mode > 1 || size < plainSize + mode * 4 || offset + size > bytes.length)
      throw new Error(`Invalid Siglus tone curve record ${index}`);
    const first = offset + recordHeader;
    const adjustment = mode === 1 ? view.getInt32(offset + plainSize, true) : 0;
    // 0x5c50ab clamps the signed adjustment and quantizes the grayscale mix.
    const percent = 100 + Math.max(-100, Math.min(0, adjustment));
    curves.set(index, {
      channels: [
        bytes.slice(first, first + colorBytes),
        bytes.slice(first + colorBytes, first + 2 * colorBytes),
        bytes.slice(first + 2 * colorBytes, first + 3 * colorBytes),
      ],
      monochrome: (255 - Math.trunc(percent * 255 / 100)) / 255,
    });
  }
  if (curves.size !== view.getUint32(4, true)) throw new Error('Wrong Siglus tone curve count');
  return curves;
}
