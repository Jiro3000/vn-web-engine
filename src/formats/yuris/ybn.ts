import {BinaryReader, ByteView} from '../../core/binary.js';
import {murmurHash2} from './murmur.js';

/**
 * YU-RIS compiled script files (`ysbin\*.ybn`). Addresses refer to `hajiron.exe` (see the
 * engine README). Every file starts with a four-byte signature and a u32 version; the
 * loaders are:
 *
 * | File            | Signature | Loader   | Contents                                  |
 * | --------------- | --------- | -------- | ----------------------------------------- |
 * | `ysc.ybn`       | `YSCM`    | 0x4635A8 | command names, argument kinds, messages   |
 * | `ysl.ybn`       | `YSLB`    | 0x4641C8 | labels, bucketed by hash                  |
 * | `yst.ybn`       | `YSTD`    | 0x463C60 | variable count                            |
 * | `yst_list.ybn`  | `YSTL`    | 0x463D24 | script file list                          |
 * | `ysv.ybn`       | `YSVR`    | 0x46BBB8 | variable declarations and initial values  |
 * | `yscfg.ybn`     | `YSCF`    | 0x463E84 | screen size and window settings           |
 * | `yse.ybn`       | `YSER`    | 0x46C1D0 | numbered error messages                   |
 * | `yst%05d.ybn`   | `YSTB`    | 0x4511C1 | one script: instructions and expressions  |
 */

export type YbnSignature = 'YSCM' | 'YSLB' | 'YSTD' | 'YSTL' | 'YSVR' | 'YSCF' | 'YSER' | 'YSTB';

export function ybnSignature(bytes: Uint8Array): YbnSignature {
  if (bytes.length < 8) throw new Error('YBN file is too short');
  const signature = String.fromCharCode(...bytes.subarray(0, 4));
  switch (signature) {
    case 'YSCM':
    case 'YSLB':
    case 'YSTD':
    case 'YSTL':
    case 'YSVR':
    case 'YSCF':
    case 'YSER':
    case 'YSTB':
      return signature;
  }
  throw new Error('Unknown YBN signature');
}

/** The script format version every loader of this executable accepts (YSTD checks it). */
export const YBN_VERSION = 0x22b;

function header(bytes: Uint8Array, signature: YbnSignature): ByteView {
  const view = new ByteView(bytes, {littleEndian: true});
  if (ybnSignature(bytes) !== signature) throw new Error(`Not a ${signature} file`);
  const version = view.u32(4);
  if (version !== YBN_VERSION) throw new Error(`${signature}: unsupported version ${version}`);
  return view;
}

/** A command argument as declared in `ysc.ybn`. */
export interface YurisCommandArgument {
  /** Bytes of the argument keyword (`ID`, `FILE`, ...); empty for positional arguments. */
  readonly name: string;
  /**
   * How the generic argument decoder 0x4253C9 reads the value: 0 evaluates it as a number,
   * 1 evaluates it into a string buffer, 2 keeps a pointer to the expression for the
   * command (an assignment target), any other kind is left to the command handler.
   */
  readonly kind: number;
  /** Range check applied by 0x4253C9 to numeric values (ranges at 0x59B5C0 / 0x59B620). */
  readonly check: number;
}

export interface YurisCommand {
  readonly name: string;
  readonly args: readonly YurisCommandArgument[];
}

export interface YurisCommandSet {
  readonly commands: readonly YurisCommand[];
  /** Message strings that follow the command table, as bytes. */
  readonly messages: readonly Uint8Array[];
  /** The 256-byte table that ends the file. */
  readonly table: Uint8Array;
}

/** Number of message strings that follow the command table in `ysc.ybn`. */
const YSCM_MESSAGES = 37;

/**
 * `YSCM` (read by 0x4635A8): u32 command count at 8, then from 0x10 per command a
 * zero-terminated name, an argument count byte and per argument a zero-terminated keyword,
 * a kind byte and a check byte. The command id is its index; 0x4635A8 fills the handler
 * table at 0x78B040 by id and leaves unimplemented ids on 0x45C958, which reports an error.
 */
