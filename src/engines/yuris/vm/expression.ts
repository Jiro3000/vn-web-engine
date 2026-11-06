import {YurisError} from './errors.js';
import {
  type ByteString,
  STRING_CAPACITY,
  atoi64,
  compareBytes,
  fistp,
  formatFloat,
  formatInt,
  i64,
  isLeadByte,
  parseHex,
  strtod,
} from './numbers.js';
import {
  SYSTEM_VARIABLE_LIMIT,
  YurisType,
  type YurisVariable,
  type YurisVariables,
} from './variables.js';

/**
 * Values of system variables (ids below 1000). `index` and `indexHigh` are the two halves of
 * the flattened 64-bit element index; reference indexes carry a variable id in the high half.
 */
export interface YurisSystemValues {
  /** 0x448280. */
  int(id: number, index: number, indexHigh: number): bigint;
  /** 0x448110. */
  float(id: number, index: number, indexHigh: number): number;
  /** 0x4212D4. */
  string(id: number, index: number, indexHigh: number): ByteString;
}

/**
 * Evaluator modes (0x7E11E4), set by the entry points: odd modes evaluate numbers as int64,
 * even modes as doubles, and modes 3 and 4 also copy the string result out.
 */
const enum Mode {
  Int = 1,
  Float = 2,
  String = 3,
  FloatString = 4,
}

/** Stack depth of the native value stacks (0x7DB9E0 and 0x7DD9E0, 0x2000 bytes each). */
const STACK = 0x400;
/** Index nesting limit of the array frames at 0x7E1200. */
const NESTING = 0x80;
const BYTE_LITERALS = Array.from({length: 256}, (_, i) => BigInt((i << 24) >> 24));
const COMMON_INDEXES = Array.from({length: 512}, (_, i) => BigInt(i));

/**
 * The YU-RIS expression evaluator (0x420ACC). Expression bytecode is a sequence of operator
 * byte, u16 payload length and payload; each operator works on three parallel stacks: int64
 * values, doubles and a string slot per position (0 for a number). Strings live in numbered
 * buffers allocated in evaluation order. Numbers use the double stack only in a float mode
 * outside array indexes; indexes are always int64. The stacks persist between evaluations,
 * as the native globals do, so stale entries behave identically.
 */
export class YurisExpression {
  private mode: Mode = Mode.Int;
  /** 0x7E11E2: stack size. */
  private top = 0;
  /** 0x7E11E5: open array index frames. */
  private depth = 0;
  // Keep signed bigint values on the stack so a pop can reuse the stored value.
  // Arithmetic and numeric conversions wrap before pushing.
  private readonly ints = new Array<bigint>(STACK).fill(0n);
  private readonly doubles = new Float64Array(STACK);
  /** 0x7E09E2: string slot per stack position. */
  private readonly slots = new Uint16Array(STACK);
  /** 0x7E09E0: next free string slot (slot 0 means a number). */
  private nextSlot = 1;
  /** 0x7DF9E0: string buffers by slot. */
  private readonly buffers: ByteString[] = [];
  /** 0x7E1200, 0x7E1280, 0x7E1480: stack base, variable id and prefix of each array frame. */
  private readonly frameBase = new Uint8Array(NESTING);
  private readonly frameId = new Uint32Array(NESTING);
  private readonly framePrefix = new Int32Array(NESTING);
  /** 0x7DB998: index values collected by the last `)` (count 0x7DB993). */
  private readonly indexes = new Array<bigint>(16).fill(0n);
  private indexCount = 0;
  /** Set by 0x46A634(0) while scripts load: variable reads only mark the result variable. */
  private constantCheck = false;
  private constantResult = true;

  /** 0x7DB980: the last variable an expression named. */
  lastId = 0;
  /** 0x7DB988: its flattened element index (64-bit). */
  private lastElement: number | bigint = 0;
  get lastIndex(): bigint {
    const index = this.lastElement;
    return typeof index === 'number' ? (COMMON_INDEXES[index] ?? BigInt(index)) : index;
  }
  /** 0x7DB991: set by `v`, a whole-variable reference. */
  wholeVariable = false;
  /** 0x7DB992: 1 for a '`' prefix, 2 for '#'; either makes reads push a reference. */
  prefix = 0;
  /** 0x7DB990: declaration mode of INT/FLT/STR targets. */
  declaring = false;

