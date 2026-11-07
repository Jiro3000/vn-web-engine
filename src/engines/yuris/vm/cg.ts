import {YBN_VERSION_500} from '../../../formats/yuris/ybn.js';
import {cgAct} from './cgact.js';
import {compose, type Rect} from './compose.js';
import {YurisError} from './errors.js';
import {YurisFileKind, YurisFileType, type YurisFiles, isSoundFileType} from './files.js';
import type {YurisMachine} from './machine.js';
import {LookupMode, type YurisNode, YurisTree, resolveNodePath} from './nodes.js';
import {type ByteString, formatInt, i64} from './numbers.js';
import {applyAtLeast, applyBounded, applyOp} from './operators.js';
import {YurisType} from './variables.js';
import {allocateBgraTarget} from '../../../graphics/bgra-effects-wasm.js';
import type {Ymv} from '../../../formats/yuris/ymv.js';
import {hasRasterText} from '../../../text/raster-text.js';
import {yurisRasterBitmap} from './raster-text.js';

/** A decoded image: straight (not premultiplied) BGRA rows, `width * 4` bytes apart. */
export interface YurisImage {
  readonly width: number;
  readonly height: number;
  readonly pixels: Uint8Array;
}

/** Image decoding for CG FILE (the decoders 0x40BF6C, 0x40BF10, 0x40BE98, 0x41C150). */
export interface YurisImageHost {
  decodeImage(bytes: Uint8Array, type: YurisFileType, path: ByteString): Promise<YurisImage>;
  decodeYmvFrame?(movie: Ymv, index: number): Promise<YurisImage | undefined>;
}

type PixelWriter = (
  pixels: Uint8Array,
  clip?: Rect,
  output?: {stride: number; x: number; y: number},
) => boolean | void;

/**
 * A layer object (0x690 bytes, initialised by 0x46BEC8). Several nodes share one object
 * through CG RID; `references` counts them (+0x58).
 */
export class YurisCg {
  /** +0x108: animation attached by YMV, shared by CG RID references. */
  ymv: Ymv | null = null;
  references = 1;
  /** +0x8: dirty marks since the last frame (0x41060C counts them, 0x410D30 clears them). */
  marks = 0;
  /** +0x30..+0x4C: the area x0, y0, x1, y1 of a layer set's buffer to recompose. */
  readonly clip = [0, 0, 0, 0];
  /** +0x50: the buffer needs recomposition. */
  dirty = false;
  /** +0x51: the whole buffer goes to the texture on the next upload (0x406801). */
  uploadAll = false;
  /** +0x54: TID (with ".TIDNO"). */
  tid: ByteString = '';
  /** +0x60, +0x68: LINT and LINT2, free script values. */
  lint = 0n;
  lint2 = 0n;
  /** +0x70, +0x78: position in pixels; FX/FY (+0x218/+0x220) hold it in 1/100 pixels. */
  x = 0n;
  y = 0n;
  fx = 0n;
  fy = 0n;
  /** +0x80 SD (saturation, 0x80 neutral), +0x84 MD (colour multiplier, 0x808080 neutral). */
  sd = 0x80;
  md = 0x808080;
  /** +0x88, +0x8C: buffer size; +0xF0, +0xF4: texture size. */
  width = 1;
  height = 1;
  textureWidth = 1;
  textureHeight = 1;
  /** +0xA2 A (opacity, 0..256), +0xA4 T, +0xA6 TA, +0xA9 MODE (blend), +0xAB E (visible). */
  a = 0x100;
  t = 0x100;
  ta = 0;
  mode = 0;
  e = 1;
  /** +0xA8: the alpha channel came from a MID mask layer. */
  masked = 0;
  /**
   * +0xC0: the pixels the compositor reads and a layer set's composition writes, straight
   * BGRA; null until a buffer exists. It is `source` or, after an MD or SD pass, `filtered`.
   */
  private displayedPixels: Uint8Array | null = null;
  private inputPixels: Uint8Array | null = null;
  private pendingPixels?: {
    source: YurisCg;
    write: (clip?: Rect) => void;
    draw?: PixelWriter;
    scale?: DeferredScale;
  };
  private windowReadback?: () => void;
  private pixelReaders?: Set<YurisCg>;
  get pixels(): Uint8Array | null {
    this.syncWindowPixels();
    if (this.pendingPixels) this.resolvePixels();
    return this.displayedPixels;
  }
  get source(): Uint8Array | null {
    this.syncWindowPixels();
    if (this.pendingPixels) this.resolvePixels();
    return this.inputPixels;
  }
  get hasPixels(): boolean {
    return this.displayedPixels !== null;
  }
  get deferredScale(): DeferredScale | undefined {
    const source = this.displayedPixels;
    return source && !hasRasterText(yurisRasterBitmap(source, this.width, this.height))
      ? this.pendingPixels?.scale
      : undefined;
  }

  /** The window renderer owns pixels outside the CPU text strip until a read. */
  deferWindowReadback(read: () => void): void {
    this.windowReadback = read;
    this.pixelRevision++;
  }

  replaceWindowReadback(): Uint8Array | null {
    this.windowReadback = undefined;
    return this.displayedPixels;
  }

