import {instantiateEmbeddedWasm} from '../../core/wasm.js';
import {SIGLUS_LZ_WASM_BINARY} from './lz-wasm-binary.js';

interface Kernel extends WebAssembly.Exports {
  memory: WebAssembly.Memory;
  __heap_base: WebAssembly.Global;
  siglus_lz(input: number, length: number, output: number, size: number, pixelMode: number): number;
}

const minOutput = 64 * 1024;
const maxReusableBytes = 32 * 1024 * 1024;
const page = 65536;
const errors = [
  '',
  'Truncated Siglus LZSS stream',
  'Truncated Siglus LZSS literal',
  'Truncated Siglus LZSS reference',
  'Invalid Siglus LZSS reference',
];
let reusable: Kernel | null | undefined;

function create(): Kernel | null {
  return (instantiateEmbeddedWasm(SIGLUS_LZ_WASM_BINARY)?.exports as Kernel | undefined) ?? null;
}

/** Uses reusable scratch space for ordinary resources and an ephemeral instance for large atlases. */
export function unpackSiglusLzWasm(
  payload: Uint8Array,
  size: number,
  pixelMode: boolean,
): Uint8Array<ArrayBuffer> | undefined {
  if (size < minOutput) return;
  const kernel =
    payload.length + size <= maxReusableBytes
      ? reusable === undefined
        ? (reusable = create())
        : reusable
      : create();
  if (!kernel) return;
  const input = Number(kernel.__heap_base.value);
  const output = input + payload.length;
  const end = output + size;
  const memory = kernel.memory;
  if (end > memory.buffer.byteLength) {
    try {
      memory.grow(Math.ceil((end - memory.buffer.byteLength) / page));
    } catch (error) {
      if (!(error instanceof RangeError)) throw error;
      return;
    }
  }
  const buffer = new Uint8Array(memory.buffer);
  buffer.set(payload, input);
  const status = kernel.siglus_lz(input, payload.length, output, size, Number(pixelMode));
  if (status) throw new Error(errors[status] ?? 'Invalid Siglus LZSS stream');
  return buffer.slice(output, end);
}
