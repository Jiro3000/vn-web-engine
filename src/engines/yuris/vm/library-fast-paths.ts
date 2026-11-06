import type {YurisArgument, YurisCommandSet, YurisInstruction} from '../../../formats/yuris/ybn.js';

export interface StringSlicePrelude {
  readonly result: number;
  readonly start: number;
  readonly length: number;
  readonly count: number;
}

const byte = (n: number) => n.toString(16).padStart(2, '0');
const word = (n: number) => byte(n & 255) + byte(n >>> 8);
const scalar = (id: number, string = false) => '480300' + (string ? '24' : '40') + word(id);
const int = (value: number) => '420100' + byte(value);
const param = (id: number, index: number, string = false) =>
  '560300' + (string ? '24' : '40') + word(id) + int(index) + '29010000';
const op = (name: string) => byte(name.charCodeAt(0)) + '0000';

function expression(arg: YurisArgument, hex: string): boolean {
  if (arg.expression.length * 2 !== hex.length || !arg.tokens) return false;
  return arg.expression.every((value, i) => value === parseInt(hex.slice(i * 2, i * 2 + 2), 16));
}

function local(instruction: YurisInstruction | undefined, arg = 0, offset = 0): number {
  const bytes = instruction?.args[arg]?.expression;
  return bytes && bytes.length >= offset + 6 ? bytes[offset + 4]! | (bytes[offset + 5]! << 8) : -1;
}

type Operand = readonly [id: number, type: number, value: string | number, op?: number];

function matchAt(code: readonly YurisInstruction[], at: number) {
  return (position: number, command: number, extra: number, ...args: Operand[]) => {
    const instruction = code[at + position];
    return (
      instruction?.command === command &&
      instruction.extra === extra &&
      instruction.args.length === args.length &&
      args.every(([id, type, value, operator = 0], i) => {
        const arg = instruction.args[i]!;
        return (
          arg.id === id &&
          arg.type === type &&
          arg.op === operator &&
          (typeof value === 'string'
            ? expression(arg, value)
            : arg.tokens === null && arg.size === value)
        );
      })
    );
  };
}

function hasSpec(
  commands: YurisCommandSet,
  command: number,
  arg: number,
  kind: number,
  check: number,
) {
  const value = commands.commands[command]?.args[arg];
  return value?.kind === kind && value.check === check;
}

/**
 * Recognize the library's scalar substring routine by its expressions and branch targets.
 * Its declarations, VARINFO LENGTH (0x455464) and first two IFs can be folded for an
 * in-bounds positive substring. The VM executes the length clamp, VARACT COPY and RETURN.
 */
export function scanStringSlice(
  code: readonly YurisInstruction[],
  at: number,
  commands: YurisCommandSet,
): StringSlicePrelude | null {
  const result = local(code[at]);
  const start = local(code[at + 1]);
  const length = local(code[at + 2]);
  const count = local(code[at + 3]);
  const ids = [result, start, length, count];
  if (ids.some((id) => id < 1000) || new Set(ids).size !== ids.length) return null;

  const matches = matchAt(code, at);
  const r = scalar(result, true),
    s = scalar(start),
    l = scalar(length),
    n = scalar(count);
  const one = int(1),
    zero = int(0),
    p = param(55, 1, true);
  const remaining = n + s + op('-') + one + op('+');
  const condition = (position: number, end: number, test: string) =>
    matches(position, 0x2c, 0, [0, 1, test], [0, 0, 0], [0, 0, at + end]);
  if (
    !matches(0, 0x5c, 0, [0, 3, r], [0, 3, '4d02002222']) ||
    !matches(1, 0x32, 0, [0, 3, s], [0, 1, param(53, 2)]) ||
    !matches(2, 0x32, 0, [0, 3, l], [0, 1, param(53, 3)]) ||
    !matches(3, 0x32, 0, [0, 3, n], [0, 1, '4c08000000000000000000']) ||
    !matches(4, 0x67, 0, [13, 1, one], [0, 3, p], [1, 1, n]) ||
    !condition(5, 12, n + zero + op('>')) ||
    !condition(
      6,
      11,
      s + zero + op('>') + s + n + op('S') + op('&') + l + zero + op('>') + op('&'),
    ) ||
    !condition(7, 9, l + remaining + op('>')) ||
    !matches(8, 0x35, 0, [0, 1, l], [0, 1, remaining]) ||
    !matches(9, 0x30, 0) ||
    !matches(10, 0x66, 0, [3, 1, one], [0, 3, p], [1, 3, r], [4, 1, s], [5, 1, l]) ||
    !matches(11, 0x30, 0) ||
    !matches(12, 0x30, 0) ||
    !matches(13, 0x4f, 0x200, [32, 3, r])
  )
    return null;

  const spec = (command: number, arg: number, kind: number, check: number) =>
    hasSpec(commands, command, arg, kind, check);
  if (
    !spec(0x5c, 0, 3, 0) ||
    !spec(0x32, 0, 3, 0) ||
    !spec(0x67, 13, 0, 3) ||
    !spec(0x67, 0, 0, 0) ||
    !spec(0x67, 1, 0, 0) ||
    !spec(0x66, 3, 0, 3) ||
    !spec(0x66, 0, 0, 0) ||
    !spec(0x66, 1, 0, 0) ||
    !spec(0x66, 4, 0, 2) ||
    !spec(0x66, 5, 0, 2) ||
    !spec(0x4f, 32, 1, 0)
  )
    return null;
  return {result, start, length, count};
}

