import type {YurisArgument, YurisInstruction} from '../../../formats/yuris/ybn.js';
import {decodeLiteral, type YurisSystemValues} from './expression.js';
import {STRING_CAPACITY, fistp} from './numbers.js';
import {NESTING_LIMIT, type YurisTask} from './task.js';
import {SYSTEM_VARIABLE_LIMIT, YurisType, type YurisVariables} from './variables.js';

/**
 * Runs the instructions of one script range for `task`, entered at `position`, and returns the
 * position where interpretation resumes. A guard that does not hold returns the position of
 * its instruction before that instruction changes any state, so the interpreter runs it.
 */
export type CompiledRegion = (task: YurisTask, position: number) => number;

/** Command numbers of the control-flow and declaration commands a region may contain. */
export interface RegionCommands {
  readonly if: number;
  readonly else: number;
  readonly ifBlend: number;
  readonly ifEnd: number;
  readonly int: number;
  readonly str: number;
  readonly let: number;
}

export interface RegionSource {
  readonly instructions: readonly YurisInstruction[];
  readonly variables: YurisVariables;
  readonly system: YurisSystemValues;
  readonly commands: RegionCommands;
  /**
   * Whether the instruction may run without its handler: the handler is the native one, the
   * decoder's checks of its arguments cannot fail and no trace observer reads its state.
   */
  eligible(position: number): boolean;
}

/** The longest range one region covers. */
export const REGION_LIMIT = 160;

/**
 * System variables whose reads only return state (0x448280, 0x4212D4): call frame
 * parameters and results, the loop counter, task values and fixed environment values.
 */
const PURE_INTS = new Set([
  0x2, 0x3, 0x4, 0x5, 0x6, 0x7, 0x8, 0x9, 0xb, 0xd, 0xf, 0x30, 0x31, 0x35, 0x38, 0x39, 0x3a, 0x3b,
  0x3c, 0x3f, 0x40, 0x41, 0x42, 0x43, 0x6c, 0x6d, 0x6e,
]);
const PURE_STRINGS = new Set([
  0xc, 0x37, 0x3e, 0x45, 0x67, 0x68, 0x69, 0x6a, 0x6b, 0x7a, 0x7b, 0x7d, 0x80, 0x81, 0x82, 0x83,
]);
/** Ids whose first index is a reference to another variable (0x421A4C). */
const REFERENCE_ARRAYS = new Set([0x32, 0x33, 0x34, 0x46]);

interface Item {
  readonly kind: 'int' | 'str';
  readonly code: string;
  /** The value of an int literal. */
  readonly literal?: bigint;
}

/** Code of one region: hoisted variables, temporaries and the bail statement. */
class Emitter {
  readonly lines: string[] = [];
  readonly variables = new Map<number, string>();
  private temp = 0;
  bail = '';

  ref(id: number): string {
    let name = this.variables.get(id);
    if (!name) this.variables.set(id, (name = 'v' + id));
    return name;
  }
  value(code: string): string {
    const name = 't' + this.temp++;
    this.lines.push(`const ${name} = ${code};`);
    return name;
  }
  guard(condition: string): void {
    this.lines.push(`if (${condition}) ${this.bail}`);
  }
}

/**
 * Compiles the expression evaluator 0x420ACC for one expression in int mode (mode 1, the
 * int64 result) or string mode (mode 3), with the variable types as they are now as guards.
 * Null when the expression uses an operator or a value the compiled form does not cover;
 * those expressions stay with the interpreter. Evaluation has no effect besides its result.
 */
