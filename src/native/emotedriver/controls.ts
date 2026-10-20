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

import {EmoteTween} from './tween.js';

const f32 = Math.fround;

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
export class EmoteMouthControl {
  /** Object +0x34. */
  shape = 0;
  readonly talk = new EmoteTween(1);

  constructor(
    readonly label: string,
    readonly talkLabel: string,
  ) {}
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

export interface EmoteOrbitSettings {
  readonly label: string;
  readonly interval: number;
  readonly tween: boolean;
  readonly orbitFrameList: readonly number[];
}

/** `orbitControl` entry (+0x290, 0x48 bytes, loader 0x18001b190): a cycling value list. */
export class EmoteOrbitControl {
  readonly label: string;
  private reset = true;
  private time = 0;
  private readonly interval: number;
  private readonly tween: boolean;
  private readonly values: readonly number[];

  constructor(s: EmoteOrbitSettings) {
    this.label = s.label;
    this.interval = f32(s.interval);
    this.tween = s.tween;
    this.values = s.orbitFrameList.map(f32);
  }

  /** Returns the `setVariable` call the step makes, or null. */
  step(frames: number): {value: number; frames: number} | null {
    const n = this.values.length;
    let index: number;
    if (this.reset) {
      this.time = 0;
      this.reset = false;
      index = 0;
    } else {
      const old = this.time;
      this.time = fmodf(f32(old + f32(frames)), this.interval);
      index = Math.trunc(f32(f32(this.time * n) / this.interval));
      if (index === Math.trunc(f32(f32(n * old) / this.interval))) return null;
    }
    const value = this.values[index] ?? 0;
    const fr = this.tween ? f32(f32(f32(this.interval / n) * (index + 1)) - this.time) : 0;
    return {value, frames: fr};
  }
}

/** CRT `fmodf`. */
export function fmodf(x: number, y: number): number {
  return f32(f32(x) % f32(y));
}
