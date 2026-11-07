import type {YurisArgument, YurisInstruction} from '../../../formats/yuris/ybn.js';
import {decodeLiteral, type YurisSystemValues} from './expression.js';
import {STRING_CAPACITY, fistp} from './numbers.js';
import {NESTING_LIMIT, type YurisLoopEntry, type YurisTask} from './task.js';
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
  readonly flt: number;
  readonly str: number;
  readonly let: number;
  readonly loop: number;
  readonly loopEnd: number;
  readonly loopBreak: number;
  readonly loopContinue: number;
  readonly gosub: number;
  readonly return: number;
}

/** Interpreter services that compiled control transfers use. */
export interface RegionHooks {
  /** Continues `task` at `position` of `script`, loading the script on first use (0x4511C1). */
  enter(script: number, position: number): void;
  /** Whether an interpreter fast path tracks the iterations of the loop entry. */
  scanned(entry: YurisLoopEntry): boolean;
  /** Drops the fast path state of a loop entry that a new LOOP reuses. */
  forget(entry: YurisLoopEntry): void;
  /**
   * After a GOSUB from `position` of `caller` entered `entry`: the interpreter's folds of
   * recognized library entries, which may run the callee to its RETURN.
   */
  called(caller: number, position: number, entry: number): void;
}

export interface RegionSource {
  readonly instructions: readonly YurisInstruction[];
  readonly variables: YurisVariables;
  readonly system: YurisSystemValues;
  readonly commands: RegionCommands;
  readonly hooks: RegionHooks;
  /** The script index and its source lines. */
  readonly script: number;
  readonly lines: ArrayLike<number>;
  /**
   * The YSCM decoder kind of argument `id` of `command` (0 number, 1 string, 2 expression,
   * other kinds unevaluated), or -1 when the decoder applies a range check to it.
   */
  argKind(command: number, id: number): number;
  /**
   * The constant label of the GOSUB at `position` when its script is loaded; null otherwise.
   */
  gosubTarget(position: number): {readonly script: number; readonly position: number} | null;
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
/** Float system variables whose reads only return state (0x448110): pi, frame values, task floats. */
const PURE_FLOATS = new Set([0xa, 0x36, 0x3d, 0x44]);
/** Ids whose first index is a reference to another variable (0x421A4C). */
const REFERENCE_ARRAYS = new Set([0x32, 0x33, 0x34, 0x46]);

interface Item {
  /** An int64 (bigint), a string, or a double of a float mode outside indexes. */
  readonly kind: 'int' | 'str' | 'num';
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
 * int64 result), float mode (mode 2, the double result) or string mode (mode 3), with the
 * variable types as they are now as guards. Float mode keeps numbers outside array indexes
 * as doubles (0x420FB2); index expressions use the int stacks. Null when the expression uses
 * an operator or a value the compiled form does not cover; those expressions stay with the
 * interpreter. Evaluation has no effect besides its result.
 */
function compileExpression(
  bytes: Uint8Array,
  mode: 'int' | 'str' | 'float',
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
  const floating = () => mode === 'float' && frames.length === 0;
  const number = (value: bigint): Item => (floating() ? double(Number(value)) : literal(value));
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
    const nums = (pair: [Item, Item] | null): [Item, Item] | null =>
      pair !== null && pair[0].kind === 'num' && pair[1].kind === 'num' ? pair : null;
    switch (op) {
      case 0x42: // B
        if (length < 1) return null;
        stack.push(number(BigInt((bytes[at]! << 24) >> 24)));
        break;
      case 0x57: // W
        if (length < 2) return null;
        stack.push(number(BigInt(view.getInt16(at, true))));
        break;
      case 0x49: // I
        if (length < 4) return null;
        stack.push(number(BigInt(view.getInt32(at, true))));
        break;
      case 0x4c: // L
        if (length < 8) return null;
        stack.push(number(view.getBigInt64(at, true)));
        break;
      case 0x46: {
        // F (0x422008): rounded by FISTP on the int stacks
        if (length < 8) return null;
        const value = view.getFloat64(at, true);
        stack.push(floating() ? double(value) : literal(fistp(value)));
        break;
      }
      case 0x4d: // M
        stack.push({kind: 'str', code: JSON.stringify(decodeLiteral(bytes, at, length))});
        break;
      case 0x48: {
        // H
        if (length !== 3) return null;
        const id = variableId(bytes, at);
        if (id < 0 || id === avoid) return null;
        const item = read(id, null, floating());
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
        const item = read(frame.id, flat, floating());
        if (!item) return null;
        stack.push(item);
        break;
      }
      case 0x2c: // ,
        break;
      case 0x52: {
        // R
        const top = stack.at(-1);
        if (!top || top.kind === 'str' || stack.length <= (frames.at(-1)?.base ?? 0)) return null;
        stack.pop();
        stack.push(
          top.kind === 'num' ? num(`-(${top.code})`) : int(`BigInt.asIntN(64, -(${top.code}))`),
        );
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
        else if (l.kind === 'num' && r.kind === 'num') stack.push(num(`${l.code} + ${r.code}`));
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
        if (pair[0].kind === 'num') {
          stack.push(num(`${pair[0].code} ${test} ${pair[1].code} ? 1 : 0`));
          break;
        }
        // A string comparison leaves its result on the int stacks only.
        if (floating()) return null;
        stack.push(int(`${pair[0].code} ${test} ${pair[1].code} ? 1n : 0n`));
        break;
      }
      case 0x3c: // <
      case 0x3e: // >
      case 0x5a: // Z (>=)
      case 0x53: {
        // S (<=)
        const pair = binary();
        const test = op === 0x3c ? '<' : op === 0x3e ? '>' : op === 0x5a ? '>=' : '<=';
        const real = nums(pair);
        if (real) {
          stack.push(num(`${real[0].code} ${test} ${real[1].code} ? 1 : 0`));
          break;
        }
        if (!ints(pair)) return null;
        stack.push(int(`${pair[0].code} ${test} ${pair[1].code} ? 1n : 0n`));
        break;
      }
      case 0x2d: // -
      case 0x2a: {
        // *
        const pair = binary();
        const real = nums(pair);
        if (real) {
          stack.push(num(`${real[0].code} ${op === 0x2d ? '-' : '*'} ${real[1].code}`));
          break;
        }
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
        const real = nums(pair);
        if (real) {
          // '%' drops the operand in a float mode.
          if (op === 0x25) stack.push(real[0]);
          else {
            const b = out.value(real[1].code);
            stack.push(num(`${b} === 0 ? 0 : ${real[0].code} / ${b}`));
          }
          break;
        }
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
        const real = nums(pair);
        if (real) {
          // Int64 only: a float mode drops the operand.
          stack.push(real[0]);
          break;
        }
        if (!ints(pair)) return null;
        const sign = op === 0x41 ? '&' : op === 0x4f ? '|' : '^';
        stack.push(int(`${pair[0].code} ${sign} ${pair[1].code}`));
        break;
      }
      case 0x26: // &
      case 0x7c: {
        // |
        const pair = binary();
        const join = op === 0x26 ? '&&' : '||';
        const real = nums(pair);
        if (real) {
          const a = out.value(real[0].code),
            b = out.value(real[1].code);
          stack.push(num(`${a} !== 0 ${join} ${b} !== 0 ? 1 : 0`));
          break;
        }
        if (!ints(pair)) return null;
        const a = out.value(pair[0].code),
          b = out.value(pair[1].code);
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
  // A string result leaves the double stack as it was.
  if (mode === 'float') return result.kind === 'num' ? result.code : null;
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
  function num(code: string): Item {
    return {kind: 'num', code: out.value(code)};
  }
  function double(value: number): Item {
    return {kind: 'num', code: Object.is(value, -0) ? '(-0)' : `(${value})`};
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

  /**
   * 0x420EC4 / 0x42158E (0x420FB2 as a double when `real`): an element read (`element` null
   * for a scalar read of element 0). Float elements round by FISTP on the int stacks.
   */
  function read(id: number, element: string | null, real: boolean): Item | null {
    const variable = entries[id];
    if (!variable) return null;
    const v = out.ref(id);
    const index = element ?? '0';
    if (id >= SYSTEM_VARIABLE_LIMIT) {
      if (variable.type === YurisType.Int) {
        out.guard(`${v}.type !== ${YurisType.Int}`);
        if (real) return num(`Number(${v}.ints[${index}] ?? 0n)`);
        return {kind: 'int', code: out.value(`${v}.ints[${index}] ?? 0n`)};
      }
      if (variable.type === YurisType.Float) {
        out.guard(`${v}.type !== ${YurisType.Float}`);
        return real ? num(`${v}.floats[${index}] ?? 0`) : int(`F(${v}.floats[${index}] ?? 0)`);
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
      const code =
        id === 0x30 && element === null
          ? 'task.loopDepth === 0 ? 0n : task.loops[task.loopDepth - 1].counter'
          : `S.int(${id}, ${index}, 0)`;
      return real ? num(`Number(${code})`) : int(code);
    }
    if (variable.type === YurisType.Float && PURE_FLOATS.has(id)) {
      out.guard(`${v}.type !== ${YurisType.Float}`);
      const code = `S.float(${id}, ${index}, 0)`;
      return real ? num(code) : int(`F(${code})`);
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
  /** The integer evaluators by argument type (table 0x872654): float types round by FISTP. */
  const integer = (arg: YurisArgument, avoid = -1): string | null => {
    if (!arg.expression) return null;
    if (!isFloat(arg)) return compileExpression(arg.expression, 'int', source, out, avoid);
    const value = compileExpression(arg.expression, 'float', source, out, avoid);
    return value === null ? null : out.value(`F(${value})`);
  };
  /** The float evaluators by argument type (table 0x872668). */
  const real = (arg: YurisArgument, avoid = -1): string | null => {
    if (!arg.expression) return null;
    const value = compileExpression(
      arg.expression,
      isFloat(arg) ? 'float' : 'int',
      source,
      out,
      avoid,
    );
    if (value === null) return null;
    return isFloat(arg) ? value : out.value(`Number(${value})`);
  };
  switch (instruction.command) {
    case c.if: {
      // 0x4435B0: the entry is pushed before the condition runs; a full stack is error 0x18CE0.
      const [condition, next, end] = args;
      if (args.length !== 3) return false;
      const value = integer(condition!);
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
      // The handler reads the condition and the jump; a third argument is unused.
      const [condition, next] = args;
      if (args.length < 2) return false;
      const value = integer(condition!);
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
    case c.flt:
    case c.str: {
      // INT 0x4438FC / FLT 0x4415C0 / STR 0x44FBC8 with a scalar target: the target's
      // dimensions clear, then the value (0 / 0.0 / '' without one) re-creates the variable
      // (0x46A558 / 0x46A2E0).
      const [target, value] = args;
      const id = scalarTarget(target);
      if (id < SYSTEM_VARIABLE_LIMIT || !entries[id] || args.length > 2) return false;
      const command = instruction.command;
      let code = command === c.str ? "''" : command === c.flt ? '0' : '0n';
      if (value) {
        if (!value.expression) return false;
        const compiled =
          command === c.int
            ? integer(value, id)
            : command === c.flt
              ? real(value, id)
              : compileExpression(value.expression, 'str', source, out, id);
        if (compiled === null) return false;
        code =
          command === c.str ? `${out.value(compiled)}.slice(0, ${STRING_CAPACITY - 1})` : compiled;
      }
      const v = out.ref(id),
        result = out.value(code);
      const [type, array, allocate] =
        command === c.str
          ? [YurisType.String, 'strings', 'allocateString']
          : command === c.flt
            ? [YurisType.Float, 'floats', 'allocateFloat']
            : [YurisType.Int, 'ints', 'allocateInt'];
      out.lines.push(
        `if (${v}.dimensions.length !== 0) ${v}.dimensions = [];`,
        `if (${v}.type === ${type} && ${v}.${array}.length === 1) { ${v}.count = 1; ${v}.${array}[0] = ${result}; }`,
        `else A.${allocate}(${id}, ${result});`,
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
      if (id < SYSTEM_VARIABLE_LIMIT || !variable) return false;
      const v = out.ref(id),
        op = target!.op;
      if (variable.type === YurisType.Int) {
        const update = INT_OPS[op];
        if (update === undefined) return false;
        out.guard(`${v}.type !== ${YurisType.Int} || ${element} >= ${v}.count`);
        const compiled = integer(value!);
        if (compiled === null) return false;
        const result = out.value(compiled);
        out.lines.push(`${v}.ints[${element}] = ${update(`${v}.ints[${element}]`, result)};`);
        return true;
      }
      if (variable.type === YurisType.Float) {
        // Element assignments evaluate in float mode whatever the argument type (0x87267C).
        const update = FLOAT_OPS[op];
        if (update === undefined) return false;
        out.guard(`${v}.type !== ${YurisType.Float} || ${element} >= ${v}.count`);
        const compiled = compileExpression(value!.expression, 'float', source, out);
        if (compiled === null) return false;
        const result = out.value(compiled);
        out.lines.push(update(`${v}.floats[${element}]`, result));
        return true;
      }
      // Type 4 sources evaluate through the float string evaluator 0x420BA8.
      if (variable.type === YurisType.String && (op === 0 || op === 1) && !isFloat(value!)) {
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
    case c.loop: {
      // LOOP 0x445DC4. Counts the interpreter batches (0, -1, 16 and more, the 5-instruction
      // character search) stay with it.
      const [count, end] = args;
      if (args.length !== 2) return false;
      // The decoder's own evaluation of either argument has no effect besides its result.
      if (source.argKind(c.loop, count!.id) < 0 || source.argKind(c.loop, end!.id) < 0)
        return false;
      const value = integer(count!);
      if (value === null) return false;
      const limit = out.value(value);
      const start = position + 1;
      out.guard(
        `${limit} === -1n || ${limit} >= 16n || ${end!.size === start + 5 ? `${limit} > 2n || ` : ''}task.loopDepth + 1 >= ${NESTING_LIMIT}`,
      );
      out.lines.push(
        'const e = task.loopEntry(task.loopDepth);',
        'H.forget(e);',
        `e.start = ${start}; e.ifDepth = task.ifDepth; e.limit = ${limit}; e.end = ${end!.size}; e.counter = 1n;`,
        'task.loopDepth++;',
        `if (${limit} === 0n) { e.counter = 0n; ${jump(end!.size)} }`,
      );
      return true;
    }
    case c.loopEnd: {
      // LOOPEND 0x4460AC; entries an interpreter scan skips through stay with it.
      if (args.length !== 0) return false;
      out.guard('task.loopDepth === 0');
      out.lines.push('const e = task.loops[task.loopDepth - 1];');
      out.guard('H.scanned(e)');
      out.lines.push(
        'if (e.limit !== -1n && e.counter >= e.limit) { task.loopDepth--; e.counter = 0n; e.limit = 0n; e.start = 0; }',
        'else { e.counter = BigInt.asIntN(64, e.counter + 1n); task.ifDepth = e.ifDepth; pc = e.start; continue; }',
      );
      return true;
    }
    case c.loopBreak:
    case c.loopContinue: {
      // LOOPBREAK 0x445F60 / LOOPCONTINUE 0x446018: the LV-th enclosing loop's LOOPEND.
      const leave = instruction.command === c.loopBreak;
      if (args.some((arg) => arg.id !== 0) || args.length > 1) return false;
      let levels = '1n';
      if (args.length === 1) {
        if (source.argKind(instruction.command, 0) !== 0) return false;
        const value = integer(args[0]!);
        if (value === null) return false;
        levels = out.value(value);
      }
      out.lines.push(
        `if (${levels} >= 1n) {`,
        `const depth = task.loopDepth - Number(${levels}) + 1;`,
      );
      out.guard('depth <= 0');
      out.lines.push(
        'task.loopDepth = depth;',
        'const e = task.loops[depth - 1];',
        'task.ifDepth = e.ifDepth;',
        ...(leave ? ['e.counter = 0n; e.limit = 0n;'] : []),
        'pc = e.end; continue;',
        '}',
      );
      return true;
    }
    case c.gosub: {
      // GOSUB 0x442C84 to a constant label: PINT/PSTR of the callee frame, the return state of
      // the caller's frame, then the callee's script continues.
      const target = source.gosubTarget(position);
      if (!target || (target.script === source.script && target.position === position))
        return false;
      const values = evaluate();
      if (!values) return false;
      const extra = instruction.extra;
      const ints = (extra & 0xff) >> 3,
        floats = (((extra & 7) * 4 + (extra >> 14)) << 24) >> 24,
        strings = (extra >> 9) & 0x1f;
      const ids = new Set(args.map((arg) => arg.id));
      const reals = parameters(floats, 16);
      if (!reals) return false;
      out.guard('task.gosubDepth === 0x3f');
      out.lines.push(
        'const d = task.gosubDepth;',
        'const callee = task.frameAt(d + 1);',
        `callee.flags[0][0] = ${ints}; callee.flags[1][0] = ${floats}; callee.flags[2][0] = ${strings};`,
      );
      if (args.length !== 1 || !ids.has(0)) {
        for (let i = 1; i <= ints; i++)
          out.lines.push(
            `callee.ints[0][${i}] = ${values.get(i) ?? '0n'}; callee.flags[0][${i}] = ${values.has(i) ? 1 : 0};`,
          );
        for (let i = 1; i <= floats; i++)
          out.lines.push(
            `callee.floats[0][${i}] = ${reals.get(i) ?? '0'}; callee.flags[1][${i}] = ${reals.has(i) ? 1 : 0};`,
          );
        for (let i = 1; i <= strings; i++)
          out.lines.push(
            `callee.strings[0][${i}] = ${values.get(32 + i) ?? `callee.strings[0][${i}] === null ? null : ''`}; callee.flags[2][${i}] = ${values.has(32 + i) ? 1 : 0};`,
          );
      }
      out.lines.push(
        'const f = task.frameAt(d);',
        `f.returnPosition = ${position + 1}; f.returnScript = ${source.script}; f.returnLine = ${source.lines[position] ?? 0};`,
        'f.ifDepth = task.ifDepth; f.loopDepth = task.loopDepth;',
        'task.gosubDepth = d + 1;',
        `H.enter(${target.script}, ${target.position});`,
        `H.called(${source.script}, ${position}, ${target.position});`,
        'return task.position;',
      );
      return true;
    }
    case c.return: {
      // RETURN 0x44B7DC inside a call: RINT/RSTR of the caller's frame, then the caller resumes.
      const values = evaluate();
      if (!values) return false;
      const extra = instruction.extra;
      const ints = (extra & 0xff) >> 3,
        floats = (((extra & 7) * 4 + (extra >> 14)) << 24) >> 24,
        strings = (extra >> 9) & 0x1f;
      const reals = parameters(floats, 15);
      if (!reals) return false;
      out.guard('task.gosubDepth === 0');
      out.lines.push(
        'const d = task.gosubDepth;',
        'const caller = task.frameAt(d - 1);',
        `caller.flags[3][0] = ${ints}; caller.flags[4][0] = ${floats}; caller.flags[5][0] = ${strings};`,
      );
      if (args.length !== 0) {
        for (let i = 1; i <= ints; i++)
          out.lines.push(
            `caller.ints[1][${i}] = ${values.get(i - 1) ?? '0n'}; caller.flags[3][${i}] = ${values.has(i - 1) ? 1 : 0};`,
          );
        for (let i = 1; i <= floats; i++)
          out.lines.push(
            `caller.floats[1][${i}] = ${reals.get(i) ?? '0'}; caller.flags[4][${i}] = ${reals.has(i) ? 1 : 0};`,
          );
        for (let i = 1; i <= strings; i++)
          out.lines.push(
            `caller.strings[1][${i}] = ${values.get(31 + i) ?? `caller.strings[1][${i}] === null ? null : ''`}; caller.flags[5][${i}] = ${values.has(31 + i) ? 1 : 0};`,
          );
      }
      out.lines.push(
        'task.gosubDepth = d - 1;',
        'H.enter(caller.returnScript, caller.returnPosition);',
        'return caller.returnPosition;',
      );
      return true;
    }
  }
  return false;

  /**
   * The decoder 0x4253C9 / 0x4430C5 for every argument: numbers and strings by their YSCM
   * kind, keyed by argument id; null when one does not compile or has a range check.
   */
  function evaluate(): Map<number, string> | null {
    const values = new Map<number, string>();
    for (const arg of args) {
      const kind = source.argKind(instruction.command, arg.id);
      if (kind < 0) return null;
      if (kind !== 0 && kind !== 1) continue;
      if (!arg.expression) return null;
      const value =
        kind === 0 ? integer(arg) : compileExpression(arg.expression, 'str', source, out);
      if (value === null) return null;
      values.set(arg.id, out.value(value));
    }
    return values;
  }

  /**
   * PFLT (ids 17..) / RFLT (ids 16..) of GOSUB and RETURN: float mode whatever the type
   * (0x420C8C) on the expression the decoder kept, keyed by parameter number; null when one
   * does not compile or its argument is not a kept expression.
   */
  function parameters(count: number, base: number): Map<number, string> | null {
    const values = new Map<number, string>();
    for (let i = 1; i <= count; i++) {
      const arg = args.find((a) => a.id === base + i);
      if (!arg) continue;
      if (source.argKind(instruction.command, arg.id) !== 2 || !arg.expression) return null;
      const value = compileExpression(arg.expression, 'float', source, out);
      if (value === null) return null;
      values.set(i, out.value(value));
    }
    return values;
  }
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
 * Float element assignments of LET (0x443BCC with the float operator table): `=`, `+=`, `-=`,
 * `*=` and `/=` on doubles (division by zero leaves the element), `%=` and the bitwise
 * operators on the FISTP-rounded values.
 */
const FLOAT_OPS: readonly ((current: string, value: string) => string)[] = [
  (current, value) => `${current} = ${value};`,
  (current, value) => `${current} = ${current} + ${value};`,
  (current, value) => `${current} = ${current} - ${value};`,
  (current, value) => `${current} = ${current} * ${value};`,
  (current, value) => `if (${value} !== 0) ${current} = ${current} / ${value};`,
  (current, value) =>
    `if (${value} !== 0) ${current} = Number(BigInt.asIntN(64, F(${current}) % (F(${value}) || 1n)));`,
  (current, value) => `${current} = Number(F(${current}) & F(${value}));`,
  (current, value) => `${current} = Number(F(${current}) | F(${value}));`,
  (current, value) => `${current} = Number(F(${current}) ^ F(${value}));`,
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
  const factory = new Function('V', 'S', 'A', 'H', 'F', body) as (
    v: YurisVariables['entries'],
    s: YurisSystemValues,
    a: YurisVariables,
    h: RegionHooks,
    f: typeof fistp,
  ) => CompiledRegion;
  return {
    region: factory(source.variables.entries, source.system, source.variables, source.hooks, fistp),
    last: end,
  };
}