  constructor(
    private readonly variables: YurisVariables,
    private readonly system: YurisSystemValues,
  ) {}

  /** The dimensions a declaration target named, collected by `)` in declaration mode. */
  get declaredDimensions(): number[] {
    const dimensions = new Array<number>(this.indexCount);
    for (let i = 0; i < dimensions.length; i++)
      dimensions[i] = Number(this.indexes[i]! & 0xffffffffn);
    return dimensions;
  }

  /** 0x420BDC (mode 1): int64 result. */
  int(bytes: Uint8Array): bigint {
    this.run(bytes, Mode.Int);
    return this.ints[0]!;
  }
  /** 0x420C0C (mode 2): double result rounded by `FISTP`. */
  floatAsInt(bytes: Uint8Array): bigint {
    this.run(bytes, Mode.Float);
    return fistp(this.doubles[0]!);
  }
  /** 0x420C60 (mode 1): int64 result as a double. */
  intAsFloat(bytes: Uint8Array): number {
    this.run(bytes, Mode.Int);
    return Number(this.ints[0]!);
  }
  /** 0x420C8C (mode 2): double result. */
  float(bytes: Uint8Array): number {
    this.run(bytes, Mode.Float);
    return this.doubles[0]!;
  }
  /** Float evaluators of LET float assignments (table 0x87267C): always 0x420C8C. */
  floatAlways(bytes: Uint8Array): number {
    return this.float(bytes);
  }
  /** 0x420A90 (mode 3): string result, empty when the result is a number. */
  string(bytes: Uint8Array): ByteString {
    return this.run(bytes, Mode.String);
  }
  /** 0x420BA8 (mode 4): string result with numbers evaluated as doubles. */
  floatString(bytes: Uint8Array): ByteString {
    return this.run(bytes, Mode.FloatString);
  }

  /** Integer evaluators by argument type (table 0x872654). */
  intOf(type: number, bytes: Uint8Array): bigint {
    return type === 2 || type === 4 ? this.floatAsInt(bytes) : this.int(bytes);
  }
  /** Float evaluators by argument type (table 0x872668). */
  floatOf(type: number, bytes: Uint8Array): number {
    return type === 2 || type === 4 ? this.float(bytes) : this.intAsFloat(bytes);
  }
  /** String evaluators by argument type (table 0x872690; type 4 is 0x420BA8). */
  stringOf(type: number, bytes: Uint8Array): ByteString {
    return type === 4 ? this.floatString(bytes) : this.string(bytes);
  }

  /**
   * Evaluates a label expression while scripts load (0x4511C1 under 0x46A634(0)): the
   * string value and whether it names no variable, the condition for resolving the label
   * once.
   */
  constant(bytes: Uint8Array): {value: ByteString; constant: boolean} {
    this.constantCheck = true;
    this.constantResult = true;
    try {
      const value = this.string(bytes);
      return {value, constant: this.constantResult};
    } finally {
      this.constantCheck = false;
    }
  }

  /** 0x420ACC. */
  private run(bytes: Uint8Array, mode: Mode): ByteString {
    this.mode = mode;
    this.nextSlot = 1;
    this.top = 0;
    this.depth = 0;
    this.indexCount = 0;
    this.indexes[0] = 0n;
    this.prefix = 0;
    this.wholeVariable = false;
    this.slots[0] = 0;
    for (let p = 0; p < bytes.length;) {
      const op = bytes[p]!,
        length = bytes[p + 1]! | (bytes[p + 2]! << 8);
      if (op === 0x56 && length === 3) {
        const next = this.indexedRead(bytes, p);
        if (next !== p) {
          p = next;
          continue;
        }
      }
      const ok = this.step(op, bytes, p + 3, length);
      p += 3 + length;
      // A failing operator ends the evaluation without producing the string result.
      if (!ok) return '';
    }
    if (mode >= Mode.String && this.slots[0] !== 0) {
      const text = this.buffers[this.slots[0]!] ?? '';
      const end = text.indexOf('\0');
      return end < 0 ? text : text.slice(0, end);
    }
    return '';
  }

