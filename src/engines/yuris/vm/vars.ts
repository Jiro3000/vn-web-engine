import {applyOp} from './operators.js';
import {YurisError} from './errors.js';
import type {YurisMachine} from './machine.js';
import {
  type ByteString,
  atoi64,
  formatFloat,
  formatInt,
  isLeadByte,
  parseHex,
  strtod,
} from './numbers.js';
import {asciiLower, asciiUpper, charLength, mbsCase, toFullWidth, toHalfWidth} from './sjis.js';
import {YurisType} from './variables.js';

/** VARACT and VARINFO command ids. */
const VARACT = 0x66,
  VARINFO = 0x67;

interface CharacterOffsets {
  text: ByteString;
  offsets: Uint32Array;
  count: number;
}

// VARINFO LENGTH and VARACT COPY often inspect the same immutable string repeatedly.
const lastCharacterOffsets = new WeakMap<YurisMachine, CharacterOffsets>();

export function characterOffsets(machine: YurisMachine, text: ByteString): CharacterOffsets {
  let cached = lastCharacterOffsets.get(machine);
  if (cached?.text === text) return cached;
  const offsets =
    cached && cached.offsets.length > text.length
      ? cached.offsets
      : new Uint32Array(text.length + 1);
  let count = 0;
  for (let i = 0; i < text.length;) {
    i += charLength(text.charCodeAt(i));
    offsets[++count] = i;
  }
  cached = {text, offsets, count};
  lastCharacterOffsets.set(machine, cached);
  return cached;
}

/** VARINFO argument ids (`ysc.ybn`). */
const enum Info {
  Set,
  Let,
  Type,
  StrType,
  DimNum,
  DimSize,
  DimSize8 = 12,
  Length,
  Search,
  StrFirst,
  SjisCode,
  Int,
  Flt,
  Str,
  No,
  No2,
}

/** VARACT argument ids (`ysc.ybn`). */
const enum Act {
  Set,
  Let,
  Cut,
  Copy,
  Pos,
  Length,
  Type,
  Upper,
  Upper2,
  Lower,
  Lower2,
  HanToZen,
  ZenToHan,
  DimSize,
  Push,
  Pop,
  Init,
  GInt,
  GFlt = 21,
  GStr = 25,
}

export function installVariableCommands(machine: YurisMachine): void {
  machine.define(VARINFO, () => varInfo(machine));
  machine.define(VARACT, () => varAct(machine));
}

/** The variable and element an argument's expression named (decoder slots 0x661C40 / 0x661DE0). */
function target(machine: YurisMachine, id: number): {id: number; index: bigint} {
  const a = machine.args,
    slot = a.has(id);
  return slot ? {id: a.variable[slot]!, index: a.variableIndex[slot]!} : {id: 0, index: 0n};
}

/**
 * VARINFO 0x455464: one query on the SET variable, its result stored in the LET element
 * through 0x45BEE4. The first present query argument wins, in id order.
 */
function varInfo(machine: YurisMachine): number {
  machine.decode();
  const a = machine.args,
    set = target(machine, Info.Set),
    to = target(machine, Info.Let),
    variable = machine.variables.get(set.id),
    store = (value: bigint) => machine.setInt(to.id, to.index, value);
  if (a.has(Info.Type)) return (store(BigInt(variable.type)), 0);
  if (a.has(Info.StrType)) {
    const text = machine.getString(set.id, set.index);
    if (text.length === 0) throw new YurisError(0x18c4a, ['VARINFO', 'STRTYPE']);
    return (store(isLeadByte(text.charCodeAt(0)) ? 2n : 1n), 0);
  }
  if (a.has(Info.DimNum)) return (store(BigInt(variable.dimensions.length)), 0);
  for (let id = Info.DimSize; id <= Info.DimSize8; id++)
    if (a.has(id)) return (store(BigInt(variable.dimensions[id - Info.DimSize] ?? 0)), 0);
  if (a.has(Info.Length)) {
    if (variable.type !== YurisType.String) throw new YurisError(0x1a6bc);
    return (
      store(BigInt(characterOffsets(machine, machine.getString(set.id, set.index)).count)),
      0
    );
  }
  if (a.has(Info.Search)) store(search(machine, set.id));
  if (a.has(Info.StrFirst) && variable.type === YurisType.String) {
    // The smallest string (strcmp) of elements NO..NO2, NO2 defaulting to DIMSIZE.
    const from = a.has(Info.No) ? a.int(Info.No) : 0n;
    const to2 = a.has(Info.No2) ? a.int(Info.No2) : BigInt(variable.dimensions[0] ?? 0);
    let best = machine.getString(set.id, from),
      found = from;
    for (let i = from; i <= to2; i++) {
      const text = machine.getString(set.id, i);
      if (best > text) {
        best = text;
        found = i;
      }
    }
    store(found);
  }
  if (a.has(Info.SjisCode)) {
    const text = machine.getString(set.id, set.index);
    const c = text.charCodeAt(0) || 0;
    store(BigInt(c !== 0 && isLeadByte(c) ? (c << 8) + (text.charCodeAt(1) || 0) : c));
  }
  return 0;
}

