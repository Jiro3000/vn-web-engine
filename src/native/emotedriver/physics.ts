/**
 * Physics controls of the E-mote 3.9.8 player (`emotedriver.dll` x64, SHA-256
 * `80d28bd088dda8e97c7c47a9c664e55159f70505b0f9fde3158d8ce2a3e1e051`): the bust spring
 * (`EPBustControl`), the two-segment pendulum used by `hairControl` and `partsControl`
 * (`EPPendControl`) and the wind field (`EPWindControl`).
 *
 * Each control follows a base layer position, steps in sub-steps of at most 1.1 frames and
 * writes its outputs (`var_lr`, `var_ud`, and for pendulums `var_lrm`) into the player's
 * variable values after Progress applied the other variables to the clip.
 */

import type {EmoteBustControl, EmotePendulumControl} from '../../formats/emote/metadata.js';
import {EMOTEDRIVER_X64_SHA256} from './build.js';
import {EmoteWind as SharedWind} from './runtime/controls/wind.js';
import {EmoteBust as SharedBust} from './runtime/controls/bust.js';
import {
  EmotePendulum as SharedPendulum,
  type EmotePendulumOutput,
} from './runtime/controls/pendulum.js';
import type {EmoteWindField} from './runtime/interfaces.js';

const f32 = Math.fround;
/** Sub-step limit 1.1 (0x181fcd558), `FLT_EPSILON` (0x181fcd510). */
const SUB_STEP = f32(1.1);
const FLT_EPSILON = f32(2 ** -23);
/** Outputs at or below 0.01 in magnitude are written as 0 (0x181fcd520). */
const OUTPUT_EPSILON = f32(0.01);
/** The player state the controls read. */
export interface EmotePhysicsHost {
  /**
   * 0x18000e6d0: the base layer's world position after outer rotation and scale handling,
   * or null when the layer is missing or not a plain layer.
   */
  basePosition(layer: string): readonly [number, number] | null;
  /** Clip rotation plus outer rotation in radians (0x180018cb0 + outer tween). */
  readonly physicsAngle: number;
  /** `bustScale`, `hairScale`, `partsScale`. */
  readonly bustScale: number;
  readonly hairScale: number;
  readonly partsScale: number;
  readonly wind: EmoteWindField | null;
  setValue(label: string, value: number): void;
}

/** `bustControl` entry (+0xf0, 0xa0 bytes; loader 0x180011690, step 0x180012580). */
export class EmoteBust {
  private readonly spring: SharedBust;
  /** +0x8: the next step is the first after a reset. */
  private first = true;
  private prevX = 0;
  private prevY = 0;

  constructor(readonly control: EmoteBustControl) {
    this.spring = new SharedBust(control, EMOTEDRIVER_X64_SHA256);
  }

  /** 0x180012490 (one entry): restores the loaded state and zeroes the outputs. */
  reset(host: EmotePhysicsHost): void {
    this.spring.reset();
    this.first = true;
    host.setValue(this.control.var_lr, 0);
    host.setValue(this.control.var_ud, 0);
  }

  /** 0x180012580 (one entry); `force` is the accumulated outer force. */
  step(host: EmotePhysicsHost, dt: number, fx: number, fy: number): void {
    const base = host.basePosition(this.control.baseLayer) ?? [0, 0];
    const x = f32(base[0] + fx),
      y = f32(base[1] + fy);
    let out: [number, number] = [0, 0];
    if (!this.first) {
      let t = 0;
      const end = f32(dt - FLT_EPSILON);
      if (end > 0) {
        do {
          const h = f32(dt - t) <= SUB_STEP ? f32(dt - t) : SUB_STEP;
          t = f32(t + h);
          const r = f32(t / dt);
          out = this.spring.update(
            f32(f32(f32(1 - r) * this.prevX) + f32(r * x)),
            f32(f32(f32(1 - r) * this.prevY) + f32(r * y)),
            h,
            f32(host.bustScale),
            f32(host.physicsAngle),
          );
        } while (t < end);
      }
    } else {
      this.first = false;
      out = this.spring.update(x, y, 0, f32(host.bustScale), f32(host.physicsAngle));
    }
    this.prevX = x;
    this.prevY = y;
    let [lr, ud] = out;
    if (Math.abs(lr) <= OUTPUT_EPSILON && Math.abs(ud) <= OUTPUT_EPSILON) lr = ud = 0;
    host.setValue(this.control.var_lr, lr);
    host.setValue(this.control.var_ud, ud);
  }
}

