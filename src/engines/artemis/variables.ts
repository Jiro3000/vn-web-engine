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
function literal(name: string): void {
  if (!name || /[\0\s$+*/()=]/.test(name))
    throw new Error(`Unsupported Artemis variable expression ${name}`);
}

export interface ArtemisVariableHost {
  /** Logical stage dimensions; supplied by the configuration/rendering owner. */
  stageSize(): {width: number; height: number};
  windowDisplay?(): WindowDisplayGeometry;
  applicationArguments?: ApplicationArgumentsHost;
}

/** Literal byte-string variables with current-local/global lookup; expressions require a separate evaluator. */
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
    } else throw new Error(`Unsupported native Artemis var system ${p.get('system') ?? ''}`);
    return true;
  }
}
