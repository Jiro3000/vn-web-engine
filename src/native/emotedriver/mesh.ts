import {createEmoteMeshKernel, bernsteinTableX64} from './runtime/mesh/index.js';
import type {EmoteX64MeshKernel} from './runtime/interfaces.js';
import {EMOTEDRIVER_X64_SHA256} from './build.js';
import {
  lerp as sharedLerp,
  lerpAngle as sharedAngle,
  lerpColor as sharedColor,
  lerpPatch,
} from './runtime/clip/interpolate.js';
/**
 * Bezier-patch and interpolation helpers of the E-mote 3.9.8 clip (`emotedriver.dll` x64,
 * SHA-256 `80d28bd0…1e051`). A patch is 16 control points stored as 32 floats (x, y pairs,
 * index = row·4 + column); patch space is the unit square of the layer's source rectangle.
 */

const f32 = Math.fround;

/** `DAT_181fcd510`: the clip's epsilon for interpolation weights. */
export const FLT_EPSILON = f32(2 ** -23);

/** `DAT_181fe39f8` (initialized at 0x18002d460): the identity patch, x = column/3, y = row/3. */
export const DEFAULT_MESH: Float32Array = (() => {
  const m = new Float32Array(32);
  for (let i = 0; i < 16; i++) {
    m[i * 2] = (i & 3) / 3;
    m[i * 2 + 1] = (i >> 2) / 3;
  }
  return m;
})();

let kernel: EmoteX64MeshKernel | undefined;
function meshKernel(): EmoteX64MeshKernel {
  return (kernel ??= createEmoteMeshKernel({driverSha256: EMOTEDRIVER_X64_SHA256}));
}
const basisCache = new Map<number, Float32Array>();

/** 0x18002df10: cached compatibility view of the shared x64 Bernstein table. */
export function bezierBasis(n: number): Float32Array {
  let table = basisCache.get(n);
  if (table) return table;
  table = bernsteinTableX64(n);
  if (n <= 1024) {
    if (basisCache.size === 64) basisCache.delete(basisCache.keys().next().value!);
    basisCache.set(n, table);
  }
  return table;
}

/** 0x180058320: in-place patch mapping through the shared mesh kernel. */
export function bezierMap(points: Float32Array, count: number, cp: Float32Array, offset = 0): void {
  meshKernel().mapPatchPoints(points, count, cp, offset);
}

/** 0x180058320 for one point. */
export function bezierPoint(cp: Float32Array, u: number, v: number): [number, number] {
  const p = new Float32Array([u, v]);
  bezierMap(p, 1, cp);
  return [p[0]!, p[1]!];
}

/** 0x180058130: p = M·(p + off) for `count` points in place; M is row-major [a, b, c, d]. */
export function affineMap(
  points: Float32Array,
  count: number,
  m: ArrayLike<number>,
  ox: number,
  oy: number,
): void {
  meshKernel().affinePoints(points, count, m, ox, oy);
}

/**
 * 0x1800586f0: tessellates the patch `cp` mapped by the affine `ms` [a, b, c, d] plus
 * (tx, ty) into a (rows + 1)·(cols + 1) grid, rows outer.
 */
export function tessellate(
  cp: Float32Array,
  cols: number,
  rows: number,
  ms: ArrayLike<number>,
  tx: number,
  ty: number,
): Float32Array {
  const out = new Float32Array((rows + 1) * (cols + 1) * 2);
  meshKernel().evaluateTransformedPatch(cp, cols, rows, ms, tx, ty, out);
  return out;
}

/** 0x180030130: scalar lerp, only when the ends differ. */
export function lerpScalar(a: number, b: number, e: number): number {
  return sharedLerp(null, a, b, e, EMOTEDRIVER_X64_SHA256);
}

/** 0x180030190: angle lerp in degrees along the short way, wrapped to [0, 360). */
export function lerpAngle(a: number, b: number, e: number): number {
  return sharedAngle(null, a, b, e, EMOTEDRIVER_X64_SHA256);
}

/** 0x180030260: per-channel colour lerp with an 8-bit weight. */
export function lerpColor(a: number, b: number, e: number): number {
  return sharedColor(null, a, b, e, EMOTEDRIVER_X64_SHA256);
}

/**
 * 0x180030810: colour modulation. 0x808080ff is neutral; colour channels (bytes 1–3)
 * multiply as x·y/128 clamped to 255, alpha (byte 0) as x·y/255.
 */
export {modulateColor} from './runtime/render/color.js';

/** 0x180030670: patch lerp; below epsilon the first patch is copied. */
export function lerpMesh(a: Float32Array, b: Float32Array, e: number): Float32Array {
  const out = new Float32Array(32);
  lerpPatch(null, a, b, e, out, EMOTEDRIVER_X64_SHA256);
  return out;
}
