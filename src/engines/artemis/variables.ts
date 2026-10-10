import type {ApplicationArgumentsHost} from '../../platform/application-arguments.js';
import type {WindowDisplayGeometry} from '../../platform/window-display.js';
import type {AsbTag} from '../../formats/artemis/asb.js';
import type {ArtemisExpressionValue} from './expression.js';

const encoder = new TextEncoder();
const empty = new Uint8Array();
/** System names whose only native writers are runtime paths (no startup initializer), so a
 * missing name follows the ordinary query path. s.clickskip: c0560 run modes 1/3/4, 2 and 7
 * set it to integer 1 through 0x1400b0940. */
const lazySystemVariables = new Set(['s.clickskip']);
function unsupportedSystem(name: string): boolean {
  return (name.startsWith('s.') || name.startsWith('ini.')) && !lazySystemVariables.has(name);
}
/** MSVC `atoi`: leading whitespace, optional sign, decimal digits; saturates at int32. */
function atoi(text: string): number {
  const match = /^[\t\n\v\f\r ]*([+-]?)(\d*)/.exec(text)!;
  let value = 0;
  for (const digit of match[2]!) value = Math.min(value * 10 + Number(digit), 0x80000000);
  return match[1] === '-' ? -value : Math.min(value, 0x7fffffff);
}
function literal(name: string): void {
  if (!name || /[\0\s$+*/()=]/.test(name))
    throw new Error(`Unsupported Artemis variable expression ${name}`);
}

export interface ArtemisVariableHost {
  /** Logical stage dimensions; supplied by the configuration/rendering owner. */
  stageSize(): {width: number; height: number};
  windowDisplay?(): WindowDisplayGeometry;
  applicationArguments?: ApplicationArgumentsHost;
  /** Selected message layer (stage +0xa0) text extents: virtual +0x140 width (widest line
   * up to the current one), +0x148 height and +0x150 last-line width, as floats. */
  messageLayerMeasure?(): {
    readonly width: number;
    readonly height: number;
    readonly lineWidth: number;
  };
  /** Wall clock in milliseconds since the Unix epoch (CRT `_time64`); local calendar fields
   * follow the host time zone like `_localtime64`. Defaults to `Date.now`. */
  now?(): number;
}
const messageLayerExtents = {
  get_message_layer_width: 'width',
  get_message_layer_height: 'height',
  get_message_layer_line_width: 'lineWidth',
} as const;

/** Literal byte-string variables with current-local/global lookup; expressions require a separate evaluator. */
/** 0x1400a0040 encoding 2: each byte from a lead byte with n further high bits set skips n
 * bytes; counting stops at the first NUL. */
