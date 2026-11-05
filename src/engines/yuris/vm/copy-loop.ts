import type {YurisInstruction, YurisToken} from '../../../formats/yuris/ybn.js';
import {SYSTEM_VARIABLE_LIMIT, YurisType, type YurisVariables} from './variables.js';

const LET = 0x35;
const LOOPEND = 0x3a;
const COUNTER = 0x30;
const IF = 0x2c;
const IFEND = 0x30;

type Assignment = {target: number} & ({value: bigint} | {offset: number});

function variable(token: YurisToken | undefined, operator: number, sigil = 0x40): number {
  if (token?.op !== operator || token.payload[0] !== sigil) return -1;
  return token.payload[1]! | (token.payload[2]! << 8);
}

function integer(token: YurisToken): bigint | undefined {
  const p = token.payload;
  const view = new DataView(p.buffer, p.byteOffset, p.byteLength);
  switch (token.op) {
    case 0x42:
      return BigInt(view.getInt8(0));
    case 0x57:
      return BigInt(view.getInt16(0, true));
    case 0x49:
      return BigInt(view.getInt32(0, true));
    case 0x4c:
      return view.getBigInt64(0, true);
  }
}

/** Recognize a pure LOOP (0x445DC4) consisting of constant fills or forward array shifts. */
export function copyLoop(
  instructions: readonly YurisInstruction[],
  start: number,
  end: number,
): readonly Assignment[] | null {
  if (end <= start || end - start > 32 || instructions[end]?.command !== LOOPEND) return null;
  const assignments: Assignment[] = [];
  const targets = new Set<number>();
  for (let i = start; i < end; i++) {
    const instruction = instructions[i]!;
    if (instruction.command !== LET || instruction.args.length !== 2) return null;
    const [left, right] = instruction.args;
    if (left!.op !== 0 || left!.type !== 1 || right!.type !== 1) return null;
    const a = left!.tokens,
      b = right!.tokens;
    if (!a || !b || a.length !== 3 || variable(a[1], 0x48) !== COUNTER || a[2]!.op !== 0x29)
      return null;
    const target = variable(a[0], 0x56);
    if (target < SYSTEM_VARIABLE_LIMIT || targets.has(target)) return null;
    targets.add(target);
    if (b.length === 1) {
      const value = integer(b[0]!);
      if (value === undefined) return null;
      assignments.push({target, value});
    } else {
      if (
        b.length !== 5 ||
        variable(b[0], 0x56) !== target ||
        variable(b[1], 0x48) !== COUNTER ||
        b[3]!.op !== 0x2b ||
        b[4]!.op !== 0x29
      )
        return null;
      const offset = variable(b[2], 0x48);
      if (offset < SYSTEM_VARIABLE_LIMIT) return null;
      assignments.push({target, offset});
    }
  }
  return assignments.some((a) => 'offset' in a && targets.has(a.offset)) ? null : assignments;
}

/** Validate every access before writing. The interpreter still executes the final iteration. */
export function applyCopyLoop(
  assignments: readonly Assignment[],
  variables: YurisVariables,
  limit: number,
): boolean {
  if (variables.entries[COUNTER]?.type !== YurisType.Int) return false;
  const operations: {values: BigInt64Array; value: bigint; offset: number | null}[] = [];
  const buffers = new Set<ArrayBufferLike>();
  for (const assignment of assignments) {
    const variable = variables.entries[assignment.target];
    const values = variable?.ints;
    if (
      variable?.type !== YurisType.Int ||
      variable.dimensions.length !== 1 ||
      !values ||
      limit >= variable.dimensions[0]! ||
      limit >= variable.count ||
      limit >= values.length ||
      buffers.has(values.buffer)
    )
      return false;
    buffers.add(values.buffer);
    if ('value' in assignment) operations.push({values, value: assignment.value, offset: null});
    else {
      const scalar = variables.entries[assignment.offset];
      const offset = scalar?.ints?.[0];
      if (
        scalar?.type !== YurisType.Int ||
        scalar.dimensions.length !== 0 ||
        offset === undefined ||
        offset < 0n ||
        offset >= BigInt(Math.min(values.length, variable.dimensions[0]!) - limit)
      )
        return false;
      operations.push({values, value: 0n, offset: Number(offset)});
    }
  }
  for (const {values, value, offset} of operations) {
    if (offset === null) values.fill(value, 1, limit);
    else values.copyWithin(1, 1 + offset, limit + offset);
  }
  return true;
}