/** `hairControl`/`partsControl` entry (0x108 bytes; loader 0x180013380, step 0x180014180). */
export class EmotePendulum {
  private readonly pend: SharedPendulum;
  private readonly out: EmotePendulumOutput = {lr: 0, lrm: 0, ud: 0};
  private first = true;
  private prevX = 0;
  private prevY = 0;

  constructor(readonly control: EmotePendulumControl) {
    this.pend = new SharedPendulum(control, EMOTEDRIVER_X64_SHA256);
  }

  /** 0x180014020 (one entry). */
  reset(host: EmotePhysicsHost): void {
    this.pend.reset();
    host.setValue(this.control.var_lr, 0);
    host.setValue(this.control.var_lrm, 0);
    host.setValue(this.control.var_ud, 0);
    this.first = true;
  }

  private sample(
    x: number,
    y: number,
    frames: number,
    scale: number,
    angle: number,
    wind: EmoteWindField | null,
  ): [number, number, number] {
    this.pend.update(x, y, frames, scale, angle, wind, this.out);
    return [this.out.lrm, this.out.lr, this.out.ud];
  }

  /** 0x180014180 (one entry). */
  step(host: EmotePhysicsHost, dt: number, scale: number, fx: number, fy: number): void {
    const base = host.basePosition(this.control.baseLayer) ?? [0, 0];
    const x = f32(base[0] + fx),
      y = f32(base[1] + fy);
    let lr = 0,
      lrm = 0,
      ud = 0;
    if (!this.first) {
      let t = 0;
      const end = f32(dt - FLT_EPSILON);
      if (end > 0) {
        do {
          const h = f32(dt - t) <= SUB_STEP ? f32(dt - t) : SUB_STEP;
          t = f32(t + h);
          const r = f32(t / dt);
          [lr, lrm, ud] = this.sample(
            f32(f32(f32(1 - r) * this.prevX) + f32(r * x)),
            f32(f32(f32(1 - r) * this.prevY) + f32(r * y)),
            h,
            f32(scale),
            f32(host.physicsAngle),
            host.wind,
          );
        } while (t < end);
      }
    } else {
      this.first = false;
      [lr, lrm, ud] = this.sample(x, y, 0, f32(scale), f32(host.physicsAngle), host.wind);
    }
    this.prevX = x;
    this.prevY = y;
    if (
      Math.abs(lrm) <= OUTPUT_EPSILON &&
      Math.abs(lr) <= OUTPUT_EPSILON &&
      Math.abs(ud) <= OUTPUT_EPSILON
    )
      lr = lrm = ud = 0;
    host.setValue(this.control.var_lr, lrm);
    host.setValue(this.control.var_lrm, lr);
    host.setValue(this.control.var_ud, ud);
  }
}

/**
 * `EPWindControl` (0x618 bytes, constructor 0x18002cc40, step 0x18002cfa0, `startWind`
 * 0x18001ac70): gusts of random width travel from `start` to `end` at `speed`.
 */
export class EmoteWind extends SharedWind {
  private readonly nextRandom: () => number;
  constructor(start: number, end: number, random: {next(): number}) {
    super(start, end, EMOTEDRIVER_X64_SHA256);
    this.nextRandom = () => random.next();
  }
  get end(): number {
    return this.goal;
  }
  get maxWidth(): number {
    return this.powerMin;
  }
  set maxWidth(value: number) {
    this.powerMin = value;
  }
  get minWidth(): number {
    return this.powerMax;
  }
  set minWidth(value: number) {
    this.powerMax = value;
  }
  get speed(): number {
    return this.velocity;
  }
  set speed(value: number) {
    this.velocity = value;
  }
  /** `startWind` supplies the already signed speed and preserves existing gusts. */
  restart(speed: number): void {
    this.enabled = true;
    this.clock = 0;
    this.velocity = f32(speed);
  }
  step(frames: number): void {
    this.update(frames, this.nextRandom);
  }
  forceAt(x: number): number {
    return this.query(x);
  }
}
