import {instantiateEmbeddedWasm} from '../core/wasm.js';
import {BGRA_EFFECTS_WASM_BINARY} from './bgra-effects-wasm-binary.js';

interface BgraEffects extends WebAssembly.Exports {
  memory: WebAssembly.Memory;
  __heap_base: WebAssembly.Global;
  present_bgrx: (
    source: number,
    destination: number,
    width: number,
    height: number,
    stride: number,
  ) => number;
  normal_blend: (
    source: number,
    destination: number,
    width: number,
    height: number,
    stride: number,
    opacity: number,
    masked: number,
  ) => void;
  transition_bgra: (
    first: number,
    second: number,
    width: number,
    height: number,
    weight: number,
    sse: number,
  ) => void;
  rule_blend: (
    source: number,
    destination: number,
    rule: number,
    weights: number,
    width: number,
    height: number,
    stride: number,
    opacity: number,
    masked: number,
  ) => void;
  table_blend: (
    source: number,
    destination: number,
    table: number,
    width: number,
    height: number,
    stride: number,
    opacity: number,
    masked: number,
    mode: number,
  ) => void;
  bilinear: (
    source: number,
    count: number,
    stride: number,
    destination: number,
    width: number,
    height: number,
    columns: number,
    xWeights: number,
    rows: number,
    yWeights: number,
    scratch: number,
    cachedRows: number,
    sse: number,
  ) => void;
}

const MIN_PIXELS = 65536;
/** A resident target needs no staging, so smaller blends already gain from the kernel. */
const RESIDENT_MIN_PIXELS = 1024;
/** Bytes of each image staged per transition band. */
const TRANSITION_BAND = 128 * 1024;
const MAX_SCRATCH = 128 * 1024 * 1024;
const page = 65536;
interface ScratchOwner {
  kernel?: BgraEffects | null;
  source?: {bytes: WeakRef<Uint8Array>; revision: number};
}
const blendMemory: ScratchOwner = {};
const scaleMemory: ScratchOwner = {};
const rowCacheMemory: ScratchOwner = {};
interface ScaleGeometry {
  bytes: WeakRef<Uint8Array>;
  revision: number;
  stride: number;
  rows: number;
  axis: readonly [number, number, number];
}
let previousScale: ScaleGeometry | undefined;
let cachedScale: ScaleGeometry | undefined;

function sameScale(
  previous: ScaleGeometry | undefined,
  bytes: Uint8Array,
  revision: number,
  stride: number,
  rows: number,
  axis: ScaleGeometry['axis'],
): boolean {
  return (
    previous?.revision === revision &&
    previous.bytes.deref() === bytes &&
    previous.stride === stride &&
    previous.rows === rows &&
    previous.axis[0] === axis[0] &&
    previous.axis[1] === axis[1] &&
    previous.axis[2] === axis[2]
  );
}

/** Synchronous operations share scratch, with no views retained across a grow. */
function workspace(owner: ScratchOwner, sizes: readonly number[]) {
  if (owner.kernel === undefined)
    owner.kernel =
      (instantiateEmbeddedWasm(BGRA_EFFECTS_WASM_BINARY)?.exports as BgraEffects | undefined) ??
      null;
  const kernel = owner.kernel;
  if (!kernel) return null;
  let end = Number(kernel.__heap_base.value);
  const offsets = sizes.map((size) => {
    const start = Math.ceil(end / 16) * 16;
    end = start + size;
    return start;
  });
  if (!Number.isSafeInteger(end) || end > MAX_SCRATCH) return null;
  const memory = kernel.memory;
  if (end > memory.buffer.byteLength) {
    try {
      memory.grow(Math.ceil((end - memory.buffer.byteLength) / page));
    } catch {
      return null;
    }
  }
  return {kernel, buffer: memory.buffer, offsets};
}

const residentTargets = new WeakMap<Uint8Array, NonNullable<ReturnType<typeof workspace>>>();

