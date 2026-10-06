import type {AsbTag} from '../../formats/artemis/asb.js';
import {parseAsb} from '../../formats/artemis/asb.js';
import {parseIet, type IetProgram} from '../../formats/artemis/iet.js';
import type {ArtemisLua, ArtemisLuaCall} from './lua.js';
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
  private readonly luaCalls: ArtemisLuaCall[] = [];
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
      const task = this.luaCalls.at(-1)!;
      const index = this.luaCalls.length - 1;
      try {
        const result = task.resume(input);
        if (result.status === 'yielded') {
          this.luaSuspended = true;
          this.state = 'waiting';
          return this.state;
        }
        if (this.luaCalls.at(-1) !== task)
          throw new Error('Artemis nested callback completed with unsettled resource work');
        this.luaCalls.pop();
        task.close();
        input = [];
      } catch (error) {
        for (const abandoned of this.luaCalls.splice(index).reverse()) abandoned.close();
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
    for (const task of this.luaCalls.slice().reverse()) task.close();
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
    if (this.lua.filterTag(tag)) return;
    switch (tag.name) {
      case 'lua':
        break;
      case 'calllua': {
        const name = tag.args.get('function');
        if (!name) throw new Error('Missing calllua function');
        if (!this.lua.suspendableTags) this.lua.call(name, tag.args);
        else {
          if (this.luaCalls.length >= 1000)
            throw new Error('Artemis Lua call depth limit exceeded');
          const task = this.lua.createCall(name, tag.args);
          const index = this.luaCalls.length;
          this.luaCalls.push(task);
          try {
            const result = task.resume();
            if (result.status === 'yielded') {
              this.luaSuspended = true;
              this.state = 'waiting';
              return 'suspended';
            }
            if (this.luaCalls.at(-1) !== task)
              throw new Error('Artemis nested callback completed with unsettled resource work');
            this.luaCalls.pop();
            task.close();
          } catch (error) {
            for (const abandoned of this.luaCalls.splice(index).reverse()) abandoned.close();
            throw error;
          }
        }
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
