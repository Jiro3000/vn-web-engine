import {instantiateEmbeddedWasm} from '../../core/wasm.js';
import {reportWasmVideoFallback} from '../../platform/runtime-advisories.js';
import type {TheoraPlane} from './decoder.js';
import type {TheoraPixelFormat, TheoraSetup} from './headers.js';
import {THEORA_RECON_WASM_BINARY} from './wasm-binary.js';

interface Kernel extends WebAssembly.Exports {
  memory: WebAssembly.Memory;
  __heap_base: WebAssembly.Global;
  theora_tokens(
    packet: number,
    bytes: number,
    position: number,
    tables: number,
    lists: number,
    luma: number,
    cb: number,
    cr: number,
    coefficients: number,
    counts: number,
  ): number;
  theora_reconstruct(
    output: number,
    previous: number,
    golden: number,
    width: number,
    height: number,
    firstFragment: number,
    divisors: number,
    flags: number,
    quantizers: number,
    qis: number,
    filterLimit: number,
  ): void;
  theora_rgba(
    output: number,
    first: number,
    second: number,
    third: number,
    stride: number,
    x: number,
    bottom: number,
    width: number,
    height: number,
    mode: number,
  ): void;
}

const quantum = 64 * 64;
const quantizerBytes = 3 * 2 * quantum * Uint16Array.BYTES_PER_ELEMENT;
const prefixEntries = 256;
const tableEntries = prefixEntries + 62;
const align = (n: number) => Math.ceil(n / 16) * 16;

/** The entropy decoder and SIMD reconstruction share frame planes and coefficients. */
export class TheoraReconstruction {
  readonly coded: Uint8Array;
  readonly mode: Uint8Array;
  readonly motionX: Int8Array;
  readonly motionY: Int8Array;
  readonly qiIndex: Uint8Array;
  readonly coefficients: Int16Array;
  readonly count: Uint8Array;
  readonly dc: Int16Array;
  private readonly buffer: ArrayBuffer;
  private readonly flags: number;
  private readonly quantizers: number;
  private readonly tables: Int16Array;
  private readonly packet: Uint8Array;
  private readonly fragments: Int32Array;
  private readonly rgbaBuffer?: Uint8ClampedArray<ArrayBuffer>;
  private cursor: number;

  static create(
    fragments: number,
    setup: TheoraSetup,
    rgbaCapacity: number,
    prefixes: readonly Int16Array[] = [],
  ): TheoraReconstruction | undefined {
    const instance = instantiateEmbeddedWasm(
      THEORA_RECON_WASM_BINARY,
      undefined,
      reportWasmVideoFallback,
    );
    if (!instance) return;
    try {
      return new TheoraReconstruction(
        instance.exports as Kernel,
        fragments,
        setup,
        prefixes,
        rgbaCapacity,
      );
    } catch (error) {
      if (!(error instanceof RangeError)) throw error;
      reportWasmVideoFallback();
      return;
    }
  }

  private constructor(
    private readonly kernel: Kernel,
    fragments: number,
    setup: TheoraSetup,
    prefixes: readonly Int16Array[],
    rgbaCapacity: number,
  ) {
    this.cursor = align(Number(kernel.__heap_base.value));
    const tableBytes = prefixes.length * tableEntries * Int16Array.BYTES_PER_ELEMENT;
    // Larger packets use the JavaScript reader. Keep existing typed arrays
    // live by allocating the packet scratch space before decoding begins.
    const packetBytes = Math.max(65536, fragments * 16) + 3;
    const fragmentBytes = fragments * Int32Array.BYTES_PER_ELEMENT;
    // Three 8x8 reference buffers, 64 i16 coefficients, and eight metadata bytes per fragment.
    const end =
      this.cursor +
      fragments * (3 * 64 + 2 * 64 + 8) +
      quantizerBytes +
      rgbaCapacity +
      tableBytes +
      packetBytes +
      fragmentBytes +
      512;
    const memory = kernel.memory;
    if (end > memory.buffer.byteLength)
      memory.grow(Math.ceil((end - memory.buffer.byteLength) / 65536));
    this.buffer = memory.buffer;
    this.coded = this.bytes(fragments);
    this.mode = this.bytes(fragments);
    this.motionX = new Int8Array(this.buffer, this.reserve(fragments), fragments);
    this.motionY = new Int8Array(this.buffer, this.reserve(fragments), fragments);
    this.qiIndex = this.bytes(fragments);
    this.coefficients = new Int16Array(this.buffer, this.reserve(fragments * 128), fragments * 64);
    this.count = this.bytes(fragments);
    this.dc = new Int16Array(this.buffer, this.reserve(fragments * 2), fragments);
    this.flags = this.reserve(8 * Uint32Array.BYTES_PER_ELEMENT);
    new Uint32Array(this.buffer, this.flags, 8).set([
      this.coded.byteOffset,
      this.mode.byteOffset,
      this.motionX.byteOffset,
      this.motionY.byteOffset,
      this.qiIndex.byteOffset,
      this.coefficients.byteOffset,
      this.count.byteOffset,
      this.dc.byteOffset,
    ]);
    this.quantizers = this.reserve(quantizerBytes);
    this.tables = new Int16Array(
      this.buffer,
      this.reserve(tableBytes),
      prefixes.length * tableEntries,
    );
    for (const [index, prefix] of prefixes.entries()) {
      this.tables.set(prefix, index * tableEntries);
      this.tables.set(setup.huffman[index]!, index * tableEntries + prefixEntries);
    }
    this.packet = this.bytes(packetBytes);
    this.fragments = new Int32Array(this.buffer, this.reserve(fragmentBytes), fragments);
    const matrices = new Uint16Array(this.buffer, this.quantizers, quantizerBytes / 2);
    for (let plane = 0; plane < 3; plane++)
      for (let type = 0; type < 2; type++)
        for (let qi = 0; qi < 64; qi++)
          matrices.set(
            setup.quantizers[type]![plane]![qi]!,
            (plane * 2 + type) * quantum + qi * 64,
          );
    if (rgbaCapacity)
      this.rgbaBuffer = new Uint8ClampedArray(
        this.buffer,
        this.reserve(rgbaCapacity),
        rgbaCapacity,
      );
  }

