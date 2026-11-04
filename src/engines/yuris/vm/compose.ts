import {type BlendRule, blendRect, colourShift, ruleWeights, saturation} from './blend.js';
import type {YurisCg, YurisCgNode} from './cg.js';
import {YurisError} from './errors.js';

/** An inclusive rectangle x0, y0, x1, y1 in a layer set's buffer. */
export type Rect = [number, number, number, number];

/** The widest buffer the filters allocate (0x405601); wider layers fail with 0x186AA. */
const FILTER_WIDTH = 0x2000;

/** The environment of a composition: the filter frame stamp and the TID lookup. */
export interface ComposeHost {
  /** 0x871F48: the frame counter that stamps filtered copies. */
  readonly frame: bigint;
  /** 0x4573E8 against names[0], then the leaf lookup 0x40CA7D; null when not found. */
  ruleLayer(tid: string): YurisCgNode | null;
}

/**
 * 0x406560: the part of a `width` x `height` rectangle at (x, y) inside `clip`, as the source
 * offset, the destination position and the size.
 */
function intersect(
  x: number,
  y: number,
  width: number,
  height: number,
  clip: Rect,
): {sx: number; sy: number; dx: number; dy: number; width: number; height: number} {
  const cw = clip[2] - clip[0] + 1,
    ch = clip[3] - clip[1] + 1;
  const axis = (p: number, size: number, c: number, cs: number) => {
    const before = p < c,
      after = p + size > c + cs;
    if (before && after) return {s: c - p, d: c, n: cs};
    if (before) return {s: c - p, d: c, n: p + size - c};
    if (after) return {s: 0, d: p, n: c + cs - p};
    return {s: 0, d: p, n: size};
  };
  const h = axis(x, width, clip[0], cw),
    v = axis(y, height, clip[1], ch);
  return {sx: h.s, sy: v.s, dx: h.d, dy: v.d, width: h.n, height: v.n};
}

/**
 * The software compositor 0x404A51 on its CPU path (window -1, as CGACT and CG SX/SY call it
 * through 0x425DF4). A layer set marked for recomposition (+0x50) redraws the part of its
 * clip rectangle (+0x30) inside `clip`: the children are blended in Z order, starting at the
 * topmost plain opaque child that covers the whole area, or after clearing the area to
 * transparent black when none does. Child layer sets are recomposed first and then blended
 * like layers. `ox`, `oy` accumulate the child set positions passed down to the nested calls.
 *
 * Returns -1 when a TID cannot be resolved or a filter buffer cannot be allocated.
 */
export function compose(host: ComposeHost, node: YurisCgNode, ox: number, oy: number, clip: Rect): number {
  const group = node.payload;
  if (!group?.pixels) return 0;
  // +0xA8 is 1 - ECX; both calls pass ECX = 1.
  group.masked = 0;
  if (!group.dirty) return 0;
  const c = group.clip;
  if (c[0]! < clip[0]) c[0] = clip[0];
  if (c[1]! < clip[1]) c[1] = clip[1];
  if (c[2]! > clip[2]) c[2] = clip[2];
  if (c[3]! > clip[3]) c[3] = clip[3];
  const area: Rect = [c[0]!, c[1]!, c[2]!, c[3]!];
  const children = node.children;
  let start = children.length - 1;
  for (; start >= 0; start--) {
    const child = children[start]!.payload!;
    if (child.e !== 1 || child.mode !== 0 || child.a !== 0x100 || child.masked !== 0) continue;
    if (child.tid && child.t !== 0x100) continue;
    const x = Number(child.x),
      y = Number(child.y);
    if (x <= area[0] && y <= area[1] && x + child.width - 1 >= area[2] && y + child.height - 1 >= area[3]) break;
  }
  if (start < 0) {
    start = 0;
    for (let y = area[1]; y <= area[3]; y++) {
      const at = (y * group.width + area[0]) * 4;
      group.pixels.fill(0, at, at + (area[2] - area[0] + 1) * 4);
    }
  }
  for (let i = start; i < children.length; i++) {
    const childNode = children[i]!,
      child = childNode.payload!;
    if (childNode.group) {
      const x = Number(child.x) + ox,
        y = Number(child.y) + oy;
      const part = intersect(x, y, child.width, child.height, area);
      const result = compose(host, childNode, x, y, [
        part.sx,
        part.sy,
        part.sx + part.width - 1,
        part.sy + part.height - 1,
      ]);
      if (result < 0) return result;
    }
    if (child.e === 0 || child.a === 0) continue;
    if (child.tid && child.t === 0) continue;
    if (child.tex !== 0) continue;
    const x = Number(child.x),
      y = Number(child.y);
    if (x > area[2] || y > area[3] || x + child.width <= area[0] || y + child.height <= area[1]) continue;
    const part = intersect(x, y, child.width, child.height, area);
    if (part.width < 1 || part.height < 1) continue;
    let rule: YurisCg | null = null,
      ruleNode: YurisCgNode | null = null;
    if (child.tid) {
      ruleNode = host.ruleLayer(child.tid);
      rule = ruleNode?.payload ?? null;
    }
    if (!child.pixels) continue;
    if (child.md !== 0x808080 && filter(host, child, (to, from) =>
      colourShift(to, child.width, from, child.width, 0, 0, child.width - 1, child.height - 1, child.md),
    ) < 0)
      return -1;
    if (child.sd !== 0x80 && filter(host, child, (to, from) =>
      saturation(to, child.width, from, child.width, 0, 0, child.width - 1, child.height - 1, child.sd),
    ) < 0)
      return -1;
    let blendRule: BlendRule | null = null;
    if (rule && child.t <= 0xff) {
      if (child.width !== rule.width || child.height !== rule.height)
        throw new YurisError(0x187d6, [childNode.name, child.width, child.height, ruleNode!.name, rule.width, rule.height]);
      blendRule = {pixels: rule.pixels!, weights: ruleWeights(child.t, child.ta, child.a)};
    }
    blendRect(
      group.pixels,
      group.width,
      part.dx,
      part.dy,
      {pixels: child.pixels, width: child.width, mode: child.mode, a: child.a, masked: child.masked === 1},
      part.sx,
      part.sy,
      part.width,
      part.height,
      blendRule,
    );
  }
  return 0;
}

/**
 * An MD or SD filter pass (0x4055C8..0x405DB7). The first pass of a frame filters the loaded
 * pixels (+0xD0) into the layer's copy (+0xE0); a later pass in the same frame filters that
 * copy again. The layer's pixels (+0xC0) then point at the copy.
 */
function filter(host: ComposeHost, cg: YurisCg, apply: (to: Uint8Array, from: Uint8Array) => void): number {
  if (cg.width > FILTER_WIDTH) throw new YurisError(0x186aa, [cg.width, cg.height]);
  const size = cg.width * cg.height * 4;
  const copy = new Uint8Array(size);
  const from = cg.filterFrame === host.frame ? (cg.filtered ?? cg.source) : cg.source;
  if (!from) return -1;
  apply(copy, from);
  cg.filtered = copy;
  cg.pixels = copy;
  cg.filterFrame = host.frame;
  return 0;
}
