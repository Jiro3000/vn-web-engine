import {EmoteUnsupportedError} from './runtime/errors.js';
import type {IEmotePlayer} from './contract.js';
import {EmotePlayerCore, compareEmoteUtf8, type EmotePlayerClip} from './runtime/player-core.js';
import type {EmoteX64ClipPlayerAccess} from './runtime/interfaces.js';
import {createEmoteControls} from './runtime/controls/index.js';
import {EMOTEDRIVER_X64_SHA256} from './build.js';
import type {EmoteModel} from '../../formats/emote/model.js';
import type {EmoteDrawItem} from './clip.js';

const f32 = Math.fround;

/** `getEmoteVersion` text of this driver build. */
export const EMOTE_DRIVER_VERSION = '3.9.8';
export const EMOTE_DRIVER_BUILD = '2022/12/28-13:02:35';

export {EmoteUnsupportedError} from './runtime/errors.js';

export interface EmoteClip {
  /** 0x180037330. */
  setVariable(label: string, value: number): void;
  /** 0x180037cf0. */
  getVariable(label: string): number;
  /** 0x18003f720. */
  progress(frames: number): void;
  /** 0x180038bc0 as inlined by the player: object selection plus the pending object. */
  selectObject(name: string): void;
  /** 0x180038cb0. */
  setMotion(name: string, flags?: number): void;
  /** +0x1c8: packed colour, channel 0 in the low byte. */
  color: number;
  /** Root node (+0x1e8): +0x348/+0x34c coordinates, +0x358/+0x35c zoom, +0x354 angle (deg). */
  rootX: number;
  rootY: number;
  rootZoomX: number;
  rootZoomY: number;
  rootAngle: number;
  /** Root +0x340 (dirty) and +0x342 (visible). */
  rootDirty: boolean;
  visible: boolean;
  /** +0x158: the clip rotates itself (angle +0x15c, applied by 0x1800390e0(clip, 2)). */
  readonly ownRotation: boolean;
  setOwnRotation(degrees: number): void;
  readonly ownRotationAngle: number;
  /** 0x180038a10: blend mode 5 with `level` (0–255), or 0. */
  setGrayscale(mode: number, level: number): void;
  readonly grayscaleMode: number;
  readonly grayscaleLevel: number;
  /** +0x488. */
  meshDivisionRatio: number;
  /** Device +0x88. */
  smoothing: boolean;
  /** +0x4b0: the draw list `progress` rebuilds, in node order. */
  readonly drawList: readonly EmoteDrawItem[];
  /** Any node +0x35 flag. */
  readonly modified: boolean;
  /** 0x18000e6d0 clip part: the layer's world position when it is a plain layer. */
  layerPosition(name: string): readonly [number, number] | null;
}

export {compareEmoteUtf8 as compareUtf8};

export interface EmotePlayerOptions {
  /** Process-wide generator shared by blinking and wind. */
  readonly random: {next(): number};
}

/** Bridges the legacy combined clip pass until its layer evaluator is shared. */
function x64ClipAccess(clip: EmoteClip): EmotePlayerClip & EmoteX64ClipPlayerAccess {
  return {
    // X64 physics uses layerPosition, not the x86 node-layout interface.
    get nodes(): never {
      throw new EmoteUnsupportedError('x86 node view of x64 clip');
    },
    nodeIndex(): never {
      throw new EmoteUnsupportedError('x86 node lookup of x64 clip');
    },
    applyVariable: (label, value) => clip.setVariable(label, value),
    getVariable: (label) => clip.getVariable(label),
    advance: (frames) => clip.progress(frames),
    // Legacy progress performs the layer pass and retires its events itself.
    evaluate() {},
    dispatchEvents() {},
    events: [],
    assignState(): never {
      throw new EmoteUnsupportedError('assignState');
    },
    get color() {
      return clip.color;
    },
    set color(value) {
      clip.color = value;
    },
    get rootVisible() {
      return clip.visible;
    },
    set rootVisible(value) {
      clip.visible = value;
    },
    get rootDirty() {
      return clip.rootDirty;
    },
    set rootDirty(value) {
      clip.rootDirty = value;
    },
    get smoothing() {
      return clip.smoothing;
    },
    set smoothing(value) {
      clip.smoothing = value;
    },
    get meshDivisionRatio() {
      return clip.meshDivisionRatio;
    },
    set meshDivisionRatio(value) {
      clip.meshDivisionRatio = value;
    },
    isModified: () => clip.modified,
    get ownRotation() {
      return clip.ownRotation;
    },
    get ownRotationAngle() {
      return clip.ownRotationAngle;
    },
    setOwnRotation: (degrees) => clip.setOwnRotation(degrees),
    setGrayscale: (mode, level) => clip.setGrayscale(mode, level),
    get grayscaleMode() {
      return clip.grayscaleMode;
    },
    get grayscaleLevel() {
      return clip.grayscaleLevel;
    },
    layerPosition(label) {
      const point = clip.layerPosition(label);
      return point ? {x: point[0], y: point[1]} : null;
    },
    setRootTransform(value) {
      clip.rootX = value.x;
      clip.rootY = value.y;
      clip.rootZoomX = value.scaleX;
      clip.rootZoomY = value.scaleY;
      clip.rootAngle = value.angle;
      // X64 mirrors matching variables; it does not reflect the clip root.
    },
  };
}

