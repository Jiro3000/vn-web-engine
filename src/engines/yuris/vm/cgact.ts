import {colourShift, saturation} from './blend.js';
import {type YurisCgNode, YurisCg, type YurisLayers} from './cg.js';
import {YurisError} from './errors.js';
import type {YurisMachine} from './machine.js';
import {sizeBicubic, sizeBilinear, sizeLanczos, sizeNearest, sizeSupersampled} from './resize.js';

/** CGACT argument ids (`ysc.ybn`). */
const enum Act {
  Id,
  Id2,
  Id3,
  Id4,
  IdNo,
  IdNo2,
  IdNo3,
  IdNo4,
  Z2,
  Set,
  Set2,
  SetStr,
  X,
  Y,
  X2,
  Y2,
  Sx,
  Sy,
  Fx,
  Fy,
  Fx2,
  Fy2,
  Fsx,
  Fsy,
  Size,
  Size2,
  Size3,
  Size4,
  Size5,
  Rotation,
  Rotation2,
  Saido,
  Meido,
  Sepia,
  Merge,
  Merge2,
  Transition,
  Transition2,
  Xor,
  And,
  Trim,
  Resize,
  Akarusa,
  Mono,
  Vertical,
  Horizontal,
  Mosaic,
  Blur,
  Blur2,
  Blur3,
  Blur4,
  Blur5,
  Blur6,
  Diffusion,
  Raster,
  Raster2,
  Raster3,
  Reverse,
  RectPaint,
  RectPaint2,
  RectPaint3,
  Gradation,
  Whirlpool,
  Bno,
  Text,
  Copy,
  Copy2,
  Swap,
  Swap2,
  TexCopy,
  TexSsCopy,
}

/** The operation codes of the region worker 0x42C21D (its AL argument). */
const enum Op {
  Akarusa = 0x01,
  Copy = 0x08,
  Copy2 = 0x09,
  Meido = 0x0c,
  Mono = 0x13,
  RectPaint = 0x18,
  Gradation = 0x1b,
  Reverse = 0x1c,
  Saido = 0x1e,
}

/** Operations that keep coordinates outside the source (no clamping of X..Y2 and FX..FY2). */
const UNCLAMPED = [
  Act.Resize,
  Act.Merge,
  Act.Merge2,
  Act.Transition,
  Act.Transition2,
  Act.Xor,
  Act.And,
  Act.Size,
  Act.Size2,
  Act.Size3,
  Act.Size4,
  Act.Size5,
];

/** The widest region buffer 0x42C21D allocates; wider regions fail with 0x186AA. */
const REGION_WIDTH = 0x2000;

/** The low dword of a 64-bit argument, as the native 32-bit locals hold it. */
const low = (value: bigint): number => Number(BigInt.asIntN(32, value));

/** The region and values every CGACT operation receives. */
interface ActParams {
  x: number;
  y: number;
  x2: number;
  y2: number;
  set: number;
  set2: number;
}

/**
 * CGACT 0x426078: an image operation on the layer ID, writing into ID2 when it is given.
 *
 * A layer set given as ID is composed first (0x425DF4), so operations read what it shows.
 * ID2..ID4 name layers; a missing one is created at the root with Z 1 and an empty object.
 * The region X..Y2 defaults to the whole source texture and is clamped to it, except for the
 * operations in UNCLAMPED. The first operation present, in the native test order, runs; BNO
 * selects the text buffer (0x5B8664) for TEXT and falls through to the remaining tests.
 */