export interface LexerRun {
  readonly text: number;
  readonly cursor: number;
  readonly count: number;
  readonly state: number;
  readonly scratch: readonly number[];
  readonly word: {readonly high: number; readonly low: number; readonly result: number} | null;
  readonly spaces: boolean;
  readonly comments: boolean;
  readonly initial: Uint8Array | null;
}

export interface CharacterSearch {
  readonly cursor: number;
  readonly length: number;
  readonly scratch: number;
}

/** CG prefix + decimal(sprite * 100 + counter), A=0 (YSTB175:169/174). */
export function scanOpacityLoop(
  code: readonly YurisInstruction[],
  at: number,
  commands: YurisCommandSet,
): {prefix: number; sprite: number} | null {
  const prefix = local(code[at]),
    sprite = local(code[at], 0, 10);
  if (Math.min(prefix, sprite) < 1000 || prefix === sprite) return null;
  const one = int(1);
  const id =
    scalar(prefix, true) +
    one +
    scalar(sprite) +
    int(100) +
    op('*') +
    op('+') +
    scalar(48) +
    op('+') +
    one +
    op('-') +
    op('s') +
    op('+');
  const matches = matchAt(code, at);
  if (
    !matches(0, 0x01, 0, [0, 3, id], [3, 1, int(0)]) ||
    !matches(1, 0x3a, 0) ||
    !hasSpec(commands, 0x01, 0, 1, 0) ||
    !hasSpec(commands, 0x01, 3, 0, 12)
  )
    return null;
  return {prefix, sprite};
}

/** A bounded forward search implemented as VARACT COPY, equality and LOOPBREAK. */
export function scanCharacterSearch(
  code: readonly YurisInstruction[],
  at: number,
  end: number,
  commands: YurisCommandSet,
): CharacterSearch | null {
  if (end !== at + 5) return null;
  const count = local(code[at - 1]);
  const cursor = local(code[at], 3);
  const length = local(code[at], 4);
  const scratch = local(code[at], 2);
  const result = local(code[at + 2]);
  const ids = [count, cursor, length, scratch, result];
  if (ids.some((id) => id < 1000) || new Set(ids).size !== ids.length) return null;
  const matches = matchAt(code, at);
  const s = scalar(scratch, true),
    c = scalar(cursor),
    l = scalar(length),
    r = scalar(result);
  const position = c + scalar(48) + op('+');
  const limit = scalar(count) + c + op('-') + l + int(1) + op('-') + op('-');
  if (
    !matches(-1, 0x37, 0, [0, 1, limit], [0, 0, end]) ||
    !matches(
      0,
      0x66,
      0,
      [3, 1, int(1)],
      [0, 3, param(55, 1, true)],
      [1, 3, s],
      [4, 1, position],
      [5, 1, l],
    ) ||
    !matches(1, 0x2c, 0, [0, 1, s + param(55, 2, true) + op('=')], [0, 0, 0], [0, 0, at + 4]) ||
    !matches(2, 0x35, 0, [0, 1, r], [0, 1, position]) ||
    !matches(3, 0x38, 0) ||
    !matches(4, 0x30, 0) ||
    !matches(5, 0x3a, 0)
  )
    return null;
  const spec = (arg: number, check: number) => hasSpec(commands, 0x66, arg, 0, check);
  if (!spec(3, 3) || !spec(0, 0) || !spec(1, 0) || !spec(4, 2) || !spec(5, 2)) return null;
  return {cursor, length, scratch};
}