  /** Numbers use doubles in float modes outside indexes. */
  private get floating(): boolean {
    return (this.mode & 1) === 0 && this.depth === 0;
  }

  /** One operator; false stops the expression as a failing native handler does. */
  private step(op: number, bytes: Uint8Array, at: number, length: number): boolean {
    switch (op) {
      case 0x4d: // M
        this.literal(bytes, at, length);
        return true;
      case 0x48: // H
        if (this.constantCheck) return this.markVariable();
        this.variable(bytes, at);
        return true;
      case 0x56: // V
        if (this.constantCheck) return this.markVariable();
        this.openIndex(bytes, at);
        return true;
      case 0x76: // v
        if (this.constantCheck) return this.markVariable();
        this.reference(bytes, at);
        return true;
      case 0x29: // )
        this.closeIndex();
        return true;
      case 0x42: // B
        return this.push(BYTE_LITERALS[bytes[at]! | 0]!);
      case 0x57: // W
        return this.push(BigInt(signed(bytes[at]! | (bytes[at + 1]! << 8), 16)));
      case 0x49: // I
        return this.push(BigInt(view(bytes).getInt32(at, true)));
      case 0x4c: // L
        return this.push(view(bytes).getBigInt64(at, true));
      case 0x46: // F
        return this.pushDouble(view(bytes).getFloat64(at, true));
      case 0x52: // R
        return this.negate();
      case 0x73: // s
        return this.toText();
      case 0x69: // i
        return this.toNumber();
      case 0x2b: // +
        return this.add();
      case 0x3d: // =
        return this.equality(true);
      case 0x21: // !
        return this.equality(false);
      case 0x3c: // <
        return this.compare((a, b) => a < b);
      case 0x3e: // >
        return this.compare((a, b) => a > b);
      case 0x5a: // Z
        return this.compare((a, b) => a >= b);
      case 0x53: // S
        return this.compare((a, b) => a <= b);
      case 0x2d: // -
        return this.arithmetic(
          (a, b) => a - b,
          (a, b) => a - b,
        );
      case 0x2a: // *
        return this.arithmetic(
          (a, b) => a * b,
          (a, b) => a * b,
        );
      case 0x2f: // /
        return this.arithmetic(
          (a, b) => (b === 0 ? 0 : a / b),
          (a, b) => (b === 0n ? 0n : a / b),
        );
      case 0x25: // %
        return this.integerOnly((a, b) => (b === 0n ? 0n : a % b));
      case 0x41: // A
        return this.integerOnly((a, b) => a & b);
      case 0x4f: // O
        return this.integerOnly((a, b) => a | b);
      case 0x5e: // ^
        return this.integerOnly((a, b) => a ^ b);
      case 0x26: // &
        return this.logical((a, b) => a && b);
      case 0x7c: // |
        return this.logical((a, b) => a || b);
      case 0x2c: // ,
        return true;
    }
    // 0x423080, installed for every other operator byte.
    throw new YurisError(0xdbbbe);
  }

  /** 0x421A3C: a variable read during the load-time label check stops the expression. */
  private markVariable(): boolean {
    this.constantResult = false;
    return false;
  }

  private allocate(text: ByteString): number {
    const slot = this.nextSlot++;
    this.buffers[slot] = text;
    return slot;
  }

  /**
   * 'M' (0x420CB8): a string literal. The payload's first byte is the delimiter; `\\`, `\n`
   * and `\t` are escapes, a backslash before any other byte is dropped, and a lead byte
   * copies two bytes.
   */
  private literal(bytes: Uint8Array, at: number, length: number): void {
    const delimiter = bytes[at]!,
      end = at + length;
    let p = at + 1,
      text = '';
    let c = p < end ? bytes[p]! : delimiter;
    while (c !== delimiter) {
      if (c === 0x5c) {
        p++;
        c = bytes[p]!;
        if (c === 0x5c) {
          text += '\\';
          c = bytes[++p]!;
        } else if (c === 0x6e) {
          text += '\n';
          c = bytes[++p]!;
        } else if (c === 0x74) {
          text += '\t';
          c = bytes[++p]!;
        }
      } else if (isLeadByte(c)) {
        text += String.fromCharCode(c, bytes[p + 1]!);
        p += 2;
        c = bytes[p]!;
      } else {
        text += String.fromCharCode(c);
        c = bytes[++p]!;
      }
      if (p >= end) break;
    }
    const position = this.top;
    this.ints[position] = 0n;
    this.slots[position] = this.allocate(text);
    this.top++;
  }