  private syncWindowPixels(): void {
    const read = this.windowReadback;
    if (!read) return;
    this.windowReadback = undefined;
    read();
  }
  pixelsForRect(x: number, y: number, width: number, height: number): Uint8Array | null {
    if (this.pendingPixels) {
      if (x === 0 && y === 0 && width === this.width && height === this.height)
        this.resolvePixels();
      else this.pendingPixels.write([x, y, x + width - 1, y + height - 1]);
    }
    return this.displayedPixels;
  }
  drawPendingTo(pixels: Uint8Array, stride: number, clip: Rect, x: number, y: number): boolean {
    const draw = this.pendingPixels?.draw;
    const source = this.displayedPixels;
    return (
      !!draw &&
      !!source &&
      !hasRasterText(yurisRasterBitmap(source, this.width, this.height)) &&
      draw(pixels, clip, {stride, x, y}) === true
    );
  }
  /** Invalidates derived pixel data after in-place writes. */
  pixelRevision = 0;
  /** +0xE0, +0xE8: the filtered copy and the frame (0x871F48) of its last filter pass. */
  filtered: Uint8Array | null = null;
  filterFrame = 0n;
  /** +0x102 REMALLOC, +0x10C TEX (kept as a texture). */
  remalloc = 0;
  tex = 0;
  /** +0x228 FBX, +0x230 FBY (scale, 10000 = 1), +0x238 FCX, +0x240 FCY (centre), +0x248..+0x258 FEX..FEZ. */
  fbx = 10000n;
  fby = 10000n;
  fcx = 0n;
  fcy = 0n;
  fex = 0n;
  fey = 0n;
  fez = 0n;
  /** +0x260..+0x268: FRX, FRY, FRZ rotation (single precision). */
  frx = 0;
  fry = 0;
  frz = 0;
  /** +0x26C FSD, +0x270 FMD, +0x274 FQU, +0x278 FID, +0x27C F: the filter set. */
  fsd = 0x80;
  fmd = 0x808080;
  fqu = 0;
  fid: ByteString = '';
  f = 0;

  /** 0x4259A8 / CG SX, SY on a layer set: a zeroed buffer clipped to its size. */
  allocate(width: number, height: number, compositing = false): void {
    this.width = this.textureWidth = width;
    this.height = this.textureHeight = height;
    const length = width * height * 4;
    this.setPixels((compositing ? allocateBgraTarget(length) : null) ?? new Uint8Array(length));
    this.dirty = true;
    this.clip[0] = this.clip[1] = 0;
    this.clip[2] = width - 1;
    this.clip[3] = height - 1;
  }

  /** 0x425B64: the 1x1 transparent image of an empty or missing FILE. */
  empty(): void {
    this.masked = 0;
    this.width = this.height = this.textureWidth = this.textureHeight = 1;
    this.setPixels(new Uint8Array(4));
  }

  /** A new buffer replaces both +0xD0 and +0xC0. */
  setPixels(pixels: Uint8Array | null): void {
    this.resolveReaders();
    this.cancelPixelWrite();
    this.windowReadback = undefined;
    this.displayedPixels = this.inputPixels = pixels;
    this.pixelRevision++;
  }

  /** 0x405DB7 selects the filtered buffer for reads of +0xC0. */
  setFilteredPixels(pixels: Uint8Array): void {
    this.displayedPixels = pixels;
    this.pixelRevision++;
  }

  /** Preserve deferred consumers before changing the buffer they captured. */
  beginPixelWrite(): void {
    this.syncWindowPixels();
    this.resolvePixels();
    this.resolveReaders();
    this.pixelRevision++;
  }

  /** Overwriting a deferred result need only retain its newest transform. */
  deferPixelWrite(
    source: YurisCg,
    from: Uint8Array,
    write: PixelWriter,
    direct = false,
    scale?: DeferredScale,
  ): boolean {
    const target = this.inputPixels;
    if (!target || target !== this.displayedPixels || from.buffer === target.buffer) return false;
    this.resolveReaders();
    this.cancelPixelWrite();
    this.pixelRevision++;
    this.pendingPixels = {
      source,
      write: (clip) => write(target, clip),
      draw: direct ? write : undefined,
      scale,
    };
    (source.pixelReaders ??= new Set()).add(this);
    return true;
  }

  private resolveReaders(): void {
    if (this.pixelReaders) for (const reader of this.pixelReaders) reader.resolvePixels();
  }

  private cancelPixelWrite(): void {
    this.pendingPixels?.source.pixelReaders?.delete(this);
    this.pendingPixels = undefined;
  }

  private resolvePixels(): void {
    const pending = this.pendingPixels;
    if (!pending) return;
    this.cancelPixelWrite();
    pending.write();
  }

  /** 0x434440: a new buffer and size; the filtered copy is dropped. */
  replace(pixels: Uint8Array, width: number, height: number): void {
    this.setPixels(pixels);
    this.filtered = null;
    this.filterFrame = 0n;
    this.width = this.textureWidth = width;
    this.height = this.textureHeight = height;
  }
}

export type YurisCgNode = YurisNode<YurisCg>;

export interface DeferredScale {
  readonly pixels: Uint8Array;
  readonly width: number;
  readonly height: number;
  readonly revision: number;
  readonly fx: number;
  readonly fy: number;
  readonly fx2: number;
  readonly fy2: number;
  readonly fsx: number;
  readonly fsy: number;
  readonly sse: boolean;
}

/** CG argument ids (`ysc.ybn`). */
const enum Cg {
  Id,
  IdNo,
  E,
  A,
  X,
  Y,
  Z,
  Sd,
  Md,
  Sx,
  Sy,
  Tex = 25,
  DxBuf,
  DxDraw,
  Fx,
  Fy,
  Fbx,
  Fby,
  Frx,
  Fry,
  Frz,
  Fcx,
  Fcy,
  Fex,
  Fey,
  Fez,
  Fsd,
  Fmd,
  Fqu,
  Fid,
  F,
  Remalloc,
  File,
  Rid,
  Mid,
  T = 50,
  Tid,
  TidNo,
  Ta,
  Mode,
  Lint = 56,
  Lint2,
}

/** CGINFO argument ids. */
const enum Info {
  Id,
  IdNo,
  Exist,
  E,
  A,
  X,
  Y,
  Z,
  T = 9,
  Tid,
  Ta,
  Mode,
  Sx,
  Sy,
  Fbx,
  Fby,
  Fex,
  Fey,
  Fez,
  Tex,
  OnMouse,
  OnMouse2,
  OnMouse3,
  Color,
  Trim,
  Lint,
  Lint2,
  Search,
  Num,
  Name,
  LSet,
  No,
  Let,
  Set,
  Set2,
}

/** Command ids (`ysc.ybn`). */
const CG = 0x01,
  CGACT = 0x02,
  CGEND = 0x03,
  CGINFO = 0x04,
  ERROR = 0x0e;

/** The window count of the window table 0x87279C. */
const WINDOWS = 4;