type Comparable = YurisType.Int | YurisType.String;
interface VariableRead {
  readonly id: number;
  readonly type: Comparable;
}
interface CounterRead extends VariableRead {
  readonly offset: number;
}
export interface GuardLoop {
  readonly primary: CounterRead;
  readonly value: bigint | VariableRead;
  readonly operator: number;
  readonly arrays: readonly CounterRead[];
  readonly scalars: readonly VariableRead[];
  readonly order?: {index: number; base: number; length: number};
}

function guardVariable(token: YurisToken | undefined, operator: number): VariableRead | null {
  const type = token?.payload[0] === 0x24 ? YurisType.String : YurisType.Int;
  const id = variable(token, operator, type === YurisType.String ? 0x24 : 0x40);
  return id >= SYSTEM_VARIABLE_LIMIT ? {id, type} : null;
}

function counterRead(tokens: readonly YurisToken[], first: number, index: number) {
  const read = guardVariable(tokens[first], 0x56);
  if (!read || variable(tokens[first + 1], 0x48) !== index) return null;
  let end = first + 2;
  let offset = 0;
  if (tokens[end]?.op === 0x42 && tokens[end + 1]?.op === 0x2d) {
    offset = -Number(integer(tokens[end]!)!);
    end += 2;
  }
  return tokens[end]?.op === 0x29 ? {read: {...read, offset}, next: end + 1} : null;
}

/** LET index=base+counter-1 followed by IF index>length / LET index-=length. */
function wrappedOrder(instructions: readonly YurisInstruction[], start: number) {
  const first = instructions[start];
  const check = instructions[start + 1];
  const reduce = instructions[start + 2];
  if (
    first?.command !== LET ||
    first.args.length !== 2 ||
    check?.command !== IF ||
    check.args.length !== 3 ||
    reduce?.command !== LET ||
    reduce.args.length !== 2 ||
    instructions[start + 3]?.command !== IFEND ||
    check.args[1]!.size !== 0 ||
    check.args[2]!.size !== start + 3 ||
    first.args[0]!.op !== 0 ||
    reduce.args[0]!.op !== 2 ||
    [first.args[0], first.args[1], check.args[0], reduce.args[0], reduce.args[1]].some(
      (arg) => arg!.type !== 1,
    )
  )
    return null;
  const target = first.args[0]!.tokens;
  const formula = first.args[1]!.tokens;
  const limit = check.args[0]!.tokens;
  const adjusted = reduce.args[0]!.tokens;
  const subtract = reduce.args[1]!.tokens;
  if (
    target?.length !== 1 ||
    formula?.length !== 5 ||
    limit?.length !== 3 ||
    adjusted?.length !== 1 ||
    subtract?.length !== 1
  )
    return null;
  const index = variable(target[0], 0x48);
  const base = variable(formula[0], 0x48);
  const length = variable(limit[1], 0x48);
  if (
    Math.min(index, base, length) < SYSTEM_VARIABLE_LIMIT ||
    index === base ||
    index === length ||
    variable(formula[1], 0x48) !== COUNTER ||
    integer(formula[2]!) !== 1n ||
    formula[3]!.op !== 0x2d ||
    formula[4]!.op !== 0x2b ||
    variable(limit[0], 0x48) !== index ||
    limit[2]!.op !== 0x3e ||
    variable(adjusted[0], 0x48) !== index ||
    variable(subtract[0], 0x48) !== length
  )
    return null;
  return {index, base, length};
}

