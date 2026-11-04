import type {YurisCgNode, YurisLayers} from './cg.js';
import {YurisError} from './errors.js';

/**
 * ROTATION 0x4359C8, mode 11 (0x436C14) / mode 12 (0x435DD0).
 * Native FSINCOS uses 3.1415926535 and truncating FISTP (FCW | 0xC00).
 * The workers keep their original exclusive scan endpoints and asymmetric edges.
 */
export function rotateCg(
  layers: YurisLayers,
  src: YurisCgNode,
  dst: YurisCgNode | null,
  hasDestination: boolean,
  set: number,
  mode: number,
): number {
  const source = src.payload!,
    output = hasDestination ? dst?.payload : source;
  if (!output || !source.pixels) return 0;
  const width = source.width,
    height = source.height;
  const fresh = !hasDestination || output.width * output.height !== width * height;
  if (fresh && width > 0x2000) throw new YurisError(0x186aa, [width, height], false);
  const to = fresh ? new Uint8Array(Math.max(0, width) * Math.max(0, height) * 4) : output.pixels;
  if (!to) return 0;
  if (mode === 11 || mode === 12) rotatePixels(to, source.pixels, width, height, set % 360, mode);
  if (fresh) output.replace(to, width, height);
  layers.markDirty(hasDestination ? dst : src);
  output.masked = set % 180 === 0 ? source.masked : 1;
  return 0;
}

function rotatePixels(
  to: Uint8Array,
  from: Uint8Array,
  w: number,
  h: number,
  angle: number,
  mode: number,
): void {
  if (angle === 0) {
    for (let y = 0; y < h; y++) to.set(from.subarray(y * w * 4, (y + 1) * w * 4), y * w * 4);
    return;
  }
  const copy = (out: number, input: number) => {
    if (out < 0 || out + 3 >= to.length) return;
    for (let c = 0; c < 4; c++) to[out + c] = from[input + c] ?? 0;
  };
  if (angle === 180) {
    for (let i = 0; i < w * h; i++) copy(i * 4, (w * h - i - 1) * 4);
    return;
  }
  // Negative non-axis angles run no worker body in the native implementation.
  if (angle < 0) return;
  const radians = (angle * 3.1415926535) / 180,
    cos = Math.cos(radians),
    sin = Math.sin(radians);
  const c = Math.trunc(cos * 65536),
    s = Math.trunc(sin * 65536),
    cx = Math.trunc(w / 2),
    cy = Math.trunc(h / 2);
  const left = -cx * cos + cx,
    top = -cx * sin + cy,
    right = (w - cx - 1) * cos + cx,
    rightY = (w - cx - 1) * sin + cy;
  const tlx = Math.trunc(left + cy * sin),
    tly = Math.trunc(top - cy * cos),
    trx = Math.trunc(right + cy * sin),
    try_ = Math.trunc(rightY - cy * cos);
  const blx = Math.trunc(left - (h - cy - 1) * sin),
    bly = Math.trunc(top + (h - cy - 1) * cos),
    brx = Math.trunc(right - (h - cy - 1) * sin),
    bry = Math.trunc(rightY + (h - cy - 1) * cos);
  let bx = (cx * 65536 + s * cy - c * cx) | 0,
    by = (cy * 65536 - cx * s - cy * c) | 0;
  const div = (a: number, b: number) => Math.trunc((a | 0) / b);
  for (let y = 0; y < h; y++) {
    let lo: number, hi: number;
    if (angle === 90 || angle === 270) {
      lo = cx - cy;
      hi = cx + cy;
    } else {
      const ax = angle < 90 || (angle > 180 && angle < 270) ? tlx : trx;
      const ay = (angle < 90 || (angle > 180 && angle < 270) ? tly : try_) + y;
      const zx = angle < 90 || (angle > 180 && angle < 270) ? brx : blx;
      const zy = (angle < 90 || (angle > 180 && angle < 270) ? bry : bly) + y;
      const swap = angle > 180;
      const da = swap ? div((h - ay) * c, s) : div((h - ay) * -s, c);
      const ea = swap ? div((h - ay) * -s, c) : div((h - ay) * c, s);
      const dz = swap ? div((h - zy) * c, s) : div((h - zy) * -s, c);
      const ez = swap ? div((h - zy) * -s, c) : div((h - zy) * c, s);
      lo = Math.max(ax + (mode === 11 ? 2 : 1) + da, zx + (mode === 11 ? 2 : 1) + ez);
      hi = Math.min(ax + (mode === 11 ? 1 : 0) + ea, zx + (mode === 11 ? 1 : 0) + dz);
    }
    lo = Math.max(0, lo);
    hi = Math.min(w - 1, hi);
    const row = y * w * 4;
    // Mode 12 only clears the axis-angle margins; other rows retain existing bytes.
    const clear = mode === 11 || angle === 90 || angle === 270;
    if (clear) to.fill(0, Math.min(to.length, row), Math.max(0, Math.min(to.length, row + lo * 4)));
    let fx = (c * lo + bx) | 0,
      fy = (s * lo + by) | 0;
    let x = lo;
    for (; x < hi; x++) {
      const ix = mode === 11 || angle === 90 || angle === 270 ? fx >> 16 : Math.trunc(fx / 65536),
        iy = mode === 11 || angle === 90 || angle === 270 ? fy >> 16 : Math.trunc(fy / 65536);
      if (mode === 12 || (ix >= 0 && ix < w && iy >= 0 && iy < h))
        copy(row + x * 4, (iy * w + ix) * 4);
      fx = (fx + c) | 0;
      fy = (fy + s) | 0;
    }
    if (clear) {
      const at = row + x * 4,
        bytes = (w - hi) * 4;
      if (bytes > 0 && at < to.length) to.fill(0, Math.max(0, at), Math.min(to.length, at + bytes));
    }
    bx = (bx - s) | 0;
    by = (by + c) | 0;
  }
}
