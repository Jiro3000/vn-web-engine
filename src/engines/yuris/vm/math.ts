import {Mt19937} from '../../../core/mt19937.js';
import {Xoshiro128pp} from '../../../core/xoshiro128.js';
import {YBN_VERSION_500} from '../../../formats/yuris/ybn.js';
import type {YurisMachine} from './machine.js';
import {type ByteString, atoi64} from './numbers.js';

/** MATH command id. */
const MATH = 0x3c;

const enum Arg {
  Let,
  Set,
  Set2,
  SetStr,
  Sin,
  Asin,
  Sinh,
  Cos,
  Acos,
  Cosh,
  Tan,
  Atan,
  Atan2,
  Tanh,
  Sqrt,
  Abs,
  Exp,
  Log,
  Log10,
  Pow,
  Rnd,
  Hash,
  Calc,
}

/** One-argument functions in the test order of 0x446198, with their CRT routines. */
const UNARY: readonly [Arg, (x: number) => number][] = [
  [Arg.Tan, Math.tan], // 0x471F04
  [Arg.Asin, Math.asin], // 0x471E34
  [Arg.Acos, Math.acos], // 0x471D64
  [Arg.Sinh, Math.sinh], // 0x471D20
  [Arg.Cosh, Math.cosh], // 0x471D2A
  [Arg.Tanh, Math.tanh], // 0x471D31
  [Arg.Atan, Math.atan], // 0x471C94
];

/**
 * MATH 0x446198: one function of SET (and SET2) into LET; the first present one in the order
 * SIN, COS, TAN, ASIN, ACOS, SINH, COSH, TANH, ATAN, ATAN2, SQRT, ABS, EXP, LOG, LOG10, POW,
 * RND, HASH, CALC runs.
 *
 * SIN and COS always evaluate SET as a double (0x420C8C); the others use the float evaluator
 * of the expression's type (table 0x872668), so an int expression is evaluated as an int.
 * Results are stored as floats (0x4549F4, rounded for an int LET) except ABS of an int, RND,
 * HASH and CALC, which store ints (0x45BEE4). The functions are the C runtime's; JavaScript's
 * `Math` may differ from them in the last bit.
 */
export function installMath(m: YurisMachine, seed: number, version: number): void {
  // 0x4686E4: the generator is seeded with timeGetTime() at start-up (0x46C544). Version 500
  // (Relirium.exe 0x49D0FC, called from the start-up 0x499024 with state 0x894180) seeds
  // xoshiro128++ from timeGetTime() ^ the thread and process ids ^ both QueryPerformanceCounter
  // words through 0x492634; the browser has no ids or counter, so only the time contributes.
  const random: {next(): number} =
    version === YBN_VERSION_500 ? Xoshiro128pp.fromSeed(seed >>> 0) : new Mt19937(seed);
  m.define(MATH, () => math(m, random));
}

function math(m: YurisMachine, random: {next(): number}): number {
  const a = m.args,
    e = m.expression;
  m.decode();
  const let_ = a.has(Arg.Let),
    id = a.variable[let_]!,
    index = a.variableIndex[let_]!;
  const set = a.has(Arg.Set),
    set2 = a.has(Arg.Set2);
  const type = a.type[set]!,
    type2 = a.type[set2]!;
  const float = () => e.floatOf(type, a.expression[set]!);
  const float2 = () => e.floatOf(type2, a.expression[set2]!);
  const putFloat = (value: number) => (m.setFloat(id, index, value), 0);
  const putInt = (value: bigint) => (m.setInt(id, index, BigInt.asIntN(64, value)), 0);

  if (a.has(Arg.Sin)) return putFloat(Math.sin(e.float(a.expression[set]!))); // 0x471624
  if (a.has(Arg.Cos)) return putFloat(Math.cos(e.float(a.expression[set]!))); // 0x4716D4
  for (const [arg, f] of UNARY) if (a.has(arg)) return putFloat(f(float()));
  if (a.has(Arg.Atan2)) return putFloat(Math.atan2(float(), float2())); // 0x471C60
  if (a.has(Arg.Sqrt)) return putFloat(Math.sqrt(float())); // FSQRT
  if (a.has(Arg.Abs)) {
    // Expression type 0 (never produced by the compiler) stores the int's absolute value;
    // type 1 (int) the absolute value of its double. Float expressions leave LET unchanged.
    if (type === 0) {
      const v = e.int(a.expression[set]!); // 0x872658
      return putInt(v < 0n ? -v : v);
    }
    if (type === 1) return putFloat(Math.abs(float()));
    return 0;
  }
  if (a.has(Arg.Exp)) return putFloat(Math.exp(float())); // 0x471C40
  if (a.has(Arg.Log)) return putFloat(Math.log(float())); // 0x471B84
  if (a.has(Arg.Log10)) return putFloat(Math.log10(float())); // 0x471204
  if (a.has(Arg.Pow)) return putFloat(Math.pow(float(), float2())); // 0x470A59
  if (a.has(Arg.Rnd)) {
    // 0x446444: lowest + the next MT19937 output modulo the 64-bit span (_allrem 0x471130);
    // version 500 (Relirium.exe 0x476424) takes the next xoshiro128++ output, inlined.
    let low = e.intOf(type, a.expression[set]!),
      high = e.intOf(type2, a.expression[set2]!);
    if (high < low) [low, high] = [high, low];
    const span = BigInt.asIntN(64, high - low + 1n);
    const r = BigInt(random.next());
    // A span of 2^64 divides by zero natively; the output is then used whole.
    const offset = span === 0n ? r : r % (span < 0n ? -span : span);
    return putInt(low + offset);
  }
  if (a.has(Arg.Hash)) return putInt(BigInt(crc32(a.text(Arg.SetStr)))); // 0x41C064
  if (a.has(Arg.Calc)) return putInt(calculate(a.text(Arg.SetStr))); // 0x446818
  return 0;
}