function compileExpression(
  bytes: Uint8Array,
  mode: 'int' | 'str',
  source: RegionSource,
  out: Emitter,
  avoid = -1,
  target = -1,
): string | null {
  const stack: Item[] = [];
  // A LET target `V<id> <indexes> )`: the flattened element of the outermost frame.
  let element: string | null = null;
  const frames: {id: number; base: number}[] = [];
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const entries = source.variables.entries;
  for (let p = 0; p < bytes.length;) {
    const op = bytes[p]!,
      length = bytes[p + 1]! | (bytes[p + 2]! << 8),
      at = p + 3;
    p = at + length;
    if (p > bytes.length) return null;
    const binary = (): [Item, Item] | null => {
      if (stack.length - (frames.at(-1)?.base ?? 0) < 2) return null;
      const right = stack.pop()!,
        left = stack.pop()!;
      return [left, right];
    };
    const ints = (pair: [Item, Item] | null): pair is [Item, Item] =>
      pair !== null && pair[0].kind === 'int' && pair[1].kind === 'int';
    switch (op) {
      case 0x42: // B
        if (length < 1) return null;
        stack.push(literal(BigInt((bytes[at]! << 24) >> 24)));
        break;
      case 0x57: // W
        if (length < 2) return null;
        stack.push(literal(BigInt(view.getInt16(at, true))));
        break;
      case 0x49: // I
        if (length < 4) return null;
        stack.push(literal(BigInt(view.getInt32(at, true))));
        break;
      case 0x4c: // L
        if (length < 8) return null;
        stack.push(literal(view.getBigInt64(at, true)));
        break;
      case 0x46: // F: rounded by FISTP on the int stacks
        if (length < 8) return null;
        stack.push(literal(fistp(view.getFloat64(at, true))));
        break;
      case 0x4d: // M
        stack.push({kind: 'str', code: JSON.stringify(decodeLiteral(bytes, at, length))});
        break;
      case 0x48: {
        // H
        if (length !== 3) return null;
        const id = variableId(bytes, at);
        if (id < 0 || id === avoid) return null;
        const item = read(id, null);
        if (!item) return null;
        stack.push(item);
        break;
      }
      case 0x56: {
        // V
        if (length !== 3) return null;
        const id = variableId(bytes, at);
        if (id < 0 || id === avoid || REFERENCE_ARRAYS.has(id)) return null;
        frames.push({id, base: stack.length});
        break;
      }
      case 0x29: {
        // )
        const frame = frames.pop();
        if (!frame) return null;
        const indexes = stack.splice(frame.base);
        if (indexes.some((item) => item.kind !== 'int')) return null;
        const flat = flatten(frame.id, indexes);
        if (flat === null) return null;
        if (target >= 0 && frames.length === 0) {
          if (frame.id !== target || element !== null) return null;
          element = flat;
          stack.push(literal(0n));
          break;
        }
        const item = read(frame.id, flat);
        if (!item) return null;
        stack.push(item);
        break;
      }
      case 0x2c: // ,
        break;
      case 0x52: {
        // R
        const top = stack.at(-1);
        if (!top || top.kind !== 'int' || stack.length <= (frames.at(-1)?.base ?? 0)) return null;
        stack.pop();
        stack.push(int(`BigInt.asIntN(64, -(${top.code}))`));
        break;
      }
      case 0x73: {
        // s
        const top = stack.at(-1);
        if (!top || top.kind !== 'int' || stack.length <= (frames.at(-1)?.base ?? 0)) return null;
        stack.pop();
        stack.push({kind: 'str', code: out.value(`(${top.code}).toString()`)});
        break;
      }
      case 0x2b: {
        // +
        const pair = binary();
        if (!pair) return null;
        const [l, r] = pair;
        if (l.kind === 'int' && r.kind === 'int')
          stack.push(int(`BigInt.asIntN(64, ${l.code} + ${r.code})`));
        else if (l.kind === 'str' && r.kind === 'str') {
          const a = out.value(l.code),
            b = out.value(r.code);
          stack.push({
            kind: 'str',
            code: out.value(`${a}.length + ${b}.length < ${STRING_CAPACITY} ? ${a} + ${b} : ${a}`),
          });
        } else return null;
        break;
      }
      case 0x3d: // =
      case 0x21: {
        // !
        const pair = binary();
        if (!pair || pair[0].kind !== pair[1].kind) return null;
        const test = op === 0x3d ? '===' : '!==';
        stack.push(int(`${pair[0].code} ${test} ${pair[1].code} ? 1n : 0n`));
        break;
      }
      case 0x3c: // <
      case 0x3e: // >
      case 0x5a: // Z (>=)
      case 0x53: {
        // S (<=)
        const pair = binary();
        if (!ints(pair)) return null;
        const test = op === 0x3c ? '<' : op === 0x3e ? '>' : op === 0x5a ? '>=' : '<=';
        stack.push(int(`${pair[0].code} ${test} ${pair[1].code} ? 1n : 0n`));
        break;
      }
      case 0x2d: // -
      case 0x2a: {
        // *
        const pair = binary();
        if (!ints(pair)) return null;
        stack.push(
          int(`BigInt.asIntN(64, ${pair[0].code} ${op === 0x2d ? '-' : '*'} ${pair[1].code})`),
        );
        break;
      }
      case 0x2f: // /
      case 0x25: {
        // %
        const pair = binary();
        if (!ints(pair)) return null;
        const b = out.value(pair[1].code);
        const sign = op === 0x2f ? '/' : '%';
        stack.push(int(`${b} === 0n ? 0n : BigInt.asIntN(64, ${pair[0].code} ${sign} ${b})`));
        break;
      }
      case 0x41: // A
      case 0x4f: // O
      case 0x5e: {
        // ^
        const pair = binary();
        if (!ints(pair)) return null;
        const sign = op === 0x41 ? '&' : op === 0x4f ? '|' : '^';
        stack.push(int(`${pair[0].code} ${sign} ${pair[1].code}`));
        break;
      }
      case 0x26: // &
      case 0x7c: {
        // |
        const pair = binary();
        if (!ints(pair)) return null;
        const a = out.value(pair[0].code),
          b = out.value(pair[1].code);
        const join = op === 0x26 ? '&&' : '||';
        stack.push(int(`${a} !== 0n ${join} ${b} !== 0n ? 1n : 0n`));
        break;
      }
      default:
        return null;
    }
  }
  if (frames.length || stack.length === 0) return null;
  if (target >= 0) return stack.length === 1 ? element : null;
  const result = stack[0]!;
  if (mode === 'int') return result.kind === 'int' ? result.code : '0n';
  if (result.kind === 'int') return "''";
  const text = out.value(result.code);
  return `(${text}.indexOf('\\0') < 0 ? ${text} : ${text}.slice(0, ${text}.indexOf('\\0')))`;

  function literal(value: bigint): Item {
    return {kind: 'int', code: `${value}n`, literal: value};
  }
  function int(code: string): Item {
    return {kind: 'int', code: out.value(code)};
  }

  /**
   * The ordinary in-bounds flattening of `)` (row-major against the dimensions); any other
   * index (out of range, or a count that is not the dimension count) goes to the interpreter.
   */
  function flatten(id: number, indexes: Item[]): string | null {
    if (!entries[id] || indexes.length === 0) return null;
    const v = out.ref(id);
    const dimensions = out.value(`${v}.dimensions`);
    out.guard(`${dimensions}.length !== ${indexes.length}`);
    let element = '';
    indexes.forEach((item, k) => {
      const index =
        item.literal !== undefined && item.literal >= 0n && item.literal < 0x7fffffffn
          ? String(item.literal)
          : out.value(`Number(${item.code})`);
      if (item.literal !== undefined && index === String(item.literal))
        out.guard(`${index} >= ${dimensions}[${k}]`);
      else out.guard(`!(${index} >= 0 && ${index} < ${dimensions}[${k}])`);
      element = k === 0 ? index : `(${element}) * ${dimensions}[${k}] + ${index}`;
    });
    return indexes.length === 1 ? element : out.value(element);
  }

  /** 0x420EC4 / 0x42158E: an element read (`element` null for a scalar read of element 0). */
  function read(id: number, element: string | null): Item | null {
    const variable = entries[id];
    if (!variable) return null;
    const v = out.ref(id);
    const index = element ?? '0';
    if (id >= SYSTEM_VARIABLE_LIMIT) {
      if (variable.type === YurisType.Int) {
        out.guard(`${v}.type !== ${YurisType.Int}`);
        return {kind: 'int', code: out.value(`${v}.ints[${index}] ?? 0n`)};
      }
      if (variable.type === YurisType.String) {
        out.guard(`${v}.type !== ${YurisType.String}`);
        return {
          kind: 'str',
          code: out.value(`${index} < ${v}.count ? ${v}.strings[${index}] : ''`),
        };
      }
      return null;
    }
    if (variable.type === YurisType.Int && PURE_INTS.has(id)) {
      out.guard(`${v}.type !== ${YurisType.Int}`);
      if (id === 0x30 && element === null)
        return {
          kind: 'int',
          code: out.value('task.loopDepth === 0 ? 0n : task.loops[task.loopDepth - 1].counter'),
        };
      return {kind: 'int', code: out.value(`S.int(${id}, ${index}, 0)`)};
    }
    if (variable.type === YurisType.String && PURE_STRINGS.has(id)) {
      out.guard(`${v}.type !== ${YurisType.String}`);
      return {kind: 'str', code: out.value(`S.string(${id}, ${index}, 0)`)};
    }
    return null;
  }
}

