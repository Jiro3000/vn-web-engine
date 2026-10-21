import {emoteBuild, EMOTEDRIVER_X86_SHA256, EMOTEDRIVER_X64_SHA256} from '../../build.js';
import {
  composeEmoteMatrix,
  multiplyEmoteMatrices,
  type EmoteMatrixTarget,
  type EmoteMatrixValues,
} from './matrix.js';

/** Evaluated or adjustment block, independent of the native node layout. */
export interface EmoteTransformState {
  changed: boolean;
  visible: boolean;
  shown: boolean;
  flipX: boolean;
  flipY: boolean;
  x: number;
  y: number;
  z: number;
  angle: number;
  zoomX: number;
  zoomY: number;
  slantX: number;
  slantY: number;
  opacity: number;
}
export interface EmoteLayerState extends EmoteTransformState {
  copyFrom(source: EmoteTransformState): void;
  inheritTransform(parent: EmoteTransformState, mask: number): void;
  removeTransform(parent: EmoteTransformState, mask: number): void;
}

/** Existing array or scalar storage; no per-layer proxy or copy is needed. */
export interface EmoteLayerTransform {
  readonly adjust: EmoteTransformState;
  readonly parent: number;
  readonly cur: {readonly empty: boolean};
  readonly framesDirty: boolean;
  readonly coordinate: number;
  readonly inheritMask: number;
  readonly meshKind: number;
  readonly transformOrder: readonly number[];
}
export interface EmoteLayerEvaluation<Node extends EmoteLayerTransform> {
  syncToParentMesh(parent: Node, node: Node): void;
  evaluateFrame(node: Node, force: boolean): boolean;
}

/** X86 evaluated block and native float matrix storage. */
export interface EmoteBlockLayerTransform extends EmoteLayerTransform {
  readonly state: EmoteLayerState;
  readonly matrix: Float32Array;
}
/** X64 evaluated fields and matrix occupy the layer itself. */
export interface EmoteScalarLayerTransform
  extends EmoteLayerTransform, EmoteLayerState, EmoteMatrixValues, EmoteMatrixTarget {}
/** Layer evaluation selected once by exact image, retaining native storage and float stores. */
export class EmoteLayerPass {
  readonly evaluate: <Node extends EmoteLayerTransform>(
    host: EmoteLayerEvaluation<Node>,
    nodes: readonly Node[],
    force: boolean,
    independent: boolean,
  ) => void;
  constructor(driverSha256 = EMOTEDRIVER_X86_SHA256) {
    this.evaluate = emoteBuild(driverSha256) === EMOTEDRIVER_X64_SHA256 ? evaluateX64 : evaluateX86;
  }
}
const f = Math.fround,
  f32 = Math.fround;