/**
 * VARINFO SEARCH: the first element from NO (default 0) below DIMSIZE equal to INT, FLT or STR
 * by the variable's type; -1 when the scan reaches DIMSIZE, the start itself when it is past.
 */
function search(machine: YurisMachine, id: number): bigint {
  const a = machine.args,
    variable = machine.variables.get(id),
    end = BigInt(variable.dimensions[0] ?? 0);
  let i = a.has(Info.No) ? BigInt.asIntN(32, a.int(Info.No)) : 0n;
  let equal: (i: number) => boolean;
  if (variable.type === YurisType.Int) {
    const value = a.int(Info.Int);
    equal = (k) => variable.ints![k] === value;
  } else if (variable.type === YurisType.Float) {
    const value = Number(a.int(Info.Flt));
    equal = (k) => variable.floats![k] === value;
  } else if (variable.type === YurisType.String) {
    const value = a.text(Info.Str);
    equal = (k) => machine.getString(id, BigInt(k)) === value;
  } else return 0n;
  for (; i < end; i++) if (equal(Number(i))) return i;
  return i === end ? -1n : i;
}

/** The SET string and the element the result goes to: LET when given, else SET itself. */
function stringOperands(machine: YurisMachine): {text: ByteString; id: number; index: bigint} {
  const set = target(machine, Act.Set),
    to = target(machine, Act.Let),
    hasLet = machine.args.has(Act.Let) !== 0;
  if (machine.variables.get(set.id).type !== YurisType.String) throw new YurisError(0x1a6bc);
  if (hasLet && machine.variables.get(to.id).type !== YurisType.String)
    throw new YurisError(0x1a6bc);
  const text = machine.getString(set.id, set.index);
  return hasLet ? {text, ...to} : {text, ...set};
}

/**
 * The byte range of the characters POS (1-based) .. POS + LENGTH - 1; a position at or past
 * the end raises `position`, a range past the end raises `range`.
 */
function charRange(
  machine: YurisMachine,
  text: ByteString,
  position: number,
  range: number,
): [number, number] {
  // Each loop either advances through this bounded string or raises at its end.
  const pos = Number(machine.args.int(Act.Pos)),
    length = Number(machine.args.int(Act.Length));
  const cached = lastCharacterOffsets.get(machine);
  if (cached?.text === text) {
    const first = Math.max(0, pos - 1);
    if (first > 0 && first >= cached.count) throw new YurisError(position);
    const last = first + Math.max(0, length);
    if (last > cached.count) throw new YurisError(range);
    return [cached.offsets[first]!, cached.offsets[last]!];
  }
  let start = 0;
  for (let k = 1; k < pos; k++) {
    start += charLength(text.charCodeAt(start));
    if (start >= text.length) throw new YurisError(position);
  }
  let end = start;
  for (let k = 0; k < length; k++) {
    if (end >= text.length) throw new YurisError(range);
    end += charLength(text.charCodeAt(end));
  }
  return [start, end];
}

/**
 * VARACT 0x45353C. TYPE converts between a number and a string; otherwise COPY or CUT on the
 * SET string, then each present conversion, DIMSIZE, PUSH, POP and INIT in that order.
 */
