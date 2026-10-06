import {
  Lua51,
  luaText,
  type LuaReference,
  type LuaTable,
  type LuaValue,
} from '../../core/lua51/runtime.js';
import {ArtemisEvents} from './events.js';
import type {AsbTag} from '../../formats/artemis/asb.js';

export interface ArtemisLuaHost {
  /** Synchronous prepared byte sources; null means the file does not exist. */
  readFile(path: string): Uint8Array | null;
  fileExists(path: string): boolean;
  now(): number;
  tag(tag: AsbTag): void;
  enqueueTag(tag: AsbTag): void;
  variable(name: string): string | Uint8Array;
  setMagicPath?(name: string, root: string): void;
}

/** Rev.3179 CLua's confirmed byte-string and tag bridge. Unbound methods fail. */
export class ArtemisLua {
  readonly vm: Lua51;
  readonly events: ArtemisEvents;
  private filter: LuaReference | undefined;
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
      host.tag(luaTag(args[0]));
      return [];
    });
    this.vm.bind('enqueueTag', (args) => {
      host.enqueueTag(luaTag(args[0]));
      return [];
    });
  }
  include(path: string): void {
    const bytes = this.host.readFile(path);
    if (bytes === null) throw new Error(`Missing Artemis Lua include ${path}`);
    this.vm.execute(bytes, `@${path}`);
  }
  call(name: string, args: ReadonlyMap<string, string> = new Map()): void {
    const parts = name.split('.');
    if (parts.some((part) => !part)) throw new Error('Invalid Artemis Lua function path');
    let callback = this.vm.referenceGlobal(parts[0]!);
    try {
      for (const part of parts.slice(1)) {
        const next = callback.get(part);
        callback.release();
        callback = next;
      }
      const values: LuaValue[] = [];
      if (args.size) {
        const params: LuaTable = new Map();
        for (const [key, value] of args) params.set(key, new TextEncoder().encode(value));
        values.push(params);
      }
      callback.invokeVoid(values, true);
    } finally {
      callback.release();
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
      const result = callback.invoke([args], true)[0];
      if (typeof result !== 'number' || !Number.isFinite(result))
        throw new Error('Invalid Artemis tag filter result');
      return Math.trunc(result) !== 0;
    } finally {
      callback.release();
    }
  }
  close(): void {
    this.vm.close();
  }
}

/** CLua 0x1401304d0: name at [1], named strings and floorf numeric values. */
export function luaTag(value: LuaValue | undefined): AsbTag {
  if (!(value instanceof Map)) throw new Error('Expected Artemis Lua tag table');
  const table = value as LuaTable,
    name = luaText(table.get(1));
  const args = new Map<string, string>();
  for (const [key, item] of table) {
    if (key === 1) continue;
    if (typeof key !== 'string') throw new Error('Unsupported numeric Artemis Lua tag argument');
    if (item instanceof Uint8Array) args.set(key, luaText(item));
    else if (typeof item === 'number') {
      const n = Math.floor(Math.fround(item));
      if (!Number.isFinite(n) || n < -0x80000000 || n > 0x7fffffff)
        throw new Error('Unsupported Artemis tag number');
      args.set(key, String(n));
    } else throw new Error(`Unsupported Artemis Lua tag argument ${key}`);
  }
  return {kind: 'tag', name, args, sourceLine: -1};
}