export function cgAct(layers: YurisLayers, m: YurisMachine): number {
  const a = m.args;
  m.decode();
  const target = layers.target(Act.Id, Act.IdNo);
  const node = layers.lookup(target.path, target.group);
  const cg = node?.payload;
  if (!node || !cg) return 0;
  if (target.group) {
    cg.uploadAll = true;
    cg.dirty = true;
    cg.clip[0] = cg.clip[1] = 0;
    cg.clip[2] = cg.width - 1;
    cg.clip[3] = cg.height - 1;
    if (layers.composeSet(node) < 0) return -1;
  }
  // BL: the highest of ID2..ID4 given; [ESP+0x7C] holds the ID2 node.
  let extra = 0;
  const others: (YurisCgNode | null)[] = [null, null, null];
  for (let k = 1; k <= 3; k++) {
    if (!a.has(Act.Id + k)) continue;
    extra = k;
    const other = layers.target(Act.Id + k, Act.IdNo + k);
    if (other.group) throw new YurisError(0x18bab, [layers.commandName(), other.path]);
    let otherNode = layers.lookup(other.path, false);
    if (!otherNode) otherNode = layers.tree.create(other.path, false, 1n, new YurisCg());
    layers.markDirty(otherNode);
    others[k - 1] = otherNode;
  }
  const destination = others[0]!;
  const expression = (id: number): number => {
    const slot = a.has(id);
    return slot ? low(m.expression.intOf(a.type[slot]!, a.expression[slot]!)) : 0;
  };
  const set = expression(Act.Set),
    set2 = expression(Act.Set2);
  const tw = cg.textureWidth,
    th = cg.textureHeight;
  const clamped = !UNCLAMPED.some((id) => a.has(id));
  const coordinate = (id: number, fallback: number, max: number): number => {
    if (!a.has(id)) return fallback;
    const v = low(a.int(id));
    return clamped ? Math.min(Math.max(v, 0), max) : v;
  };
  const x = coordinate(Act.X, 0, tw - 1),
    y = coordinate(Act.Y, 0, th - 1),
    x2 = coordinate(Act.X2, tw - 1, tw - 1),
    y2 = coordinate(Act.Y2, th - 1, th - 1);
  const p: ActParams = {x, y, x2, y2, set, set2};
  // 0x4268DC..0x426D37: FX..FY2 default to X..Y2 in hundredths and are clamped like them;
  // FSX and FSY default to SX and SY (0 when absent) in hundredths.
  const fine = (id: number, fallback: number, max: number): number => {
    if (!a.has(id)) return fallback;
    const v = low(a.int(id));
    return clamped ? Math.min(Math.max(v, 0), max) : v;
  };
  const sx = a.has(Act.Sx) ? low(a.int(Act.Sx)) : 0,
    sy = a.has(Act.Sy) ? low(a.int(Act.Sy)) : 0;
  const fp: FineParams = {
    fx: fine(Act.Fx, Math.imul(x, 100), Math.imul(tw - 1, 100)),
    fy: fine(Act.Fy, Math.imul(y, 100), Math.imul(th - 1, 100)),
    fx2: fine(Act.Fx2, Math.imul(x2, 100), Math.imul(tw - 1, 100)),
    fy2: fine(Act.Fy2, Math.imul(y2, 100), Math.imul(th - 1, 100)),
    fsx: a.has(Act.Fsx) ? low(a.int(Act.Fsx)) : Math.imul(sx, 100),
    fsy: a.has(Act.Fsy) ? low(a.int(Act.Fsy)) : Math.imul(sy, 100),
  };
  // 0x426DB6: the output size must be 1..0x2000 pixels; the message names SX and SY.
  const size = (id: Act, base: number) => {
    for (const [value, arg, given] of [
      [fp.fsx, Act.Sx, sx],
      [fp.fsy, Act.Sy, sy],
    ] as const)
      if ((Math.trunc(value / 100) - 1) >>> 0 > 0x1fff)
        throw new YurisError(0x18a88, [layers.commandName(), m.argName(arg), given, 1, 0x2000]);
    const mode = id === Act.Size ? base : (low(a.int(id)) + base) & 0xff;
    return resize(layers, node, destination, extra !== 0, fp, mode, m.system.simd);
  };
  const region = (op: Op, mode: number): number =>
    regionOp(layers, op, destination, node, p, extra !== 0, mode);
  const masksDestination = (id: number) => {
    if (a.int(id) >= 2n && destination?.payload) destination.payload.masked = 1;
  };

  const copy = (id: Act, op: Op) => {
    if (!extra) throw new YurisError(0x18bb0, [layers.commandName(), m.argName(id)]);
    return region(op, 0);
  };
  const paint = (id: Act, mode: number) => {
    masksDestination(id);
    return region(Op.RectPaint, mode);
  };
  // The tests of 0x426DAB..0x4281B6 in order; null marks an operation not reproduced yet.
  const operations: [Act, (() => number) | null][] = [
    [Act.Size, () => size(Act.Size, 0x0a)],
    [Act.Size2, () => size(Act.Size2, 0x14)],
    [Act.Size3, () => size(Act.Size3, 0x1e)],
    [Act.Size4, () => size(Act.Size4, 0x28)],
    [Act.Size5, () => size(Act.Size5, 0x32)],
    [Act.Rotation, null],
    [Act.Rotation2, null],
    [Act.Saido, () => region(Op.Saido, 0)],
    [Act.Meido, () => region(Op.Meido, 0)],
    [Act.Sepia, null],
    [Act.Akarusa, null],
    [Act.Mono, null],
    [Act.Vertical, null],
    [Act.Horizontal, null],
    [Act.Mosaic, null],
    [Act.Blur, null],
    [Act.Blur2, null],
    [Act.Blur3, null],
    [Act.Blur4, null],
    [Act.Blur5, null],
    [Act.Blur6, null],
    [Act.Diffusion, null],
    [Act.Raster, null],
    [Act.Raster2, null],
    [Act.Raster3, null],
    [Act.Whirlpool, null],
    [Act.Reverse, null],
    [Act.RectPaint, () => paint(Act.RectPaint, 1)],
    [Act.RectPaint2, () => paint(Act.RectPaint2, 2)],
    [Act.RectPaint3, () => paint(Act.RectPaint3, 3)],
    [Act.Gradation, null],
    // 0x428E7B: BNO selects the text buffer and the tests go on.
    [Act.Bno, () => ((layers.textBuffer = low(a.int(Act.Bno))), NaN)],
    [Act.Text, null],
    [Act.Merge, null],
    [Act.Merge2, null],
    [Act.Transition, null],
    [Act.Transition2, null],
    [Act.Xor, null],
    [Act.And, null],
    [Act.Trim, null],
    [Act.Resize, null],
    [Act.Copy, () => copy(Act.Copy, Op.Copy)],
    [Act.Copy2, () => copy(Act.Copy2, Op.Copy2)],
    [Act.Swap, null],
    [Act.Swap2, null],
    [Act.TexCopy, null],
    [Act.TexSsCopy, null],
  ];
  for (const [id, operation] of operations) {
    if (!a.has(id)) continue;
    if (!operation) throw new Error(`CGACT ${m.argName(id)} is not implemented`);
    const result = operation();
    if (!Number.isNaN(result)) return result;
  }
  // 0x428CD6: no operation resets the text buffer.
  layers.textBuffer = 0;
  return 0;
}