export function parseYscm(bytes: Uint8Array): YurisCommandSet {
  const view = header(bytes, 'YSCM');
  const count = view.u32(8);
  const reader = new BinaryReader(bytes, true);
  reader.position = 0x10;
  const string = (): Uint8Array => {
    const value = view.cString(reader.position);
    reader.position += value.length + 1;
    return value;
  };
  const latin1 = (value: Uint8Array): string => String.fromCharCode(...value);
  const commands: YurisCommand[] = [];
  for (let i = 0; i < count; i++) {
    const name = latin1(string());
    const argc = reader.u8();
    const args: YurisCommandArgument[] = [];
    for (let j = 0; j < argc; j++) {
      const argName = latin1(string());
      args.push({name: argName, kind: reader.u8(), check: reader.u8()});
    }
    commands.push({name, args});
  }
  const messages: Uint8Array[] = [];
  for (let i = 0; i < YSCM_MESSAGES; i++) messages.push(string());
  const table = reader.range(0x100);
  if (reader.position !== bytes.length) throw new Error('YSCM: trailing bytes');
  return {commands, messages, table};
}

export interface YurisLabel {
  /** Label name bytes as the script compiler stored them. */
  readonly name: Uint8Array;
  /** MurmurHash2 of the name. */
  readonly hash: number;
  /** Instruction index inside the script. */
  readonly position: number;
  /** Script number (`yst%05d.ybn`). */
  readonly script: number;
  readonly ifNest: number;
  readonly loopNest: number;
}

export interface YurisLabels {
  /** First label index for each top hash byte. */
  readonly buckets: Uint32Array;
  readonly labels: readonly YurisLabel[];
}

/**
 * `YSLB` (0x4641C8): u32 label count at 8, 256 u32 bucket starts at 0xC (the first is
 * forced to 0), then per label a length byte, the name, u32 hash, u32 instruction index,
 * u16 script number and two nesting bytes.
 */
export function parseYslb(bytes: Uint8Array): YurisLabels {
  const view = header(bytes, 'YSLB');
  const count = view.u32(8);
  const buckets = new Uint32Array(256);
  for (let i = 0; i < 256; i++) buckets[i] = view.u32(0xc + i * 4);
  buckets[0] = 0;
  const labels: YurisLabel[] = [];
  let p = 0x40c;
  for (let i = 0; i < count; i++) {
    const length = view.u8(p);
    const name = view.range(p + 1, length);
    const q = p + 1 + length;
    labels.push({
      name,
      hash: view.u32(q),
      position: view.u32(q + 4),
      script: view.u16(q + 8),
      ifNest: view.u8(q + 10),
      loopNest: view.u8(q + 11),
    });
    p = q + 12;
  }
  if (p !== bytes.length) throw new Error('YSLB: trailing bytes');
  return {buckets, labels};
}

/**
 * Label lookup of 0x451610: the MurmurHash2 of the name selects a bucket by its top byte
 * before the final mixing step, and the labels from the bucket start are compared by full
 * hash and then byte for byte. Returns the label index or -1.
 */
export function findYurisLabel(labels: YurisLabels, name: Uint8Array): number {
  const hash = murmurHash2(name);
  const bucket = unmixLast(hash) >>> 24;
  for (let i = labels.buckets[bucket]!; i < labels.labels.length; i++) {
    const label = labels.labels[i]!;
    if (label.hash === hash && bytesEqual(label.name, name)) return i;
  }
  return -1;
}

/** Inverts the final `h ^= h >>> 15` of MurmurHash2, giving the value 0x451610 buckets by. */
function unmixLast(hash: number): number {
  return (hash ^ (hash >>> 15) ^ (hash >>> 30)) >>> 0;
}

function bytesEqual(a: Uint8Array, b: Uint8Array): boolean {
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) return false;
  return true;
}

export interface YurisScriptTable {
  /** Number of variable slots (ids 0..variableCount). */
  readonly variableCount: number;
  /** Copied to 0x872464; counts the compiled text lines. */
  readonly textCount: number;
}

/** `YSTD` (0x463C60): u32 variable count at 8 and the u32 at 0xC. */
export function parseYstd(bytes: Uint8Array): YurisScriptTable {
  const view = header(bytes, 'YSTD');
  return {variableCount: view.u32(8), textCount: view.u32(0xc)};
}

export interface YurisScriptFile {
  readonly index: number;
  /** Source file name bytes. */
  readonly name: Uint8Array;
  /** The five u32 fields after the name; 0x463D24 keeps the fifth (at 0x8725F4). */
  readonly fields: readonly number[];
}

/**
 * `YSTL` (0x463D24): u32 count at 8, then per script a u32 index (at most the count), a
 * u32 name length, the name and five u32 fields.
 */