  private setPrefixAndId(bytes: Uint8Array, at: number): number {
    const sigil = bytes[at]!;
    this.prefix = (sigil === 0x60 ? 1 : 0) + (sigil === 0x23 ? 2 : 0);
    this.lastId = bytes[at + 1]! | (bytes[at + 2]! << 8);
    this.lastElement = 0;
    return this.lastId;
  }

  /** 'H' (0x420EC4): a scalar variable read; nothing is pushed for a declaration target. */
  private variable(bytes: Uint8Array, at: number): void {
    const id = this.setPrefixAndId(bytes, at);
    if (this.declaring && this.depth === 0) return;
    if (id >= this.variables.entries.length) throw new YurisError(0x1a5ea);
    this.pushVariable(id, this.variables.get(id), this.top, 0);
    this.top++;
  }

  /** 'V' (0x4218B0): opens an array index frame with a placeholder entry. */
  private openIndex(bytes: Uint8Array, at: number): void {
    const id = this.setPrefixAndId(bytes, at);
    if ((!this.declaring || this.depth !== 0) && id >= this.variables.entries.length)
      throw new YurisError(0x1a5ea);
    const d = this.depth;
    this.frameBase[d] = this.top;
    this.frameId[d] = id;
    this.framePrefix[d] = this.prefix;
    this.ints[this.top] = 0n;
    this.slots[this.top] = 0;
    this.top++;
    this.depth++;
  }

  /** Fuse V, a scalar index, and ) for the ordinary one-dimensional access. */
  private indexedRead(bytes: Uint8Array, p: number): number {
    if (
      (bytes[p + 3] !== 0x40 && bytes[p + 3] !== 0x24) ||
      this.constantCheck ||
      this.top >= 255 ||
      this.depth >= NESTING ||
      (this.declaring && this.depth === 0)
    )
      return p;
    const id = bytes[p + 4]! | (bytes[p + 5]! << 8);
    // The four reference arrays flatten against the referenced variable instead.
    if (id === 0x32 || id === 0x33 || id === 0x34 || id === 0x46) return p;
    const target = this.variables.entries[id];
    if (!target || target.dimensions.length !== 1) return p;
    const kind = bytes[p + 6]!;
    const close = p + (kind === 0x48 ? 12 : 10);
    if (
      bytes[close] !== 0x29 ||
      bytes[close + 1] !== 1 ||
      bytes[close + 2] !== 0 ||
      close + 4 > bytes.length
    )
      return p;
    let index: bigint;
    if (kind === 0x48 && bytes[p + 7] === 3 && bytes[p + 8] === 0 && bytes[p + 9] === 0x40) {
      const key = bytes[p + 10]! | (bytes[p + 11]! << 8);
      const scalar = this.variables.entries[key];
      if (scalar?.type !== YurisType.Int) return p;
      if (key >= SYSTEM_VARIABLE_LIMIT && scalar.ints) index = scalar.ints[0] ?? 0n;
      else if (key === 0x30) index = this.system.int(key, 0, 0);
      else return p;
    } else if (kind === 0x42 && bytes[p + 7] === 1 && bytes[p + 8] === 0)
      index = BYTE_LITERALS[bytes[p + 9]!]!;
    else return p;
    const top = this.top;
    this.frameBase[this.depth] = top;
    this.frameId[this.depth] = id;
    this.framePrefix[this.depth] = 0;
    this.slots[top] = this.slots[top + 1] = 0;
    this.ints[top] = 0n;
    this.ints[top + 1] = index;
    const element = Number(index);
    if (element < 0 || element >= target.dimensions[0]!) {
      this.depth++;
      this.top += 2;
      this.closeIndex();
      return close + 4;
    }
    this.indexes[0] = index;
    this.indexCount = 1;
    this.lastId = id;
    this.lastElement = element;
    this.prefix = 0;
    this.pushVariable(id, target, top, element);
    this.top++;
    return close + 4;
  }