/** The region in hundredths of a pixel and the output size of the SIZE operations. */
interface FineParams {
  fx: number;
  fy: number;
  fx2: number;
  fy2: number;
  fsx: number;
  fsy: number;
}

/**
 * 0x4344C8: SIZE..SIZE5 scale the source into a buffer of FSX/100 x FSY/100 pixels that
 * replaces the target: the destination when one is given, otherwise the source.
 *
 * A destination whose texture already has that size is written in place; so is one with
 * REMALLOC set that is larger in both directions, which then takes the new size without a
 * new buffer. The mode byte (the operation's value plus its base) selects the worker: 0x0A
 * SIZE (nearest, reading the source's displayed +0xC0 pixels), 0x15 SIZE2=1 (bilinear),
 * 0x1F SIZE3=1 (bicubic), 0x29 SIZE4=1 (supersampled bilinear) and 0x33 SIZE5=1 (Lanczos);
 * these read the +0xD0 buffer. Any other value leaves the new buffer as allocated. The target
 * takes the source's mask flag.
 */
function resize(
  layers: YurisLayers,
  src: YurisCgNode,
  dst: YurisCgNode | null,
  hasDestination: boolean,
  f: FineParams,
  mode: number,
  simd: boolean,
): number {
  const width = Math.trunc(f.fsx / 100),
    height = Math.trunc(f.fsy / 100);
  const s = src.payload!;
  const node = hasDestination ? dst! : src,
    t = node.payload!;
  layers.markDirty(node);
  let reuse = 0;
  if (hasDestination && width === t.textureWidth && height === t.textureHeight) reuse = 1;
  if (t.remalloc === 1 && hasDestination && width < t.textureWidth && height < t.textureHeight)
    reuse = 2;
  const buffer = reuse === 0 ? allocate(width, height) : dst!.payload!.source;
  if (!buffer) return -1;
  t.masked = s.masked;
  const tw = s.textureWidth,
    th = s.textureHeight;
  const px = Math.trunc(f.fx / 100),
    py = Math.trunc(f.fy / 100),
    px2 = Math.trunc(f.fx2 / 100),
    py2 = Math.trunc(f.fy2 / 100);
  const from = mode === 0x0a ? s.pixels : s.source;
  if (from) {
    if (mode === 0x0a) sizeNearest(buffer, width, height, from, tw, th, px, py, px2, py2);
    else if (mode === 0x15)
      sizeBilinear(buffer, from, tw, th, f.fx, f.fy, f.fx2, f.fy2, f.fsx, f.fsy, simd);
    else if (mode === 0x1f) sizeBicubic(buffer, width, height, from, tw, th, px, py, px2, py2);
    else if (mode === 0x29)
      sizeSupersampled(buffer, from, tw, th, f.fx, f.fy, f.fx2, f.fy2, f.fsx, f.fsy);
    else if (mode === 0x33) sizeLanczos(buffer, width, height, from, tw, th);
  }
  if (reuse === 0) {
    t.replace(buffer, width, height);
    layers.markDirty(node);
  } else if (reuse === 2) {
    t.width = t.textureWidth = width;
    t.height = t.textureHeight = height;
    layers.markDirty(node);
  }
  return 0;
}