/**
 * The layer tree 0x872414 and its commands. The root's object spans the screen; tree
 * initialisation (0x46891C) creates the layer set "W0" (Z 1) with a screen-sized buffer, the
 * composition target of window 0.
 */
export class YurisLayers {
  readonly tree = new YurisTree<YurisCg>();
  private readonly ruleIds = new Set<ByteString>();
  private readonly opacityDamage = new Map<YurisCgNode, number>();
  private readonly coveredPixelDamage = new Set<YurisCgNode>();
  /** 0x872018: a layer changed since the last composition. */
  redraw = false;
  /** 0x871FF4: Keep the composition mode selected by native Direct3D initialization. */
  readonly direct = true;
  /** 0x5B8664: the text buffer CGACT TEXT draws with (set by BNO, 0x4039D0). */
  textBuffer = 0;
  /** 0x872234: the layer DXBUF selected. */
  directBuffer: YurisCgNode | null = null;
  /** +0x124 of each window: the layer set it shows. */
  readonly windowLayers: (YurisCgNode | null)[] = new Array(WINDOWS).fill(null);

  constructor(
    private readonly machine: YurisMachine,
    private readonly files: YurisFiles,
    private readonly images: YurisImageHost,
  ) {
    const width = machine.screenWidth,
      height = machine.screenHeight;
    const root = new YurisCg();
    root.width = root.textureWidth = width;
    root.height = root.textureHeight = height;
    this.tree.root.payload = root;
    const screen = new YurisCg();
    screen.allocate(width, height, true);
    this.windowLayers[0] = this.tree.create('W0', true, 1n, screen);
  }

  install(): void {
    const m = this.machine;
    m.define(CG, () => this.cg());
    m.define(CGEND, () => this.cgEnd());
    m.define(CGINFO, () => this.cgInfo());
    m.define(ERROR, () => this.error());
    m.define(CGACT, () => cgAct(this, m));
  }

  /** The CG A setter of 0x423860, including damage for shared payloads. */
  private changeOpacity(node: YurisCgNode, cg: YurisCg, next: number): boolean {
    if (next === cg.a) return false;
    const shared = cg.references > 1;
    if (shared) {
      if (node.group) this.markSet(node);
      else this.markDirty(node);
    } else {
      const previous = this.opacityDamage.get(node) ?? cg.a;
      if (next === previous) this.opacityDamage.delete(node);
      else this.opacityDamage.set(node, previous);
      this.redraw = true;
    }
    cg.a = next;
    return shared;
  }

  clearOpacityRange(prefix: ByteString, first: number, count: number): void {
    const namespace = this.machine.system.names[0]!;
    const parent = namespace ? this.tree.lookup(namespace, LookupMode.Group) : this.tree.root;
    if (parent) {
      for (let i = 0; i < count; i++) {
        const node = parent.child(prefix + (first + i), LookupMode.Leaf);
        const cg = node?.payload;
        if (node && cg && this.changeOpacity(node, cg, 0)) {
          this.redraw = true;
          this.markDirty(node);
        }
      }
    }
  }

  /** ID with ".IDNO" (`_i64toa` base 10), resolved against the layer namespace (id 0x80). */
  target(idArg: number, idNoArg: number): {path: ByteString; group: boolean} {
    const a = this.machine.args;
    let id = a.text(idArg);
    if (a.has(idNoArg)) id = `${id}.${formatInt(a.int(idNoArg))}`;
    const resolved = resolveNodePath(this.machine.system.names[0]!, id);
    // A numbered id names a layer, never a layer set.
    return {path: resolved.path, group: a.has(idNoArg) ? false : resolved.group};
  }

  lookup(path: ByteString, group: boolean): YurisCgNode | null {
    return this.tree.lookup(path, group ? LookupMode.Group : LookupMode.Leaf);
  }

  /** The single CGINFO LINT2 query of 0x43B448. */
  readLint2(id: ByteString): bigint {
    const {path, group} = resolveNodePath(this.machine.system.names[0]!, id);
    return this.lookup(path, group)?.payload?.lint2 ?? 0n;
  }

  commandName(): string {
    return this.machine.commandName(this.machine.instruction.command);
  }

  /**
   * CG 0x423860: creates a layer (FILE, or RID to share another layer's object) or a layer set
   * (SX, SY and Z), then changes the given properties in their native order.
   */
  private cg(): number | Promise<number> {
    const m = this.machine,
      a = m.args;
    m.decode();
    const {path, group} = this.target(Cg.Id, Cg.IdNo);
    let node = this.lookup(path, group);
    let cg = node?.payload ?? null;
    const sx = a.has(Cg.Sx) ? a.int(Cg.Sx) : -1n,
      sy = a.has(Cg.Sy) ? a.int(Cg.Sy) : -1n;
    let z = a.has(Cg.IdNo) ? a.int(Cg.IdNo) : -1n;
    let changed = false;
    if (a.has(Cg.Z)) {
      z = applyAtLeast(a.op[a.has(Cg.Z)]!, node ? node.z : 1n, a.int(Cg.Z), 1n);
      if (node && node.z !== z) {
        this.tree.setZ(node, z);
        changed = true;
      }
    }
    const file = a.has(Cg.File),
      rid = a.has(Cg.Rid);
    if (!node) {
      if (!group) {
        if (!file && !rid) {
          if (m.errorFlags[CG] === 0) return 0;
          throw new YurisError(0x18b6e, [this.commandName(), path]);
        }
        if (z === -1n) throw new YurisError(0x18790, [this.commandName()]);
        node = this.tree.create(path, false, z);
        if (file) {
          cg = node.payload = new YurisCg();
        } else if (a.text(Cg.Rid)) {
          const source = this.lookup(
            resolveNodePath(m.system.names[0]!, a.text(Cg.Rid)).path,
            false,
          );
          if (!source) throw new YurisError(0x18b82, [this.commandName(), a.text(Cg.Rid)]);
          cg = node.payload = source.payload;
          if (cg) cg.references++;
        }
        if (!cg) return -1;
      } else {
        if (file || rid) throw new YurisError(0x18ba0, [this.commandName()]);
        if (sx === -1n || sy === -1n || z === -1n) return 0;
        node = this.tree.create(path, true, z);
        cg = node.payload = new YurisCg();
        cg.allocate(Number(sx & 0xffffffffn) | 0, Number(sy & 0xffffffffn) | 0, true);
        this.markSet(node);
      }
    }
    if (!cg) return 0;
    if (!file) return this.updateCg(node, cg, group, sx, sy, false, changed);
    if (group) throw new YurisError(0x18ba0, [this.commandName()]);
    this.markDirty(node);
    const layer = cg;
    return this.load(layer, a.text(Cg.File)).then((result) => {
      if (result !== 0) {
        m.quit = true;
        return -1;
      }
      return this.updateCg(node, layer, group, sx, sy, true, true);
    });
  }

