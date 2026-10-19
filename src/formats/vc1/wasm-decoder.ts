import {instantiateEmbeddedWasm} from '../../core/wasm.js';
import {reportWasmVideoFallback} from '../../platform/runtime-advisories.js';
import {
  Vc1Decoder as ReferenceDecoder,
  type Vc1Picture,
  type Vc1PixelBackend,
} from './reference.js';
import {VC1_VIDEO_WASM_BINARY} from './wasm-binary.js';

interface Kernel extends WebAssembly.Exports {
  memory: WebAssembly.Memory;
  __heap_base: WebAssembly.Global;
  vc1_tx8(block: number): void;
  vc1_tx_small(dst: number, stride: number, block: number, width: number, height: number): void;
  vc1_tx_dc(dst: number, stride: number, width: number, height: number, dc: number): void;
  vc1_pixels(block: number, dst: number, stride: number, mode: number): void;
  vc1_loop(p: number, step: number, stride: number, length: number, pq: number): void;
  vc1_mspel(
    dst: number,
    src: number,
    stride: number,
    n: number,
    h: number,
    v: number,
    rnd: number,
    avg: number,
  ): void;
  vc1_hpel(
    dst: number,
    src: number,
    stride: number,
    n: number,
    dxy: number,
    noRnd: number,
    avg: number,
  ): void;
  vc1_chroma(
    dst: number,
    src: number,
    stride: number,
    w: number,
    h: number,
    x: number,
    y: number,
    noRnd: number,
    avg: number,
  ): void;
}
const MEMORY_LIMIT = 128 * 1024 * 1024;
const align = (n: number) => (n + 15) & ~15;
class AllocationFailure extends Error {}

/** All pixel storage is reserved together, before making views. Rust and JS share the
 * same planes and coefficient ring; no copies cross the ABI for individual blocks. */
class PixelKernel implements Vc1PixelBackend {
  private readonly base: number;
  private cursor = 0;
  private end = 0;
  readonly dsp: Vc1PixelBackend['dsp'];
  constructor(private readonly kernel: Kernel) {
    this.base = align(Number(kernel.__heap_base.value));
    this.dsp = {
      invTrans8x8: (block, b) => kernel.vc1_tx8(block.byteOffset + b * 2),
      invTrans8x4: (dst, o, stride, block, b) =>
        kernel.vc1_tx_small(dst.byteOffset + o, stride, block.byteOffset + b * 2, 8, 4),
      invTrans4x8: (dst, o, stride, block, b) =>
        kernel.vc1_tx_small(dst.byteOffset + o, stride, block.byteOffset + b * 2, 4, 8),
      invTrans4x4: (dst, o, stride, block, b) =>
        kernel.vc1_tx_small(dst.byteOffset + o, stride, block.byteOffset + b * 2, 4, 4),
      invTrans8x8Dc: (dst, o, stride, dc) => kernel.vc1_tx_dc(dst.byteOffset + o, stride, 8, 8, dc),
      invTrans8x4Dc: (dst, o, stride, dc) => kernel.vc1_tx_dc(dst.byteOffset + o, stride, 8, 4, dc),
      invTrans4x8Dc: (dst, o, stride, dc) => kernel.vc1_tx_dc(dst.byteOffset + o, stride, 4, 8, dc),
      invTrans4x4Dc: (dst, o, stride, dc) => kernel.vc1_tx_dc(dst.byteOffset + o, stride, 4, 4, dc),
      putPixelsClamped: (block, b, dst, o, stride) =>
        kernel.vc1_pixels(block.byteOffset + b * 2, dst.byteOffset + o, stride, 0),
      putSignedPixelsClamped: (block, b, dst, o, stride) =>
        kernel.vc1_pixels(block.byteOffset + b * 2, dst.byteOffset + o, stride, 1),
      addPixelsClamped: (block, b, dst, o, stride) =>
        kernel.vc1_pixels(block.byteOffset + b * 2, dst.byteOffset + o, stride, 2),
      vLoopFilter: (p, o, stride, len, pq) => kernel.vc1_loop(p.byteOffset + o, 1, stride, len, pq),
      hLoopFilter: (p, o, stride, len, pq) => kernel.vc1_loop(p.byteOffset + o, stride, 1, len, pq),
      mspelMc: (dst, d, src, s, stride, n, h, v, rnd, avg) =>
        kernel.vc1_mspel(dst.byteOffset + d, src.byteOffset + s, stride, n, h, v, rnd, +avg),
      hpelMc: (dst, d, src, s, stride, n, dxy, noRnd, avg) =>
        kernel.vc1_hpel(dst.byteOffset + d, src.byteOffset + s, stride, n, dxy, +noRnd, +avg),
      chromaMc: (dst, d, src, s, stride, w, h, x, y, noRnd, avg) =>
        kernel.vc1_chroma(dst.byteOffset + d, src.byteOffset + s, stride, w, h, x, y, +noRnd, +avg),
    };
  }
  reset(bytes: number): void {
    const end = align(this.base + bytes);
    if (end > MEMORY_LIMIT) throw new AllocationFailure();
    const memory = this.kernel.memory;
    if (end > memory.buffer.byteLength) {
      try {
        memory.grow(Math.ceil((end - memory.buffer.byteLength) / 65536));
      } catch {
        throw new AllocationFailure();
      }
    }
    this.cursor = this.base;
    this.end = end;
    new Uint8Array(memory.buffer, this.base, end - this.base).fill(0);
  }
  private allocate(bytes: number): number {
    const p = this.cursor;
    const end = align(p + bytes);
    if (end > this.end) throw new AllocationFailure();
    this.cursor = end;
    return p;
  }
  u8(length: number): Uint8Array {
    return new Uint8Array(this.kernel.memory.buffer, this.allocate(length), length);
  }
  i16(length: number): Int16Array {
    return new Int16Array(this.kernel.memory.buffer, this.allocate(length * 2), length);
  }
}

/** Progressive decoder with the Rust SIMD pixel kernels. Parsing and prediction state
 * follow the JavaScript reference; coefficient and picture storage stays in Wasm memory. */
export class Vc1WasmDecoder {
  private constructor(private readonly decoder: ReferenceDecoder) {}
  static create(
    fourcc: number,
    width: number,
    height: number,
    extra: Uint8Array,
  ): Vc1WasmDecoder | null {
    const instance = instantiateEmbeddedWasm(VC1_VIDEO_WASM_BINARY, {}, reportWasmVideoFallback);
    if (!instance) return null;
    try {
      const backend = new PixelKernel(instance.exports as Kernel);
      return new Vc1WasmDecoder(new ReferenceDecoder(fourcc, width, height, extra, backend));
    } catch (error) {
      if (!(error instanceof AllocationFailure)) throw error;
      reportWasmVideoFallback();
      return null;
    }
  }
  get width(): number {
    return this.decoder.width;
  }
  get height(): number {
    return this.decoder.height;
  }
  decode(data: Uint8Array | null, time: number): Vc1Picture | null {
    return this.decoder.decode(data, time);
  }
}
