import {instantiateEmbeddedWasm} from '../core/wasm.js';
import {reportWasmVideoFallback} from '../platform/runtime-advisories.js';
import type {YuvFrame} from './frame.js';
import {I420_RGBA_WASM_BINARY} from './i420-rgba-wasm-binary.js';

interface Kernel extends WebAssembly.Exports {
  memory: WebAssembly.Memory;
  __heap_base: WebAssembly.Global;
  i420_rgba(
    out: number,
    y: number,
    cb: number,
    cr: number,
    width: number,
    height: number,
    stride: number,
    paddedHeight: number,
    bgra: number,
  ): void;
}

interface FrameStorage {
  width: number;
  height: number;
  stride: number;
  paddedHeight: number;
  y: Uint8Array;
  cb: Uint8Array;
  cr: Uint8Array;
  output: Uint8ClampedArray<ArrayBuffer>;
}

/** Retains plane and image allocations across frames of the same dimensions. */
export class I420Rgba {
  private storage?: FrameStorage;

  static create(): I420Rgba | undefined {
    const instance = instantiateEmbeddedWasm(
      I420_RGBA_WASM_BINARY,
      undefined,
      reportWasmVideoFallback,
    );
    return instance ? new I420Rgba(instance.exports as Kernel) : undefined;
  }

  private constructor(private readonly kernel: Kernel) {}

  /** The returned view is valid until the next call to convert. */
  convert(frame: YuvFrame, format: 'rgba' | 'bgra' = 'rgba'): Uint8ClampedArray<ArrayBuffer> {
    const {width, height, stride, paddedHeight} = frame;
    const old = this.storage;
    const storage =
      old?.width === width &&
      old.height === height &&
      old.stride === stride &&
      old.paddedHeight === paddedHeight
        ? old
        : this.allocate(frame);
    if (
      frame.y.length < storage.y.length ||
      frame.cb.length < storage.cb.length ||
      frame.cr.length < storage.cr.length
    )
      throw new RangeError('Truncated movie frame planes');
    storage.y.set(frame.y.subarray(0, storage.y.length));
    storage.cb.set(frame.cb.subarray(0, storage.cb.length));
    storage.cr.set(frame.cr.subarray(0, storage.cr.length));
    this.kernel.i420_rgba(
      storage.output.byteOffset,
      storage.y.byteOffset,
      storage.cb.byteOffset,
      storage.cr.byteOffset,
      width,
      height,
      stride,
      paddedHeight,
      Number(format === 'bgra'),
    );
    return storage.output;
  }

  private allocate({
    width,
    height,
    stride,
    paddedHeight,
    y: luma,
    cb: blue,
    cr: red,
  }: YuvFrame): FrameStorage {
    if (
      ![width, height, stride, paddedHeight].every(Number.isSafeInteger) ||
      width < 1 ||
      height < 1 ||
      stride < width ||
      paddedHeight < height ||
      stride % 2 !== 0 ||
      paddedHeight % 2 !== 0
    )
      throw new RangeError('Invalid planar movie dimensions');
    const lumaSize = stride * paddedHeight;
    const chromaSize = lumaSize / 4;
    if (luma.length < lumaSize || blue.length < chromaSize || red.length < chromaSize)
      throw new RangeError('Truncated movie frame planes');
    const pixels = width * height * 4;
    const start = Number(this.kernel.__heap_base.value);
    const capacity = start + lumaSize + 2 * chromaSize + pixels;
    if (!Number.isSafeInteger(capacity) || capacity > 0xffffffff)
      throw new RangeError('Movie frame exceeds WebAssembly memory');
    const memory = this.kernel.memory;
    if (capacity > memory.buffer.byteLength)
      memory.grow(Math.ceil((capacity - memory.buffer.byteLength) / 65536));
    const buffer = memory.buffer;
    const y = new Uint8Array(buffer, start, lumaSize);
    const cb = new Uint8Array(buffer, start + lumaSize, chromaSize);
    const cr = new Uint8Array(buffer, start + lumaSize + chromaSize, chromaSize);
    const output = new Uint8ClampedArray(buffer, start + lumaSize + 2 * chromaSize, pixels);
    return (this.storage = {width, height, stride, paddedHeight, y, cb, cr, output});
  }
}