/** X64 binding of the shared player core, with the legacy clip calling convention. */
export class EmotePlayer {
  private readonly core: EmotePlayerCore;
  constructor(
    model: EmoteModel,
    readonly clip: EmoteClip,
    options: EmotePlayerOptions,
  ) {
    clip.selectObject(model.metadata.base.chara);
    clip.setMotion(model.metadata.base.motion);
    const access = x64ClipAccess(clip);
    this.core = new EmotePlayerCore({
      model,
      driverSha256: EMOTEDRIVER_X64_SHA256,
      random: () => options.random.next(),
      createClip: () => access,
      createControls: createEmoteControls,
    });
  }
  get metadata() {
    return this.core.model.metadata;
  }
  get timelines() {
    return this.core.timelines;
  }
  get suitableClearColor() {
    return this.core.getSuitableClearColor();
  }
  get queuing() {
    return this.core.queuing;
  }
  set queuing(value: boolean) {
    this.core.queuing = value;
  }
  get hairScale() {
    return this.core.hairScale;
  }
  set hairScale(value: number) {
    this.core.hairScale = value;
  }
  get partsScale() {
    return this.core.partsScale;
  }
  set partsScale(value: number) {
    this.core.partsScale = value;
  }
  get bustScale() {
    return this.core.bustScale;
  }
  set bustScale(value: number) {
    this.core.bustScale = value;
  }
  get flags() {
    return this.core.flags;
  }
  set flags(value: number) {
    this.core.flags = value;
  }
  get physicsAngle() {
    return this.core.physicsAngle;
  }
  getCoord(): [number, number] {
    const value = this.core.getCoord();
    return [value.x, value.y];
  }
  basePosition(label: string): readonly [number, number] | null {
    const value = this.core.physicsBasePosition(label);
    return value ? [value.x, value.y] : null;
  }
  setValue(label: string, value: number): void {
    this.core.cell(label).value = Math.fround(value);
  }
  setStereovisionEnabled(value: boolean): void {
    if (value) throw new EmoteUnsupportedError('stereovision');
  }
  getStereovisionEnabled(): boolean {
    return false;
  }