  private updateCg(
    node: YurisCgNode,
    cg: YurisCg,
    group: boolean,
    sx: bigint,
    sy: bigint,
    file: boolean,
    changed: boolean,
  ): number {
    const m = this.machine,
      a = m.args;
    // Each change first marks the area the node covers before it (0x410550, or 0x425E74 for
    // a layer set); the final mark adds the area after the change.
    const touch = () => (group ? this.markSet(node) : this.markDirty(node));
    if (a.has(Cg.Mid) && a.text(Cg.Mid)) {
      const mask = this.lookup(
        resolveNodePath(m.system.names[0]!, a.text(Cg.Mid)).path,
        false,
      )?.payload;
      if (mask) {
        if (cg.width !== mask.width || cg.height !== mask.height) {
          m.quit = true;
          return m.messageBox('レイヤ画像とマスクレイヤ画像のサイズが異なります。');
        }
        const to = cg.pixels!,
          from = mask.pixels!;
        cg.beginPixelWrite();
        for (let i = 0; i < cg.width * cg.height; i++) to[i * 4 + 3] = from[i * 4]!;
        cg.masked = 1;
      }
    }
    if (a.has(Cg.Tid)) {
      const previous = cg.tid;
      cg.tid = a.text(Cg.Tid);
      if (a.has(Cg.TidNo)) cg.tid += `.${formatInt(a.int(Cg.TidNo))}`;
      if (cg.tid) this.ruleIds.add(cg.tid);
      // The new rule may have been edited earlier in this pass while it was hidden.
      if (cg.tid !== previous) changed = true;
    }
    const op = (id: number) => a.op[a.has(id)]!;
    const value = (id: number) => a.int(id);
    const bounded = (id: number, current: number, min: bigint, max: bigint) =>
      Number(applyBounded(op(id), BigInt(current), value(id), min, max));
    if (a.has(Cg.E) && BigInt(cg.e) !== value(Cg.E)) {
      touch();
      cg.e = (Number(value(Cg.E) & 0xffn) << 24) >> 24;
      changed = true;
    }
    if (a.has(Cg.A)) {
      const next = (bounded(Cg.A, cg.a, 0n, 256n) << 16) >> 16;
      changed = this.changeOpacity(node, cg, next) || changed;
    }
    if (
      a.count <= 4 &&
      a.count ===
        Number(!!a.has(Cg.Id)) +
          Number(!!a.has(Cg.IdNo)) +
          Number(!!a.has(Cg.A)) +
          Number(!!a.has(Cg.E))
    ) {
      if (changed) {
        this.redraw = true;
        touch();
      }
      return 0;
    }
    if (a.has(Cg.X)) {
      const x = applyOp(op(Cg.X), cg.x, value(Cg.X));
      if (x !== cg.x) {
        touch();
        cg.x = x;
        cg.fx = i64(x * 100n);
        changed = true;
      }
    }
    if (a.has(Cg.Fx)) {
      const fx = applyOp(op(Cg.Fx), cg.fx, value(Cg.Fx));
      if (fx !== cg.fx) {
        touch();
        cg.fx = fx;
        cg.x = fx / 100n;
        changed = true;
      }
    }
    if (a.has(Cg.Y)) {
      // Y is kept as its low 32 bits, sign extended, and FY as the 32-bit product.
      const y = BigInt.asIntN(32, applyOp(op(Cg.Y), cg.y, value(Cg.Y)));
      if (y !== cg.y) {
        touch();
        cg.y = y;
        cg.fy = BigInt.asIntN(32, y * 100n);
        changed = true;
      }
    }
    if (a.has(Cg.Fy)) {
      const fy = applyOp(op(Cg.Fy), cg.fy, value(Cg.Fy));
      if (fy !== cg.fy) {
        touch();
        cg.fy = fy;
        cg.y = fy / 100n;
        changed = true;
      }
    }
    if (a.has(Cg.Md)) {
      const before = cg.md;
      cg.md = bounded(Cg.Md, cg.md, 0n, 0x1000000n) | 0;
      if (cg.md !== before) changed = true;
    }
    if (a.has(Cg.Sd)) {
      const before = cg.sd;
      cg.sd = bounded(Cg.Sd, cg.sd, 0n, 256n) | 0;
      if (cg.sd !== before) changed = true;
    }
    if (group) {
      if (a.has(Cg.Sx)) {
        this.markSet(node);
        cg.width = cg.textureWidth = Number(sx & 0xffffffffn) | 0;
        if (cg.width > 0 && cg.height > 0) this.reallocate(node);
      }
      if (a.has(Cg.Sy)) {
        this.markSet(node);
        cg.height = cg.textureHeight = Number(sy & 0xffffffffn) | 0;
        if (cg.width > 0 && cg.height > 0) this.reallocate(node);
      }
    } else if (sx !== -1n || sy !== -1n) {
      if (!file) changed = true;
      else {
        if (sx === -1n || sy === -1n) throw new YurisError(0x18793, [this.commandName()]);
        this.markDirty(node);
        this.resize(cg, Number(sx), Number(sy));
        this.markDirty(node);
      }
    }
    if (a.has(Cg.T)) {
      const before = cg.t;
      cg.t = (bounded(Cg.T, cg.t, 0n, 256n) << 16) >> 16;
      if (cg.t !== before) changed = true;
    }
    if (a.has(Cg.Ta)) {
      if (BigInt(cg.ta) !== value(Cg.Ta)) changed = true;
      cg.ta = (Number(value(Cg.Ta) & 0xffffn) << 16) >> 16;
    }
    if (a.has(Cg.Mode)) {
      if (BigInt(cg.mode) !== value(Cg.Mode)) changed = true;
      cg.mode = (Number(value(Cg.Mode) & 0xffn) << 24) >> 24;
    }
    if (a.has(Cg.Tex) && value(Cg.Tex) === 1n && this.direct) {
      // 0x407911 uploads the pixels as a texture; the compositor keeps every layer as one.
      cg.tex = 1;
      changed = true;
    }
    if (a.has(Cg.DxBuf)) {
      if (value(Cg.DxBuf) === 1n) this.directBuffer = node;
      if (value(Cg.DxBuf) === 0n) this.directBuffer = null;
    }
    const fine = (id: number, current: bigint): bigint => {
      const next = applyOp(op(id), current, value(id));
      if (next !== current) changed = true;
      return next;
    };
    if (a.has(Cg.Fbx)) cg.fbx = fine(Cg.Fbx, cg.fbx);
    if (a.has(Cg.Fby)) cg.fby = fine(Cg.Fby, cg.fby);
    const rotation = (id: number, current: number): number => {
      const next = applyOp(op(id), BigInt(Math.round(current)), value(id));
      if (BigInt(Math.round(current)) !== next) changed = true;
      return Math.fround(Number(next));
    };
    if (a.has(Cg.Frx)) cg.frx = rotation(Cg.Frx, cg.frx);
    if (a.has(Cg.Fry)) cg.fry = rotation(Cg.Fry, cg.fry);
    if (a.has(Cg.Frz)) cg.frz = rotation(Cg.Frz, cg.frz);
    if (a.has(Cg.Fcx)) cg.fcx = fine(Cg.Fcx, cg.fcx);
    if (a.has(Cg.Fcy)) cg.fcy = fine(Cg.Fcy, cg.fcy);
    if (a.has(Cg.Fex)) cg.fex = fine(Cg.Fex, cg.fex);
    if (a.has(Cg.Fey)) cg.fey = fine(Cg.Fey, cg.fey);
    if (a.has(Cg.Fez)) cg.fez = fine(Cg.Fez, cg.fez);
    if (a.has(Cg.Fsd)) {
      const before = cg.fsd;
      cg.fsd = bounded(Cg.Fsd, cg.fsd, 0n, 256n) | 0;
      if (cg.fsd !== before) changed = true;
    }
    if (a.has(Cg.Fmd)) {
      const before = cg.fmd;
      cg.fmd = bounded(Cg.Fmd, cg.fmd, 0n, 0x1000000n) | 0;
      if (cg.fmd !== before) changed = true;
    }
    if (a.has(Cg.Fqu)) {
      const fqu = (Number(value(Cg.Fqu) & 0xffn) << 24) >> 24;
      if (fqu !== cg.fqu) changed = true;
      cg.fqu = fqu;
    }
    if (a.has(Cg.Fid)) {
      cg.fid = a.text(Cg.Fid);
      changed = true;
    }
    if (a.has(Cg.F)) {
      const before = cg.f;
      cg.f = (bounded(Cg.F, cg.f, 0n, 256n) << 16) >> 16;
      if (cg.f !== before) changed = true;
    }
    if (a.has(Cg.Remalloc)) {
      const before = cg.remalloc;
      cg.remalloc = (bounded(Cg.Remalloc, cg.remalloc, 0n, 1n) << 24) >> 24;
      if (cg.remalloc !== before) changed = true;
    }
    // 0x407020 draws the DXDRAW layer into the Direct3D buffer at the next composition.
    if (a.has(Cg.DxDraw) && this.direct) changed = true;
    if (a.has(Cg.Lint)) cg.lint = applyOp(op(Cg.Lint), cg.lint, value(Cg.Lint));
    if (a.has(Cg.Lint2)) cg.lint2 = applyOp(op(Cg.Lint2), cg.lint2, value(Cg.Lint2));
    if (changed) {
      this.redraw = true;
      touch();
    }
    return 0;
  }

