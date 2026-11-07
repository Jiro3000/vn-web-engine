import {ByteView, checkRange} from '../../core/binary.js';
import type {ProgressiveBytes} from '../zlib.js';

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
  /**
   * `data` holds the whole file; `until`, when given, resolves once a prefix of it has been
   * written, and frames are read only after `ready`.
   */
  constructor(
    private readonly data: Uint8Array,
    private readonly until?: (end: number) => Promise<void>,
  ) {
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
  /** Opens a movie whose bytes are still arriving once its header and frame table have. */
  static async open(source: ProgressiveBytes): Promise<Ymv> {
    const {bytes, until} = source;
    await until(Math.min(32, bytes.length));
    if (bytes.length >= 32) {
      const count = new ByteView(bytes, {littleEndian: true}).u32(8);
      await until(Math.min(32 + count * 12, bytes.length));
    }
    return new Ymv(bytes, until);
  }

  /** Waits until `frame(index)` can read its JPEG pair. */
  async ready(index: number): Promise<void> {
    if (!this.until || this.count === 0) return;
    index = Math.max(0, Math.min(this.count - 1, index));
    await this.until(this.offsets[index]! + this.colors[index]! + this.alphas[index]!);
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