  private reserve(bytes: number): number {
    const start = this.cursor;
    this.cursor = align(start + bytes);
    return start;
  }

  bytes(length: number): Uint8Array {
    return new Uint8Array(this.buffer, this.reserve(length), length);
  }

  decodeTokens(packet: Uint8Array, position: number, lists: readonly Int32Array[]): boolean {
    const bytes = packet.length;
    if (!this.tables.length || bytes + 3 > this.packet.length) return false;
    this.packet.set(packet);
    this.packet.fill(0, bytes, bytes + 3);
    const [luma, cb, cr] = lists;
    this.fragments.set(luma!);
    this.fragments.set(cb!, luma!.length);
    this.fragments.set(cr!, luma!.length + cb!.length);
    if (
      !this.kernel.theora_tokens(
        this.packet.byteOffset,
        bytes,
        position,
        this.tables.byteOffset,
        this.fragments.byteOffset,
        luma!.length,
        cb!.length,
        cr!.length,
        this.coefficients.byteOffset,
        this.count.byteOffset,
      )
    )
      throw Error('Invalid Theora DCT token run');
    return true;
  }

  rgba(
    [first, second, third]: readonly TheoraPlane[],
    mode: number,
    width: number,
    height: number,
    x: number,
    bottom: number,
  ): Uint8ClampedArray<ArrayBuffer> | undefined {
    const output = this.rgbaBuffer;
    const length = width * height * 4;
    if (!output || output.length < length) return;
    this.kernel.theora_rgba(
      output.byteOffset,
      first!.data.byteOffset,
      second!.data.byteOffset,
      third!.data.byteOffset,
      first!.width,
      x,
      bottom,
      width,
      height,
      mode,
    );
    // Each caller owns its frame, including when the worker transfers it.
    return output.slice(0, length);
  }

  reconstruct(
    target: readonly TheoraPlane[],
    previous: readonly TheoraPlane[] | null,
    golden: readonly TheoraPlane[] | null,
    pixelFormat: TheoraPixelFormat,
    qis: readonly number[],
    filterLimit: number,
  ): void {
    const packedQis = qis[0]! | ((qis[1] ?? 0) << 6) | ((qis[2] ?? 0) << 12);
    let fragment = 0;
    for (const [plane, output] of target.entries()) {
      const xDivisor = plane > 0 && !(pixelFormat & 1) ? 4 : 2;
      const yDivisor = plane > 0 && !(pixelFormat & 2) ? 4 : 2;
      this.kernel.theora_reconstruct(
        output.data.byteOffset,
        previous?.[plane]?.data.byteOffset ?? 0,
        golden?.[plane]?.data.byteOffset ?? 0,
        output.width,
        output.height,
        fragment,
        xDivisor | (yDivisor << 8),
        this.flags,
        this.quantizers + plane * 2 * quantum * Uint16Array.BYTES_PER_ELEMENT,
        packedQis,
        filterLimit,
      );
      fragment += output.data.length / 64;
    }
  }
}
