import type {AsbTag} from '../../formats/artemis/asb.js';
import {parseAsb} from '../../formats/artemis/asb.js';
import {parseIet, type IetProgram} from '../../formats/artemis/iet.js';
import {artemisTagFilterResult, type ArtemisLua, type ArtemisLuaCall} from './lua.js';
import type {LuaValue} from '../../core/lua51/runtime.js';

export interface ArtemisScriptTrace {
  readonly origin: 'script' | 'queue';
  readonly file: string;
  readonly tagIndex: number;
  readonly tag: AsbTag;
}
export type ArtemisScriptState = 'ready' | 'waiting' | 'stopped' | 'ended' | 'faulted';
export interface ArtemisScriptHost {
  readFile(path: string): Uint8Array | null;
  /** Implemented native services. Throw for every unsupported command. */
  dispatch(tag: AsbTag): 'waiting' | 'stopped' | 'suspended' | void;
  trace?(event: ArtemisScriptTrace): void;
  pushLocal?(): void;
  popLocal?(): void;
  /** Return with no caller reaches native exit/save handling, supplied by the host. */
  emptyReturn?(): 'stopped' | void;
}
interface PendingLuaCall {
  readonly task: ArtemisLuaCall;
  readonly filterTag?: AsbTag;
}
interface Cursor {
  program: IetProgram;
  file: string;
  index: number;
}

/** Script cursor/queue execution. Native rendering, waits and exit/save effects require host dispatch. */
export class ArtemisScript {
  private cursor: Cursor | null = null;
  private readonly cache = new Map<string, IetProgram>();
  private readonly callers: Cursor[] = [];
  private queue: AsbTag[] = [];
  private queueHead = 0;
  private running = false;
  private readonly luaCalls: PendingLuaCall[] = [];
  private luaSuspended = false;
  state: ArtemisScriptState = 'ended';
  get currentFile(): string {
    return this.cursor?.file ?? '';
  }
  constructor(
    private readonly lua: ArtemisLua,
    private readonly host: ArtemisScriptHost,
  ) {}

