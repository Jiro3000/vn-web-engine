import type {AsbTag} from '../../formats/artemis/asb.js';
import type {ArtemisEvents} from './events.js';
import type {ArtemisModes} from './modes.js';
import type {ArtemisSave} from './save.js';
import type {ArtemisScriptEvents} from './script-events.js';
import {artemisRevision} from './revision.js';

export interface ArtemisRunModeHost {
  /** Native byte32, distinct from skip/debug and the disabled event byte4b. */
  schedulerFlagEnabled(): boolean;
  setSchedulerFlag(active: boolean): void;
  eventsDisabled(): boolean;
  /** Clear caret wait fields b94..b9b and bc4, then update message state. */
  clearWaitFlags(): void;
  resumeMessageState(): void;
  debugMode(): number;
  fullscreen(): boolean;
  writeStatus(name: string, value: boolean): void;
  registration(mode: 5 | 6, phase: 'in' | 'out'): AsbTag;
  reportCallbackError(event: 'onClickWaitIn' | 'onClickWaitOut', error: unknown): void;
}
export interface ArtemisRunModeOwners {
  readonly modes: ArtemisModes;
  readonly save: ArtemisSave;
  readonly callbacks: ArtemisEvents;
  readonly events: ArtemisScriptEvents;
  readonly host: ArtemisRunModeHost;
}
function signedMode(mode: number): number {
  if (!Number.isInteger(mode) || mode < -0x80000000 || mode > 0xffffffff)
    throw Error('Unsupported Artemis run mode');
  return mode | 0;
}

/** c6160 entry / c6480 release and c0560 event latches. Initial native mode fields
 * are supplied explicitly; no Script ready/waiting-to-native mapping is invented.
 */
export class ArtemisRunMode {
  private current: number;
  private previous: number;
  private readonly latches = [false, false];
  constructor(
    hash: string,
    initial: {
      readonly current: number;
      readonly previous: number;
      readonly latches: readonly [boolean, boolean];
    },
    private readonly owners: ArtemisRunModeOwners,
  ) {
    artemisRevision(hash);
    this.current = signedMode(initial.current);
    this.previous = signedMode(initial.previous);
    this.latches[0] = initial.latches[0];
    this.latches[1] = initial.latches[1];
  }
  get mode(): number {
    return this.current;
  }
  get previousMode(): number {
    return this.previous;
  }
  disabled(): boolean {
    return this.owners.host.eventsDisabled();
  }
  latched(mode: 0 | 1): boolean {
    return this.latches[mode]!;
  }
  latch(mode: 0 | 1): void {
    this.latches[mode] = true;
  }
  /** c05e2: call after scene update and before effect/music ticks, once per frame. */
  beginEventPhase(): void {
    this.latches[0] = this.latches[1] = false;
  }
  private schedulerFlag(): void {
    this.owners.host.setSchedulerFlag(
      this.owners.host.schedulerFlagEnabled() && this.current === 1,
    );
  }
  private callback(event: 'onClickWaitIn' | 'onClickWaitOut'): void {
    try {
      this.owners.callbacks.emit(event);
    } catch (error) {
      this.owners.host.reportCallbackError(event, error);
    }
  }
  enter(input: number): boolean {
    const mode = signedMode(input);
    if (this.current === 13) return false;
    const old = this.current;
    this.previous = old;
    this.current = mode;
    this.schedulerFlag();
    const {host, modes, save, events} = this.owners;
    switch (mode) {
      case 0:
        if (old === 1) this.callback('onClickWaitOut');
        host.clearWaitFlags();
        host.resumeMessageState();
        break;
      case 1:
        this.callback('onClickWaitIn');
      // Native mode1 deliberately falls through to the save gate of mode3.
      case 3:
        if (
          (!modes.skipAllowed || (!modes.commandSkip && !modes.controlSkip)) &&
          host.debugMode() === 0
        )
          save.request(modes.autosave === 2 ? 'autosave.dat' : '');
        break;
      case 5:
      case 6:
        events.dispatch(host.registration(mode, 'in'));
        break;
      case 14:
        host.writeStatus('s.status.fullscreenatexit', host.fullscreen());
        save.request('', false, true);
        break;
    }
    return true;
  }
  release(): void {
    const old = this.current;
    this.current = this.previous;
    this.schedulerFlag();
    this.owners.events.releasePending();
    if (old === 5 || old === 6)
      this.owners.events.dispatch(this.owners.host.registration(old, 'out'));
  }
}
