import {
  Lua51,
  LuaRuntimeError,
  luaText,
  type LuaReference,
  type LuaTable,
  type LuaValue,
  type LuaThread,
  type LuaThreadResult,
} from '../../core/lua51/runtime.js';
import {ArtemisEvents} from './events.js';
import type {AsbTag} from '../../formats/artemis/asb.js';
import type {PointerPositionHost} from '../../input/cursor-host.js';
import {windowsTextFileBytes} from '../../platform/windows-text-file.js';

export interface ArtemisLuaHost {
  /** Synchronous prepared byte sources; null means the file does not exist. */
  readFile(path: string): Uint8Array | null;
  /** Optional prepared CFile owner. Include tries luaL_loadfile here before
   * retrying the normal loose-first CArtemisPackFile read on any failure.
   */
  readPlainFile?(path: string): Uint8Array | null;
  /** Native12d080 level1 reporting returns to the include caller. The concrete
   * owner supplies logging/debug policy; absent owner retains diagnostic refusal.
   */
  reportIncludeError?(path: string, error: unknown): void;
  fileExists(path: string): boolean;
  now(): number;
  tag(tag: AsbTag): void | 'suspended';
  /** Opt in only when callbacks run through createCall and the owner drives yielded work. */
  suspendableTags?: boolean;
  enqueueTag(tag: AsbTag): void;
  variable(name: string): string | Uint8Array;
  setMagicPath?(name: string, root: string): void;
  setTouchLimit?(limit: number): void;
  pointerPosition?: PointerPositionHost;
  /** Actual native mode1 preload request owner; call returns without waiting for decode. */
  bindSurfaceAsync?(path: string): void;
  /** Cancel a queued binding or release a completed named native binding. */
  unbindSurface?(path: string): void;
  clearSurfaceLoadQueue?(): void;
  /** Missing/non-string Lua argument queries the whole queue; a string queries its name. */
  isLoadingSurface?(path?: string): boolean;
}