/** The variable id of an `H`/`V` operand; -1 for the reference prefixes '`' and '#'. */
function variableId(bytes: Uint8Array, at: number): number {
  const sigil = bytes[at]!;
  if (sigil === 0x60 || sigil === 0x23) return -1;
  return bytes[at + 1]! | (bytes[at + 2]! << 8);
}

/** The variable of a scalar target `H<sigil><id>`, or -1. */
function scalarTarget(arg: YurisArgument | undefined): number {
  const bytes = arg?.expression;
  if (!bytes || bytes.length !== 6 || bytes[0] !== 0x48 || bytes[1] !== 3 || bytes[2] !== 0)
    return -1;
  return variableId(bytes, 3);
}

const isFloat = (arg: YurisArgument) => arg.type === 2 || arg.type === 4;

/** Code of one instruction, or null when it stays with the interpreter. */
function compileInstruction(
  position: number,
  source: RegionSource,
  out: Emitter,
  jump: (target: number) => string,
): boolean {
  const instruction = source.instructions[position]!;
  const c = source.commands,
    args = instruction.args,
    entries = source.variables.entries;
  out.bail = `return ${position};`;
  switch (instruction.command) {
    case c.if: {
      // 0x4435B0: the entry is pushed before the condition runs; a full stack is error 0x18CE0.
      const [condition, next, end] = args;
      if (args.length !== 3 || !condition!.expression || isFloat(condition!)) return false;
      const value = compileExpression(condition!.expression, 'int', source, out);
      if (value === null) return false;
      const test = out.value(value);
      out.lines.push(
        'const d = task.ifDepth;',
        `if (d + 1 >= ${NESTING_LIMIT}) ${out.bail}`,
        'const e = task.ifEntry(d);',
        `e.position = ${position}; e.loopDepth = task.loopDepth; e.end = ${end!.size};`,
        'task.ifDepth = d + 1;',
        `if (${test} === 0n) ${jump(next!.size !== 0 ? next!.size : end!.size)}`,
      );
      return true;
    }
    case c.else: {
      // 0x43D710
      out.guard('task.ifDepth === 0');
      if (args.length === 0) return true;
      const [condition, next] = args;
      if (args.length !== 2 || !condition!.expression || isFloat(condition!)) return false;
      const value = compileExpression(condition!.expression, 'int', source, out);
      if (value === null) return false;
      const target = next!.size !== 0 ? String(next!.size) : 'task.ifs[task.ifDepth - 1].end';
      out.lines.push(`if (${value} === 0n) { pc = ${target}; continue; }`);
      return true;
    }
    case c.ifBlend:
      // 0x4436A8
      out.guard('task.ifDepth === 0');
      out.lines.push('pc = task.ifs[task.ifDepth - 1].end; continue;');
      return true;
    case c.ifEnd:
      // 0x4437F8
      out.guard('task.ifDepth === 0');
      out.lines.push('task.ifs[--task.ifDepth].end = 0;');
      return true;
    case c.int:
    case c.str: {
      // INT/STR 0x469CE0 with a scalar target: the target's dimensions clear, then the value
      // (0 / '' without one) re-creates the variable (0x46A558 / 0x46A2E0).
      const [target, value] = args;
      const id = scalarTarget(target);
      if (id < SYSTEM_VARIABLE_LIMIT || !entries[id] || args.length > 2) return false;
      const string = instruction.command === c.str;
      let code = string ? "''" : '0n';
      if (value) {
        if (!value.expression || (!string && isFloat(value))) return false;
        const compiled = compileExpression(
          value.expression,
          string ? 'str' : 'int',
          source,
          out,
          id,
        );
        if (compiled === null) return false;
        code = string ? `${out.value(compiled)}.slice(0, ${STRING_CAPACITY - 1})` : compiled;
      }
      const v = out.ref(id),
        result = out.value(code);
      const type = string ? YurisType.String : YurisType.Int,
        array = string ? 'strings' : 'ints';
      out.lines.push(
        `if (${v}.dimensions.length !== 0) ${v}.dimensions = [];`,
        `if (${v}.type === ${type} && ${v}.${array}.length === 1) { ${v}.count = 1; ${v}.${array}[0] = ${result}; }`,
        `else A.${string ? 'allocateString' : 'allocateInt'}(${id}, ${result});`,
      );
      return true;
    }
    case c.let: {
      // LET 0x443BCC on an int or string element of a script variable.
      const [target, value] = args;
      if (args.length !== 2 || !target!.expression || !value!.expression) return false;
      const bytes = target!.expression;
      let id = scalarTarget(target),
        element = '0';
      if (id < 0) {
        // V<sigil><id> <indexes> ): the target's element, in bounds.
        if (bytes[0] !== 0x56 || bytes[1] !== 3 || bytes[2] !== 0) return false;
        id = variableId(bytes, 3);
        if (id < SYSTEM_VARIABLE_LIMIT) return false;
        const flat = compileExpression(bytes, 'int', source, out, -1, id);
        if (flat === null) return false;
        element = flat;
      }
      const variable = entries[id];
      if (id < SYSTEM_VARIABLE_LIMIT || !variable || isFloat(value!)) return false;
      const v = out.ref(id),
        op = target!.op;
      if (variable.type === YurisType.Int) {
        const update = INT_OPS[op];
        if (update === undefined) return false;
        out.guard(`${v}.type !== ${YurisType.Int} || ${element} >= ${v}.count`);
        const compiled = compileExpression(value!.expression, 'int', source, out);
        if (compiled === null) return false;
        const result = out.value(compiled);
        out.lines.push(`${v}.ints[${element}] = ${update(`${v}.ints[${element}]`, result)};`);
        return true;
      }
      if (variable.type === YurisType.String && (op === 0 || op === 1)) {
        out.guard(`${v}.type !== ${YurisType.String} || ${element} >= ${v}.count`);
        const compiled = compileExpression(value!.expression, 'str', source, out);
        if (compiled === null) return false;
        if (op === 0) out.lines.push(`${v}.strings[${element}] = ${compiled};`);
        else {
          // The bound counts the source expression's bytes.
          const current = out.value(`${v}.strings[${element}]`);
          out.lines.push(
            `if (${value!.size} + ${current}.length < ${STRING_CAPACITY}) ${v}.strings[${element}] = ${current} + ${compiled};`,
          );
        }
        return true;
      }
      return false;
    }
  }
  return false;
}