/** Give a large compositor target a fixed backing buffer and private blend scratch. */
export function allocateBgraTarget(length: number): Uint8Array | null {
  if (length < MIN_PIXELS * 4 || length > 16 * 1024 * 1024) return null;
  const stage = workspace({}, [length, length, length, 1024, length]);
  if (!stage) return null;
  const target = new Uint8Array(stage.buffer, stage.offsets[1]!, length);
  residentTargets.set(target, stage);
  return target;
}

/** View an RGBA display buffer beside its BGRA source in fixed linear memory. */
export function bgraDisplayFrame(bytes: Uint8Array, width: number, height: number) {
  const stage = residentTargets.get(bytes);
  if (!stage || width * height * 4 !== bytes.length || height > 0xffff) return null;
  const output = stage.offsets[4]!;
  return {
    pixels: new Uint8ClampedArray(stage.buffer, output, bytes.length),
    update(left: number, top: number, columns: number, rows: number): number {
      if (
        left < 0 ||
        top < 0 ||
        columns <= 0 ||
        rows <= 0 ||
        left + columns > width ||
        top + rows > height
      )
        return 0;
      const offset = (top * width + left) * 4;
      return stage.kernel.present_bgrx(
        bytes.byteOffset + offset,
        output + offset,
        columns,
        rows,
        width,
      );
    },
  };
}

export function cloneBgraTarget(bytes: Uint8Array, offset: number, length: number): Uint8Array {
  const copy = residentTargets.has(bytes) ? allocateBgraTarget(length) : null;
  if (!copy) return bytes.slice(offset, offset + length);
  copy.set(bytes.subarray(offset, offset + length));
  return copy;
}

function pack(
  target: Uint8Array,
  source: Uint8Array,
  start: number,
  stride: number,
  rowBytes: number,
): void {
  if (stride === rowBytes) target.set(source.subarray(start, start + target.length));
  else
    for (let i = 0; i < target.length; i += rowBytes, start += stride)
      target.set(source.subarray(start, start + rowBytes), i);
}

function unpack(
  target: Uint8Array,
  source: Uint8Array,
  start: number,
  stride: number,
  rowBytes: number,
): void {
  if (stride === rowBytes) target.set(source, start);
  else
    for (let i = 0; i < source.length; i += rowBytes, start += stride)
      target.set(source.subarray(i, i + rowBytes), start);
}

interface BgraRegion {
  bytes: Uint8Array;
  offset: number;
  stride: number;
}

/** Stage disjoint transition inputs, preserving the paired midpoint and odd scalar tail. */
export function transitionBgra(
  first: BgraRegion,
  second: BgraRegion,
  target: BgraRegion,
  width: number,
  height: number,
  weight: number,
  sse: boolean,
): boolean {
  if (
    width <= 0 ||
    height <= 0 ||
    width * height < MIN_PIXELS ||
    weight < 1 ||
    weight > 256 ||
    target.bytes.buffer === first.bytes.buffer ||
    target.bytes.buffer === second.bytes.buffer
  )
    return false;
  const row = width * 4;
  for (const {bytes, offset, stride} of [first, second, target])
    if (offset < 0 || offset + (height - 1) * stride + row > bytes.length) return false;
  // Pixels are independent within a row, so bands of whole rows keep the staged copies in
  // cache instead of streaming every image through linear memory twice.
  const rows = Math.min(height, Math.max(1, Math.floor(TRANSITION_BAND / row)));
  const stage = workspace(blendMemory, [row * rows, row * rows]);
  if (!stage) return false;
  const [a, b] = stage.offsets as [number, number];
  for (let top = 0; top < height; top += rows) {
    const count = Math.min(rows, height - top),
      length = row * count;
    const out = new Uint8Array(stage.buffer, a, length);
    pack(out, first.bytes, first.offset + top * first.stride, first.stride, row);
    pack(
      new Uint8Array(stage.buffer, b, length),
      second.bytes,
      second.offset + top * second.stride,
      second.stride,
      row,
    );
    stage.kernel.transition_bgra(a, b, width, count, weight, Number(sse));
    unpack(target.bytes, out, target.offset + top * target.stride, target.stride, row);
  }
  return true;
}