  /** 'v' (0x421994): a whole-variable reference, used by LET re-initialisation. */
  private reference(bytes: Uint8Array, at: number): void {
    const id = this.setPrefixAndId(bytes, at);
    if (id >= this.variables.entries.length) throw new YurisError(0x1a5ea);
    this.wholeVariable = true;
    this.ints[this.top] = 0n;
    this.slots[this.top] = 0;
    this.top++;
  }

  /**
   * ')' (0x421A4C): collects the index values above the frame's placeholder, flattens them
   * row-major against the variable's dimensions and pushes the element in place of the frame.
   * Ids 0x32, 0x33, 0x34 and 0x46 address another variable: the first index is a reference
   * (variable id in the high half) and further indexes select an element of that variable.
   */
  private closeIndex(): void {
    this.depth--;
    const d = this.depth,
      base = this.frameBase[d]!;
    this.indexCount = 0;
    for (let p = base + 1; p < this.top; p++) {
      const index = this.indexCount++;
      if (index < this.indexes.length) this.indexes[index] = this.ints[p]!;
      if (this.slots[p] !== 0) throw new YurisError(0x2710a);
    }
    const id = this.frameId[d]!;
    this.lastId = id;
    this.prefix = this.framePrefix[d]!;
    if (d === 0 && this.declaring) return;
    const n = this.indexCount;
    const variable = this.variables.get(id);
    let index: number | bigint;
    if (id === 0x32 || id === 0x33 || id === 0x34 || id === 0x46) {
      index = this.referenceIndex(n);
    } else {
      const dimensions = variable.dimensions;
      // Ordinary in-bounds indexes fit the allocated array and flatten exactly as numbers.
      // The VM's low-dword validation and int64 wrap still apply to irregular operands.
      let ordinary = n === dimensions.length;
      let flattened = 0;
      for (let k = 0; ordinary && k < n; k++) {
        const element = Number(this.indexes[k]!);
        const dimension = dimensions[k]!;
        if (element >= 0 && element < dimension) flattened = flattened * dimension + element;
        else ordinary = false;
      }
      if (ordinary && Number.isSafeInteger(flattened)) index = flattened;
      else {
        for (let k = 0; k < n; k++)
          if (unsigned32(BigInt(dimensions[k] ?? 0) - 1n) < unsigned32(this.indexes[k]!))
            throw new YurisError(0x1a202);
        index = 0n;
        let multiplier = 1n;
        for (let k = dimensions.length - 1; k >= 0; k--) {
          index += multiplier * this.indexes[k]!;
          multiplier *= BigInt(dimensions[k]!);
        }
        index = i64(index);
      }
    }
    this.lastElement = index;
    this.top = base;
    this.pushVariable(id, variable, base, index);
    this.top++;
  }

  private referenceIndex(n: number): bigint {
    const first = this.indexes[0]!;
    if (n === 1) return first;
    const target = Number(first >> 32n);
    const variable = this.variables.get(target);
    let dimensions: number;
    if (n === 2) {
      if (variable.dimensions.length !== 1 || variable.dimensions[0]! <= lowSigned(first))
        return i64(first + (this.indexes[1]! & ~0xffffffffn) + (this.indexes[1]! & 0xffffffffn));
      dimensions = 1;
    } else {
      dimensions = variable.dimensions.length;
    }
    if (dimensions !== n - 1) throw new YurisError(0x1a20c);
    for (let k = 0; k < n - 1; k++)
      if (unsigned32(BigInt(variable.dimensions[k]!) - 1n) < unsigned32(this.indexes[k + 1]!))
        throw new YurisError(0x1a202);
    let index = 0n,
      multiplier = 1n;
    for (let k = dimensions - 1; k >= 0; k--) {
      index += multiplier * this.indexes[k + 1]!;
      multiplier *= BigInt(variable.dimensions[k]!);
    }
    return i64(index + (BigInt(target) << 32n));
  }