/** The first IF guards the whole loop body and starts with an array comparison.
 * Any remaining clause must be a pure, independent predicate combined with AND.
 */
export function scanGuardLoop(
  instructions: readonly YurisInstruction[],
  start: number,
  end: number,
): GuardLoop | null {
  const order = wrappedOrder(instructions, start);
  const branch = instructions[start + (order ? 4 : 0)];
  if (
    branch?.command !== IF ||
    branch.args.length !== 3 ||
    branch.args[1]!.size !== 0 ||
    branch.args[2]!.size !== end - 1 ||
    instructions[end - 1]?.command !== IFEND ||
    instructions[end]?.command !== LOOPEND
  )
    return null;
  const condition = branch.args[0]!;
  const tokens = condition.tokens;
  if (condition.type !== 1 || !tokens || tokens.length > 128) return null;
  const index = order?.index ?? COUNTER;
  const first = counterRead(tokens, 0, index);
  if (!first) return null;
  const operator = tokens[first.next + 1]?.op;
  if (
    operator === undefined ||
    (operator !== 0x3d &&
      operator !== 0x21 &&
      (first.read.type !== YurisType.Int || ![0x3c, 0x3e, 0x5a, 0x53].includes(operator)))
  )
    return null;
  const operand = tokens[first.next]!;
  const scalarValue = guardVariable(operand, 0x48);
  const value = scalarValue ?? integer(operand);
  if (value === undefined || (scalarValue?.type ?? YurisType.Int) !== first.read.type) return null;
  const arrays = [first.read];
  const scalars: VariableRead[] = scalarValue ? [scalarValue] : [];
  let p = first.next + 2;
  if (p !== tokens.length && tokens.at(-1)!.op !== 0x26) return null;
  const stack: Comparable[] = [];
  while (p < tokens.length - 1) {
    const array = counterRead(tokens, p, index);
    const scalar = guardVariable(tokens[p], 0x48);
    const token = tokens[p]!;
    if (array) {
      arrays.push(array.read);
      stack.push(array.read.type);
      p = array.next;
      continue;
    }
    if (scalar) {
      scalars.push(scalar);
      stack.push(scalar.type);
    } else if (integer(token) !== undefined) stack.push(YurisType.Int);
    else {
      const right = stack.pop(),
        left = stack.pop();
      if (left === undefined || left !== right) return null;
      if (token.op !== 0x3d && ((token.op !== 0x26 && token.op !== 0x7c) || left !== YurisType.Int))
        return null;
      stack.push(YurisType.Int);
    }
    p++;
  }
  if (p < tokens.length && (stack.length !== 1 || stack[0] !== YurisType.Int)) return null;
  if (order && scalars.some((scalar) => scalar.id === order.index)) return null;
  return {primary: first.read, value, operator, arrays, scalars, order: order ?? undefined};
}

function comparable(variables: YurisVariables, {id, type}: VariableRead) {
  const variable = variables.entries[id];
  if (variable?.type !== type) return null;
  return type === YurisType.Int ? variable.ints : variable.strings;
}

