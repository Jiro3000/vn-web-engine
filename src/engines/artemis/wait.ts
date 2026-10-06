import type {AsbTag} from '../../formats/artemis/asb.js';
import type {ArtemisModes} from './modes.js';
import type {ArtemisSave} from './save.js';

export interface ArtemisTimedWaitHost {
  now(): number;
  debugSkipActive(): boolean;
  /** This subset requires an empty message owner; active message waits need its full progression. */
  hasActiveMessage(): boolean;
  beginWait(inputEnabled: boolean, skipIndicator: boolean): void;
  endWait(): void;
  clickWaitEvent(kind: 'in' | 'out'): void;
  /** 0x1400b6cf0 update after native state 0 clears wait flags. */
  resumeMessageState(): void;
}
function integer(value: string): number {
  const token = /^[\t\n\v\f\r ]*([+-]?\d+)/.exec(value);
  const number = token ? Number(token[1]) : 0;
  if (!Number.isInteger(number) || number < -0x80000000 || number > 0x7fffffff)
    throw new Error('Unsupported Artemis wait integer');
  return number;
}

/** Empty-message timed waits from 0x1400cc0c0 / 0x1400c6160 / 0x1400c0560.
 * Message/scenario, media completion, automode and click-to-skip require their owners.
 */
export class ArtemisTimedWait {
  private active = false;
  private inputEnabled = false;
  private deadline = 0;
  constructor(
    private readonly modes: ArtemisModes,
    private readonly save: ArtemisSave,
    private readonly host: ArtemisTimedWaitHost,
  ) {}
  get pending(): boolean {
    return this.active;
  }
  get deadlineTick(): number {
    return this.deadline;
  }
  dispatch(tag: AsbTag): boolean {
    if (tag.name !== 'wait') return false;
    const p = tag.args;
    const input = integer(p.get('input') ?? '0');
    const skipping = this.modes.skipAllowed && (this.modes.commandSkip || this.modes.controlSkip);
    const debugSkip = this.host.debugSkipActive();
    // Native input=2 bypasses all wait setup while skip/debug-skip is active.
    if (input === 2 && (skipping || debugSkip)) return true;
    if (this.active) throw new Error('Artemis timed wait is already pending');
    if (p.has('se') || p.has('video') || integer(p.get('scenario') ?? '0') !== 0)
      throw new Error('Artemis media/scenario waits are not implemented');
    if (this.host.hasActiveMessage() || this.modes.automode)
      throw new Error('Artemis message/automode wait progression is not implemented');
    this.inputEnabled = input === 1;
    this.deadline = (integer(p.get('time') ?? '0') + this.host.now()) >>> 0;
    this.active = true;
    this.host.beginWait(this.inputEnabled, skipping || debugSkip);
    if (this.inputEnabled) {
      this.host.clickWaitEvent('in');
      if (!skipping && !debugSkip)
        this.save.request(this.modes.autosave === 2 ? 'autosave.dat' : '');
    }
    return true;
  }
  /** Native compares absolute uint32 deadlines strictly; zero is its disabled sentinel. */
  tick(now: number): boolean {
    if (!this.active || !this.deadline || this.deadline >= now >>> 0) return false;
    // Enter native state 0: scheduler release precedes Out, then wait flags/message update.
    this.host.endWait();
    if (this.inputEnabled) this.host.clickWaitEvent('out');
    this.deadline = 0;
    this.active = false;
    this.host.resumeMessageState();
    return true;
  }
}
