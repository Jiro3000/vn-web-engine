import {byteDataView, checkRange} from '../../core/binary.js';
import {unpackSiglusLz, xorCycle} from './compression.js';
import {imageXor} from './tables.js';

export interface G00Frame {
  width: number;
  height: number;
  x: number;
  y: number;
  bgra: Uint8Array<ArrayBuffer>;
  centerX: number;
  centerY: number;
}

function pixelBytes(width: number, height: number): number {
  if (width <= 0 || height <= 0 || width * height > 16_777_216)
    throw new Error('Invalid G00 dimensions');
  return width * height * 4;
}

/** Keeps decompressed cut data and expands only the requested frame. */
export class G00Image {
  readonly type: number;
  readonly width: number;
  readonly height: number;
  readonly count: number;
  private readonly data: Uint8Array<ArrayBuffer>;

  constructor(private readonly bytes: Uint8Array) {
    const view = byteDataView(bytes);
    this.type = view.getUint8(0);
    this.width = view.getUint16(1, true);
    this.height = view.getUint16(3, true);
    pixelBytes(this.width, this.height);
    this.count = this.type === 2 ? view.getUint32(5, true) : 1;
    const start = this.type === 2 ? 9 + this.count * 24 : 5;
    checkRange(bytes.length, start, 1);
    if (this.type === 3) {
      this.data = new Uint8Array(bytes.subarray(start));
      xorCycle(this.data, imageXor);
    } else if (this.type <= 2) this.data = unpackSiglusLz(bytes.subarray(start), this.type === 0);
    else throw new Error(`Unsupported G00 type ${this.type}`);
  }

  jpeg(): Uint8Array<ArrayBuffer> {
    if (this.type !== 3) throw new Error('G00 does not contain JPEG data');
    return this.data;
  }

  frame(index: number): G00Frame {
    if (!Number.isInteger(index) || index < 0 || index >= this.count || this.type === 3)
      throw new Error(`Invalid G00 frame ${index}`);
    const width = this.width;
    const height = this.height;
    const size = pixelBytes(width, height);
    if (this.type === 0) {
      if (this.data.length !== size) throw new Error('Invalid G00 pixel data length');
      return {width, height, x: 0, y: 0, centerX: 0, centerY: 0, bgra: this.data};
    }
    const view = byteDataView(this.data);
    if (this.type === 1) {
      const paletteSize = view.getUint16(0, true);
      const pixels = 2 + paletteSize * 4;
      checkRange(this.data.length, pixels, size / 4);
      const bgra = new Uint8Array(size);
      for (let i = 0; i < size / 4; i++) {
        const color = this.data[pixels + i]!;
        if (color >= paletteSize) throw new Error('Invalid G00 palette index');
        bgra.set(this.data.subarray(2 + color * 4, 6 + color * 4), i * 4);
      }
      return {width, height, x: 0, y: 0, centerX: 0, centerY: 0, bgra};
    }
    const outer = byteDataView(this.bytes);
    const x = outer.getInt32(9 + index * 24, true);
    const y = outer.getInt32(13 + index * 24, true);
    const offset = view.getUint32(4 + index * 8, true);
    const length = view.getUint32(8 + index * 8, true);
    if (!offset || !length)
      return {width: 1, height: 1, x, y, centerX: 0, centerY: 0, bgra: new Uint8Array(4)};
    checkRange(this.data.length, offset, length);
    const block = this.data.subarray(offset, offset + length);
    const cut = byteDataView(block);
    const chips = cut.getUint16(2, true);
    const w = cut.getInt32(28, true);
    const h = cut.getInt32(32, true);
    const bgra = new Uint8Array(pixelBytes(w, h));
    let p = 116;
    for (let i = 0; i < chips; i++) {
      const left = cut.getUint16(p, true);
      const top = cut.getUint16(p + 2, true);
      const cw = cut.getUint16(p + 6, true);
      const ch = cut.getUint16(p + 8, true);
      p += 92;
      checkRange(block.length, p, cw * ch * 4);
      if (left + cw > w || top + ch > h) throw new Error('G00 chip outside cut');
      for (let row = 0; row < ch; row++) {
        const start = p + row * cw * 4;
        bgra.set(block.subarray(start, start + cw * 4), ((top + row) * w + left) * 4);
      }
      p += cw * ch * 4;
    }
    return {
      width: w,
      height: h,
      x,
      y,
      centerX: cut.getInt32(20, true),
      centerY: cut.getInt32(24, true),
      bgra,
    };
  }
}
