import {
  EmoteRotateTween as SharedRotateTween,
  wrapAngle as sharedWrapAngle,
  EMOTE_TWO_PI,
} from './runtime/controls/rotate.js';
export {EMOTE_TWO_PI};
import {EMOTEDRIVER_X64_SHA256} from './build.js';
import {
  EmoteTween as SharedTween,
  easingPower as sharedEasingPower,
} from './runtime/controls/transition.js';

/**
 * Queued value tweens of the E-mote 3.9.8 player (`emotedriver.dll` x64, SHA-256
 * `80d28bd088dda8e97c7c47a9c664e55159f70505b0f9fde3158d8ce2a3e1e051`).
 *
 * `EmoteTween` (0x60 bytes: queue at +0x8, count +0x30, state +0x34, current/start/target
 * vectors +0x38/+0x40/+0x48, power +0x50, t +0x54, 1/frames +0x58) holds up to four floats.
 * The player uses it for coordinates, scale, colour, grayscale, outer forces, timeline blend
 * ratios, difference tracks, variable differences and `transitionControl` variables.
 * `EmoteRotateTween` is the single-angle variant used by `setRot` and `setOuterRot`.
 *
 * The curve is `powf(t, power)`; `easingPower` derives the exponent from an API easing value.
 */

const f32 = Math.fround;

/** Inlined at every API entry: easing value → `pow` exponent. */
export function easingPower(easing: number): number {
  return sharedEasingPower(easing, EMOTEDRIVER_X64_SHA256);
}

/** `powf` as the CRT computes it, rounded to float. */
export function powf(x: number, y: number): number {
  return f32(Math.pow(f32(x), f32(y)));
}

/** Compatibility constructor for the x64 bindings; arithmetic lives in the shared runtime. */
export class EmoteTween extends SharedTween {
  constructor(count: number) {
    super(count, EMOTEDRIVER_X64_SHA256);
  }
}

/** x64 wrapping retains non-finite values before entering the finite native loop. */
export function wrapAngle(value: number, period: number): number {
  const rounded = f32(value);
  return Number.isFinite(rounded) ? sharedWrapAngle(rounded, period) : rounded;
}

/** Compatibility constructor over the shared exact-build rotation tween. */
export class EmoteRotateTween extends SharedRotateTween {
  constructor() {
    super(EMOTEDRIVER_X64_SHA256);
  }
}