/** Replay the last rejected iteration to preserve the evaluator and IF stack state. */
export function skipGuardLoop(
  plan: GuardLoop,
  variables: YurisVariables,
  first: number,
  last: number,
): number {
  if (first >= last || variables.entries[COUNTER]?.type !== YurisType.Int) return first;
  let base = 1;
  if (plan.order) {
    const valueOf = (id: number) => {
      const variable = variables.entries[id];
      return variable?.type === YurisType.Int && variable.dimensions.length === 0
        ? variable.ints?.[0]
        : undefined;
    };
    const start = valueOf(plan.order.base);
    if (
      start === undefined ||
      start < 1n ||
      start > BigInt(last) ||
      valueOf(plan.order.length) !== BigInt(last) ||
      valueOf(plan.order.index) === undefined
    )
      return first;
    base = Number(start);
  }
  for (const read of plan.arrays) {
    const {id, offset} = read;
    const variable = variables.entries[id]!;
    const values = comparable(variables, read);
    if (
      !values ||
      variable.dimensions.length !== 1 ||
      (plan.order ? 1 : first) + offset < 0 ||
      last + offset >= variable.dimensions[0]! ||
      last + offset >= variable.count ||
      last + offset >= values.length
    )
      return first;
  }
  for (const read of plan.scalars) if (comparable(variables, read)?.[0] === undefined) return first;
  const {offset} = plan.primary;
  const values = comparable(variables, plan.primary)!;
  const expected =
    typeof plan.value === 'bigint' ? plan.value : comparable(variables, plan.value)![0];
  if (plan.operator === 0x3d) {
    const find = (from: number, count: number) => {
      if (values instanceof BigInt64Array)
        return values.subarray(from, from + count).indexOf(expected as bigint);
      const found = values.indexOf(expected as string, from);
      return found >= from && found < from + count ? found - from : -1;
    };
    const start = base + first - 1;
    const index = start <= last ? start : start - last;
    const span = Math.min(last - first + 1, last - index + 1);
    const match = find(index + offset, span);
    if (match >= 0) return Math.max(first, first + match - 1);
    const remaining = last - first + 1 - span;
    if (remaining <= 0) return last;
    const wrapped = find(1 + offset, remaining);
    return wrapped < 0 ? last : Math.max(first, first + span + wrapped - 1);
  }
  const matches = (value: bigint | string | undefined) => {
    if (plan.operator === 0x21) return value !== expected;
    if (typeof value !== 'bigint' || typeof expected !== 'bigint') return false;
    switch (plan.operator) {
      case 0x3c:
        return value < expected;
      case 0x3e:
        return value > expected;
      case 0x5a:
        return value >= expected;
      case 0x53:
        return value <= expected;
    }
    return false;
  };
  let next = first;
  while (next <= last) {
    const index = base + next - 1;
    if (matches(values[(index <= last ? index : index - last) + offset])) break;
    next++;
  }
  return Math.max(first, next - 1);
}

export interface InactiveLoop {
  readonly cursor: number;
  readonly limit: number;
  readonly scratch: number;
  readonly mapping: CounterRead;
  readonly enabled: number;
  readonly selectors: readonly {read: CounterRead; value: bigint}[];
}

function scalarAssignment(instruction: YurisInstruction | undefined, op: number) {
  if (instruction?.command !== LET || instruction.args.length !== 2) return null;
  const [left, right] = instruction.args;
  if (left!.op !== op || left!.type !== 1 || right!.type !== 1 || left!.tokens?.length !== 1)
    return null;
  const id = variable(left!.tokens[0], 0x48);
  return id >= SYSTEM_VARIABLE_LIMIT && right!.tokens ? {id, tokens: right!.tokens} : null;
}

function unbranchedIf(instructions: readonly YurisInstruction[], at: number, last: number) {
  const branch = instructions[at];
  if (branch?.command !== IF || branch.args.length !== 3 || branch.args[1]!.size !== 0) return null;
  const condition = branch.args[0]!;
  const end = branch.args[2]!.size;
  if (
    condition.type !== 1 ||
    !condition.tokens ||
    end <= at ||
    end >= last ||
    instructions[end]?.command !== IFEND
  )
    return null;
  return {tokens: condition.tokens, end};
}

/** Match an open-ended LOOP whose first IF breaks at a scalar limit.
 * Empty iterations advance the cursor, read a mapping and reject every slot predicate.
 */