/** Accelerate a validated, nonaliased normal layer blend with the native fixed-point weights. */
export function blendBgra(
  source: Uint8Array,
  si: number,
  sourceWidth: number,
  target: Uint8Array,
  di: number,
  targetWidth: number,
  width: number,
  height: number,
  opacity: number,
  masked: boolean,
  rule?: {readonly pixels: Uint8Array; readonly weights: Int32Array},
): boolean {
  const pixels = width * height;
  const resident = residentTargets.get(target);
  if (pixels < (resident ? RESIDENT_MIN_PIXELS : MIN_PIXELS)) return false;
  const length = pixels * 4,
    rowBytes = width * 4;
  const stage =
    resident ?? workspace(blendMemory, rule ? [length, length, length, 1024] : [length, length]);
  if (!stage) return false;
  const [input, output, ruleInput, weights] = stage.offsets as [number, number, number, number];
  const staged = resident ? null : new Uint8Array(stage.buffer, output, length);
  const destination = resident ? output + di * 4 : output;
  const stride = resident ? targetWidth : width;
  pack(new Uint8Array(stage.buffer, input, length), source, si * 4, sourceWidth * 4, rowBytes);
  if (staged) pack(staged, target, di * 4, targetWidth * 4, rowBytes);
  if (rule) {
    pack(
      new Uint8Array(stage.buffer, ruleInput, length),
      rule.pixels,
      si * 4,
      sourceWidth * 4,
      rowBytes,
    );
    new Int32Array(stage.buffer, weights, 256).set(rule.weights);
    stage.kernel.rule_blend(
      input,
      destination,
      ruleInput,
      weights,
      width,
      height,
      stride,
      opacity,
      Number(masked),
    );
  } else
    stage.kernel.normal_blend(input, destination, width, height, stride, opacity, Number(masked));
  if (staged) unpack(target, staged, di * 4, targetWidth * 4, rowBytes);
  return true;
}

/**
 * A validated, nonaliased layer blend through a per-channel function table
 * (`table[source * 256 + destination]`, 65536 bytes) without a rule. Mode 1 below full
 * opacity is the saturated scaled sum and mode 8 truncates its alpha product toward zero.
 */
export function tableBlendBgra(
  source: Uint8Array,
  si: number,
  sourceWidth: number,
  target: Uint8Array,
  di: number,
  targetWidth: number,
  width: number,
  height: number,
  opacity: number,
  masked: boolean,
  mode: number,
  table: Uint8Array,
): boolean {
  const pixels = width * height;
  const resident = residentTargets.get(target);
  if (pixels < (resident ? RESIDENT_MIN_PIXELS : MIN_PIXELS) || table.length !== 0x10000)
    return false;
  const length = pixels * 4,
    rowBytes = width * 4;
  // A resident target's rule scratch (at least 256 KiB) holds the table.
  const stage = resident ?? workspace(blendMemory, [length, length, 0x10000]);
  if (!stage) return false;
  const [input, output, tableInput] = stage.offsets as [number, number, number];
  const staged = resident ? null : new Uint8Array(stage.buffer, output, length);
  pack(new Uint8Array(stage.buffer, input, length), source, si * 4, sourceWidth * 4, rowBytes);
  if (staged) pack(staged, target, di * 4, targetWidth * 4, rowBytes);
  new Uint8Array(stage.buffer, tableInput, 0x10000).set(table);
  stage.kernel.table_blend(
    input,
    resident ? output + di * 4 : output,
    tableInput,
    width,
    height,
    resident ? targetWidth : width,
    opacity,
    Number(masked),
    mode,
  );
  if (staged) unpack(target, staged, di * 4, targetWidth * 4, rowBytes);
  return true;
}