export interface ArrayRanges {
  readonly index: number;
  readonly value: number;
  readonly result: number;
  readonly arrays: readonly [number, number, number, number];
}

export type IntQuery =
  | {readonly kind: 'length'; readonly result: number}
  | {readonly kind: 'lint2'; readonly result: number; readonly separator: number};

/** Scalar wrappers for VARINFO LENGTH (0x455464) and CGINFO LINT2 (0x43B448). */
export function scanIntQuery(
  code: readonly YurisInstruction[],
  at: number,
  commands: YurisCommandSet,
): IntQuery | null {
  const result = local(code[at]);
  const r = scalar(result);
  const p = param(55, 1, true);
  const matches = matchAt(code, at);
  if (
    result < 1000 ||
    !matches(0, 0x32, 0, [0, 3, r], [0, 1, '4c08000000000000000000']) ||
    !matches(2, 0x4f, 8, [0, 1, r]) ||
    !hasSpec(commands, 0x32, 0, 3, 0) ||
    !hasSpec(commands, 0x4f, 0, 0, 0)
  )
    return null;
  if (
    matches(1, 0x67, 0, [13, 1, int(1)], [0, 3, p], [1, 1, r]) &&
    hasSpec(commands, 0x67, 13, 0, 3) &&
    hasSpec(commands, 0x67, 0, 0, 0) &&
    hasSpec(commands, 0x67, 1, 0, 0)
  )
    return {kind: 'length', result};
  const separator = local(code[at + 1], 0, 14);
  const add = op('+');
  const id =
    p +
    scalar(separator, true) +
    add +
    '4d09002242542e4f46463d22' +
    add +
    param(53, 2) +
    op('s') +
    add +
    '4d0400223d3122' +
    add;
  if (
    separator < 1000 ||
    separator === result ||
    !matches(1, 4, 0, [0, 3, id], [27, 1, int(1)], [33, 1, r]) ||
    !hasSpec(commands, 4, 0, 1, 0) ||
    !hasSpec(commands, 4, 27, 0, 1) ||
    !hasSpec(commands, 4, 33, 0, 0)
  )
    return null;
  return {kind: 'lint2', result, separator};
}

/** Two inclusive integer ranges drawn from four one-dimensional tables. */
export function scanArrayRanges(
  code: readonly YurisInstruction[],
  at: number,
  commands: YurisCommandSet,
): ArrayRanges | null {
  const index = local(code[at]);
  const value = local(code[at + 1]);
  const result = local(code[at + 2]);
  const arrays = [
    local(code[at + 3]),
    local(code[at + 3], 0, 25),
    local(code[at + 6]),
    local(code[at + 6], 0, 25),
  ] as const;
  const ids = [index, value, result, ...arrays];
  if (ids.some((id) => id < 1000) || new Set(ids).size !== ids.length) return null;
  const matches = matchAt(code, at);
  const i = scalar(index),
    v = scalar(value),
    r = scalar(result);
  const element = (id: number) => '56030040' + word(id) + i + '29010000';
  const condition = (low: number, high: number) =>
    element(low) + v + op('S') + element(high) + v + op('Z') + op('&');
  if (
    !matches(0, 0x32, 0, [0, 1, i], [0, 1, param(53, 1)]) ||
    !matches(1, 0x32, 0, [0, 1, v], [0, 1, param(53, 2)]) ||
    !matches(2, 0x32, 0, [0, 1, r], [0, 1, '4c08000000000000000000']) ||
    !matches(3, 0x2c, 0, [0, 1, condition(arrays[0], arrays[1])], [0, 0, at + 6], [0, 0, at + 8]) ||
    !matches(4, 0x35, 0, [0, 1, r], [0, 1, int(1)]) ||
    !matches(5, 0x2d, 0) ||
    !matches(6, 0x0b, 0, [0, 1, condition(arrays[2], arrays[3])], [0, 0, 0], [0, 0, 0]) ||
    !matches(7, 0x35, 0, [0, 1, r], [0, 1, int(1)]) ||
    !matches(8, 0x30, 0) ||
    !matches(9, 0x4f, 8, [0, 1, r]) ||
    !hasSpec(commands, 0x32, 0, 3, 0) ||
    !hasSpec(commands, 0x4f, 0, 0, 0)
  )
    return null;
  return {index, value, result, arrays};
}