/** Rev.3179 CLua's confirmed byte-string and tag bridge. Unbound methods fail. */
export class ArtemisLua {
  readonly vm: Lua51;
  readonly events: ArtemisEvents;
  private filter: LuaReference | undefined;
  private eventFilter: LuaReference | undefined;
  constructor(
    private readonly host: ArtemisLuaHost,
    instructionLimit?: number,
  ) {
    this.vm = new Lua51(instructionLimit);
    this.events = new ArtemisEvents((name, args) => this.call(name, args));
    this.vm.bind('setEventHandler', (args) => {
      const table = args[0];
      if (!(table instanceof Map)) throw new Error('Expected Artemis event handler table');
      const entries: [string, string][] = [];
      for (const [key, value] of table)
        if (typeof key === 'string' && value instanceof Uint8Array)
          entries.push([key, luaText(value)]);
      this.events.register(entries);
      return [];
    });
    this.vm.bindReferences('setTagFilter', (args) => {
      const table = args[0];
      if (!table || table.type !== 5) throw new Error('Expected Artemis tag filter table');
      const next = table.retain();
      this.filter?.release();
      this.filter = next;
      return [];
    });
    this.vm.bindReferences('setEventFilter', (args) => {
      const callback = args[0];
      if (!callback || callback.type !== 6)
        throw new Error('Expected Artemis event filter function');
      const next = callback.retain();
      this.eventFilter?.release();
      this.eventFilter = next;
      return [];
    });
    if (host.setMagicPath)
      this.vm.bind('setMagicPath', (args) => {
        const table = args[0];
        if (!(table instanceof Map)) throw new Error('Expected Artemis magic path tuple');
        let name = '',
          root = '';
        for (const [key, value] of table) {
          if (typeof key !== 'number' || !(value instanceof Uint8Array)) continue;
          if (Math.trunc(key) === 1) name = luaText(value);
          if (Math.trunc(key) === 2) root = luaText(value);
        }
        host.setMagicPath!(name, root);
        return [];
      });
    if (host.setTouchLimit)
      this.vm.bind('setUseMultiTouch', (args) => {
        const number = args[0];
        if (
          typeof number !== 'number' ||
          !Number.isFinite(number) ||
          Math.trunc(number) < -0x80000000 ||
          Math.trunc(number) > 0x7fffffff
        )
          throw new Error('Unsupported Artemis touch limit');
        host.setTouchLimit!(Math.trunc(number));
        return [];
      });
    if (host.bindSurfaceAsync)
      this.vm.bind('bindSurfaceAsync', (args) => {
        const value = args[0];
        if (!(value instanceof Uint8Array)) throw Error('Expected Artemis surface name string');
        const nul = value.indexOf(0);
        host.bindSurfaceAsync!(luaText(nul < 0 ? value : value.subarray(0, nul)));
        return [];
      });
    if (host.unbindSurface)
      this.vm.bind('unbindSurface', (args) => {
        const value = args[0];
        if (!(value instanceof Uint8Array)) throw Error('Expected Artemis surface name string');
        const nul = value.indexOf(0);
        host.unbindSurface!(luaText(nul < 0 ? value : value.subarray(0, nul)));
        return [];
      });
    if (host.clearSurfaceLoadQueue)
      this.vm.bind('clearSurfaceLoadQueue', () => {
        host.clearSurfaceLoadQueue!();
        return [];
      });
    if (host.isLoadingSurface)
      this.vm.bind('isLoadingSurface', (args) => {
        const value = args[0];
        let path: string | undefined;
        if (value instanceof Uint8Array) {
          const nul = value.indexOf(0);
          path = luaText(nul < 0 ? value : value.subarray(0, nul));
        }
        const loading = host.isLoadingSurface!(path);
        if (typeof loading !== 'boolean') throw Error('Expected Artemis surface loading boolean');
        return [loading];
      });
    if (host.pointerPosition)
      this.vm.bind('getMousePoint', () => {
        // 134ca0 reads the provider twice, stores each coordinate as float32,
        // then 138f10 widens it to the Lua number. No integer truncation.
        const coordinate = (value: number) => {
          if (typeof value !== 'number' || !Number.isFinite(Math.fround(value)))
            throw new Error('Invalid Artemis pointer position');
          return Math.fround(value);
        };
        const x = coordinate(host.pointerPosition!.readPointerPosition().x);
        const y = coordinate(host.pointerPosition!.readPointerPosition().y);
        return [
          new Map<string, LuaValue>([
            ['x', x],
            ['y', y],
          ]),
        ];
      });
    this.vm.bind('now', () => [Math.trunc(host.now()) & 0x7fffffff]);
    this.vm.bind('file', (args) => [host.readFile(luaText(args[0]))]);
    this.vm.bind('isFileExists', (args) => [host.fileExists(luaText(args[0]))]);
    this.vm.bind('include', (args) => {
      this.include(luaText(args[0]));
      return [];
    });
    this.vm.bind('var', (args) => {
      const value = host.variable(luaText(args[0]));
      return [typeof value === 'string' ? new TextEncoder().encode(value) : value];
    });
    this.vm.bind('tag', (args) => {
      if (host.tag(luaTag(args[0])) === 'suspended') {
        if (!host.suspendableTags)
          throw new Error('Artemis tag suspension requires a coroutine owner');
        return [true];
      }
      return [];
    });
    this.vm.bind('enqueueTag', (args) => {
      host.enqueueTag(luaTag(args[0]));
      return [];
    });
    if (host.suspendableTags) {
      // Resource failures are raised by a host method so they keep a host cause.
      this.vm.bind('artemisResourceFailure', (args) => {
        const message = args[0];
        throw new Error(
          message instanceof Uint8Array
            ? new TextDecoder().decode(message)
            : 'Artemis resource operation failed',
        );
      });
      this.vm.execute(
        new TextEncoder().encode(`
        local nativeTag = engine.tag
        local resourceFailure = engine.artemisResourceFailure
        engine.artemisResourceFailure = nil
        engine.tag = function(self, command)
          if nativeTag(self, command) then
            local ok, message = coroutine.yield()
            if ok == false then resourceFailure(self, message) end
          end
        end
      `),
        '@artemis/suspendable-tag',
      );
    }
  }
  include(path: string): void {
    if (this.host.readPlainFile) {
      try {
        const plain = this.host.readPlainFile(path);
        if (plain !== null) {
          this.vm.executeFile(plain, path, windowsTextFileBytes(plain));
          return;
        }
      } catch (error) {
        if (!this.vm.usable) throw error;
        // 12d590 retries on open/load/pcall failure, preserving prior Lua effects.
      }
    }
    const bytes = this.host.readFile(path);
    try {
      if (bytes === null) throw new Error(`Missing Artemis Lua include ${path}`);
      this.vm.execute(bytes, path); // Native packed luaL_loadbuffer uses the literal filename.
    } catch (error) {
      if (!this.vm.usable || !this.host.reportIncludeError) throw error;
      this.host.reportIncludeError(path, error);
    }
  }
  get suspendableTags(): boolean {
    return this.host.suspendableTags === true;
  }
  call(name: string, args: ReadonlyMap<string, string> = new Map()): void {
    const callback = this.callback(name);
    try {
      callback.invokeVoid(this.callArguments(args), true);
    } finally {
      callback.release();
    }
  }
  /** Resumable counterpart for owners that load resources asynchronously. */
  createCall(name: string, args: ReadonlyMap<string, string> = new Map()): ArtemisLuaCall {
    const callback = this.callback(name);
    try {
      const values = this.callArguments(args);
      return new ArtemisLuaCall(this.vm.createThread(callback, true), values);
    } finally {
      callback.release();
    }
  }
  private callArguments(args: ReadonlyMap<string, string>): LuaValue[] {
    if (!args.size) return [];
    const params: LuaTable = new Map();
    for (const [key, value] of args) params.set(key, new TextEncoder().encode(value));
    return [params];
  }
  /** Native12c030 last-error bytes for a calllua failure it catches, or null when the
   * failure must remain strict. Its luabind::error catch converts a string or nil
   * error value with object_cast<const char*> and assigns up to the first NUL; nil
   * and other values are not recoverable there. Host refusals, VM traps and the web
   * memory cap (status4) are never reported as script errors.
   */
  callErrorMessage(error: unknown): Uint8Array | null {
    if (!this.vm.usable) return null;
    if (error instanceof ArtemisLuaFunctionNotFound) return new TextEncoder().encode(error.message);
    if (!(error instanceof LuaRuntimeError) || error.hostCause !== undefined || !error.value)
      return null;
    if (error.status !== 2 && error.status !== 5) return null;
    const nul = error.value.indexOf(0);
    return nul < 0 ? error.value : error.value.subarray(0, nul);
  }
  /** 12c030 splits on '.', stops at nil/false and requires a Lua function at the end. */
  private callback(name: string): LuaReference {
    const parts = name.split('.');
    if (parts.some((part) => !part)) throw new Error('Invalid Artemis Lua function path');
    let callback = this.vm.referenceGlobal(parts[0]!);
    try {
      for (let index = 1; ; index++) {
        if (callback.type === 0 || (callback.type === 1 && callback.read() === false))
          throw new ArtemisLuaFunctionNotFound(name);
        if (index === parts.length) break;
        const next = callback.get(parts[index]!);
        callback.release();
        callback = next;
      }
      if (callback.type !== 6) throw new ArtemisLuaFunctionNotFound(name);
      return callback;
    } catch (error) {
      callback.release();
      throw error;
    }
  }
  /** Script-origin tags are filtered; direct/queued CLua tags have negative sourceLine and bypass it. */
  filterTag(tag: AsbTag): boolean {
    if (tag.sourceLine < 0 || !this.filter) return false;
    const callback = this.filter.get(tag.name);
    try {
      if (callback.type !== 6) return false;
      const args: LuaTable = new Map();
      for (const [key, value] of tag.args) args.set(key, new TextEncoder().encode(value));
      return artemisTagFilterResult(callback.invokeFirst([args], true));
    } finally {
      callback.release();
    }
  }
  createTagFilterCall(tag: AsbTag): ArtemisLuaCall | null {
    if (tag.sourceLine < 0 || !this.filter) return null;
    const callback = this.filter.get(tag.name);
    try {
      if (callback.type !== 6) return null;
      const params: LuaTable = new Map();
      for (const [key, value] of tag.args) params.set(key, new TextEncoder().encode(value));
      return new ArtemisLuaCall(this.vm.createThread(callback, true), [params], false);
    } finally {
      callback.release();
    }
  }
  /** Native event dispatcher: zero falls through, two fails, other nonzero values consume.
   * The event owner must report callback errors and continue its default dispatch.
   * This is separate from script tag filtering and does not dispatch default actions.
   */
  filterEvent(tag: AsbTag): number {
    if (!tag.name || !this.eventFilter) return 0;
    const args: LuaTable = new Map();
    for (const [key, value] of tag.args) args.set(key, new TextEncoder().encode(value));
    const result = this.eventFilter.invokeFirst([new TextEncoder().encode(tag.name), args], true);
    if (
      typeof result !== 'number' ||
      !Number.isFinite(result) ||
      !Number.isSafeInteger(Math.trunc(result))
    )
      throw new Error('Unsupported Artemis event filter result');
    return Math.trunc(result) | 0;
  }
  close(): void {
    this.vm.close();
  }
}