  /**
   * CG SX/SY on a layer set (0x424195): a zeroed buffer of the new size, marked whole, then
   * composed at once.
   */
  private reallocate(node: YurisCgNode): void {
    const cg = node.payload!;
    if (cg.width > 0x2000) throw new YurisError(0x186aa, [cg.width, cg.height]);
    cg.allocate(cg.width, cg.height, true);
    this.markSet(node);
    if (this.composeSet(node) < 0) this.machine.quit = true;
  }

  flushDamage(): void {
    for (const changed of this.coveredPixelDamage)
      if (!this.isCovered(changed)) this.markDirty(changed);
    this.coveredPixelDamage.clear();
    // Commands can temporarily hide a sprite while updating its buffer. Only the
    // opacity at the next composition can damage the pixels already on screen.
    for (const changed of this.opacityDamage.keys()) {
      if (changed.group) this.markSet(changed);
      else this.markDirty(changed);
    }
    this.opacityDamage.clear();
  }

  compositionHost() {
    return {
      frame: this.machine.system.frames,
      rasterText: this.machine.tracksRasterText,
      ruleLayer: (tid: ByteString) =>
        this.tree.lookup(resolveNodePath(this.machine.system.names[0]!, tid).path, LookupMode.Leaf),
    };
  }

  /** 0x425DF4: composes a layer set's whole buffer (0x404A51 with window -1). */
  composeSet(node: YurisCgNode): number {
    this.flushDamage();
    const cg = node.payload;
    if (!cg) return 0;
    return compose(this.compositionHost(), node, 0, 0, [0, 0, cg.width - 1, cg.height - 1]);
  }