export function scanInactiveLoop(
  instructions: readonly YurisInstruction[],
  start: number,
  end: number,
): InactiveLoop | null {
  if (instructions[end]?.command !== LOOPEND) return null;
  const increment = scalarAssignment(instructions[start], 1);
  if (increment?.tokens.length !== 1 || integer(increment.tokens[0]!) !== 1n) return null;
  const cursor = increment.id;
  const stop = unbranchedIf(instructions, start + 1, end);
  const leave = instructions[start + 2];
  if (
    stop?.end !== start + 3 ||
    stop.tokens.length !== 3 ||
    variable(stop.tokens[0], 0x48) !== cursor ||
    stop.tokens[2]!.op !== 0x3e ||
    leave?.command !== 0x38 ||
    leave.args.length !== 0
  )
    return null;
  const limit = variable(stop.tokens[1], 0x48);
  const auxiliary = scalarAssignment(instructions[start + 4], 0);
  if (!auxiliary) return null;
  const mapping = counterRead(auxiliary.tokens, 0, cursor);
  if (
    !mapping ||
    mapping.next !== auxiliary.tokens.length ||
    mapping.read.offset !== 0 ||
    mapping.read.type !== YurisType.Int
  )
    return null;
  const optional = unbranchedIf(instructions, start + 5, end);
  if (optional?.tokens.length !== 1) return null;
  const enabled = variable(optional.tokens[0], 0x48);
  const scratch = auxiliary.id;
  if (
    limit < SYSTEM_VARIABLE_LIMIT ||
    enabled < SYSTEM_VARIABLE_LIMIT ||
    new Set([cursor, limit, scratch, enabled]).size !== 4
  )
    return null;
  const selectors: {read: CounterRead; value: bigint}[] = [];
  for (let p = optional.end + 1; p < end;) {
    if (selectors.length === 3) return null;
    const branch = unbranchedIf(instructions, p, end);
    if (!branch) return null;
    const array = counterRead(branch.tokens, 0, cursor);
    if (
      !array ||
      array.next + 2 !== branch.tokens.length ||
      array.read.offset !== 0 ||
      array.read.type !== YurisType.Int ||
      branch.tokens[array.next + 1]!.op !== 0x3d
    )
      return null;
    const value = integer(branch.tokens[array.next]!);
    if (value === undefined) return null;
    selectors.push({read: array.read, value});
    p = branch.end + 1;
  }
  return selectors.length
    ? {cursor, limit, scratch, mapping: mapping.read, enabled, selectors}
    : null;
}

export function skipInactiveLoop(plan: InactiveLoop, variables: YurisVariables): number {
  const scalar = (id: number) => {
    const variable = variables.entries[id];
    return variable?.type === YurisType.Int && variable.dimensions.length === 0
      ? variable.ints
      : null;
  };
  const cursor = scalar(plan.cursor);
  const index = cursor?.[0];
  const length = scalar(plan.limit)?.[0];
  if (
    index === undefined ||
    index < 0n ||
    length === undefined ||
    length > 4_000_000n ||
    index >= length ||
    scalar(plan.scratch)?.[0] === undefined ||
    scalar(plan.enabled)?.[0] !== 0n
  )
    return 0;
  const first = Number(index) + 1,
    last = Number(length);
  const array = (id: number) => {
    const variable = variables.entries[id];
    return variable?.type === YurisType.Int &&
      variable.dimensions.length === 1 &&
      last < variable.dimensions[0]! &&
      last < (variable.ints?.length ?? 0)
      ? variable.ints
      : null;
  };
  if (!array(plan.mapping.id)) return 0;
  let next = last + 1;
  for (const {read, value} of plan.selectors) {
    const values = array(read.id);
    if (!values) return 0;
    const found = values.subarray(first, next).indexOf(value);
    if (found >= 0) next = first + found;
  }
  const skipped = next - first - 1;
  if (skipped <= 0) return 0;
  // Run the final rejected iteration through LET/IF normally. That restores
  // the scratch slot, evaluator stack and IF entries before any active branch.
  cursor![0] = index + BigInt(skipped);
  return skipped;
}

interface Initializer {
  readonly start: number;
  readonly end: number;
  readonly index: number;
  readonly fills: readonly {
    readonly id: number;
    readonly type: YurisType.Int | YurisType.Float | YurisType.String;
    readonly value: bigint | number | string;
  }[];
}