  private prepare(path: string): IetProgram {
    const cached = this.cache.get(path);
    if (cached) return cached;
    const bytes = this.host.readFile(path);
    if (bytes === null) throw new Error(`Missing Artemis script ${path}`);
    const parsed =
      bytes[0] === 65 && bytes[1] === 83 && bytes[2] === 66 ? parseAsb(bytes) : parseIet(bytes);
    // Native loader executes every inline Lua block during first load, then clears its argument.
    for (const tag of parsed.tags)
      if (tag.name === 'lua') {
        const script = tag.args.get('script');
        if (script === undefined) throw new Error('Missing inline Lua script');
        this.lua.vm.execute(new TextEncoder().encode(script), `@${path}:${tag.sourceLine}`);
      }
    const program = {
      ...parsed,
      tags: parsed.tags.map((tag) =>
        tag.name === 'lua' ? {...tag, args: new Map([['script', '']])} : tag,
      ),
    };
    this.cache.set(path, program);
    return program;
  }
  private transfer(path: string, label?: string): Cursor {
    if (!path) path = this.cursor?.file ?? '';
    if (!path) throw new Error('Missing Artemis script path');
    const program = this.prepare(path);
    const index = !label ? 0 : program.labels.get(label);
    if (index === undefined) throw new Error(`Missing Artemis label ${path}:${label}`);
    return {program, file: path, index};
  }
  load(path: string, label?: string): void {
    if (this.running) throw new Error('Use jump/call for script transfers during dispatch');
    try {
      this.cancelLuaCalls();
      this.cursor = this.transfer(path, label);
      this.state = 'ready';
    } catch (error) {
      this.state = 'faulted';
      throw error;
    }
  }
  jump(path = '', label?: string): void {
    this.cursor = this.transfer(path, label);
    this.state = 'ready';
  }
  call(path = '', label?: string): void {
    if (!this.cursor) throw new Error('Artemis call without a script cursor');
    if (this.callers.length >= 10000) throw new Error('Artemis call depth limit exceeded');
    const destination = this.transfer(path, label);
    this.host.pushLocal?.();
    this.callers.push({...this.cursor});
    this.cursor = destination;
    this.state = 'ready';
  }
  return(): void {
    if (!this.callers.length) {
      if (!this.host.emptyReturn)
        throw new Error('Native Artemis exit/save handling is not implemented');
      this.state = this.host.emptyReturn() ?? 'ended';
      return;
    }
    this.host.popLocal?.();
    this.cursor = this.callers.pop()!;
    this.state = 'ready';
  }
  enqueue(tag: AsbTag): void {
    if (this.queue.length - this.queueHead >= 10000)
      throw new Error('Artemis tag queue limit exceeded');
    this.queue.push({...tag, args: new Map(tag.args)});
  }
  get queuedTags(): number {
    return this.queue.length - this.queueHead;
  }
  get callDepth(): number {
    return this.callers.length;
  }
  pause(): void {
    if (this.state !== 'ready') throw new Error('Artemis script is not ready to wait');
    this.state = 'waiting';
  }
  resume(): void {
    if (this.luaSuspended) throw new Error('Use resumeLua for a suspended Artemis callback');
    if (this.state !== 'waiting') throw new Error('Artemis script is not waiting');
    this.state = 'ready';
  }
  get pendingLuaCalls(): number {
    return this.luaCalls.length;
  }
  /** Resource completion drives the deepest callback, then its suspended callers. */
  resumeLua(values: readonly LuaValue[] = []): ArtemisScriptState {
    if (this.state !== 'waiting' || !this.luaCalls.length || !this.luaSuspended)
      throw new Error('No suspended Artemis Lua callback');
    this.state = 'ready';
    this.luaSuspended = false;
    let input = values;
    while (this.luaCalls.length) {
      const frame = this.luaCalls.at(-1)!;
      const task = frame.task;
      const index = this.luaCalls.length - 1;
      try {
        const result = task.resume(input);
        if (result.status === 'yielded') {
          this.luaSuspended = true;
          this.state = 'waiting';
          return this.state;
        }
        if (this.luaCalls.at(-1) !== frame)
          throw new Error('Artemis nested callback completed with unsettled resource work');
        this.luaCalls.pop();
        task.close();
        if (frame.filterTag && !artemisTagFilterResult(result.values[0])) {
          if (this.dispatchNative(frame.filterTag) === 'suspended') return this.state;
        }
        input = [];
      } catch (error) {
        for (const abandoned of this.luaCalls.splice(index).reverse()) abandoned.task.close();
        if (!this.luaCalls.length) {
          this.state = 'faulted';
          throw error;
        }
        input = [
          false,
          new TextEncoder().encode(error instanceof Error ? error.message : String(error)),
        ];
      }
    }
    return this.state;
  }
  cancelLuaCalls(): void {
    for (const frame of this.luaCalls.slice().reverse()) frame.task.close();
    this.luaCalls.length = 0;
    this.luaSuspended = false;
  }
  executeTag(tag: AsbTag): void | 'suspended' {
    try {
      return this.dispatch(tag);
    } catch (error) {
      this.state = 'faulted';
      throw error;
    }
  }
  private dispatch(tag: AsbTag): void | 'suspended' {
    if (this.lua.suspendableTags) {
      const task = this.lua.createTagFilterCall(tag);
      if (task) return this.beginLuaCall(task, {...tag, args: new Map(tag.args)});
    } else if (this.lua.filterTag(tag)) return;
    return this.dispatchNative(tag);
  }
  private beginLuaCall(task: ArtemisLuaCall, filterTag?: AsbTag): void | 'suspended' {
    if (this.luaCalls.length >= 1000) {
      task.close();
      throw new Error('Artemis Lua call depth limit exceeded');
    }
    const frame = {task, filterTag},
      index = this.luaCalls.length;
    this.luaCalls.push(frame);
    try {
      const result = task.resume();
      if (result.status === 'yielded') {
        this.luaSuspended = true;
        this.state = 'waiting';
        return 'suspended';
      }
      if (this.luaCalls.at(-1) !== frame)
        throw new Error('Artemis nested callback completed with unsettled resource work');
      this.luaCalls.pop();
      task.close();
      if (filterTag && !artemisTagFilterResult(result.values[0]))
        return this.dispatchNative(filterTag);
    } catch (error) {
      for (const abandoned of this.luaCalls.splice(index).reverse()) abandoned.task.close();
      throw error;
    }
  }
  private dispatchNative(tag: AsbTag): void | 'suspended' {
    switch (tag.name) {
      case 'lua':
        break;
      case 'calllua': {
        const name = tag.args.get('function');
        if (!name) throw new Error('Missing calllua function');
        if (!this.lua.suspendableTags) this.lua.call(name, tag.args);
        else return this.beginLuaCall(this.lua.createCall(name, tag.args));
        break;
      }
      case 'jump':
        this.jump(tag.args.get('file'), tag.args.get('label'));
        break;
      case 'call':
        this.call(tag.args.get('file'), tag.args.get('label'));
        break;
      case 'return':
        this.return();
        break;
      default: {
        const state = this.host.dispatch(tag);
        if (state === 'suspended') {
          this.state = 'waiting';
          return 'suspended';
        }
        if (state) this.state = state;
      }
    }
  }
  step(): ArtemisScriptState {
    if (this.running) throw new Error('Reentrant Artemis script step');
    if (this.state !== 'ready') return this.state;
    const cursor = this.cursor,
      queued = this.queuedTags > 0;
    const tag = queued ? this.queue[this.queueHead++] : cursor?.program.tags[cursor.index];
    if (this.queueHead === this.queue.length) {
      this.queue = [];
      this.queueHead = 0;
    }
    if (!tag) {
      try {
        this.return();
        return this.state;
      } catch (error) {
        this.state = 'faulted';
        throw error;
      }
    }
    this.running = true;
    try {
      this.host.trace?.({
        origin: queued ? 'queue' : 'script',
        file: cursor?.file ?? '',
        tagIndex: queued ? -1 : cursor!.index,
        tag,
      });
      if (!queued) cursor!.index++;
      this.dispatch(tag);
      return this.state;
    } catch (error) {
      this.state = 'faulted';
      throw error;
    } finally {
      this.running = false;
    }
  }
  run(maxSteps = 1000): ArtemisScriptState {
    if (!Number.isSafeInteger(maxSteps) || maxSteps < 1)
      throw new Error('Invalid Artemis step limit');
    for (let n = 0; n < maxSteps && this.state === 'ready'; n++) this.step();
    return this.state;
  }
}
