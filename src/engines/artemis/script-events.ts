import type {AsbTag} from '../../formats/artemis/asb.js';
import {artemisRevision} from './revision.js';

export interface ArtemisScriptEventHost {
  /** Actual native run mode c70; the producer owns its lifecycle/mapping. */
  nativeMode(): number;
  disabled(): boolean;
  /** b73e0 latches30/31; the frame/control owner decides when they clear. */
  latched(mode: 0 | 1): boolean;
  latch(mode: 0 | 1): void;
  filter(command: AsbTag): number;
  report(kind: 'filter' | 'default', command: AsbTag, error: unknown): void;
  /** Default event transfers return the native failed flag, not consumed status. */
  jump(file: string, label: string): boolean;
  call(file: string, label: string): boolean;
  /** Save caret, install empty caret and push a fresh local variable scope. */
  enterHandlerScope(): void;
  /** Priority script queue, sourceLine0; never invoke a Lua handler directly. */
  enqueueHandler(command: AsbTag): void;
}
export type ArtemisScriptEventResult =
  | {readonly status: 'suppressed' | 'queued'}
  | {readonly status: 'delivered'; readonly failed: boolean};
const copy = (command: AsbTag): AsbTag => ({...command, args: new Map(command.args)});

/** b73e0 deferred event queue and c6730 default dispatcher. Native mode/latches,
 * transfer effects and local-scope storage remain required concrete owners.
 */
export class ArtemisScriptEvents {
  private pending: AsbTag[] = [];
  constructor(
    hash: string,
    private readonly host: ArtemisScriptEventHost,
  ) {
    artemisRevision(hash);
  }
  get queuedEvents(): number {
    return this.pending.length;
  }
  private immediate(): boolean {
    const mode = this.host.nativeMode();
    if (!Number.isInteger(mode) || mode < -0x80000000 || mode > 0x7fffffff)
      throw Error('Unsupported Artemis native event mode');
    return mode === 0 || mode === 1 || mode === 3 || mode === 4;
  }
  emit(command: AsbTag, mode: number, force: boolean): ArtemisScriptEventResult {
    if (!Number.isInteger(mode) || mode < -0x80000000 || mode > 0x7fffffff)
      throw Error('Unsupported Artemis native event latch mode');
    if (this.host.disabled()) return {status: 'suppressed'};
    if (!force && (mode === 0 || mode === 1)) {
      if (this.host.latched(mode)) return {status: 'suppressed'};
      this.host.latch(mode);
    }
    const captured = copy(command);
    if (this.immediate()) return {status: 'delivered', failed: this.dispatch(captured)};
    if (this.pending.length >= 10000) throw Error('Artemis deferred event queue limit exceeded');
    this.pending.push(captured);
    return {status: 'queued'};
  }
  /** Drain one queued registration after the producer makes the mode dispatchable.
   * Latches were already applied at enqueue time and must not be applied again.
   */
  drainOne(): ArtemisScriptEventResult | null {
    if (!this.pending.length || !this.immediate()) return null;
    const command = this.pending.shift()!;
    return {status: 'delivered', failed: this.dispatch(command)};
  }
  clear(): void {
    this.pending = [];
  }
  dispatch(input: AsbTag): boolean {
    const command = copy(input);
    if (!command.name) return true;
    try {
      const status = this.host.filter(command);
      if (!Number.isInteger(status) || status < -0x80000000 || status > 0x7fffffff)
        throw Error('Unsupported Artemis event filter result');
      if (status !== 0) return status === 2;
    } catch (error) {
      this.host.report('filter', command, error);
    }
    const args = command.args;
    try {
      if (args.has('file') || args.has('label')) {
        const file = args.get('file') ?? '',
          label = args.get('label') ?? '';
        const failed =
          args.has('call') && args.get('call') !== '0'
            ? this.host.call(file, label)
            : this.host.jump(file, label);
        if (failed) return true;
      } else if (args.has('handler')) this.host.enterHandlerScope();
      if (args.has('handler'))
        this.host.enqueueHandler({
          kind: 'tag',
          name: args.get('handler')!,
          sourceLine: 0,
          args: new Map(args),
        });
      return false;
    } catch (error) {
      this.host.report('default', command, error);
      return true;
    }
  }
}

/** Actual Lua filter + script cursor/queue/scope adapter. The application must
 * supply native mode/latches; no ready/waiting enum is silently guessed here.
 */
export function createArtemisScriptEvents(
  hash: string,
  lua: import('./lua.js').ArtemisLua,
  script: import('./script.js').ArtemisScript,
  control: Pick<ArtemisScriptEventHost, 'nativeMode' | 'disabled' | 'latched' | 'latch' | 'report'>,
): ArtemisScriptEvents {
  return new ArtemisScriptEvents(hash, {
    ...control,
    filter: (command) => lua.filterEvent(command),
    jump: (file, label) => {
      script.jump(file, label);
      return false;
    },
    call: (file, label) => {
      script.call(file, label);
      return false;
    },
    enterHandlerScope: () => script.enterEventHandlerScope(),
    enqueueHandler: (command) => script.enqueue(command),
  });
}