  /**
   * 0x425E74: marks a layer set's pending area in itself and, moved by each position on the
   * way up, in the enclosing sets.
   */
  markSet(node: YurisCgNode | null): void {
    const cg = node?.payload;
    if (!node || !cg) return;
    const rect = [...cg.clip];
    for (let n: YurisCgNode | null = node; n && n !== this.tree.root && n.payload; n = n.parent) {
      markArea(n.payload, rect);
      const x = Number(n.payload.x),
        y = Number(n.payload.y);
      rect[0]! += x;
      rect[1]! += y;
      rect[2]! += x;
      rect[3]! += y;
    }
  }

  /**
   * CG SX/SY with FILE on a layer (0x434440): a new opaque black buffer with the loaded
   * image's top-left part copied in.
   */
  private resize(cg: YurisCg, width: number, height: number): void {
    const pixels = new Uint8Array(Math.max(width, 0) * Math.max(height, 0) * 4);
    const columns = Math.max(Math.min(width, cg.width), 0),
      rows = cg.pixels ? Math.max(Math.min(height, cg.height), 0) : 0;
    // Opaque black outside the copied top-left part; the copy overwrites the rest.
    const black = (from: number, to: number): void => {
      if (LITTLE_ENDIAN) new Uint32Array(pixels.buffer, from * 4, to - from).fill(0xff000000);
      else for (let i = from * 4 + 3; i < to * 4; i += 4) pixels[i] = 0xff;
    };
    for (let y = 0; y < rows; y++) {
      pixels.set(
        cg.pixels!.subarray(y * cg.width * 4, (y * cg.width + columns) * 4),
        y * width * 4,
      );
      if (columns < width) black(y * width + columns, (y + 1) * width);
    }
    if (rows < height && width > 0) black(rows * width, height * width);
    cg.replace(pixels, width, height);
  }

  /**
   * CG FILE (0x425B34 / 0x425C29): an empty name or a file that is not found gives a 1x1
   * transparent image; a found file must be an image type (error 0x186BE).
   */
  private async load(cg: YurisCg, name: ByteString): Promise<number> {
    if (!name) {
      cg.empty();
      return 0;
    }
    const file = this.files.resolve(name, YurisFileKind.Image);
    if (!file.found) {
      cg.empty();
      return 0;
    }
    cg.masked = 0;
    if (file.type === YurisFileType.None || isSoundFileType(file.type)) {
      this.machine.fail(new YurisError(0x186be, [this.commandName(), name]));
      return -1;
    }
    const data = await this.files.read(file.path);
    const image = await this.images.decodeImage(data, file.type, file.path);
    cg.masked = Number(maskedImage(file.type, data, this.files.version));
    cg.setPixels(image.pixels);
    cg.width = cg.textureWidth = image.width;
    cg.height = cg.textureHeight = image.height;
    return 0;
  }

  /**
   * 0x410550: marks the node's area in each enclosing layer set for recomposition. The area
   * starts as the node's buffer and moves by each node's position on the way up.
   */
  markDirty(node: YurisCgNode | null, area?: Rect): void {
    const cg = node?.payload;
    if (!node || !cg) return;
    const rect = area ? [...area] : [0, 0, cg.width - 1, cg.height - 1];
    for (
      let child = node, set = node.parent;
      set && set !== this.tree.root;
      child = set, set = set.parent
    ) {
      const x = Number(child.payload?.x ?? 0n),
        y = Number(child.payload?.y ?? 0n);
      rect[0]! += x;
      rect[1]! += y;
      rect[2]! += x;
      rect[3]! += y;
      if (set.payload) markArea(set.payload, rect);
    }
  }

  /** A pixel-only write to an invisible leaf cannot change its enclosing image.
   * Retain the native mark for any potential TID source, even when it is hidden.
   */
  markPixelsChanged(node: YurisCgNode | null, area?: Rect): void {
    const cg = node?.payload;
    if (!node || !cg) return;
    const hidden =
      !node.group && (cg.e === 0 || (cg.a === 0 && (this.opacityDamage.get(node) ?? 0) === 0));
    if (hidden || area) {
      // Namespaces may change before composition. A literal final name can only
      // resolve to the same leaf name, while directory syntax stays conservative.
      for (const id of this.ruleIds) {
        if (id.endsWith(node.name) || id.endsWith('/') || id.endsWith(':')) {
          this.markDirty(node);
          return;
        }
      }
    }
    if (!hidden) this.markDirty(node, area);
  }

  /** Same-sized writes underneath an opaque sibling cannot affect the enclosing buffer. */
  isCovered(node: YurisCgNode): boolean {
    const cg = node.payload;
    if (!cg || node.group || cg.references !== 1 || !node.parent) return false;
    // A hidden layer can still supply TID weights to a visible sibling.
    for (const id of this.ruleIds)
      if (id.endsWith(node.name) || id.endsWith('/') || id.endsWith(':')) return false;
    const siblings = node.parent.children;
    for (let i = siblings.length - 1; i >= 0; i--) {
      const above = siblings[i]!;
      if (above === node) break;
      const p = above.payload;
      if (
        p?.hasPixels &&
        p.references === 1 &&
        !above.group &&
        p.e === 1 &&
        p.a === 256 &&
        !p.masked &&
        p.mode === 0 &&
        !p.tex &&
        (!p.tid || p.t === 256) &&
        p.x <= cg.x &&
        p.y <= cg.y &&
        p.x + BigInt(p.width) >= cg.x + BigInt(cg.width) &&
        p.y + BigInt(p.height) >= cg.y + BigInt(cg.height)
      )
        return true;
    }
    return false;
  }

  /** Recheck the opaque cover after the script has finished updating layer state. */
  markCoveredPixelWrite(node: YurisCgNode): void {
    this.coveredPixelDamage.add(node);
  }

  /**
   * 0x445810 (LOAD with ID): the layer is marked (0x410550) and released (0x43B264), and a new
   * layer is created at `path` with Z 1 (0x46753D) holding the saved size and pixels.
   */
  restore(
    node: YurisCgNode,
    path: ByteString,
    width: number,
    height: number,
    pixels: Uint8Array,
  ): void {
    this.markDirty(node);
    this.remove(node);
    const cg = new YurisCg();
    cg.width = cg.textureWidth = width;
    cg.height = cg.textureHeight = height;
    cg.setPixels(pixels);
    this.tree.create(path, false, 1n, cg);
  }