function varAct(machine: YurisMachine): number {
  machine.decode();
  const a = machine.args;
  if (a.has(Act.Type)) return convert(machine);
  if (a.has(Act.Copy)) {
    const {text, id, index} = stringOperands(machine);
    const [start, end] = charRange(machine, text, 0x1d4ca, 0x1d4d4);
    machine.setString(id, index, text.slice(start, end));
    return 0;
  }
  if (a.has(Act.Cut)) {
    const {text, id, index} = stringOperands(machine);
    const [start, end] = charRange(machine, text, 0x1d52e, 0x1d538);
    machine.setString(id, index, text.slice(0, start) + text.slice(end));
    return 0;
  }
  const conversions: [number, (text: ByteString) => ByteString][] = [
    [Act.HanToZen, toFullWidth],
    [Act.ZenToHan, toHalfWidth],
    [Act.Upper, asciiUpper],
    [Act.Upper2, (text) => mbsCase(text, true)],
    [Act.Lower, asciiLower],
    [Act.Lower2, (text) => mbsCase(text, false)],
  ];
  for (const [id, convert] of conversions) {
    if (!a.has(id)) continue;
    const {text, id: to, index} = stringOperands(machine);
    machine.setString(to, index, convert(text));
  }
  const set = target(machine, Act.Set),
    variable = machine.variables.get(set.id);
  if (a.has(Act.DimSize)) {
    if (variable.dimensions.length !== 1)
      return machine.messageBox(
        '配列サイズを変更しようとしましたが、この変数は１次元配列ではありません。',
      );
    // 0x45467F: the assignment operator applies to the current size (0x425220).
    const size = applyOp(
      a.op[a.has(Act.DimSize)]!,
      BigInt(variable.dimensions[0]!),
      a.int(Act.DimSize),
    );
    if (size < 1n) return machine.messageBox('変更後の配列サイズが不正です。');
    if (size !== BigInt(variable.dimensions[0]!)) machine.variables.resize(set.id, Number(size));
  }
  if (a.has(Act.Push)) {
    if (variable.dimensions.length !== 1)
      return machine.messageBox(
        '配列挿入処理をしようとしましたが、この変数は１次元配列ではありません。',
      );
    // Shifts the elements from PUSH one up, dropping the last, and clears element PUSH.
    const position = a.int(Act.Push);
    let i = BigInt((variable.dimensions[0]! - 1) | 0);
    for (; position < i; i--) moveElement(machine, set.id, i, i - 1n);
    clearElement(machine, set.id, i);
  }
  if (a.has(Act.Pop)) {
    if (variable.dimensions.length !== 1)
      return machine.messageBox(
        '配列削除処理をしようとしましたが、この変数は１次元配列ではありません。',
      );
    // Shifts the elements after POP one down and clears the last.
    let i = BigInt.asIntN(32, a.int(Act.Pop));
    const last = BigInt(variable.dimensions[0]!) - 1n;
    for (; i < last; i++) moveElement(machine, set.id, i, i + 1n);
    clearElement(machine, set.id, i);
  }
  if (a.has(Act.Init)) {
    const mask = (from: number) => {
      let bits = 0;
      for (let k = 0; k < 4; k++) if (a.has(from + k)) bits |= 1 << k;
      return bits;
    };
    machine.variables.reset(
      machine.project.variables,
      mask(Act.GInt),
      mask(Act.GFlt),
      mask(Act.GStr),
      (bytes) => machine.expression.string(bytes),
    );
  }
  return 0;
}

function moveElement(machine: YurisMachine, id: number, to: bigint, from: bigint): void {
  const variable = machine.variables.get(id);
  if (variable.type === YurisType.Int) machine.setInt(id, to, variable.ints![Number(from)] ?? 0n);
  else if (variable.type === YurisType.Float)
    machine.setFloat(id, to, variable.floats![Number(from)] ?? 0);
  else if (variable.type === YurisType.String)
    machine.setString(id, to, variable.strings![Number(from)] ?? '');
}

function clearElement(machine: YurisMachine, id: number, index: bigint): void {
  const variable = machine.variables.get(id);
  if (variable.type === YurisType.Int) machine.setInt(id, index, 0n);
  else if (variable.type === YurisType.Float) machine.setFloat(id, index, 0);
  else if (variable.type === YurisType.String) machine.setString(id, index, '');
}

/**
 * VARACT TYPE: SET and LET must differ in type with one of them a string (error 0x1A6A8).
 * Numbers format with `_i64toa` / `"%f"`; strings parse as `0x` hex (at most 16 digits; a
 * failed parse yields the frame) or as decimal digits, '.', '-' (error 0x1A6B2 otherwise),
 * through `strtod` with a '.', else `_atoi64`.
 */
function convert(machine: YurisMachine): number {
  const set = target(machine, Act.Set),
    to = target(machine, Act.Let);
  const from = machine.variables.get(set.id).type,
    into = machine.variables.get(to.id).type;
  if ((from < YurisType.String && into < YurisType.String) || from === into)
    throw new YurisError(0x1a6a8);
  if (from === YurisType.Int)
    machine.setString(to.id, to.index, formatInt(machine.getInt(set.id, set.index)));
  else if (from === YurisType.Float)
    machine.setString(to.id, to.index, formatFloat(machine.getFloat(set.id, set.index)));
  else if (from === YurisType.String) {
    const text = machine.getString(set.id, set.index);
    if (text.charCodeAt(0) === 0x30 && text.charCodeAt(1) === 0x78) {
      const value = parseHex(text);
      if (value === null) return -1;
      machine.setInt(to.id, to.index, value);
      return 0;
    }
    let dot = false,
      k = 0;
    for (; k < text.length; k++) {
      const c = text.charCodeAt(k);
      if (isLeadByte(c)) break;
      if (c === 0x2e) dot = true;
      else if ((c < 0x30 || c > 0x39) && c !== 0x2d) break;
    }
    if (k < text.length) throw new YurisError(0x1a6b2);
    if (dot) machine.setFloat(to.id, to.index, strtod(text));
    else machine.setInt(to.id, to.index, atoi64(text));
  }
  return 0;
}
