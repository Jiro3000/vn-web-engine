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
const REACH_EPSILON = f32(0.0001);
/** Blink speed factor 2.5 (0x181fcd578) and hold divisor 5 (0x181fcd58c). */
const BLINK_SPEED = f32(2.5);
const BLINK_HOLD = f32(5);
/** `FLT_EPSILON` (0x181fcd510). */
const FLT_EPSILON = f32(2 ** -23);

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

interface WalkEntry {
  readonly value: number;
  readonly frames: number;
  readonly power: number;
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
export class EmoteEyeControl {
  readonly label: string;
  readonly walker: EmoteGraphWalker;
  private readonly begin: number;
  private readonly end: number;
  private readonly blinkMin: number;
  private readonly blinkMax: number;
  private readonly blinkFrames: number;
  /** +0xc8 (the API toggles it). */
  blinkEnabled: number;
  /** +0xbc: 0 open, 10 closing, 11 closed, 12 opening. */
  blinkState = 0;
  private blinkPos: number;
  private blinkTimer: number;

  constructor(
    s: EmoteEyeSettings,
    private readonly random: EmoteRandom,
  ) {
    this.label = s.label;
    this.begin = f32(s.beginFrame);
    this.end = f32(s.endFrame);
    this.blinkMin = f32(s.blinkIntervalMin);
    this.blinkMax = f32(s.blinkIntervalMax);
    this.blinkFrames = f32(s.blinkFrameCount);
    this.blinkEnabled = s.blinkEnabled ? 1 : 0;
    this.walker = new EmoteGraphWalker(
      new EmoteGraph(
        s.edge.map(([a, b]) => [f32(a), f32(b)] as const),
        s.node.map((n) => n.map(f32)),
      ),
      this.begin,
    );
    this.blinkPos = this.begin;
    this.blinkTimer = this.interval();
  }

  /** `setBlinkEnabled`: disabling restarts the blink cycle with an open eye. */
  setBlinkEnabled(enabled: boolean): void {
    const b = enabled ? 1 : 0;
    if (b === this.blinkEnabled) return;
    this.blinkEnabled = b;
    if (b === 0) {
      this.blinkState = 0;
      this.blinkPos = this.begin;
      this.blinkTimer = this.interval();
    }
  }

  private interval(): number {
    return f32(f32(this.random.next() * f32(this.blinkMax - this.blinkMin)) + this.blinkMin);
  }

  /** Steps the walk and the blink, then returns the output value. */
  step(frames: number): number {
    const dt = f32(frames);
    this.walker.step(dt);
    const speed = f32(f32(dt * BLINK_SPEED) / this.blinkFrames);
    const range = f32(this.end - this.begin);
    for (;;) {
      if (this.blinkState === 0) {
        if (this.blinkEnabled !== 0 && Math.trunc(this.blinkPos) === this.begin) {
          this.blinkTimer = f32(this.blinkTimer - dt);
          if (this.blinkTimer <= 0) {
            this.blinkState = 10;
            continue;
          }
        }
        break;
      }
      if (this.blinkState === 10) {
        this.blinkPos = f32(this.blinkPos + f32(range * speed));
        if (this.blinkPos >= this.end) {
          this.blinkState = 11;
          this.blinkPos = this.end;
          this.blinkTimer = f32(this.blinkFrames / BLINK_HOLD);
        }
        break;
      }
      if (this.blinkState === 11) {
        this.blinkTimer = f32(this.blinkTimer - dt);
        if (this.blinkTimer <= 0) {
          this.blinkState = 12;
          this.blinkTimer = this.interval();
        }
        break;
      }
      if (this.blinkState === 12) {
        this.blinkPos = f32(this.blinkPos - f32(speed * range));
        if (this.blinkPos <= this.begin) {
          this.blinkPos = this.begin;
          this.blinkState = 0;
          continue;
        }
        break;
      }
      break;
    }
    return this.output();
  }