  /** 0x410D30: the frame's marks are consumed; every layer set starts clean. */
  frameEnd(): void {
    const clear = (node: YurisCgNode): void => {
      for (const child of node.children) {
        if (!child.group || !child.payload) continue;
        child.payload.marks = 0;
        child.payload.dirty = false;
        clear(child);
      }
    };
    clear(this.tree.root);
  }

  /**
   * CGEND 0x43B0D8: deletes a layer, or a layer set with everything under it (0x43B204). A
   * shared object is freed with its last node.
   */
  private cgEnd(): number {
    const m = this.machine;
    m.decode();
    const {path, group} = this.target(0, 1);
    const node = this.lookup(path, group);
    if (!node?.payload) return 0;
    this.markDirty(node);
    this.redraw = true;
    this.remove(node);
    return 0;
  }

  /** 0x43B220 then 0x43B264: children first, then the node itself. */
  private remove(node: YurisCgNode): void {
    for (const child of [...node.children]) this.remove(child);
    this.opacityDamage.delete(node);
    this.coveredPixelDamage.delete(node);
    for (let w = 0; w < WINDOWS; w++)
      if (this.windowLayers[w] === node) this.windowLayers[w] = null;
    if (this.directBuffer === node) this.directBuffer = null;
    this.tree.remove(node);
    if (node.payload && --node.payload.references === 0) {
      node.payload.ymv = null;
      node.payload.setPixels(null);
      node.payload.filtered = null;
    }
    node.payload = null;
  }

  /**
   * CGINFO 0x43B448: one query, the first present one in the native order, stored in the LET
   * element. A missing layer stores 0, 0.0 or the empty string by the LET variable's type.
   */
  private cgInfo(): number {
    const m = this.machine,
      a = m.args;
    m.decode();
    const slot = a.has(Info.Let),
      to = {id: a.variable[slot]!, index: a.variableIndex[slot]!};
    const store = (value: bigint) => (m.setInt(to.id, to.index, value), 0);
    const storeString = (value: ByteString) => (m.setString(to.id, to.index, value), 0);
    const {path, group} = this.target(Info.Id, Info.IdNo);
    const node = this.lookup(path, group);
    const cg = node?.payload;
    if (!node || !cg) {
      const type = m.variables.get(to.id).type;
      if (type === YurisType.Int) return store(0n);
      if (type === YurisType.Float) return (m.setFloat(to.id, to.index, 0), 0);
      if (type === YurisType.String) return storeString('');
      return 0;
    }
    if (a.has(Info.Exist)) return store(1n);
    if (a.has(Info.E)) return store(BigInt(cg.e));
    if (a.has(Info.A)) return store(BigInt(cg.a));
    if (a.has(Info.T)) return store(BigInt(cg.t));
    if (a.has(Info.Tid)) return storeString(cg.tid);
    if (a.has(Info.Ta)) return store(BigInt(cg.ta));
    if (a.has(Info.X)) return store(cg.x);
    if (a.has(Info.Y)) return store(cg.y);
    if (a.has(Info.Z)) return store(node.z);
    if (a.has(Info.Mode)) return store(BigInt(cg.mode));
    if (a.has(Info.Sx)) return store(BigInt(cg.width));
    if (a.has(Info.Sy)) return store(BigInt(cg.height));
    if (a.has(Info.Fbx)) return store(cg.fbx);
    if (a.has(Info.Fby)) return store(cg.fby);
    if (a.has(Info.Fex)) return store(cg.fex);
    if (a.has(Info.Fey)) return store(cg.fey);
    if (a.has(Info.Fez)) return store(cg.fez);
    if (a.has(Info.Tex)) return store(BigInt(cg.tex));
    const count = node.children.length;
    if (a.has(Info.Search) && group) {
      if (!a.has(Info.Lint)) return store(0n);
      let at = a.has(Info.No) ? a.int(Info.No) : 0n;
      if (at < 1n) at = 1n;
      const both = a.has(Info.Lint2) !== 0;
      for (let i = Number(at); i <= count; i++) {
        const child = node.childAt(count - i + 1)?.payload;
        if (!child || child.lint !== a.int(Info.Lint)) continue;
        if (both && child.lint2 !== a.int(Info.Lint2)) continue;
        return store(BigInt(i));
      }
      return store(-1n);
    }
    if (a.has(Info.Lint)) return store(cg.lint);
    if (a.has(Info.Lint2)) return store(cg.lint2);
    if (a.has(Info.Num) && group) return store(BigInt(count));
    const no = a.has(Info.No) ? Number(BigInt.asIntN(32, a.int(Info.No))) : 0;
    const numbered = group && no >= 1 && no <= count ? node.childAt(count - no + 1) : null;
    if (a.has(Info.Name) && numbered) return storeString(numbered.name);
    if (a.has(Info.LSet) && numbered) return store(numbered.group ? 1n : 0n);
    const set = a.has(Info.Set) ? Number(BigInt.asIntN(32, a.int(Info.Set))) : null,
      set2 = a.has(Info.Set2) ? Number(BigInt.asIntN(32, a.int(Info.Set2))) : null;
    for (const [id, mode] of [
      [Info.OnMouse, 1],
      [Info.OnMouse2, 2],
      [Info.OnMouse3, 3],
    ] as const) {
      if (!a.has(id)) continue;
      // 0x43B448 indexes from 0x872798, four bytes before the main-window
      // pointer at 0x87279C: ONMOUSE*=1 therefore selects window 0. The
      // script argument is one-based even though the host arrays are not.
      const w = Math.max(0, Math.min(Number(BigInt.asIntN(32, a.int(id))), WINDOWS - 1) - 1);
      const mx = set ?? m.system.mouseX[w]!,
        my = set2 ?? m.system.mouseY[w]!;
      if (mx < 0 || my < 0 || mx >= m.screenWidth || my >= m.screenHeight) return store(-1n);
      let left = 0n,
        top = 0n;
      for (let n: YurisCgNode | null = node; n && n.name; n = n.parent) {
        left += n.payload?.x ?? 0n;
        top += n.payload?.y ?? 0n;
      }
      return store(pixel(cg, mx - Number(left), my - Number(top), mode));
    }
    if (a.has(Info.Color)) {
      if (set === null || set2 === null)
        throw new YurisError(0x18baf, [this.commandName(), 'COLOR']);
      return store(pixel(cg, set, set2, 1));
    }
    if (a.has(Info.Trim)) return store(trim(cg, set2 ?? 0, set ?? 0));
    return store(0n);
  }