  countVariables(): number {
    return this.core.countVariables();
  }
  getVariableLabelAt(index: number): string {
    return this.core.getVariableLabelAt(index);
  }
  countVariableFrameAt(index: number): number {
    return this.core.countVariableFrameAt(index);
  }
  getVariableFrameLabelAt(index: number, frame: number): string {
    return this.core.getVariableFrameLabelAt(index, frame);
  }
  getVariableFrameValueAt(index: number, frame: number): number {
    return this.core.getVariableFrameValueAt(index, frame);
  }
  addUserDefinedVariable(label: string): void {
    return this.core.addUserDefinedVariable(label);
  }
  setVariable(label: string, value: number, frames = 0, easing = 0): void {
    return this.core.setVariable(label, value, frames, easing);
  }
  getVariable(label: string): number {
    return this.core.getVariable(label);
  }
  setVariableDiff(module: string, label: string, value: number, frames = 0, easing = 0): void {
    return this.core.setVariableDiff(module, label, value, frames, easing);
  }
  getVariableDiff(module: string, label: string): number {
    return this.core.getVariableDiff(module, label);
  }
  setCoord(x: number, y: number, frames = 0, easing = 0): void {
    return this.core.setCoord(x, y, frames, easing);
  }
  setScale(scale: number, frames = 0, easing = 0): void {
    return this.core.setScale(scale, frames, easing);
  }
  getScale(): number {
    return this.core.getScale();
  }
  setRot(radians: number, frames = 0, easing = 0): void {
    return this.core.setRot(radians, frames, easing);
  }
  getRot(): number {
    return this.core.getRot();
  }
  setColor(color: number, frames = 0, easing = 0): void {
    return this.core.setColor(color, frames, easing);
  }
  getColor(): number {
    return this.core.getColor();
  }
  setGrayscale(value: number, frames = 0, easing = 0): void {
    return this.core.setGrayscale(value, frames, easing);
  }
  getGrayscale(): number {
    return this.core.getGrayscale();
  }
  setAsOriginalScale(value: boolean): void {
    return this.core.setAsOriginalScale(value);
  }
  isAsOriginalScale(): boolean {
    return this.core.isAsOriginalScale();
  }
  setOuterForce(label: string, x: number, y: number, frames = 0, easing = 0): void {
    return this.core.setOuterForce(label, x, y, frames, easing);
  }
  getOuterForce(label: string): [number, number] {
    return this.core.getOuterForce(label);
  }
  setOuterRot(radians: number, frames = 0, easing = 0): void {
    return this.core.setOuterRot(radians, frames, easing);
  }
  getOuterRot(): number {
    return this.core.getOuterRot();
  }
  startWind(start: number, end: number, power: number, maxWidth: number, minWidth: number): void {
    return this.core.startWind(start, end, power, maxWidth, minWidth);
  }
  stopWind(): void {
    return this.core.stopWind();
  }
  setMirror(value: boolean): void {
    return this.core.setMirror(value);
  }
  show(): void {
    return this.core.show();
  }
  hide(): void {
    return this.core.hide();
  }
  isHidden(): boolean {
    return this.core.isHidden();
  }
  setSmoothing(value: boolean): void {
    return this.core.setSmoothing(value);
  }
  getSmoothing(): boolean {
    return this.core.getSmoothing();
  }
  setMeshDivisionRatio(value: number): void {
    return this.core.setMeshDivisionRatio(value);
  }
  getMeshDivisionRatio(): number {
    return this.core.getMeshDivisionRatio();
  }
  isModified(): boolean {
    return this.core.isModified();
  }
  countMainTimelines(): number {
    return this.core.countMainTimelines();
  }
  getMainTimelineLabelAt(index: number): string {
    return this.core.getMainTimelineLabelAt(index);
  }
  countDiffTimelines(): number {
    return this.core.countDiffTimelines();
  }
  getDiffTimelineLabelAt(index: number): string {
    return this.core.getDiffTimelineLabelAt(index);
  }
  countPlayingTimelines(): number {
    return this.core.countPlayingTimelines();
  }
  getPlayingTimelineLabelAt(index: number): string {
    return this.core.getPlayingTimelineLabelAt(index);
  }
  getPlayingTimelineFlagsAt(index: number): number {
    return this.core.getPlayingTimelineFlagsAt(index);
  }
  isLoopTimeline(label: string): boolean {
    return this.core.isLoopTimeline(label);
  }
  getTimelineTotalFrameCount(label: string): number {
    return this.core.getTimelineTotalFrameCount(label);
  }
  playTimeline(label: string, flags = 0): void {
    return this.core.playTimeline(label, flags);
  }
  isTimelinePlaying(label: string): boolean {
    return this.core.isTimelinePlaying(label);
  }
  stopTimeline(label: string): void {
    return this.core.stopTimeline(label);
  }
  setTimelineBlendRatio(
    label: string,
    value: number,
    frames = 0,
    easing = 0,
    stopWhenDone = false,
  ): void {
    return this.core.setTimelineBlendRatio(label, value, frames, easing, stopWhenDone);
  }
  getTimelineBlendRatio(label: string): number {
    return this.core.getTimelineBlendRatio(label);
  }
  fadeInTimeline(label: string, frames = 0, easing = 0): void {
    return this.core.fadeInTimeline(label, frames, easing);
  }
  fadeOutTimeline(label: string, frames = 0, easing = 0): void {
    return this.core.fadeOutTimeline(label, frames, easing);
  }
  isCharaProfileAvailable(): boolean {
    return this.core.isCharaProfileAvailable();
  }
  getCharaHeight(): number {
    return this.core.getCharaHeight();
  }
  countCharaProfiles(): number {
    return this.core.countCharaProfiles();
  }
  getCharaProfileLabelAt(index: number): string {
    return this.core.getCharaProfileLabelAt(index);
  }
  getCharaProfile(label: string): number {
    return this.core.getCharaProfile(label);
  }
  getSuitableClearColor(): number {
    return this.core.getSuitableClearColor();
  }
  setBlinkEnabled(enabled: boolean): void {
    return this.core.setBlinkEnabled(enabled);
  }
  getBlinkEnabled(): boolean {
    return this.core.getBlinkEnabled();
  }
  isAnimating(): boolean {
    return this.core.isAnimating();
  }
  skip(): void {
    return this.core.skip();
  }
  step(): void {
    return this.core.step();
  }
  pass(): void {
    return this.core.pass();
  }
  progress(frames: number): void {
    return this.core.progress(frames);
  }
}