  /**
   * 0x42158E (int stacks) and 0x420FB2 (doubles): the value of variable `id` at `index`, or
   * with a prefix the reference `(id + indexHigh) << 32 | indexLow`. A variable without a
   * type pushes nothing; its stack position keeps its previous value.
   */
  private pushVariable(
    id: number,
    variable: YurisVariable,
    position: number,
    index: number | bigint,
  ): void {
    if (variable.type === YurisType.None) return;
    const floating = this.floating;
    if (this.prefix) {
      const value = id < SYSTEM_VARIABLE_LIMIT ? 0n : i64((BigInt(id) << 32n) + BigInt(index));
      if (floating) this.doubles[position] = Number(value);
      else this.ints[position] = value;
      this.slots[position] = 0;
      return;
    }
    if (id < SYSTEM_VARIABLE_LIMIT) {
      const low = typeof index === 'number' ? index >>> 0 : Number(BigInt.asUintN(32, index)),
        high =
          typeof index === 'number'
            ? Math.floor(index / 0x100000000) | 0
            : Number(BigInt.asIntN(32, index >> 32n));
      if (variable.type === YurisType.String) {
        this.ints[position] = 0n;
        this.slots[position] = this.allocate(this.system.string(id, low, high));
      } else if (variable.type === YurisType.Int) {
        const value = this.system.int(id, low, high);
        if (floating) this.doubles[position] = Number(value);
        else this.ints[position] = value;
        this.slots[position] = 0;
      } else {
        const value = this.system.float(id, low, high);
        if (floating) this.doubles[position] = value;
        else this.ints[position] = fistp(value);
        this.slots[position] = 0;
      }
      return;
    }
    const element = typeof index === 'number' ? index | 0 : lowSigned(index);
    switch (variable.type) {
      case YurisType.Int: {
        const value = variable.ints![element] ?? 0n;
        if (floating) this.doubles[position] = Number(value);
        else this.ints[position] = value;
        this.slots[position] = 0;
        break;
      }
      case YurisType.Float: {
        const value = variable.floats![element] ?? 0;
        if (floating) this.doubles[position] = value;
        else this.ints[position] = fistp(value);
        this.slots[position] = 0;
        break;
      }
      case YurisType.String:
        this.ints[position] = 0n;
        this.slots[position] = this.allocate(
          variable.has(element) ? variable.strings![element]! : '',
        );
        break;
    }
  }

  private push(value: bigint): boolean {
    const position = this.top++;
    if (this.floating) this.doubles[position] = Number(value);
    else this.ints[position] = value;
    this.slots[position] = 0;
    return true;
  }

  /** 'F' (0x422008): rounded by `FISTP` on the int stacks. */
  private pushDouble(value: number): boolean {
    const position = this.top++;
    if (this.floating) this.doubles[position] = value;
    else this.ints[position] = fistp(value);
    this.slots[position] = 0;
    return true;
  }

  /** 'R' (0x422090). */
  private negate(): boolean {
    const p = this.top - 1;
    if (this.floating) this.doubles[p] = -this.doubles[p]!;
    else this.ints[p] = i64(-this.ints[p]!);
    return true;
  }

  /** 's' (0x4220EC): `%f` or `_i64toa` of the top into a new string. */
  private toText(): boolean {
    const p = this.top - 1;
    const text = this.floating ? formatFloat(this.doubles[p]!) : formatInt(this.ints[p]!);
    this.ints[p] = 0n;
    this.slots[p] = this.allocate(text);
    return true;
  }

  /**
   * 'i' (0x42220C): a string to a number. `0x` takes up to 16 hex digits; otherwise every
   * byte must be a digit, '.' or '-' (error 0x1A6B2 at the first other byte or lead byte),
   * and the text goes through `strtod` when it has a '.', else `_atoi64`.
   */
  private toNumber(): boolean {
    const p = this.top - 1;
    const text = this.buffers[this.slots[p]!] ?? '';
    let int: bigint, double: number;
    if (text.charCodeAt(0) === 0x30 && text.charCodeAt(1) === 0x78) {
      const value = parseHex(text);
      if (value === null) return false;
      int = value;
      double = Number(int);
    } else {
      let dot = false,
        k = 0;
      for (; k < text.length; k++) {
        const c = text.charCodeAt(k);
        if (isLeadByte(c)) break;
        if (c === 0x2e) dot = true;
        else if ((c < 0x30 || c > 0x39) && c !== 0x2d) break;
      }
      if (k < text.length) throw new YurisError(0x1a6b2);
      if (dot) {
        double = strtod(text);
        int = fistp(double);
      } else {
        int = atoi64(text);
        double = Number(int);
      }
    }
    if (this.floating) this.doubles[p] = double;
    else this.ints[p] = int;
    this.slots[p] = 0;
    return true;
  }

