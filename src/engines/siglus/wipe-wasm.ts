import {instantiateEmbeddedWasm} from '../../core/wasm.js';
import {SIGLUS_WIPE_WASM_BINARY} from './wipe-wasm-binary.js';

interface Kernel extends WebAssembly.Exports {
  memory: WebAssembly.Memory;
  __heap_base: WebAssembly.Global;
  siglus_fan_wipe(
    output: number,
    width: number,
    height: number,
    triangles: number,
    count: number,
  ): void;
}

type Point = readonly [number, number];
const maxTriangles = 4 * 63;
const wordsPerTriangle = 7;
const triangleBytes = maxTriangles * wordsPerTriangle * Int32Array.BYTES_PER_ELEMENT;
const maxPixels = 16 * 1024 * 1024;
const pageBytes = 65536;
let instance: Kernel | null | undefined;

/** Procedural tile masks stay in JavaScript. Full-screen fans amortize the
 * call and output copy over hundreds of triangles and scanlines. */
export function createFanWipeRaster(
  width: number,
  height: number,
  mask: Uint8Array,
):
  | {triangle(origin: Point, first: Point, second: Point, level: number): void; finish(): void}
  | undefined {
  if (
    mask.length < 256 * 1024 ||
    mask.length > maxPixels ||
    mask.length !== width * height ||
    !Number.isInteger(width) ||
    !Number.isInteger(height) ||
    width <= 0 ||
    height <= 0
  )
    return;
  if (instance === undefined)
    instance =
      (instantiateEmbeddedWasm(SIGLUS_WIPE_WASM_BINARY)?.exports as Kernel | undefined) ?? null;
  const kernel = instance;
  if (!kernel) return;
  const inputAt = Number(kernel.__heap_base.value);
  const outputAt = inputAt + triangleBytes;
  const required = outputAt + mask.length;
  const memory = kernel.memory;
  if (required > memory.buffer.byteLength) {
    try {
      memory.grow(Math.ceil((required - memory.buffer.byteLength) / pageBytes));
    } catch (error) {
      if (!(error instanceof RangeError)) throw error;
      return;
    }
  }
  const triangles = new Int32Array(memory.buffer, inputAt, maxTriangles * wordsPerTriangle);
  let index = 0;
  return {
    triangle([ax, ay], [bx, by], [cx, cy], level) {
      triangles[index++] = ax;
      triangles[index++] = ay;
      triangles[index++] = bx;
      triangles[index++] = by;
      triangles[index++] = cx;
      triangles[index++] = cy;
      triangles[index++] = level;
    },
    finish() {
      kernel.siglus_fan_wipe(outputAt, width, height, inputAt, index / wordsPerTriangle);
      mask.set(new Uint8Array(memory.buffer, outputAt, mask.length));
    },
  };
}