export function parseYstl(bytes: Uint8Array): readonly YurisScriptFile[] {
  const view = header(bytes, 'YSTL');
  const count = view.u32(8);
  const files: YurisScriptFile[] = [];
  let p = 0xc;
  for (let i = 0; i < count; i++) {
    const index = view.u32(p),
      length = view.u32(p + 4);
    if (index > count) throw new Error('YSTL: script index out of range');
    const name = view.range(p + 8, length);
    const q = p + 8 + length;
    files.push({index, name, fields: [0, 1, 2, 3, 4].map((k) => view.u32(q + k * 4))});
    p = q + 20;
  }
  if (p !== bytes.length) throw new Error('YSTL: trailing bytes');
  return files;
}

export const enum YurisValueType {
  Integer = 1,
  Float = 2,
  String = 3,
}

export interface YurisVariableDeclaration {
  /** 1 and 3: global, initialised at start; 2: local to `script`, initialised on load. */
  readonly scope: number;
  /** Stored in the variable's first byte. */
  readonly flags: number;
  readonly script: number;
  readonly id: number;
  /** 0 for a declaration that carries no value. */
  readonly type: YurisValueType | 0;
  readonly dimensions: readonly number[];
  /** Integer or float initial value, or the string initial value's expression bytes. */
  readonly value: bigint | number | Uint8Array | null;
}

/**
 * `YSVR` (pointer kept by 0x46BBB8, read by 0x45170C): u16 count at 8 and records from 10:
 * scope byte, flags byte, u16 script, u16 variable id, type byte, dimension count byte,
 * the u32 dimension sizes and the value: i64 for integers, f64 for floats, and for strings
 * a u16 length and an expression evaluated in string mode.
 */
export function parseYsvr(bytes: Uint8Array): readonly YurisVariableDeclaration[] {
  const view = header(bytes, 'YSVR');
  const count = view.u16(8);
  const declarations: YurisVariableDeclaration[] = [];
  let p = 10;
  for (let i = 0; i < count; i++) {
    const scope = view.u8(p),
      flags = view.u8(p + 1),
      script = view.u16(p + 2),
      id = view.u16(p + 4),
      type = view.u8(p + 6),
      dims = view.u8(p + 7);
    p += 8;
    const dimensions: number[] = [];
    for (let d = 0; d < dims; d++, p += 4) dimensions.push(view.u32(p));
    let value: bigint | number | Uint8Array | null = null;
    if (type === 0) {
      // A declaration without a value: 0x45170C sets the type and dimensions only.
    } else if (type === YurisValueType.Integer) {
      value = view.i64(p);
      p += 8;
    } else if (type === YurisValueType.Float) {
      value = view.f64(p);
      p += 8;
    } else if (type === YurisValueType.String) {
      const length = view.u16(p);
      value = view.range(p + 2, length);
      tokenizeExpression(value);
      p += 2 + length;
    } else throw new Error(`YSVR: variable ${id} has unknown type ${type}`);
    declarations.push({scope, flags, script, id, type, dimensions, value});
  }
  if (p !== bytes.length) throw new Error('YSVR: trailing bytes');
  return declarations;
}

export interface YurisConfig {
  /** Screen size; 0x463E84 accepts 0x80..0x2000 by 0x10..0x2000, or 0 by 0 for the default. */
  readonly width: number;
  readonly height: number;
  /** The byte stored at 0x18 of the screen state. */
  readonly screenMode: number;
  /** Eight bytes copied to 0x872318 and four to 0x872320. */
  readonly reserved: Uint8Array;
  readonly reserved2: Uint8Array;
  /** 0 or 1, stored at 0x872314. */
  readonly threadMode: number;
  /** Seven settings stored as bytes at 0x8722C4, 0x8722FC, 0x872300, 0x8722D4, 0x872304, 0x872308, 0x87230C (file order). */
  readonly settings: readonly number[];
  /** Window caption bytes (at most 0x80); an empty caption becomes a space. */
  readonly caption: Uint8Array;
}

