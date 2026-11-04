import {ByteView, checkRange} from '../../core/binary.js';

/** JPEG frame pairs in YSMV, read by hajiron.exe 0x458A24. */
export class Ymv {
  readonly count: number;
  readonly alphaMode: number;
  readonly width: number;
  readonly height: number;
  readonly fps: number;
  private readonly offsets: Uint32Array;
  private readonly colors: Uint32Array;
  private readonly alphas: Uint32Array;
  constructor(private readonly data: Uint8Array) {
    const v = new ByteView(data, {littleEndian: true});
    v.check(0, 32);
    if (v.u32(0) !== 0x564d5359) throw new Error('YMV: invalid YSMV signature');
    this.count = v.u32(8);
    this.alphaMode = v.u32(12);
    this.width = v.u32(16);
    this.height = v.u32(20);
    this.fps = v.u32(24);
    v.check(32, this.count * 12);
    this.offsets = new Uint32Array(this.count);
    this.colors = new Uint32Array(this.count);
    this.alphas = new Uint32Array(this.count);
    for (let i = 0; i < this.count; i++) {
      const offset = v.u32(32 + i * 4),
        color = v.u32(32 + (this.count + i) * 4),
        alpha = v.u32(32 + (this.count * 2 + i) * 4);
      checkRange(data.length, offset, color + alpha);
      this.offsets[i] = offset;
      this.colors[i] = color;
      this.alphas[i] = alpha;
    }
  }
  /** Native FRAME clamps to 0..NUM-1; each JPEG resets the XOR position to zero. */
  frame(index: number): {index: number; color: Uint8Array; alpha: Uint8Array | null} {
    if (this.count === 0) throw new Error('YMV: no frames');
    index = Math.max(0, Math.min(this.count - 1, index));
    const offset = this.offsets[index]!,
      colorSize = this.colors[index]!,
      alphaSize = this.alphas[index]!;
    const decrypt = (at: number, size: number): Uint8Array => {
      const out = this.data.slice(at, at + size);
      for (let i = 0; i < size; i++) out[i] = out[i]! ^ ((i & 15) + 16);
      return out;
    };
    return {
      index,
      color: decrypt(offset, colorSize),
      alpha: alphaSize ? decrypt(offset + colorSize, alphaSize) : null,
    };
  }
}