const CRC_TABLE = (() => {
  const table = new Uint32Array(256);
  for (let i = 0; i < 256; i++) {
    let c = i;
    for (let k = 0; k < 8; k++) c = (c >>> 1) ^ (0xedb88320 & -(c & 1));
    table[i] = c >>> 0;
  }
  return table;
})();

/** 0x41C064: CRC-32 (table 0x59B1C0) of the string up to its terminator. */
function crc32(text: ByteString): number {
  let crc = 0xffffffff;
  for (let i = 0; i < text.length; i++) {
    const c = text.charCodeAt(i) & 0xff;
    if (c === 0) break;
    crc = (crc >>> 8) ^ CRC_TABLE[(c ^ crc) & 0xff]!;
  }
  return ~crc >>> 0;
}

/**
 * CALC 0x446818: an integer expression of decimal numbers, `+ - * / %` and parentheses,
 * evaluated in 64 bits. A leading sign applies to the first term only; division and remainder
 * by zero keep the left operand; anything else that is not a number or `(` reads as 0 and
 * ends the expression. Spaces and tabs separate tokens; a line feed ends the text.
 */
export function calculate(text: ByteString): bigint {
  const end = text.indexOf('\0');
  const source = end < 0 ? text : text.slice(0, end);
  let position = 0;
  let token = '';
  const isDigit = (c: number) => c >= 0x30 && c <= 0x39;
  // 0x4468BC: the next token into 0x866CC0; false at the end of the text.
  const advance = (): boolean => {
    token = '';
    while (position < source.length && (source[position] === ' ' || source[position] === '\t'))
      position++;
    const c = source.charCodeAt(position);
    if (position >= source.length || c === 10) return false;
    if (!isDigit(c)) {
      token = source[position++]!;
      return true;
    }
    const start = position;
    while (position < source.length && isDigit(source.charCodeAt(position))) position++;
    token = source.slice(start, position);
    return true;
  };
  // 0x446A20: a number (_atoi64), or a parenthesised expression.
  const factor = (): bigint => {
    if (token !== '' && isDigit(token.charCodeAt(0))) {
      const value = atoi64(token);
      advance();
      return value;
    }
    if (token !== '(') return 0n;
    advance();
    const value = expression();
    if ((token as string) === ')') advance();
    return value;
  };
  // 0x446998.
  const term = (): bigint => {
    let value = factor();
    for (let op = token; op === '*' || op === '/' || op === '%'; op = token) {
      if (!advance()) return value;
      const right = factor();
      if (op === '*') value = BigInt.asIntN(64, value * right);
      else if (right !== 0n) value = BigInt.asIntN(64, op === '/' ? value / right : value % right);
    }
    return value;
  };
  // 0x446828.
  const expression = (): bigint => {
    let sign = 1n;
    if (token === '+' || token === '-') {
      sign = token === '-' ? -1n : 1n;
      advance();
    }
    let value = BigInt.asIntN(64, sign * term());
    for (let op = token; op === '+' || op === '-'; op = token) {
      if (!advance()) return value;
      const right = term();
      value = BigInt.asIntN(64, op === '+' ? value + right : value - right);
    }
    return value;
  };
  advance();
  return expression();
}
