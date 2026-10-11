import type {Lua51, LuaReference, LuaTable, LuaValue} from '../../core/lua51/runtime.js';
import type {ArtemisReadAheadName} from './files.js';

const LUA_TABLE = 5;
const text = new TextDecoder('utf-8', {fatal: true});
const string = (value: LuaValue | undefined): string | undefined => {
  if (!(value instanceof Uint8Array)) return undefined;
  try {
    return text.decode(value);
  } catch {
    return undefined;
  }
};
const table = (value: LuaValue | undefined): LuaTable | undefined =>
  value instanceof Map ? value : undefined;

/** Follows `name.key...` through Lua tables; null where a step is not a table. */
function field(vm: Lua51, path: readonly string[]): LuaReference | null {
  let reference = vm.referenceGlobal(path[0]!);
  for (const key of path.slice(1)) {
    if (reference.type !== LUA_TABLE) {
      reference.release();
      return null;
    }
    const next = reference.get(key);
    reference.release();
    reference = next;
  }
  return reference;
}

/** The game's current scenario block (`scr.ip.block`), or undefined. */
export function artemisCurrentBlock(vm: Lua51): string | undefined {
  const reference = field(vm, ['scr', 'ip', 'block']);
  if (!reference) return undefined;
  try {
    return string(reference.read());
  } finally {
    reference.release();
  }
}

/** One block of the loaded scenario (`ast[name]`) as a plain table. */
function block(vm: Lua51, name: string): LuaTable | undefined {
  const reference = field(vm, ['ast', name]);
  if (!reference) return undefined;
  try {
    return reference.type === LUA_TABLE ? table(reference.read()) : undefined;
  } finally {
    reference.release();
  }
}

/** File names a block's tags refer to: every string attribute of each tag, under the
 * tag's `path` directory when it has one, and the voices of its text. */
function blockNames(source: LuaTable, names: ArtemisReadAheadName[]): void {
  const tag = (entry: LuaTable) => {
    const path = string(entry.get('path'));
    const directory = path?.startsWith(':') ? path : undefined;
    for (const [key, value] of entry) {
      if (key === 1 || key === 'path') continue;
      const name = string(value);
      if (name && !name.includes(' ') && name.length < 128) names.push({directory, name});
    }
  };
  for (const [key, value] of source) {
    const entry = table(value);
    if (entry && typeof key === 'number') tag(entry);
  }
  const voices = table(table(source.get('text'))?.get('vo'));
  for (const voice of voices?.values() ?? []) {
    const entry = table(voice);
    if (entry) {
      const name = string(entry.get('file'));
      if (name) names.push({directory: ':vo/', name});
    }
  }
}

/**
 * Names of the files the block after `current` uses: its `linknext` block, and for a
 * selection every block of the same scenario its choices name.
 */
export function artemisNextBlockNames(vm: Lua51, current: string): ArtemisReadAheadName[] {
  const names: ArtemisReadAheadName[] = [];
  const here = block(vm, current);
  if (!here) return names;
  const targets = new Set<string>();
  const next = string(here.get('linknext'));
  if (next) targets.add(next);
  const visit = (value: LuaValue | undefined, depth: number) => {
    const name = string(value);
    if (name?.startsWith('block_')) targets.add(name);
    const entry = table(value);
    if (entry && depth < 4) for (const item of entry.values()) visit(item, depth + 1);
  };
  visit(here.get('select'), 0);
  for (const target of targets) {
    const source = block(vm, target);
    if (source) blockNames(source, names);
  }
  return names;
}