/**
 * 0x42C21D: runs a region operation of the source layer `src` (its +0xD0 pixels).
 *
 * Without a destination, MONO, RECTPAINT and GRADATION change the source in place; the
 * others build a new buffer the size of the region that replaces the source (0x434440).
 * With a destination, the result always replaces the destination's buffer: the size of the
 * region, or of the whole source texture for MONO and RECTPAINT, which copy it first. COPY
 * also copies the source's properties (0x42E2E1); the destination takes the source's mask
 * flag.
 */
function regionOp(
  layers: YurisLayers,
  op: Op,
  dst: YurisCgNode | null,
  src: YurisCgNode,
  p: ActParams,
  hasDestination: boolean,
  mode: number,
): number {
  const s = src.payload!;
  const from = s.source;
  if (!from) return 0;
  const tw = s.textureWidth,
    th = s.textureHeight;
  let rw = p.x2 - p.x + 1,
    rh = p.y2 - p.y + 1;
  if (!hasDestination) {
    if (op === Op.Mono || op === Op.RectPaint || op === Op.Gradation) {
      run(op, from, from, s, p, tw, th, rw, rh, mode);
      layers.markDirty(src);
      return 0;
    }
    const buffer = allocate(rw, rh);
    run(op, buffer, from, s, p, tw, th, rw, rh, mode);
    layers.markDirty(src);
    s.replace(buffer, rw, rh);
    layers.markDirty(src);
    return 0;
  }
  const d = dst!.payload!;
  if (op === Op.Mono || op === Op.RectPaint) {
    rw = tw;
    rh = th;
  }
  const buffer = allocate(rw, rh);
  if (op === Op.RectPaint) buffer.set(from.subarray(0, buffer.length));
  run(op, buffer, from, s, p, tw, th, rw, rh, mode);
  d.replace(buffer, rw, rh);
  layers.markDirty(dst);
  if (op === Op.Copy) copyProperties(s, d);
  d.masked = s.masked;
  return 0;
}

function allocate(width: number, height: number): Uint8Array {
  if (width > REGION_WIDTH) throw new YurisError(0x186aa, [width, height]);
  return new Uint8Array(Math.max(width, 0) * Math.max(height, 0) * 4);
}