/** Scale only the valid output rectangle; the caller clears the native borders separately. */
export function bilinearBgra(
  source: Uint8Array,
  stride: number,
  sourceRows: number,
  target: Uint8Array,
  targetWidth: number,
  left: number,
  top: number,
  right: number,
  bottom: number,
  originX: number,
  originY: number,
  columns: Int32Array,
  weights: Uint8Array,
  rowPositions: Int32Array,
  sse: boolean,
  sourceRevision?: number,
  axis?: ScaleGeometry['axis'],
  destination?: {stride: number; x: number; y: number},
): boolean {
  const width = right - left,
    height = bottom - top;
  const outputStride = destination?.stride ?? targetWidth;
  const outputX = destination?.x ?? left;
  const outputY = destination?.y ?? top;
  if (
    width * height < MIN_PIXELS ||
    sourceRows * stride >= 0x20000000 ||
    outputX < 0 ||
    outputY < 0 ||
    outputX + width > outputStride ||
    target.length < ((outputY + height - 1) * outputStride + outputX + width) * 4
  )
    return false;
  const pairWidth = (width + 1) & ~1;
  const length = width * height * 4;
  let reuseRows = false;
  if (
    sourceRevision !== undefined &&
    axis &&
    left === 0 &&
    right === targetWidth &&
    pairWidth * (sourceRows + 1) * 8 <= 64 * 1024 * 1024
  ) {
    reuseRows = sameScale(previousScale, source, sourceRevision, stride, sourceRows, axis);
    if (!reuseRows)
      previousScale = {
        bytes: new WeakRef(source),
        revision: sourceRevision,
        stride,
        rows: sourceRows,
        axis,
      };
  }
  const owner = reuseRows ? rowCacheMemory : scaleMemory;
  const stage = workspace(owner, [
    source.length,
    pairWidth * (reuseRows ? sourceRows + 1 : 2) * 8,
    reuseRows ? sourceRows + 1 : 0,
    length,
    pairWidth * 4,
    pairWidth,
    height * 4,
    height,
  ]);
  if (!stage) return false;
  const [input, scratch, cachedRows, output, cols, xWeights, rows, yWeights] = stage.offsets as [
    number,
    number,
    number,
    number,
    number,
    number,
    number,
    number,
  ];
  // The scaler's first allocation is always at the same offset and is never
  // shared with the blend scratch. Growth preserves its contents.
  if (
    sourceRevision === undefined ||
    owner.source?.revision !== sourceRevision ||
    owner.source.bytes.deref() !== source
  ) {
    new Uint8Array(stage.buffer, input, source.length).set(source);
    owner.source =
      sourceRevision === undefined
        ? undefined
        : {bytes: new WeakRef(source), revision: sourceRevision};
  }
  if (reuseRows && cachedScale !== previousScale) {
    new Uint8Array(stage.buffer, cachedRows, sourceRows + 1).fill(0);
    cachedScale = previousScale;
  }
  const xs = new Int32Array(stage.buffer, cols, pairWidth),
    xw = new Uint8Array(stage.buffer, xWeights, pairWidth),
    ys = new Int32Array(stage.buffer, rows, height),
    yw = new Uint8Array(stage.buffer, yWeights, height);
  for (let x = 0; x < width; x++) {
    const column = columns[left + x]! + originX;
    if (column < 0 || column >= stride) return false;
    xs[x] = column;
    xw[x] = weights[left + x]!;
  }
  if (pairWidth !== width) {
    xs[width] = 0;
    xw[width] = 0;
  }
  for (let y = 0; y < height; y++) {
    const position = rowPositions[top + y]!;
    const row = (position >> 8) + originY;
    if (row < 0 || row >= sourceRows) return false;
    ys[y] = row;
    yw[y] = position & 255;
  }
  stage.kernel.bilinear(
    input,
    source.length >>> 2,
    stride,
    output,
    width,
    height,
    cols,
    xWeights,
    rows,
    yWeights,
    scratch,
    reuseRows ? cachedRows : 0,
    Number(sse),
  );
  unpack(
    target,
    new Uint8Array(stage.buffer, output, length),
    (outputY * outputStride + outputX) * 4,
    outputStride * 4,
    width * 4,
  );
  return true;
}
