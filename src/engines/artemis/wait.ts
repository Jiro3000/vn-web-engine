import type {AsbTag} from '../../formats/artemis/asb.js';
import type {ArtemisModes} from './modes.js';
import type {ArtemisSave} from './save.js';

export interface ArtemisTimedWaitHost {
  now(): number;
  debugSkipActive(): boolean;
  /** Current text layer (stage +0xa0) virtual +0x1c8(vector, 1): the skip vector +0x3718
   * when `skip`, otherwise the current message layer's `in` vector (+0x3730 map). */
  startTextDisplay(skip: boolean): void;
  /** Text layer +0x1e0: no display tween is registered any more. */
  textDisplayComplete(): boolean;
  /** Text layer +0x1d0: finish every display tween. */
  finishTextDisplay(): void;
  /** `s.clickskip = 1`. */
  writeClickSkip(): void;
  beginWait(inputEnabled: boolean): void;
  endWait(): void;
  clickWaitEvent(kind: 'in' | 'out'): void;
  /** 0x1400b6cf0 update after native state 0 clears wait flags. */
  resumeMessageState(): void;
  /** Root layer lookup +0x140 cast to a video layer (0x1400f53d0), then its +0x208:
   * false when the layer is missing, is not a video layer or has finished playing. */
  videoPlaying?(id: string): boolean;
}
function integer(value: string): number {
  const token = /^[\t\n\v\f\r ]*([+-]?\d+)/.exec(value);
  const number = token ? Number(token[1]) : 0;
  if (!Number.isInteger(number) || number < -0x80000000 || number > 0x7fffffff)
    throw new Error('Unsupported Artemis wait integer');
  return number;
}

/** wait tag 0x1400cc0c0, click-wait tag `@` 0x1400cbf20, run-mode entry 0x1400c6160
 * (1 with input=1 or `@`, else 4) and the run mode 1/3/4 frame branch of 0x1400c0560.
 *
 * `time` (flag b98) ends once the absolute uint32 deadline b94 has passed; `scenario=1`
 * (flag b99) ends once the current text display has completed. `@` sets no wait flag and
 * ends only on a click. All of them start the text display first. In run mode 1 a click
 * on a complete display ends the wait (writing `s.clickskip` when a wait flag is set); a
 * click on an incomplete display finishes it and writes `s.clickskip`. `video=<id>` (flag
 * bc4, id bc8) starts no text display and ends once layer `id` is no longer a playing
 * video. `scenario=2`, `se`, automode, skip-mode click-wait progression and the
 * debug-skip frame branch need owners that are not implemented. */