/** 12c030 resolution failure. The message is the native last-error literal at0x140375638;
 * the UTF-8 form corresponds to its converting branch for the engine text flag.
 */
export class ArtemisLuaFunctionNotFound extends Error {
  constructor(readonly functionName: string) {
    super('指定されたfunctionが見つかりません');
    this.name = 'ArtemisLuaFunctionNotFound';
  }
}

/** The resource owner resumes with no values after success, or false/error bytes after failure. */
export class ArtemisLuaCall {
  private started = false;
  constructor(
    private readonly thread: LuaThread,
    private readonly initialArgs: readonly LuaValue[],
    private readonly discardDoneValues = true,
  ) {}
  resume(values: readonly LuaValue[] = []): LuaThreadResult {
    if (!this.started && values.length)
      throw new Error('Artemis call arguments are already captured');
    const args = this.started ? values : this.initialArgs;
    this.started = true;
    return this.thread.resume(args, this.discardDoneValues, this.discardDoneValues ? Infinity : 1);
  }
  close(): void {
    this.thread.close();
  }
}

export function artemisTagFilterResult(result: LuaValue | undefined): boolean {
  if (
    typeof result !== 'number' ||
    !Number.isFinite(result) ||
    !Number.isSafeInteger(Math.trunc(result))
  )
    throw new Error('Invalid Artemis tag filter result');
  return (Math.trunc(result) | 0) !== 0;
}