  /** '+' (0x4225B0): numbers or string concatenation (skipped past 0x1000 bytes). */
  private add(): boolean {
    const r = --this.top,
      l = r - 1;
    if (this.slots[r] === 0) {
      if (this.slots[l] !== 0) throw new YurisError(0x2710a);
      if (this.floating) this.doubles[l] = this.doubles[l]! + this.doubles[r]!;
      else this.ints[l] = i64(this.ints[l]! + this.ints[r]!);
      return true;
    }
    const left = this.slots[l]!;
    if (left === 0) throw new YurisError(0x2710a);
    const a = this.buffers[left]!,
      b = this.buffers[this.slots[r]!]!;
    if (a.length + b.length < STRING_CAPACITY) this.buffers[left] = a + b;
    this.slots[r] = 0;
    return true;
  }

  /** '=' (0x422700) and '!' (0x422870): numbers, or `strcmp` with the result on the ints. */
  private equality(equal: boolean): boolean {
    const r = --this.top,
      l = r - 1;
    if (this.slots[r] === 0) {
      if (this.slots[l] !== 0) throw new YurisError(0x2710a);
      if (this.floating) this.doubles[l] = (this.doubles[l] === this.doubles[r]) === equal ? 1 : 0;
      else this.ints[l] = (this.ints[l] === this.ints[r]) === equal ? 1n : 0n;
      return true;
    }
    if (this.slots[l] === 0) throw new YurisError(0x2710a);
    const same = compareBytes(this.buffers[this.slots[l]!]!, this.buffers[this.slots[r]!]!) === 0;
    this.ints[l] = same === equal ? 1n : 0n;
    this.slots[l] = 0;
    this.slots[r] = 0;
    return true;
  }

  /** '<' '>' 'Z' (>=) 'S' (<=): numeric only, string slots are not consulted. */
  private compare(test: (a: number | bigint, b: number | bigint) => boolean): boolean {
    const r = --this.top,
      l = r - 1;
    if (this.floating) this.doubles[l] = test(this.doubles[l]!, this.doubles[r]!) ? 1 : 0;
    else this.ints[l] = test(this.ints[l]!, this.ints[r]!) ? 1n : 0n;
    return true;
  }

  private arithmetic(
    double: (a: number, b: number) => number,
    int: (a: bigint, b: bigint) => bigint,
  ): boolean {
    const r = --this.top,
      l = r - 1;
    if (this.floating) this.doubles[l] = double(this.doubles[l]!, this.doubles[r]!);
    else this.ints[l] = i64(int(this.ints[l]!, this.ints[r]!));
    return true;
  }

  /** '%' 'A' 'O' '^': int64 only; in a float mode the operand is dropped. */
  private integerOnly(int: (a: bigint, b: bigint) => bigint): boolean {
    const r = --this.top,
      l = r - 1;
    if (!this.floating) this.ints[l] = i64(int(this.ints[l]!, this.ints[r]!));
    return true;
  }

  /** '&' (0x422EE0) and '|' (0x422F8C): 1 or 0. */
  private logical(test: (a: boolean, b: boolean) => boolean): boolean {
    const r = --this.top,
      l = r - 1;
    if (this.floating) this.doubles[l] = test(this.doubles[l] !== 0, this.doubles[r] !== 0) ? 1 : 0;
    else this.ints[l] = test(this.ints[l] !== 0n, this.ints[r] !== 0n) ? 1n : 0n;
    return true;
  }
}

function signed(value: number, bits: number): number {
  const shift = 32 - bits;
  return (value << shift) >> shift;
}

function unsigned32(value: bigint): bigint {
  return value & 0xffffffffn;
}

/** The low half as the signed 32-bit element index the accessors bound-check. */
function lowSigned(value: bigint): number {
  return Number(BigInt.asIntN(32, value));
}

const views = new WeakMap<Uint8Array, DataView>();
function view(bytes: Uint8Array): DataView {
  let v = views.get(bytes);
  if (!v) views.set(bytes, (v = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength)));
  return v;
}