export class ArtemisTimedWait {
  private active = false;
  private inputEnabled = false;
  private deadline = 0;
  private scenario = false;
  /** `@`: no wait flag is set. */
  private click = false;
  /** bc4/bc8: the layer id of a `video=` wait. */
  private video: string | null = null;
  constructor(
    private readonly modes: ArtemisModes,
    private readonly save: ArtemisSave,
    private readonly host: ArtemisTimedWaitHost,
  ) {}
  get pending(): boolean {
    return this.active;
  }
  /** A `scenario=1` wait is pending (flag b99). */
  get scenarioPending(): boolean {
    return this.active && this.scenario;
  }
  /** A `video=` wait is pending (flag bc4). */
  get videoPending(): boolean {
    return this.active && this.video !== null;
  }
  /** An `@` click-wait is pending. */
  get clickPending(): boolean {
    return this.active && this.click;
  }
  get deadlineTick(): number {
    return this.deadline;
  }
  /** Wait flags read by Lua `getScriptWaitReason` (0x1401315b0): `time` is b98 with the
   * uint32 deadline b94; `textTween` is b99; `video` is bc4 with the id bc8.
   * textClearTween (b9a) and sound (b9b) belong to the unimplemented scenario=2 and se
   * waits and are never set here. */
  get reason(): {readonly time?: number; readonly textTween?: true; readonly video?: string} {
    if (!this.active || this.click) return {};
    if (this.video !== null) return {video: this.video};
    return this.scenario ? {textTween: true} : {time: this.deadline};
  }
  dispatch(tag: AsbTag): boolean {
    if (tag.name === '@') {
      this.clickWait();
      return true;
    }
    if (tag.name !== 'wait') return false;
    const p = tag.args;
    const input = integer(p.get('input') ?? '0');
    const skipping = this.modes.skipAllowed && (this.modes.commandSkip || this.modes.controlSkip);
    const debugSkip = this.host.debugSkipActive();
    // Native input=2 bypasses all wait setup while skip/debug-skip is active.
    if (input === 2 && (skipping || debugSkip)) return true;
    if (this.active) throw new Error('Artemis timed wait is already pending');
    if (p.has('se')) throw new Error('Artemis se waits are not implemented');
    const video = p.get('video');
    const scenario = video === undefined ? integer(p.get('scenario') ?? '0') : 0;
    if (scenario === 2) throw new Error('Artemis scenario=2 waits are not implemented');
    if (this.modes.automode)
      throw new Error('Artemis automode wait progression is not implemented');
    if (video !== undefined && !this.host.videoPlaying)
      throw new Error('Unsupported Artemis video wait owner');
    this.scenario = scenario === 1;
    this.click = false;
    this.deadline = 0;
    this.video = video ?? null;
    // The video branch starts no text display.
    if (this.scenario) this.host.startTextDisplay(false);
    else if (video === undefined) {
      this.deadline = (integer(p.get('time') ?? '0') + this.host.now()) >>> 0;
      this.host.startTextDisplay(skipping || debugSkip);
    }
    this.inputEnabled = input === 1;
    this.active = true;
    this.host.beginWait(this.inputEnabled);
    if (this.inputEnabled) {
      this.host.clickWaitEvent('in');
      if (!skipping && !debugSkip)
        this.save.request(this.modes.autosave === 2 ? 'autosave.dat' : '');
    }
    return true;
  }
  /** 0x1400cbf20: display start with the skip vector while skipping or debug-skipping,
   * then the open-coded run mode 1 entry (c74 = c70, c70 = 1, onClickWaitIn, save gate). */
  private clickWait(): void {
    if (this.active) throw new Error('Artemis timed wait is already pending');
    if (this.modes.automode)
      throw new Error('Artemis automode wait progression is not implemented');
    const skip =
      (this.modes.skipAllowed && (this.modes.commandSkip || this.modes.controlSkip)) ||
      this.host.debugSkipActive();
    this.host.startTextDisplay(skip);
    this.scenario = false;
    this.click = true;
    this.deadline = 0;
    this.inputEnabled = true;
    this.active = true;
    this.host.beginWait(true);
    this.host.clickWaitEvent('in');
    if (!skip) this.save.request(this.modes.autosave === 2 ? 'autosave.dat' : '');
  }
  /** One frame of 0x1400c0560 for this wait. `clicked` is the run mode 1 click query
   * (b5690 key 0 or b5170); other run modes ignore it. Native compares absolute uint32
   * deadlines strictly; zero is the disabled sentinel. */
  tick(now: number, clicked = false): boolean {
    if (!this.active) return false;
    if (this.host.debugSkipActive())
      throw Error('Artemis debug-skip wait frame is not implemented');
    if (this.click && this.modes.skipAllowed && (this.modes.commandSkip || this.modes.controlSkip))
      throw Error('Artemis skip click-wait progression is not implemented');
    if (this.inputEnabled && clicked) {
      if (this.host.textDisplayComplete()) {
        // b98/b99 mark s.clickskip; `@` sets no wait flag.
        if (!this.click) this.host.writeClickSkip();
        this.end();
        return true;
      }
      this.host.finishTextDisplay();
      this.host.writeClickSkip();
    }
    if (this.deadline && this.deadline < now >>> 0) {
      this.end();
      return true;
    }
    if (this.scenario && this.host.textDisplayComplete()) {
      this.end();
      return true;
    }
    if (this.video !== null && !this.host.videoPlaying!(this.video)) {
      this.end();
      return true;
    }
    return false;
  }
  /** c6160(0): scheduler release precedes Out, then wait flags/message update. */
  private end(): void {
    this.host.endWait();
    if (this.inputEnabled) this.host.clickWaitEvent('out');
    this.deadline = 0;
    this.scenario = false;
    this.click = false;
    this.video = null;
    this.active = false;
    this.host.resumeMessageState();
  }
}