/** `YSCF` (0x463E84). */
export function parseYscf(bytes: Uint8Array): YurisConfig {
  const view = header(bytes, 'YSCF');
  const width = view.i32(0x10),
    height = view.i32(0x14);
  // Zero by zero keeps the executable's default size; anything else must be in range.
  if (
    (width !== 0 || height !== 0) &&
    ((width - 0x80) >>> 0 > 0x1f80 || (height - 0x10) >>> 0 > 0x1ff0)
  )
    throw new Error('YSCF: screen size out of range');
  const threadMode = view.i32(0x28);
  if (threadMode < 0 || threadMode > 1) throw new Error('YSCF: invalid thread mode');
  const length = view.u16(0x4c);
  const caption = view.range(0x4e, length);
  const zero = caption.indexOf(0);
  const text = zero < 0 ? caption : caption.subarray(0, zero);
  if (text.length > 0x80) throw new Error('YSCF: caption too long');
  return {
    width,
    height,
    screenMode: view.u8(0x18),
    reserved: view.range(0x1c, 8),
    reserved2: view.range(0x24, 4),
    threadMode,
    settings: [0x2c, 0x30, 0x34, 0x38, 0x3c, 0x40, 0x44].map((o) => view.i32(o)),
    caption: text.length ? text : Uint8Array.of(0x20),
  };
}

/** `YSER` (0x46C1D0): u32 count at 8, then from 0x10 per message a u32 id and a string. */
export function parseYser(bytes: Uint8Array): ReadonlyMap<number, Uint8Array> {
  const view = header(bytes, 'YSER');
  const count = view.u32(8);
  const messages = new Map<number, Uint8Array>();
  let p = 0x10;
  for (let i = 0; i < count; i++) {
    const id = view.u32(p);
    const text = view.cString(p + 4);
    messages.set(id, text);
    p += 5 + text.length;
  }
  if (p !== bytes.length) throw new Error('YSER: trailing bytes');
  return messages;
}

/**
 * Expression operators and their fixed payload sizes (-1: variable), as installed in the
 * dispatch table at 0x7E1680 by 0x46A634. Operators outside this table reach 0x423080,
 * which reports an error.
 */
export const EXPRESSION_OPS: ReadonlyMap<number, number> = new Map(
  (
    [
      ['M', -1], // 0x420CB8 string literal
      ['H', 3], // 0x420EC4 variable value (prefix byte, u16 id)
      ['V', 3], // 0x4218B0 array element start
      ['v', 3], // 0x421994 variable reference
      [')', 1], // 0x421A4C array indices end (index count)
      ['B', 1], // 0x421E44 i8
      ['W', 2], // 0x421EBC i16
      ['I', 4], // 0x421F34 i32
      ['L', 8], // 0x421F9C i64
      ['F', 8], // 0x422008 f64
      ['R', 0], // 0x422090 negate
      ['s', 0], // 0x4220EC to string
      ['i', 0], // 0x42220C to number
      ['+', 0], // 0x4225B0
      ['=', 0], // 0x422700
      ['!', 0], // 0x422870
      ['>', 0], // 0x4229E0
      ['<', 0], // 0x422A7C
      ['Z', 0], // 0x422B14 >=
      ['S', 0], // 0x422BAC <=
      ['-', 0], // 0x422C48
      ['*', 0], // 0x422CAC
      ['/', 0], // 0x422D24
      ['%', 0], // 0x422DD8
      ['A', 0], // 0x422E50 bitwise and
      ['O', 0], // 0x422E98 bitwise or
      ['&', 0], // 0x422EE0 logical and
      ['|', 0], // 0x422F8C logical or
      ['^', 0], // 0x423038 xor
      [',', 0], // 0x469A24 separator
    ] as const
  ).map(([op, size]) => [op.charCodeAt(0), size]),
);

export interface YurisToken {
  readonly op: number;
  readonly payload: Uint8Array;
}

/**
 * Splits expression bytecode as the evaluator loop 0x420ACC walks it: an operator byte, a
 * u16 payload length and the payload.
 */
export function tokenizeExpression(bytes: Uint8Array): readonly YurisToken[] {
  const view = new ByteView(bytes, {littleEndian: true});
  const tokens: YurisToken[] = [];
  for (let p = 0; p < bytes.length;) {
    const op = view.u8(p),
      length = view.u16(p + 1);
    const expected = EXPRESSION_OPS.get(op);
    if (expected === undefined) throw new Error(`Unknown expression operator 0x${hex(op)}`);
    if (expected >= 0 && length !== expected)
      throw new Error(`Expression operator '${String.fromCharCode(op)}' has payload ${length}`);
    tokens.push({op, payload: view.range(p + 3, length)});
    p += 3 + length;
  }
  return tokens;
}

function hex(value: number): string {
  return value.toString(16).padStart(2, '0');
}