  output(): number {
    const cur = this.walker.current;
    if (this.begin <= cur && cur <= this.end) {
      return f32(
        f32(
          f32(f32(this.blinkPos - this.begin) * f32(this.end - cur)) / f32(this.end - this.begin),
        ) + cur,
      );
    }
    return cur;
  }
}

export interface EmoteEyebrowSettings {
  readonly label: string;
  readonly beginFrame: number;
  readonly edge: readonly (readonly [number, number])[];
  readonly node: readonly (readonly number[])[];
}

/** `EPEyebrowControl` (loader 0x180015540, step 0x180027f20): the walk without blinking. */
export class EmoteEyebrowControl {
  readonly label: string;
  readonly walker: EmoteGraphWalker;

  constructor(s: EmoteEyebrowSettings) {
    this.label = s.label;
    this.walker = new EmoteGraphWalker(
      new EmoteGraph(
        s.edge.map(([a, b]) => [f32(a), f32(b)] as const),
        s.node.map((n) => n.map(f32)),
      ),
      f32(s.beginFrame),
    );
  }

  step(frames: number): number {
    this.walker.step(frames);
    return this.walker.current;
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
  readonly tween: EmoteTween | null;
  readonly offValue: number;
  readonly onValue: number;
}

/** `EPSelectorControl` (0x58 bytes, loader 0x180017a50): one option on, the others off. */
export class EmoteSelectorControl {
  private queue: WalkEntry[] = [];
  /** +0x30. */
  selected = 0;
  private state = 0;
  private inv = 0;
  private t = 0;

  constructor(
    readonly label: string,
    readonly options: readonly EmoteSelectorOption[],
  ) {
    this.select(0, 0, 0);
  }

  /** 0x18002bfa0. */
  private select(index: number, frames: number, power: number): void {
    this.selected = index;
    for (let i = 0; i < this.options.length; i++) {
      const o = this.options[i]!;
      if (!o.tween) continue;
      const target = i === index ? o.onValue : o.offValue;
      const cur = o.tween.step(0)[0]!;
      if (o.tween.busy || Math.abs(f32(cur - target)) >= FLT_EPSILON) {
        const span = Math.abs(f32(f32(cur - target) / f32(o.onValue - o.offValue)));
        o.tween.set([target], f32(span * f32(frames)), power, false);
      }
    }
  }

  get busy(): boolean {
    return this.state !== 0 || this.queue.length !== 0;
  }

  /** setVariable kind 8. */
  set(value: number, frames: number, power: number, queuing: boolean): void {
    const fr = f32(frames);
    if (fr <= 0) {
      this.queue = [];
      this.state = 0;
      this.select(Math.trunc(value), 0, 0);
      return;
    }
    if (queuing) {
      this.queue.push({value: f32(value), frames: fr, power});
      return;
    }
    this.queue = [{value: f32(value), frames: fr, power}];
    this.state = 0;
  }

  /** 0x180018450. */
  skip(): void {
    const last = this.queue[this.queue.length - 1];
    if (!last) {
      if (this.state !== 0) {
        this.state = 0;
        this.select(this.selected, 0, 0);
      }
      return;
    }
    this.state = 0;
    this.select(Math.trunc(last.value), 0, 0);
    this.queue = [];
  }

  /** Returns the selected index as the variable value. */
  step(frames: number): number {
    const dt = f32(frames);
    for (;;) {
      if (this.state !== 0) {
        if (this.state === 1) {
          this.t = f32(f32(dt * this.inv) + this.t);
          if (f32(this.t - 1) < -REACH_EPSILON) break;
          this.t = 1;
          this.state = 0;
        }
      }
      const entry = this.queue.shift();
      if (!entry) break;
      this.select(Math.trunc(entry.value), entry.frames, entry.power);
      this.state = 1;
      this.t = 0;
      this.inv = f32(1 / entry.frames);
    }
    return this.selected;
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