/** Int assignment operators of LET (0x872AF0): `=`, `+=`, `-=`, `*=`, `/=`, `%=`, `&=`, `|=`, `^=`. */
const INT_OPS: readonly ((current: string, value: string) => string)[] = [
  (_, value) => value,
  (current, value) => `BigInt.asIntN(64, ${current} + ${value})`,
  (current, value) => `BigInt.asIntN(64, ${current} - ${value})`,
  (current, value) => `BigInt.asIntN(64, ${current} * ${value})`,
  (current, value) => `${value} === 0n ? ${current} : BigInt.asIntN(64, ${current} / ${value})`,
  (current, value) => `${value} === 0n ? ${current} : BigInt.asIntN(64, ${current} % ${value})`,
  (current, value) => `${current} & ${value}`,
  (current, value) => `${current} | ${value}`,
  (current, value) => `${current} ^ ${value}`,
];

/**
 * Compiles the eligible instructions of `first..last` (inclusive) into one function; an
 * instruction that does not compile ends the range before it. Returns the function and the
 * last position it covers, or null when the first instruction does not compile.
 */
export function compileRegion(
  source: RegionSource,
  first: number,
  last: number,
): {region: CompiledRegion; last: number} | null {
  const out = new Emitter();
  const cases: string[] = [];
  let end = first;
  for (let position = first; position <= last && position - first < REGION_LIMIT; position++) {
    if (!source.eligible(position)) break;
    const mark = out.lines.length,
      names = new Map(out.variables);
    const ok = compileInstruction(
      position,
      source,
      out,
      (target) => `{ pc = ${target}; continue; }`,
    );
    if (!ok) {
      out.lines.length = mark;
      out.variables.clear();
      for (const [k, v] of names) out.variables.set(k, v);
      break;
    }
    cases.push(`case ${position}: {\n${out.lines.splice(mark).join('\n')}\n}`);
    end = position;
  }
  if (cases.length === 0) return null;
  // Jumps past the compiled range return to the interpreter through the default case.
  const body = [
    ...[...out.variables].map(([id, name]) => `const ${name} = V[${id}];`),
    'return function region(task, pc) {',
    'for (;;) {',
    'switch (pc) {',
    ...cases,
    `return ${end + 1};`,
    'default: return pc;',
    '}',
    '}',
    '};',
  ].join('\n');
  // eslint-disable-next-line @typescript-eslint/no-implied-eval
  const factory = new Function('V', 'S', 'A', body) as (
    v: YurisVariables['entries'],
    s: YurisSystemValues,
    a: YurisVariables,
  ) => CompiledRegion;
  return {
    region: factory(source.variables.entries, source.system, source.variables),
    last: end,
  };
}