/** A single GOSUB taking the LOOP counter and filling parallel arrays by that index. */
export function scanInitializer(
  instructions: readonly YurisInstruction[],
  call: number,
  end: number,
  target: number,
): Initializer | null {
  const gosub = instructions[call];
  if (
    end !== call + 1 ||
    instructions[end]?.command !== LOOPEND ||
    gosub?.command !== 0x2b ||
    gosub.extra !== 8 ||
    gosub.args.length !== 2 ||
    gosub.args[0]!.id !== 0 ||
    gosub.args[1]!.id !== 1 ||
    gosub.args[1]!.type !== 1
  )
    return null;
  const parameter = gosub.args[1]!.tokens;
  if (parameter?.length !== 1 || variable(parameter[0], 0x48) !== COUNTER) return null;
  const declaration = instructions[target];
  if (declaration?.command !== 0x32 || declaration.args.length !== 2) return null;
  const indexTokens = declaration.args[0]!.tokens,
    valueTokens = declaration.args[1]!.tokens;
  if (
    indexTokens?.length !== 1 ||
    valueTokens?.length !== 3 ||
    declaration.args[1]!.type !== 1 ||
    variable(valueTokens[0], 0x56) !== 53 ||
    integer(valueTokens[1]!) !== 1n ||
    valueTokens[2]!.op !== 0x29
  )
    return null;
  const index = variable(indexTokens[0], 0x48);
  if (index < SYSTEM_VARIABLE_LIMIT) return null;
  const fills: Initializer['fills'][number][] = [];
  const targets = new Set<number>();
  for (let position = target + 1; position <= target + 33; position++) {
    const ins = instructions[position];
    if (ins?.command === 0x4f && ins.extra === 0 && ins.args.length === 0)
      return fills.length ? {start: target, end: position, index, fills} : null;
    if (ins?.command !== LET || ins.args.length !== 2) return null;
    const [left, right] = ins.args;
    const a = left!.tokens,
      b = right!.tokens;
    if (
      left!.op !== 0 ||
      a?.length !== 3 ||
      b?.length !== 1 ||
      variable(a[1], 0x48) !== index ||
      a[2]!.op !== 0x29
    )
      return null;
    const id = variable(a[0], 0x56, left!.type === 3 ? 0x24 : 0x40);
    if (id < SYSTEM_VARIABLE_LIMIT || id === index || targets.has(id)) return null;
    targets.add(id);
    const token = b[0]!;
    if (
      left!.type === 3 &&
      right!.type === 3 &&
      token.op === 0x4d &&
      token.payload.length === 2 &&
      token.payload[0] === token.payload[1]
    ) {
      fills.push({id, type: YurisType.String, value: ''});
    } else if ((left!.type === 1 || left!.type === 2) && right!.type === 1) {
      const value = integer(token);
      if (value === undefined) return null;
      fills.push(
        left!.type === 1
          ? {id, type: YurisType.Int, value}
          : {id, type: YurisType.Float, value: Number(value)},
      );
    } else return null;
  }
  return null;
}

export function applyInitializer(
  plan: Initializer,
  variables: YurisVariables,
  count: number,
): boolean {
  if (
    variables.entries[COUNTER]?.type !== YurisType.Int ||
    variables.entries[53]?.type !== YurisType.Int ||
    !variables.entries[plan.index]
  )
    return false;
  for (const {id, type} of plan.fills) {
    const variable = variables.entries[id];
    if (
      !variable ||
      variable.type !== type ||
      variable.dimensions.length !== 1 ||
      count >= variable.dimensions[0]! ||
      count >= variable.count
    )
      return false;
    const storage =
      type === YurisType.Int
        ? variable.ints
        : type === YurisType.Float
          ? variable.floats
          : variable.strings;
    if (!storage || count >= storage.length) return false;
  }
  for (const {id, value} of plan.fills) {
    const variable = variables.entries[id]!;
    if (typeof value === 'bigint') variable.ints!.fill(value, 1, count);
    else if (typeof value === 'number') variable.floats!.fill(value, 1, count);
    else variable.strings!.fill(value, 1, count);
  }
  // The ordinary final call restores all register, argument and frame state.
  return true;
}