/**
 * `PEmotePlayer` (vtable 0x1007174c, 0x24 bytes): the exported player. Slots 0–55 delegate
 * to the player core (`MEmotePlayer`, `PEmotePlayer+0x10`); slot 56 draws through the
 * renderer the device supplies. Addresses refer to `emotedriver.dll` SHA-256
 * `a3b693b6…5e70b3a86`.
 */

/** Draws a player (slot 56, 0x10002b30). Supplied by the device. */
export interface EmotePlayerRenderer {
  render(player: PEmotePlayer): void;
}

/**
 * Renderer state shared by a player and its clones (`AMotionRenderer`, `PEmotePlayer+0xc`,
 * reference counted at +0x9c).
 */
export interface EmotePlayerRendererState {
  /** Renderer +0x98 (slots 7/8); 1 after construction (0x10058570). */
  smoothing: boolean;
}

export class PEmotePlayer implements IEmotePlayer {
  /** +0x4. */
  private refCount = 1;
  private destroyed = false;

  constructor(
    readonly core: EmotePlayerCore,
    readonly renderer: EmotePlayerRenderer,
    readonly rendererState: EmotePlayerRendererState = {smoothing: true},
    /** Called when the reference count reaches zero (slot 57). */
    private readonly onDestroy?: (player: PEmotePlayer) => void,
  ) {}

  /** Slot 0 (0x10001d90). */
  addRef(): number {
    return ++this.refCount;
  }

  /** Slot 1 (0x10001da0); slot 57 at zero. */
  release(): number {
    const n = --this.refCount;
    if (n === 0 && !this.destroyed) {
      this.destroyed = true;
      this.onDestroy?.(this);
    }
    return n;
  }

  /** Slot 2 (0x10001dc0 → 0x10001bd0): shares the renderer, copies the core (0x1000e000). */
  clone(): IEmotePlayer {
    return new PEmotePlayer(this.core.clone(), this.renderer, this.rendererState, this.onDestroy);
  }

  /** Slot 3 (0x10001e30 → 0x1000f2a0). Only players of this implementation are accepted. */
  assignState(source: IEmotePlayer): void {
    if (!(source instanceof PEmotePlayer)) {
      throw new TypeError('emotedriver: assignState needs a player of this runtime');
    }
    this.core.assignState(source.core);
  }

  show(): void {
    this.core.show();
  }

  hide(): void {
    this.core.hide();
  }

  isHidden(): boolean {
    return this.core.isHidden();
  }

  setSmoothing(enabled: boolean): void {
    this.rendererState.smoothing = enabled;
  }

  getSmoothing(): boolean {
    return this.rendererState.smoothing;
  }

  setMeshDivisionRatio(ratio: number): void {
    this.core.setMeshDivisionRatio(ratio);
  }

  getMeshDivisionRatio(): number {
    return this.core.getMeshDivisionRatio();
  }

  /** Slots 11/12 (0x10001f00/0x10001f10): core `p+0x30`. */
  setQueuing(enabled: boolean): void {
    this.core.queuing = enabled;
  }

  getQueuing(): boolean {
    return this.core.queuing;
  }

  /** Slots 13–18: `p+0x28`, `p+0x2c`, `p+0x24`. */
  setHairScale(scale: number): void {
    this.core.hairScale = f32(scale);
  }

  getHairScale(): number {
    return this.core.hairScale;
  }

  setPartsScale(scale: number): void {
    this.core.partsScale = f32(scale);
  }

  getPartsScale(): number {
    return this.core.partsScale;
  }

  setBustScale(scale: number): void {
    this.core.bustScale = f32(scale);
  }

  getBustScale(): number {
    return this.core.bustScale;
  }

  setCoord(x: number, y: number, frameCount: number, easing: number): void {
    this.core.setCoord(x, y, frameCount, easing);
  }