/** CLua 0x1401304d0: name at [1], named strings and floorf numeric values. Other keys
 * (numeric keys besides 1, booleans, tables) and values of other Lua types are skipped. */
export function luaTag(value: LuaValue | undefined): AsbTag {
  if (!(value instanceof Map)) throw new Error('Expected Artemis Lua tag table');
  const table = value as LuaTable,
    name = luaText(table.get(1));
  const args = new Map<string, string>(),
    bytes = new Map<string, Uint8Array>();
  for (const [key, item] of table) {
    if (typeof key !== 'string') continue;
    if (item instanceof Uint8Array) {
      // 0x140139920 copies lua_tostring/lua_objlen bytes, so binary data (Pluto) survives.
      bytes.set(key, item);
      args.set(key, tagText(item));
    } else if (typeof item === 'number') {
      const n = Math.floor(Math.fround(item));
      if (!Number.isFinite(n) || n < -0x80000000 || n > 0x7fffffff)
        throw new Error('Unsupported Artemis tag number');
      args.set(key, String(n));
    }
  }
  return {kind: 'tag', name, args, bytes, sourceLine: -1};
}

const strictText = new TextDecoder('utf-8', {fatal: true}),
  lossyText = new TextDecoder('utf-8');
/** Text view of a byte argument; text consumers of binary data see replacement characters. */
function tagText(bytes: Uint8Array): string {
  try {
    return strictText.decode(bytes);
  } catch {
    return lossyText.decode(bytes);
  }
}