/** Command ids whose dedicated handlers read jump targets from their trailing arguments. */
export const enum YurisFlowCommand {
  Else = 0x0b,
  Go = 0x2a,
  Gosub = 0x2b,
  If = 0x2c,
  Loop = 0x37,
}

export interface YurisArgument {
  /** Index into the command's declared arguments (0 for commands that declare none). */
  readonly id: number;
  /**
   * Evaluator selector: index into the evaluator tables at 0x872654 (numbers), 0x872668
   * (floats) and 0x872690 (strings). 0 marks an argument that is not evaluated directly.
   */
  readonly type: number;
  /** Assignment operator of `LET` targets. */
  readonly op: number;
  /** Expression length, or the jump target of IF/ELSE/LOOP trailing arguments. */
  readonly size: number;
  /** Expression offset into the resource section. */
  readonly offset: number;
  /** Expression tokens; null for jump targets. */
  readonly tokens: readonly YurisToken[] | null;
  /** The expression bytes (empty for jump targets). */
  readonly expression: Uint8Array;
}

export interface YurisInstruction {
  readonly command: number;
  readonly args: readonly YurisArgument[];
  /** The u16 after the argument count. */
  readonly extra: number;
}

export interface YurisScript {
  readonly instructions: readonly YurisInstruction[];
  readonly resources: Uint8Array;
  /** Source line of each instruction. */
  readonly lines: Uint32Array;
}

/**
 * The four-byte XOR key of `YSTB` sections. 0x468D20 computes it as the big-endian bytes of
 * the CRC-32 of a string compiled into the executable. Each section is XORed from its own
 * start, and the first argument record's resource offset is always zero, so the four bytes
 * at argument offset 8 of any script with arguments are the key itself.
 */
export function ystbKey(bytes: Uint8Array): Uint8Array | null {
  const view = header(bytes, 'YSTB');
  const code = view.u32(0xc),
    args = view.u32(0x10);
  if (args < 12) return null;
  return view.range(0x20 + code + 8, 4).slice();
}

/** The big-endian bytes of the CRC-32 of `name`, the key 0x468D20 derives. */
export function ystbKeyFromName(name: Uint8Array): Uint8Array {
  let crc = ~0;
  for (const b of name) {
    crc ^= b;
    for (let k = 0; k < 8; k++) crc = (crc >>> 1) ^ (0xedb88320 & -(crc & 1));
  }
  crc = ~crc >>> 0;
  return Uint8Array.of(crc >>> 24, (crc >>> 16) & 0xff, (crc >>> 8) & 0xff, crc & 0xff);
}

/**
 * `YSTB` (0x4511C1): header of eight u32 (signature, version, instruction count, code,
 * argument, resource and line section sizes), then the four sections, each XORed with the
 * key. Code: per instruction a command byte, an argument count byte and a u16. Arguments:
 * 12-byte records of id byte, a pad byte, type byte, operator byte, u32 size and u32
 * resource offset, consumed in instruction order. Lines: a u32 per instruction.
 */