function utf8Characters(bytes: Uint8Array): number {
  const end = bytes.indexOf(0) < 0 ? bytes.length : bytes.indexOf(0);
  let count = 0;
  for (let index = 0; index < end; count++) {
    const byte = bytes[index]!;
    let skip = 0;
    if (byte & 0x80) for (let bit = 0x40; byte & bit; bit >>= 1) skip++;
    index += skip + 1;
    if (index > end) throw new Error('Artemis var length source ends inside a character');
  }
  return count;
}
export class ArtemisVariables {
  constructor(private readonly host?: ArtemisVariableHost) {}
  private dirty = false;
  get globalDirty(): boolean {
    return this.dirty;
  }
  clearGlobalDirty(): void {
    this.dirty = false;
  }
  private readonly global = new Map<string, Uint8Array>();
  private readonly locals: Map<string, Uint8Array>[] = [];
  /** Stored values created by 0x140157fa0 as CVariant integers; any write replaces them. */
  private readonly integers = new WeakSet<Uint8Array>();
  pushLocal(): void {
    this.locals.push(new Map());
  }
  popLocal(): void {
    if (!this.locals.length) throw new Error('Artemis local scope underflow');
    this.locals.pop();
  }
  /** Non-inserting native named-variable lookup; callers may distinguish absence
   * from an empty byte string. System expressions still require their own owner. */
  lookup(name: string): Uint8Array | undefined {
    literal(name);
    const value = this.locals.at(-1)?.get(name) ?? this.global.get(name);
    return value === undefined ? undefined : Uint8Array.from(value);
  }
  read(name: string): Uint8Array {
    literal(name);
    const local = this.locals.at(-1);
    const value = local?.get(name) ?? this.global.get(name);
    if (!value && unsupportedSystem(name))
      throw new Error(`Unsupported native Artemis variable ${name}`);
    return (value ?? empty).slice();
  }
  /** Literal expression leaf 0x140157fa0: absent names are created as integer zero. */
  queryLiteral(name: string): Uint8Array {
    literal(name);
    if (!this.locals.at(-1)?.has(name) && !this.global.has(name)) {
      if (unsupportedSystem(name)) throw new Error(`Unsupported native Artemis variable ${name}`);
      this.write(name, '0');
      this.integers.add(this.global.get(name)!);
    }
    return this.read(name);
  }
  /** Expression leaf value: query-created zeros are integers, stored data is a string. */
  expressionValue(name: string): ArtemisExpressionValue {
    const bytes = this.queryLiteral(name);
    const stored = this.locals.at(-1)?.get(name) ?? this.global.get(name)!;
    return this.integers.has(stored) ? {kind: 'integer', value: 0} : {kind: 'string', bytes};
  }
  write(name: string, value: Uint8Array | string, local = false): void {
    literal(name);
    const target = local && this.locals.length ? this.locals.at(-1)! : this.global;
    const bytes = typeof value === 'string' ? encoder.encode(value) : value.slice();
    const old = target.get(name);
    if (
      target === this.global &&
      name.startsWith('g.') &&
      (!old || old.length !== bytes.length || old.some((byte, index) => byte !== bytes[index]))
    )
      this.dirty = true;
    target.set(name, bytes);
  }
  /** Save serialization (0x14013ec90): global entries whose name starts with prefix, as
   * their stored strings. Native order follows MSVC hash iteration; readers do not depend
   * on it. */
  globalEntries(prefix: string): [string, Uint8Array][] {
    return [...this.global]
      .filter(([name]) => name.startsWith(prefix))
      .map(([name, value]) => [name, value.slice()]);
  }
  /** Save load (0x14013ef10): find-or-insert and the value's string setter, bypassing the
   * table setter, so the global dirty flag is unchanged. */
  restore(name: string, value: Uint8Array): void {
    this.global.set(name, value.slice());
  }
  /** Scenario save 0x1400aff10: every variable not starting with "g.", "s." or "t.", for
   * the global table and then each local frame (oldest first). */
  scenarioEntries(): {
    readonly global: [string, Uint8Array][];
    readonly locals: [string, Uint8Array][][];
  } {
    const entries = (table: Map<string, Uint8Array>): [string, Uint8Array][] =>
      [...table]
        .filter(([name]) => !['g.', 's.', 't.'].some((prefix) => name.startsWith(prefix)))
        .map(([name, value]) => [name, value.slice()]);
    return {global: entries(this.global), locals: this.locals.map(entries)};
  }
  /** Scenario load 0x1400b0370: the reset tail, then find-or-insert with the string setter
   * (no dirty mark); local frames are replaced by the saved frames. */
  restoreScenario(
    global: readonly (readonly [string, Uint8Array])[],
    locals: readonly (readonly (readonly [string, Uint8Array])[])[],
  ): void {
    this.resetScenario();
    for (const [name, value] of global) this.global.set(name, value.slice());
    this.locals.length = 0;
    for (const frame of locals)
      this.locals.push(new Map(frame.map(([name, value]) => [name, value.slice()])));
  }
  /** Variables virtual +0x38 (0x1400b0bd0), the reset tag tail: every global variable
   * except g. and s. names is erased. Local scopes are separate and unchanged. */
  resetScenario(): void {
    for (const name of [...this.global.keys()])
      if (!name.startsWith('g.') && !name.startsWith('s.')) this.global.delete(name);
  }
  delete(name: string, local = false): void {
    literal(name);
    const target = local && this.locals.length ? this.locals.at(-1)! : this.global;
    if (target.has(name)) target.delete(name);
    else for (const key of target.keys()) if (key.startsWith(name + '.')) target.delete(key);
  }
  private unixTime(): number {
    return Math.floor((this.host?.now?.() ?? Date.now()) / 1000);
  }
  dispatch(tag: AsbTag): boolean {
    if (tag.name !== 'var') return false;
    const p = tag.args,
      name = p.get('name');
    if (name === undefined) throw new Error('Missing Artemis var name');
    const local = p.has('writelocal') && p.get('writelocal') !== '0';
    // The native handler gives data precedence over system queries.
    if (p.has('data')) this.write(name, tag.bytes?.get('data') ?? p.get('data')!, local);
    else if (p.get('system') === 'delete') this.delete(name, local);
    else if (p.get('system') === 'get_exe_parameter') {
      if (!this.host?.applicationArguments)
        throw new Error('Artemis application argument provider is not configured');
      for (const [key, value] of this.host.applicationArguments.readApplicationArguments())
        this.write(`${name}.${key}`, value, local);
    } else if (p.get('system') === 'os') this.write(name, 'windows', local);
    else if (p.get('system') === 'fullscreen') {
      if (!this.host?.windowDisplay)
        throw new Error('Artemis window display provider is not configured');
      this.write(name, this.host.windowDisplay().fullscreen ? '1' : '0', local);
    } else if (p.get('system') === 'screen_width' || p.get('system') === 'screen_height') {
      if (!this.host) throw new Error('Artemis stage size provider is not configured');
      const size = this.host.stageSize();
      const value = p.get('system') === 'screen_width' ? size.width : size.height;
      if (!Number.isInteger(value) || value < 1 || value > 0x7fffffff)
        throw new Error('Invalid Artemis stage size');
      this.write(name, String(value), local);
    } else if (Object.hasOwn(messageLayerExtents, p.get('system') ?? '')) {
      // e56a0 stores (int)float through the integer setter.
      if (!this.host?.messageLayerMeasure)
        throw new Error('Artemis message layer measure provider is not configured');
      const key = messageLayerExtents[p.get('system') as keyof typeof messageLayerExtents];
      const value = Math.trunc(this.host.messageLayerMeasure()[key]);
      if (!Number.isInteger(value) || value < -0x80000000 || value > 0x7fffffff)
        throw new Error('Unsupported Artemis message layer extent');
      this.write(name, String(value), local);
    } else if (p.get('system') === 'length') {
      // e56a0: mode absent or "0" stores the byte size of source; mode "1" counts UTF-8
      // characters with 0x1400a0040 (encoding 2); any other mode writes nothing.
      const mode = p.get('mode');
      if (mode !== undefined && mode !== '0' && mode !== '1') return true;
      if (!p.has('source')) throw new Error('Missing Artemis var source');
      const source = tag.bytes?.get('source') ?? new TextEncoder().encode(p.get('source')!);
      this.write(name, String(mode === '1' ? utf8Characters(source) : source.length | 0), local);
    } else if (p.get('system') === 'unixtime')
      // 0x14019a970 `_time64`, stored through the 32-bit integer setter.
      this.write(name, String(this.unixTime() | 0), local);
    else if (p.get('system') === 'date') {
      // 0x14019a980: `_localtime64` of the 32-bit `unixtime` argument (atoi) or the clock.
      const seconds = p.has('unixtime') ? atoi(p.get('unixtime')!) >>> 0 : this.unixTime() >>> 0;
      const date = new Date(seconds * 1000);
      const fields: [string, number][] = [
        ['year', date.getFullYear()],
        ['month', date.getMonth() + 1],
        ['day', date.getDate()],
        ['hour', date.getHours()],
        ['minute', date.getMinutes()],
        ['second', date.getSeconds()],
      ];
      for (const [field, value] of fields) this.write(`${name}.${field}`, String(value), local);
    } else throw new Error(`Unsupported native Artemis var system ${p.get('system') ?? ''}`);
    return true;
  }
}