/** The per-operation workers of 0x42C21D; `to` is the region buffer or, in place, `from`. */
function run(
  op: Op,
  to: Uint8Array,
  from: Uint8Array,
  s: YurisCg,
  p: ActParams,
  tw: number,
  th: number,
  rw: number,
  _rh: number,
  mode: number,
): void {
  switch (op) {
    case Op.Copy:
    case Op.Copy2:
      copyRegion(to, from, p.x, p.y, p.x2, p.y2, tw, rw);
      return;
    case Op.Meido:
      colourShift(to, rw, from, tw, p.x, p.y, p.x2, p.y2, p.set);
      return;
    case Op.Saido:
      saturation(to, rw, from, tw, p.x, p.y, p.x2, p.y2, p.set);
      return;
    case Op.RectPaint:
      rectPaint(to, s, p.x, p.y, p.x2, p.y2, tw, th, p.set, mode);
      return;
  }
  throw new Error(`CGACT region operation ${op} is not implemented`);
}

/** 0x43A688: rows y0..y1, columns x0..x1 of `from` (stride `fromWidth`) to the top of `to`. */
function copyRegion(
  to: Uint8Array,
  from: Uint8Array,
  x0: number,
  y0: number,
  x1: number,
  y1: number,
  fromWidth: number,
  toWidth: number,
): void {
  const bytes = (x1 - x0 + 1) * 4;
  if (bytes <= 0) return;
  for (let y = y0, at = 0; y <= y1; y++, at += toWidth * 4) {
    const start = (y * fromWidth + x0) * 4;
    to.set(from.subarray(start, start + bytes), at);
  }
}

/**
 * 0x42E0F0: fills x0..x1, y0..y1 of a `width`-wide buffer. Mode 1 paints the opaque colour
 * 0xRRGGBB, mode 2 sets the alpha to the low byte, mode 3 paints the whole 0xAARRGGBB. Modes
 * 2 and 3 clear the source's mask flag when the fill is opaque and covers the whole buffer.
 */
function rectPaint(
  to: Uint8Array,
  s: YurisCg,
  x0: number,
  y0: number,
  x1: number,
  y1: number,
  width: number,
  height: number,
  colour: number,
  mode: number,
): void {
  const whole = width === x1 - x0 + 1 && height === y1 - y0 + 1;
  if (mode === 2) s.masked = (colour & 0xff) === 0xff && whole ? 0 : 1;
  if (mode === 3) s.masked = (colour & 0xff000000) === (0xff000000 | 0) && whole ? 0 : 1;
  const b = colour & 0xff,
    g = (colour >>> 8) & 0xff,
    r = (colour >>> 16) & 0xff,
    alpha = mode === 1 ? 0xff : (colour >>> 24) & 0xff;
  for (let y = y0; y <= y1; y++)
    for (let x = x0, i = (y * width + x0) * 4; x <= x1; x++, i += 4) {
      if (mode === 2) {
        to[i + 3] = colour & 0xff;
        continue;
      }
      to[i] = b;
      to[i + 1] = g;
      to[i + 2] = r;
      to[i + 3] = alpha;
    }
}

/** 0x42E2E1: COPY gives the destination the source's display properties. */
function copyProperties(s: YurisCg, d: YurisCg): void {
  d.e = s.e;
  d.a = s.a;
  d.lint = s.lint;
  d.lint2 = s.lint2;
  d.x = s.x;
  d.y = s.y;
  d.t = s.t;
  d.ta = s.ta;
  d.mode = s.mode;
  d.masked = s.masked;
  d.tid = s.tid;
  d.fid = s.fid;
  d.fx = s.fx;
  d.fy = s.fy;
  d.fbx = s.fbx;
  d.fby = s.fby;
  d.fcx = s.fcx;
  d.fcy = s.fcy;
  d.fex = s.fex;
  d.fey = s.fey;
  d.fez = s.fez;
  d.frx = s.frx;
  d.fry = s.fry;
  d.frz = s.frz;
  d.fsd = s.fsd;
  d.fmd = s.fmd;
  d.fqu = s.fqu;
  d.f = s.f;
}