/** 0x1003ece0: array/block layout; frame and mesh evaluation stay on the clip. */
function evaluateX86<Node extends EmoteLayerTransform>(
  host: EmoteLayerEvaluation<Node>,
  nodes: readonly Node[],
  clipForce: boolean,
  independent: boolean,
): void {
  const root = nodes[0]! as Node & EmoteBlockLayerTransform;
  for (let i = 1; i < nodes.length; i++) {
    const node = nodes[i]! as Node & EmoteBlockLayerTransform;

    let parent = nodes[node.parent]! as Node & EmoteBlockLayerTransform;
    while (parent.inheritMask & 0x400000)
      parent = nodes[parent.parent]! as Node & EmoteBlockLayerTransform;
    const currentFrame = node.cur;
    const force = clipForce || parent.state.changed || node.adjust.changed;
    if (!host.evaluateFrame(node, force)) continue;
    node.adjust.changed = false;
    const s = node.state,
      p = parent.state;
    if (currentFrame.empty) {
      const changed = p.changed || node.framesDirty;
      s.copyFrom(p);
      s.changed = changed;
      s.visible = false;
      s.shown = p.shown && node.adjust.shown;
      node.matrix.set(parent.matrix);
      continue;
    }
    const a = node.adjust;
    s.changed = true;
    s.shown = a.shown && p.shown;
    s.visible = a.visible && s.shown;
    s.flipX = s.flipX !== a.flipX;
    s.flipY = s.flipY !== a.flipY;
    s.angle = f(a.angle + s.angle);
    s.zoomX = f(a.zoomX * s.zoomX);
    s.zoomY = f(a.zoomY * s.zoomY);
    s.slantX = f(a.slantX + s.slantX);
    s.slantY = f(a.slantY + s.slantY);
    s.opacity = Math.trunc(Math.imul(a.opacity, s.opacity) / 255) >>> 0;
    s.x = f(a.x + s.x);
    s.y = f(a.y + s.y);
    s.z = f(a.z + s.z);
    if (parent.meshKind !== 0) host.syncToParentMesh(parent, node);
    const m = parent.matrix;
    let lx: number, ly: number, lz: number;
    if (node.coordinate === 0) {
      lx = f(m[1]! * s.y + m[0]! * s.x);
      ly = f(m[2]! * s.x + m[3]! * s.y);
      lz = s.z;
    } else {
      lx = f(m[0]! * s.x + s.z * m[1]!);
      lz = f(m[2]! * s.x + m[3]! * s.z);
      ly = s.y;
    }
    s.x = f(p.x + lx);
    s.y = f(p.y + ly);
    s.z = f(p.z + lz);
    const mask = node.inheritMask;
    if (mask & 0x400) s.opacity = Math.trunc(Math.imul(p.opacity, s.opacity) / 255) >>> 0;
    else if (!independent)
      s.opacity = Math.trunc(Math.imul(root.state.opacity, s.opacity) / 255) >>> 0;
    if ((mask & 0x1fc) === 0x1fc) {
      composeEmoteMatrix(node.state, node.transformOrder, node.matrix);
      multiplyEmoteMatrices(m, node.matrix, node.matrix);
      s.flipX = s.flipX !== p.flipX;
      s.flipY = s.flipY !== p.flipY;
      s.angle = f(p.angle + s.angle);
      s.zoomX = f(p.zoomX * s.zoomX);
      s.zoomY = f(p.zoomY * s.zoomY);
      s.slantX = f(p.slantX + s.slantX);
      s.slantY = f(p.slantY + s.slantY);
      continue;
    }
    s.inheritTransform(p, mask);
    if (independent) {
      composeEmoteMatrix(node.state, node.transformOrder, node.matrix);
      continue;
    }
    const r = root.state;
    s.removeTransform(r, mask);
    composeEmoteMatrix(node.state, node.transformOrder, node.matrix);
    s.inheritTransform(r, mask);
    multiplyEmoteMatrices(root.matrix, node.matrix, node.matrix);
  }
}
/** 0x180043010: direct scalar stores avoid per-node layout dispatch. */
function evaluateX64<Node extends EmoteLayerTransform>(
  host: EmoteLayerEvaluation<Node>,
  nodes: readonly Node[],
  clipForce: boolean,
  independent: boolean,
): void {
  const root = nodes[0]! as Node & EmoteScalarLayerTransform;
  for (let k = 1; k < nodes.length; k++) {
    const n = nodes[k]! as Node & EmoteScalarLayerTransform;
    const a = n.adjust;
    const D = nodes[n.parent]! as Node & EmoteScalarLayerTransform;
    let P = D;
    while (P.inheritMask & 0x400000) P = nodes[P.parent]! as Node & EmoteScalarLayerTransform;
    const force = clipForce || P.changed || D.changed || a.changed;
    if (!host.evaluateFrame(n, force)) continue;
    a.changed = false;
    if (n.cur.empty) {
      n.changed = P.changed || n.framesDirty;
      n.visible = false;
      n.flipX = P.flipX;
      n.flipY = P.flipY;
      n.x = P.x;
      n.y = P.y;
      n.z = P.z;
      n.angle = P.angle;
      n.zoomX = P.zoomX;
      n.zoomY = P.zoomY;
      n.slantX = P.slantX;
      n.slantY = P.slantY;
      n.opacity = P.opacity;
      n.shown = P.shown && a.shown;
      n.setMatrix(P.m00, P.m01, P.m10, P.m11);
      continue;
    }
    n.changed = true;
    n.shown = a.shown && P.shown;
    n.visible = a.visible && n.shown;
    n.flipX = n.flipX !== a.flipX;
    n.flipY = n.flipY !== a.flipY;
    n.angle = f32(a.angle + n.angle);
    n.zoomX = f32(a.zoomX * n.zoomX);
    n.zoomY = f32(a.zoomY * n.zoomY);
    n.slantX = f32(a.slantX + n.slantX);
    n.slantY = f32(a.slantY + n.slantY);
    n.opacity = Math.floor(((a.opacity * n.opacity) >>> 0) / 255);
    n.x = f32(a.x + n.x);
    n.y = f32(a.y + n.y);
    n.z = f32(a.z + n.z);
    if (P.meshKind !== 0) host.syncToParentMesh(P, n);
    const x = n.x,
      y = n.y,
      z = n.z;
    if (P.coordinate === 0) {
      n.x = f32(y * P.m01 + x * P.m00 + P.x);
      n.y = f32(f32(x * P.m10 + y * P.m11) + P.y);
      n.z = f32(z + P.z);
    } else {
      n.x = f32(z * P.m01 + x * P.m00 + P.x);
      n.y = f32(y + P.y);
      n.z = f32(f32(z * P.m11 + x * P.m10) + P.z);
    }
    if (n.inheritMask & 0x400) n.opacity = Math.floor(((P.opacity * n.opacity) >>> 0) / 255);
    else if (!independent) n.opacity = Math.floor(((root.opacity * n.opacity) >>> 0) / 255);
    if ((n.inheritMask & 0x1fc) === 0x1fc) {
      composeEmoteMatrix(n, n.transformOrder, n, EMOTEDRIVER_X64_SHA256);
      multiplyEmoteMatrices(P, n, n, EMOTEDRIVER_X64_SHA256);
      n.flipX = n.flipX !== P.flipX;
      n.flipY = n.flipY !== P.flipY;
      n.angle = f32(P.angle + n.angle);
      n.zoomX = f32(P.zoomX * n.zoomX);
      n.zoomY = f32(P.zoomY * n.zoomY);
      n.slantX = f32(P.slantX + n.slantX);
      n.slantY = f32(P.slantY + n.slantY);
    } else {
      const m = n.inheritMask;
      n.inheritTransform(P, m);
      if (!independent) {
        n.removeTransform(root, m);
        composeEmoteMatrix(n, n.transformOrder, n, EMOTEDRIVER_X64_SHA256);
        n.inheritTransform(root, m);
        multiplyEmoteMatrices(root, n, n, EMOTEDRIVER_X64_SHA256);
      } else composeEmoteMatrix(n, n.transformOrder, n, EMOTEDRIVER_X64_SHA256);
    }
  }
}
