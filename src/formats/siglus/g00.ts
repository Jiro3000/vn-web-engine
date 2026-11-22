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
  contentBounds?: [left: number, top: number, right: number, bottom: number];
}

function pixelBytes(width: number, height: number): number {
  if (width <= 0 || height <= 0 || width * height > 67_108_864)
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
      const count = size >>> 2;
      checkRange(this.data.length, pixels, count);
      const bgra = new Uint8Array(size);
      const bgra32 = new Uint32Array(bgra.buffer);
      const pal32 = new Uint32Array(paletteSize);
      for (let c = 0; c < paletteSize; c++) {
        const o = 2 + c * 4;
        pal32[c] =
          (this.data[o]! |
            (this.data[o + 1]! << 8) |
            (this.data[o + 2]! << 16) |
            (this.data[o + 3]! << 24)) >>>
          0;
      }
      for (let i = 0; i < count; i++) {
        const color = this.data[pixels + i]!;
        if (color >= paletteSize) throw new Error('Invalid G00 palette index');
        bgra32[i] = pal32[color]!;
      }
      return {width, height, x: 0, y: 0, centerX: 0, centerY: 0, bgra};
    }
    const outer = byteDataView(this.bytes);
    const x = outer.getInt32(9 + index * 24, true);
    const y = outer.getInt32(13 + index * 24, true);
    const offset = view.getUint32(4 + index * 8, true);
    // Native 0x6de3bc checks length != 0; deduplicated Type 2 cuts store negative signed length (-N).
    const length = Math.abs(view.getInt32(8 + index * 8, true));
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
      const chipBytes = cw * ch * 4;
      checkRange(block.length, p, chipBytes);
      if (left + cw > w || top + ch > h) throw new Error('G00 chip outside cut');
      if (left === 0 && cw === w) {
        bgra.set(block.subarray(p, p + chipBytes), top * w * 4);
      } else {
        const rowBytes = cw * 4;
        const dstStride = w * 4;
        let src = p;
        let dst = (top * w + left) * 4;
        for (let row = 0; row < ch; row++) {
          bgra.set(block.subarray(src, src + rowBytes), dst);
          src += rowBytes;
          dst += dstStride;
        }
      }
      p += chipBytes;
    }
    const left = cut.getInt32(4, true);
    const top = cut.getInt32(8, true);
    const contentWidth = cut.getInt32(12, true);
    const contentHeight = cut.getInt32(16, true);
    return {
      width: w,
      height: h,
      x,
      y,
      centerX: cut.getInt32(20, true),
      centerY: cut.getInt32(24, true),
      contentBounds: [left, top, left + contentWidth, top + contentHeight],
      bgra,
    };
  }
}
