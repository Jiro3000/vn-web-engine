import {instantiateEmbeddedWasm} from '../../core/wasm.js';
import {SIGLUS_NWA_WASM_BINARY} from './nwa-wasm-binary.js';

interface Kernel extends WebAssembly.Exports {
  memory: WebAssembly.Memory;
  __heap_base: WebAssembly.Global;
  siglus_nwa(
    input: number,
    offsets: number,
    blocks: number,
    output: number,
    samples: number,
    blockSamples: number,
    channels: number,
    level: number,
    runs: number,
  ): number;
}

export interface NwaBlockRange {
  readonly first: number;
  readonly last: number;
  readonly sourceOffset: number;
  readonly sourceEnd: number;
}

interface NwaBlockFormat {
  readonly channels: number;
  readonly level: number;
  readonly runs: number;
  readonly blockSamples: number;
}

const minSamples = 8192;
const blocksPerBatch = 512;
const maxScratch = 4 * 1024 * 1024;
const pageBytes = 65536;
let instance: Kernel | null | undefined;

/** Batches independent blocks to avoid both a WASM call per small block and
 * staging an entire large track in a second heap. False lets the caller use
 * the JavaScript decoder, preserving its diagnostics for malformed streams. */
export function decodeNwaWasm(
  bytes: Uint8Array,
  table: DataView,
  {first, last, sourceOffset, sourceEnd}: NwaBlockRange,
  {channels, level, runs, blockSamples}: NwaBlockFormat,
  pcm: Int16Array,
): boolean {
  if (pcm.length < minSamples) return false;
  if (instance === undefined)
    instance =
      (instantiateEmbeddedWasm(SIGLUS_NWA_WASM_BINARY, undefined, () => {})?.exports as
        Kernel | undefined) ?? null;
  if (!instance) return false;
  const memory = instance.memory;
  const offsetsAt = Number(instance.__heap_base.value);
  for (let from = first; from < last; from += blocksPerBatch) {
    const to = Math.min(last, from + blocksPerBatch);
    const blocks = to - from;
    const start = table.getUint32(from * 4, true) - sourceOffset;
    const end = (to === last ? sourceEnd : table.getUint32(to * 4, true)) - sourceOffset;
    if (start < 0 || end < start || end > bytes.length) return false;

    const destination = (from - first) * blockSamples;
    const samples = Math.min(blocks * blockSamples, pcm.length - destination);
    const outputAt = offsetsAt + (blocks + 1) * 4;
    const inputAt = outputAt + samples * 2;
    const required = inputAt + end - start;
    if (required - offsetsAt > maxScratch) return false;
    if (required > memory.buffer.byteLength) {
      try {
        memory.grow(Math.ceil((required - memory.buffer.byteLength) / pageBytes));
      } catch (error) {
        if (!(error instanceof RangeError)) throw error;
        return false;
      }
    }

    const offsets = new Uint32Array(memory.buffer, offsetsAt, blocks + 1);
    offsets[0] = 0;
    for (let i = 1; i < blocks; i++) {
      const relative = table.getUint32((from + i) * 4, true) - sourceOffset - start;
      if (relative < offsets[i - 1]! || relative > end - start) return false;
      offsets[i] = relative;
    }
    offsets[blocks] = end - start;
    new Uint8Array(memory.buffer, inputAt, end - start).set(bytes.subarray(start, end));
    if (
      !instance.siglus_nwa(
        inputAt,
        offsetsAt,
        blocks,
        outputAt,
        samples,
        blockSamples,
        channels,
        level,
        Number(Boolean(runs)),
      )
    )
      return false;
    pcm.set(new Int16Array(memory.buffer, outputAt, samples), destination);
  }
  return true;
}