  /** ERROR 0x469DE4: COM_<command> sets the error flag of each command (table 0x667E60). */
  private error(): number {
    const m = this.machine,
      a = m.args;
    m.decode();
    for (let command = 1; command <= 0x79; command++) {
      const slot = a.has(command + 2);
      if (slot) m.errorFlags[command] = Number(a.value[slot]! & 0xffn);
    }
    return 0;
  }
}

/** The rectangle of 0x41060C that matches nothing (-999999999 in every field). */
const NO_AREA = -999999999;
const LITTLE_ENDIAN = new Uint8Array(Uint32Array.of(1).buffer)[0] === 1;

/**
 * 0x41060C: clips `rect` (changed in place) to the layer set's buffer and joins it to the area
 * to recompose; the first mark of a frame or of a clean set replaces the area. A rectangle
 * outside the buffer becomes NO_AREA, which stays outside every enclosing set.
 */
function markArea(set: YurisCg, rect: number[]): void {
  if (set.width !== 0 && set.height !== 0) {
    if (!(rect[0]! < set.width && rect[1]! < set.height && rect[2]! >= 0 && rect[3]! >= 0)) {
      rect.fill(NO_AREA);
      return;
    }
    if (rect[0]! < 0) rect[0] = 0;
    if (rect[1]! < 0) rect[1] = 0;
    if (rect[2]! > set.width - 1) rect[2] = set.width - 1;
    if (rect[3]! > set.height - 1) rect[3] = set.height - 1;
  }
  const c = set.clip;
  if (set.marks === 0 || !set.dirty) {
    c[0] = rect[0]!;
    c[1] = rect[1]!;
    c[2] = rect[2]!;
    c[3] = rect[3]!;
    set.dirty = true;
    set.marks++;
    return;
  }
  if (rect[0]! < c[0]!) c[0] = rect[0]!;
  if (rect[1]! < c[1]!) c[1] = rect[1]!;
  if (rect[2]! > c[2]!) c[2] = rect[2]!;
  if (rect[3]! > c[3]!) c[3] = rect[3]!;
}

/**
 * 0x43C258: the pixel at (x, y), -1 outside the buffer. Mode 1 is the colour 0xRRGGBB, 2 the
 * alpha, 3 the whole 0xAARRGGBB as a signed 32-bit value.
 */
function pixel(cg: YurisCg, x: number, y: number, mode: 1 | 2 | 3): bigint {
  if (!cg.pixels || x < 0 || y < 0 || x >= cg.width || y >= cg.height) return -1n;
  const p = (y * cg.width + x) * 4,
    b = cg.pixels;
  if (mode === 2) return BigInt(b[p + 3]!);
  const rgb = b[p]! | (b[p + 1]! << 8) | (b[p + 2]! << 16);
  return mode === 1 ? BigInt(rgb) : BigInt(rgb | (b[p + 3]! << 24) | 0);
}

/**
 * CGINFO TRIM: the bounding box of the pixels whose alpha exceeds `threshold`; `side` 1 is the
 * top row, 2 the bottom row, 3 the left column, 4 the right column, -1 when none qualifies.
 */
function trim(cg: YurisCg, threshold: number, side: number): bigint {
  let top = -1,
    bottom = -1,
    left = -1,
    right = -1;
  const b = cg.pixels;
  if (b)
    for (let y = 0; y < cg.height; y++)
      for (let x = 0; x < cg.width; x++) {
        if (b[(y * cg.width + x) * 4 + 3]! <= threshold) continue;
        if (top < 0) {
          top = bottom = y;
          left = right = x;
        } else {
          left = Math.min(left, x);
          right = Math.max(right, x);
          bottom = y;
        }
      }
  switch (side) {
    case 1:
      return BigInt(top);
    case 2:
      return BigInt(bottom);
    case 3:
      return BigInt(left);
    case 4:
      return BigInt(right);
  }
  return 0n;
}

/**
 * Whether an image load selects the masked blitters (cg+0xA8). 0x41A69C and YSPNG.DLL
 * 0x10001014 set it for PNG color types 4 and 6 (IHDR), even when every alpha byte is zero or
 * 255; WebP sets it at 0x418910. Version 500 (Relirium.exe loader thread 0x448F80) also sets it
 * for a PNG with a tRNS chunk (0x44B1BC, spng_get_trns 0x426F3C), and always for YDG
 * (0x4499FC) and QOI (0x449438).
 */
function maskedImage(type: YurisFileType, data: Uint8Array, version: number): boolean {
  switch (type) {
    case YurisFileType.Webp:
    case YurisFileType.Ydg:
    case YurisFileType.Qoi:
      return true;
    case YurisFileType.Png:
      return (
        data[25] === 4 ||
        data[25] === 6 ||
        (version === YBN_VERSION_500 && pngHasChunk(data, 'tRNS'))
      );
    default:
      return false;
  }
}

/** Whether a PNG has `tag` before its first IDAT chunk. */
function pngHasChunk(data: Uint8Array, tag: string): boolean {
  for (let offset = 8; offset + 8 <= data.length;) {
    const length =
      ((data[offset]! << 24) |
        (data[offset + 1]! << 16) |
        (data[offset + 2]! << 8) |
        data[offset + 3]!) >>>
      0;
    const name = String.fromCharCode(
      data[offset + 4]!,
      data[offset + 5]!,
      data[offset + 6]!,
      data[offset + 7]!,
    );
    if (name === tag) return true;
    if (name === 'IDAT') return false;
    offset += 12 + length;
  }
  return false;
}