export function parseYstb(
  bytes: Uint8Array,
  key: Uint8Array,
  commands: YurisCommandSet,
): YurisScript {
  const source = header(bytes, 'YSTB');
  const count = source.u32(8),
    codeSize = source.u32(0xc),
    argSize = source.u32(0x10),
    resourceSize = source.u32(0x14),
    lineSize = source.u32(0x18);
  if (codeSize !== count * 4) throw new Error('YSTB: code section size');
  if (lineSize !== count * 4) throw new Error('YSTB: line section size');
  if (argSize % 12) throw new Error('YSTB: argument section size');
  const decoded = source.range(0x20, codeSize + argSize + resourceSize + lineSize).slice();
  if (0x20 + decoded.length !== bytes.length) throw new Error('YSTB: trailing bytes');
  let start = 0;
  for (const size of [codeSize, argSize, resourceSize, lineSize]) {
    for (let i = 0; i < size; i++) decoded[start + i]! ^= key[i & 3]!;
    start += size;
  }
  const view = new ByteView(decoded, {littleEndian: true});
  const resources = decoded.subarray(codeSize + argSize, codeSize + argSize + resourceSize);
  const lines = new Uint32Array(count);
  for (let i = 0; i < count; i++) lines[i] = view.u32(codeSize + argSize + resourceSize + i * 4);
  const resourceView = new ByteView(resources);
  const instructions: YurisInstruction[] = [];
  let a = codeSize;
  const argEnd = codeSize + argSize;
  for (let i = 0; i < count; i++) {
    const command = view.u8(i * 4),
      argc = view.u8(i * 4 + 1),
      extra = view.u16(i * 4 + 2);
    const declared = commands.commands[command];
    if (!declared) throw new Error(`Instruction ${i}: unknown command ${command}`);
    const args: YurisArgument[] = [];
    for (let j = 0; j < argc; j++, a += 12) {
      view.check(a, 12, argEnd);
      const id = view.u8(a),
        type = view.u8(a + 2),
        op = view.u8(a + 3),
        size = view.u32(a + 4),
        offset = view.u32(a + 8);
      const where = `Instruction ${i} (${declared.name}) argument ${j}`;
      if (declared.args.length ? id >= declared.args.length : id !== 0)
        throw new Error(`${where}: unknown argument id ${id}`);
      if (view.u8(a + 1) !== 0) throw new Error(`${where}: nonzero pad byte`);
      if (type > 4) throw new Error(`${where}: unknown evaluator type ${type}`);
      if (isJumpTarget(command, argc, j)) {
        if (type !== 0 || size > count) throw new Error(`${where}: invalid jump target`);
        args.push({id, type, op, size, offset, tokens: null, expression: new Uint8Array(0)});
        continue;
      }
      const expression = resourceView.range(offset, size);
      let tokens: readonly YurisToken[];
      try {
        tokens = tokenizeExpression(expression);
      } catch (error) {
        throw new Error(`${where}: ${(error as Error).message}`);
      }
      args.push({id, type, op, size, offset, tokens, expression});
    }
    instructions.push({command, args, extra});
  }
  if (a !== argEnd) throw new Error('YSTB: unused argument records');
  return {instructions, resources, lines};
}

/**
 * IF (0x4435B0) carries the condition and two targets (the next branch, 0 when there is
 * none, and the instruction after IFEND); ELSE with a condition (0x43D710) has the same
 * shape; LOOP (0x445DC4) carries the count and the instruction after LOOPEND.
 */
function isJumpTarget(command: number, argc: number, index: number): boolean {
  switch (command) {
    case YurisFlowCommand.If:
    case YurisFlowCommand.Else:
      return argc === 3 && index > 0;
    case YurisFlowCommand.Loop:
      return argc === 2 && index === 1;
  }
  return false;
}

/** The project files a YU-RIS executable loads before its first script. */
export interface YurisProject {
  readonly commands: YurisCommandSet;
  readonly labels: YurisLabels;
  readonly table: YurisScriptTable;
  readonly files: readonly YurisScriptFile[];
  readonly variables: readonly YurisVariableDeclaration[];
  readonly config: YurisConfig;
  readonly errors: ReadonlyMap<number, Uint8Array>;
  readonly key: Uint8Array;
  /** Reads and parses `ysbin\yst%05d.ybn`. */
  script(index: number): Promise<YurisScript>;
}

export function yurisScriptPath(index: number): string {
  return `ysbin\\yst${String(index).padStart(5, '0')}.ybn`;
}

/**
 * Loads the project files in the order of the start-up path (0x4635A8, 0x463C60, 0x463D24,
 * 0x46BBB8, 0x463E84, 0x4641C8, 0x46C1D0). `read` takes a byte-string path. The script key
 * comes from the first listed script that has arguments (see ystbKey).
 */
export async function loadYurisProject(
  read: (path: string) => Promise<Uint8Array>,
): Promise<YurisProject> {
  const commands = parseYscm(await read('ysbin\\ysc.ybn'));
  const table = parseYstd(await read('ysbin\\yst.ybn'));
  const files = parseYstl(await read('ysbin\\yst_list.ybn'));
  const variables = parseYsvr(await read('ysbin\\ysv.ybn'));
  const config = parseYscf(await read('ysbin\\yscfg.ybn'));
  const labels = parseYslb(await read('ysbin\\ysl.ybn'));
  const errors = parseYser(await read('ysbin\\yse.ybn'));
  let key: Uint8Array | null = null;
  for (const file of files) {
    key = ystbKey(await read(yurisScriptPath(file.index)));
    if (key) break;
  }
  if (!key) throw new Error('No script carries arguments to derive the YSTB key from');
  const scriptKey = key;
  return {
    commands,
    labels,
    table,
    files,
    variables,
    config,
    errors,
    key: scriptKey,
    async script(index: number): Promise<YurisScript> {
      return parseYstb(await read(yurisScriptPath(index)), scriptKey, commands);
    },
  };
}