  getCoord(): {readonly x: number; readonly y: number} {
    return this.core.getCoord();
  }

  setScale(scale: number, frameCount: number, easing: number): void {
    this.core.setScale(scale, frameCount, easing);
  }

  getScale(): number {
    return this.core.getScale();
  }

  setRot(rot: number, frameCount: number, easing: number): void {
    this.core.setRot(rot, frameCount, easing);
  }

  getRot(): number {
    return this.core.getRot();
  }

  setColor(argb: number, frameCount: number, easing: number): void {
    this.core.setColor(argb, frameCount, easing);
  }

  getColor(): number {
    return this.core.getColor();
  }

  countVariables(): number {
    return this.core.countVariables();
  }

  getVariableLabelAt(index: number): string {
    return this.core.getVariableLabelAt(index);
  }

  countVariableFrameAt(index: number): number {
    return this.core.countVariableFrameAt(index);
  }

  getVariableFrameLabelAt(index: number, frame: number): string {
    return this.core.getVariableFrameLabelAt(index, frame);
  }

  getVariableFrameValueAt(index: number, frame: number): number {
    return this.core.getVariableFrameValueAt(index, frame);
  }

  setVariable(label: string, value: number, frameCount: number, easing: number): void {
    this.core.setVariable(label, value, frameCount, easing);
  }

  getVariable(label: string): number {
    return this.core.getVariable(label);
  }

  startWind(start: number, goal: number, speed: number, powerMin: number, powerMax: number): void {
    this.core.startWind(start, goal, speed, powerMin, powerMax);
  }

  stopWind(): void {
    this.core.stopWind();
  }

  /** Slots 36/37 (0x100022d0/0x10002300): `p+0x1a0`. */
  countMainTimelines(): number {
    return this.core.timelines.mainLabels.length;
  }

  getMainTimelineLabelAt(index: number): string {
    return this.core.timelines.mainLabels[index] ?? '';
  }

  /** Slots 38/39: `p+0x1b0`. */
  countDiffTimelines(): number {
    return this.core.timelines.diffLabels.length;
  }

  getDiffTimelineLabelAt(index: number): string {
    return this.core.timelines.diffLabels[index] ?? '';
  }

  /** Slots 40/41 (0x100023f0/0x10002420): `p+0x190`. */
  countPlayingTimelines(): number {
    return this.core.timelines.playing.length;
  }

  getPlayingTimelineLabelAt(index: number): string {
    // Index == count reads past the vector natively.
    return this.core.timelines.playing[index] ?? '';
  }

  /** Slot 42 (0x1001c9d0): play flags | 1, or 0. */
  getPlayingTimelineFlagsAt(index: number): number {
    return this.core.timelines.playingFlagsAt(index);
  }

  isLoopTimeline(label: string): boolean {
    return this.core.timelines.isLoop(label);
  }

  playTimeline(label: string, flags: number): void {
    this.core.timelines.play(label, flags & 0xff);
  }

  isTimelinePlaying(label: string): boolean {
    return this.core.timelines.isPlaying(label);
  }

  stopTimeline(label: string): void {
    this.core.timelines.stop(label);
  }

  setTimelineBlendRatio(
    label: string,
    value: number,
    frameCount: number,
    easing: number,
    stopWhenBlendDone: boolean,
  ): void {
    this.core.timelines.setBlendRatio(label, value, frameCount, easing, stopWhenBlendDone);
  }

  getTimelineBlendRatio(label: string): number {
    return this.core.timelines.getBlendRatio(label);
  }

  /** Slot 49 (0x100028f0). */
  fadeInTimeline(label: string, frameCount: number, easing: number): void {
    const t = this.core.timelines;
    if (!t.isPlaying(label)) {
      t.play(label, 3);
      t.setBlendRatio(label, 0, 0, 0, false);
    }
    t.setBlendRatio(label, 1, frameCount, easing, false);
  }

  /** Slot 50 (0x10002a00). */
  fadeOutTimeline(label: string, frameCount: number, easing: number): void {
    this.core.timelines.setBlendRatio(label, 0, frameCount, easing, true);
  }

  isAnimating(): boolean {
    return this.core.isAnimating();
  }

  skip(): void {
    this.core.skip();
  }

  pass(): void {
    this.core.pass();
  }

  progress(frameCount: number): void {
    this.core.progress(frameCount);
  }

  isModified(): boolean {
    return this.core.isModified();
  }

  /** Slot 56 (0x10002b30). */
  render(): void {
    this.renderer.render(this);
  }
}