/**
 * Recognize paths that only classify a character and advance the cursor.
 * Replay the final iteration before the delimiter to restore scratch outputs.
 */
export function scanLexerRun(
  code: readonly YurisInstruction[],
  at: number,
  end: number,
  commands: YurisCommandSet,
): LexerRun | null {
  if (end !== at + 241) return null;
  const cursor = local(code[at]);
  const count = local(code[at], 0, 6);
  const text = local(code[at + 3], 1);
  const state = local(code[at + 11]);
  const current = local(code[at + 4]);
  const following = local(code[at + 6]);
  const char = local(code[at + 7], 2);
  const nextChar = local(code[at + 8], 2);
  const high = local(code[at + 9]);
  const low = local(code[at + 10]);
  const scratch = [current, following, char, nextChar, high, low];
  const ids = [cursor, count, text, state, ...scratch];
  if (ids.some((id) => id < 1000) || new Set(ids).size !== ids.length) return null;

  const matches = matchAt(code, at);
  const c = scalar(cursor),
    n = scalar(count),
    s = scalar(state),
    ch = scalar(char);
  const equals = (value: string, number: number) => value + int(number) + op('=');
  const condition = (position: number, exit: number, test: string, next = 0) =>
    matches(position, 0x2c, 0, [0, 1, test], [0, 0, next ? at + next : 0], [0, 0, at + exit]);
  const readChar = (position: number, offset: number, target: number, result: number) =>
    matches(
      position,
      0x2b,
      0x218,
      [0, 3, '4d0c002265732e5f7374726d696422'],
      [33, 3, scalar(text, true)],
      [2, 1, c + int(offset) + op('+')],
      [3, 1, int(1)],
    ) &&
    matches(position + 1, 0x35, 0, [0, 3, scalar(target, true)], [0, 3, param(62, 1, true)]) &&
    matches(
      position === 3 ? 7 : 8,
      0x67,
      0,
      [16, 1, int(1)],
      [0, 3, scalar(target, true)],
      [1, 1, scalar(result)],
    );
  const extended = [91, 92, 93, 94, 95, 96]
    .map((n) => equals(s, n))
    .reduce((a, b) => a + b + op('|'));
  if (
    !matches(-1, 0x37, 0, [0, 1, int(255)], [0, 0, end]) ||
    !condition(0, 2, c + n + op('>')) ||
    !matches(1, 0x38, 0) ||
    !matches(2, 0x30, 0) ||
    !readChar(3, 0, current, char) ||
    !readChar(5, 1, following, nextChar) ||
    !matches(9, 0x35, 0, [0, 1, scalar(high)], [0, 1, ch + '5702000001' + op('/')]) ||
    !matches(10, 0x35, 0, [0, 1, scalar(low)], [0, 1, ch + '5702000001' + op('%')]) ||
    !condition(11, 240, equals(s, 0), 180) ||
    !matches(180, 0x0b, 0) ||
    !condition(181, 192, equals(s, 22)) ||
    !condition(182, 191, equals(ch, 34) + equals(ch, 13) + op('|')) ||
    !condition(193, 201, equals(s, 31)) ||
    !condition(202, 210, equals(s, 32)) ||
    !condition(211, 223, extended) ||
    !condition(224, 238, equals(s, 99)) ||
    ![191, 192, 201, 210, 223, 238, 240].every((position) => matches(position, 0x30, 0)) ||
    !matches(239, 0x35, 0, [0, 1, c, 1], [0, 1, int(1)]) ||
    !matches(241, 0x3a, 0)
  )
    return null;
  const spec = (command: number, arg: number, kind: number, check: number) =>
    hasSpec(commands, command, arg, kind, check);
  if (
    !spec(0x2b, 0, 1, 0) ||
    !spec(0x2b, 33, 1, 0) ||
    !spec(0x2b, 2, 0, 0) ||
    !spec(0x2b, 3, 0, 0) ||
    !spec(0x67, 16, 0, 3) ||
    !spec(0x67, 0, 0, 0) ||
    !spec(0x67, 1, 0, 0)
  )
    return null;
  const spaces =
    condition(194, 200, ch + int(32) + op('!')) &&
    condition(203, 209, ch + int(9) + op('!')) &&
    matches(200, 0x30, 0) &&
    matches(209, 0x30, 0);
  const comments =
    condition(225, 237, equals(ch, 42) + equals(scalar(nextChar), 47) + op('&'), 233) &&
    matches(232, 0x2d, 0) &&
    matches(233, 0x0b, 0, [0, 1, equals(ch, 13)], [0, 0, 0], [0, 0, 0]) &&
    matches(237, 0x30, 0);
  const wordResult = local(code[at + 212]);
  const highTable = local(code[at + 212], 1);
  const lowTable = local(code[at + 212], 1, 16);
  const table = (id: number, index: string) => '56030040' + word(id) + index + '29010000';
  const result = scalar(wordResult);
  const wordIds = [...ids, wordResult, highTable, lowTable];
  const wordRun =
    wordIds.every((id) => id >= 1000) &&
    new Set(wordIds).size === wordIds.length &&
    matches(
      212,
      0x35,
      0,
      [0, 1, result],
      [
        0,
        1,
        table(highTable, scalar(high)) +
          table(lowTable, equals(scalar(high), 0) + scalar(low) + op('*')) +
          op('+'),
      ],
    ) &&
    condition(213, 222, equals(result, 0)) &&
    matches(222, 0x30, 0);
  // The leading state classifier is an IF/ELSE chain with one state assignment per arm.
  const branches = [
    {lo: 48, hi: 57, extra: 45, state: 91},
    {lo: 65, hi: 90, state: 92},
    {lo: 97, hi: 122, state: 93},
    {lo: 94, hi: 94, state: 93},
    {lo: 39, hi: 39, state: 93},
    {lo: 95, hi: 95, state: 94},
    {lo: 46, hi: 46, state: 95},
    {lo: 129, hi: 254, state: 96, high: true},
    {lo: 34, hi: 34, state: 22},
    {lo: 32, hi: 32, state: 31},
    {lo: 9, hi: 9, state: 32},
  ];
  const number = (n: number) => (n <= 127 ? int(n) : '570200' + word(n));
  const classify =
    code[at + 45]?.command === 0x0b &&
    matches(177, 0x30, 0) &&
    matches(178, 0x35, 0, [0, 1, c, 1], [0, 1, int(1)]) &&
    matches(179, 0x2d, 0) &&
    branches.every(({lo, hi, extra, state, high: useHigh}, i) => {
      const value = useHigh ? scalar(high) : ch;
      let test =
        lo === hi
          ? equals(value, lo)
          : value + number(lo) + op('Z') + value + number(hi) + op('S') + op('&');
      if (extra !== undefined) test += equals(value, extra) + op('|');
      const position = 12 + i * 3;
      return (
        matches(
          position,
          i === 0 ? 0x2c : 0x0b,
          0,
          [0, 1, test],
          [0, 0, at + position + 3],
          [0, 0, i === 0 ? at + 177 : 0],
        ) &&
        matches(position + 1, 0x35, 0, [0, 1, s], [0, 1, int(state)]) &&
        matches(position + 2, 0x2d, 0)
      );
    });
  const initial = classify ? new Uint8Array(65536).fill(45) : null;
  if (initial) {
    for (const [i, {lo, hi, extra, high: useHigh}] of branches.entries()) {
      const position = 13 + i * 3;
      initial.fill(position, useHigh ? lo << 8 : lo, useHigh ? (hi + 1) << 8 : hi + 1);
      if (extra !== undefined) initial[extra] = position;
    }
  }
  return {
    text,
    cursor,
    count,
    state,
    scratch,
    spaces,
    comments,
    initial,
    word: wordRun ? {high: highTable, low: lowTable, result: wordResult} : null,
  };
}
