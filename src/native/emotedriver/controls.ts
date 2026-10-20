import {EmoteOrbit, type EmoteOrbitSettings} from './runtime/controls/orbit.js';
import {EmoteMouth} from './runtime/controls/mouth.js';
import {EmoteSelector, type EmoteSelectorTransition} from './runtime/controls/selector.js';
import {EmoteEye} from './runtime/controls/eye.js';
import {EmoteEyebrow} from './runtime/controls/eyebrow.js';
import {EMOTEDRIVER_X64_SHA256} from './build.js';
import {EmoteGraph as SharedGraph, EmoteGraphFollower} from './runtime/controls/graph.js';
import {EmoteXorshift128} from './runtime/controls/random.js';

/**
 * Automatic face controls of the E-mote 3.9.8 player (`emotedriver.dll` x64, SHA-256
 * `80d28bd088dda8e97c7c47a9c664e55159f70505b0f9fde3158d8ce2a3e1e051`): the gaze graph walk
 * (`EPEyeControl`, `EPEyebrowControl`), blinking, the mouth tween, `selectorControl` and
 * `orbitControl`. Each control is stepped from the Progress sub-step loop (0x18000d3f0) and
 * writes its result into the player's variable values.
 */

/**
 * Process-wide generator of 0x180028950, an xorshift variant whose last word mixes
 * `((w >> 11) ^ t) >> 8`. The native fourth word is seeded from `_time64`.
 */
export class EmoteRandom extends EmoteXorshift128 {
  constructor(seed: number) {
    super(seed >>> 0);
  }
}

type Segment = readonly [number, number];

/** Compatibility names for the x64 bindings over the shared exact-build graph. */
export class EmoteGraph extends SharedGraph {
  constructor(edges: readonly Segment[], nodes: readonly (readonly number[])[]) {
    super(edges, nodes, EMOTEDRIVER_X64_SHA256);
  }
  get cost(): number {
    return this.total;
  }
  set cost(value: number) {
    this.total = value;
  }
  edgeOf(value: number): number {
    return this.edgeAt(value);
  }
  path(from: number, to: number): Segment[] {
    return this.search(from, to);
  }
}

/**
 * The graph walker shared by the eye (+0x20…+0xd0) and eyebrow (+0x8…+0xa8) controls: the
 * value moves along the path's segments with `powf` easing over the whole path length.
 */
export class EmoteGraphWalker extends EmoteGraphFollower {
  get current(): number {
    return this.value;
  }
  set current(value: number) {
    this.value = value;
  }
  step(frames: number): void {
    this.advance(frames);
  }
}

export interface EmoteEyeSettings {
  readonly label: string;
  readonly beginFrame: number;
  readonly endFrame: number;
  readonly blinkIntervalMin: number;
  readonly blinkIntervalMax: number;
  readonly blinkFrameCount: number;
  readonly blinkEnabled: boolean;
  readonly edge: readonly (readonly [number, number])[];
  readonly node: readonly (readonly number[])[];
}

/** `EPEyeControl` (0xf8 bytes, loader 0x180014640, step 0x180028ab0). */
export class EmoteEyeControl extends EmoteEye {
  private readonly nextRandom: () => number;
  constructor(settings: EmoteEyeSettings, random: EmoteRandom) {
    const nextRandom = () => random.next();
    super(settings, nextRandom, EMOTEDRIVER_X64_SHA256);
    this.nextRandom = nextRandom;
  }
  get walker(): EmoteGraphFollower {
    return this.motion;
  }
  step(frames: number): number {
    return this.update(frames, this.nextRandom);
  }
}

export interface EmoteEyebrowSettings {
  readonly label: string;
  readonly beginFrame: number;
  readonly edge: readonly (readonly [number, number])[];
  readonly node: readonly (readonly number[])[];
}

/** `EPEyebrowControl` (loader 0x180015540, step 0x180027f20): the walk without blinking. */
export class EmoteEyebrowControl extends EmoteEyebrow {
  constructor(settings: EmoteEyebrowSettings) {
    super(settings, EMOTEDRIVER_X64_SHA256);
  }
  get walker(): EmoteGraphFollower {
    return this.motion;
  }
  step(frames: number): number {
    return this.update(frames);
  }
}

/**
 * `mouthControl` entry (+0x168, 0x48 bytes): `label` holds an integer shape index, `talkLabel`
 * a tweened opening.
 */
export class EmoteMouthControl extends EmoteMouth {
  constructor(label: string, talkLabel: string) {
    super({enabled: true, label, talkLabel, beginFrame: 0, unread: {}}, EMOTEDRIVER_X64_SHA256);
  }
  get shape(): number {
    return this.frame;
  }
  set shape(value: number) {
    this.frame = value;
  }
}

export interface EmoteSelectorOption {
  /** The linked `transitionControl` tween, or null when no entry has the label. */
  readonly tween: EmoteSelectorTransition | null;
  readonly offValue: number;
  readonly onValue: number;
}

/** `EPSelectorControl` (0x58 bytes, loader 0x180017a50): one option on, the others off. */
export class EmoteSelectorControl extends EmoteSelector {
  constructor(label: string, options: readonly EmoteSelectorOption[]) {
    super(
      {
        label,
        optionList: options.map((option, index) => ({
          label: String(index),
          offValue: option.offValue,
          onValue: option.onValue,
        })),
        unread: {},
      },
      (label) => options[Number(label)]?.tween ?? null,
      EMOTEDRIVER_X64_SHA256,
    );
  }
  step(frames: number): number {
    return this.update(frames);
  }
}

export type {EmoteOrbitSettings} from './runtime/controls/orbit.js';

/** Compatibility constructor for x64 orbit controls. */
export class EmoteOrbitControl extends EmoteOrbit {
  constructor(settings: EmoteOrbitSettings) {
    super(settings, EMOTEDRIVER_X64_SHA256);
  }
}
