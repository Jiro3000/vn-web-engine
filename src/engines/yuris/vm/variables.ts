import type {YurisVariableDeclaration} from '../../../formats/yuris/ybn.js';
import {YurisError} from './errors.js';
import type {ByteString} from './numbers.js';

/** Variable value types (struct byte +1). 0: declared without a value. */
export const enum YurisType {
  None = 0,
  Int = 1,
  Float = 2,
  String = 3,
}

/** Ids below this are system variables whose values the engine computes. */
export const SYSTEM_VARIABLE_LIMIT = 1000;

/** Element count limit of 0x454EA4. */
const MAX_ELEMENTS = 4_000_000;

/**
 * A variable record (0x40 bytes allocated per id by 0x463C60): flags (+0), type (+1), the
 * dimension count (+2) and sizes (+4), the element count (+0x28) and one element array per
 * type (+0x30 int64, +0x34 double, +0x38 string pointers). Re-typing replaces only the array of
 * the new type, as the allocators do.
 */
export class YurisVariable {
  flags = 0;
  type: YurisType = YurisType.None;
  dimensions: number[] = [];
  count = 0;
  ints: BigInt64Array | null = null;
  floats: Float64Array | null = null;
  strings: ByteString[] | null = null;

  /** Whether `index` addresses an element (the 64-bit bound check every accessor repeats). */
  has(index: number): boolean {
    return index >= 0 && index < this.count;
  }
}

export class YurisVariables {
  readonly entries: YurisVariable[];

  /** `count` is the YSTD variable count; ids 0..count exist (0x463C60 allocates count + 1). */
  constructor(count: number) {
    this.entries = Array.from({length: count + 1}, () => new YurisVariable());
  }

  get(id: number): YurisVariable {
    const variable = this.entries[id];
    if (!variable) throw new YurisError(0xdbbe6);
    return variable;
  }

  /** 0x454EA4: the element count from the dimensions, 1 without dimensions. */
  private size(variable: YurisVariable): void {
    let count = 1;
    for (const dimension of variable.dimensions) count *= dimension;
    if (count > MAX_ELEMENTS) throw new YurisError(0x18aec, [MAX_ELEMENTS]);
    if (count <= 0) throw new YurisError(0x18af6);
    variable.count = count;
  }

  /** 0x46A558: re-types as int64 and fills every element. */
  allocateInt(id: number, value: bigint): void {
    const variable = this.get(id);
    if (
      variable.type === YurisType.Int &&
      variable.dimensions.length === 0 &&
      variable.ints?.length === 1
    ) {
      variable.count = 1;
      variable.ints[0] = value;
      return;
    }
    variable.type = YurisType.Int;
    this.size(variable);
    variable.ints = new BigInt64Array(variable.count).fill(value);
  }

  /** 0x46A478: re-types as double and fills every element. */
  allocateFloat(id: number, value: number): void {
    const variable = this.get(id);
    if (
      variable.type === YurisType.Float &&
      variable.dimensions.length === 0 &&
      variable.floats?.length === 1
    ) {
      variable.count = 1;
      variable.floats[0] = value;
      return;
    }
    variable.type = YurisType.Float;
    this.size(variable);
    variable.floats = new Float64Array(variable.count).fill(value);
  }

  /** 0x46A2CC: re-types as string and fills every element. */
  allocateString(id: number, value: ByteString): void {
    const variable = this.get(id);
    if (
      variable.type === YurisType.String &&
      variable.dimensions.length === 0 &&
      variable.strings?.length === 1
    ) {
      variable.count = 1;
      variable.strings[0] = value;
      return;
    }
    variable.type = YurisType.String;
    this.size(variable);
    variable.strings = new Array<ByteString>(variable.count).fill(value);
  }

  /**
   * 0x454AD4 (VARACT DIMSIZE): resizes a one-dimensional variable, keeping the common
   * elements and filling new ones with 0, 0.0 or ''.
   */
  resize(id: number, size: number): void {
    const variable = this.get(id);
    const keep = Math.min(size, variable.dimensions[0] ?? 0);
    if (variable.type === YurisType.Int) {
      const ints = new BigInt64Array(size);
      ints.set(variable.ints!.subarray(0, keep));
      variable.ints = ints;
    } else if (variable.type === YurisType.Float) {
      const floats = new Float64Array(size);
      floats.set(variable.floats!.subarray(0, keep));
      variable.floats = floats;
    } else if (variable.type === YurisType.String) {
      const strings = new Array<ByteString>(size).fill('');
      for (let i = 0; i < keep; i++) strings[i] = variable.strings![i]!;
      variable.strings = strings;
    } else return;
    variable.dimensions[0] = size;
    this.size(variable);
  }

  /**
   * 0x45170C: initializes the declarations of one scope from YSVR. `script` -1 selects the
   * global scopes 1 and 3; a script index selects the scope-2 declarations of that script,
   * which 0x4511C1 initializes when the script is first loaded.
   */
  initialize(
    declarations: readonly YurisVariableDeclaration[],
    script: number,
    stringValue: (expression: Uint8Array) => ByteString,
  ): void {
    for (const declaration of declarations) {
      const selected =
        script === -1
          ? declaration.scope === 1 || declaration.scope === 3
          : declaration.script === script && declaration.scope === 2;
      if (declaration.id >= this.entries.length) throw new YurisError(0xdbbe6);
      if (selected) this.initializeOne(declaration, stringValue);
    }
  }

  /**
   * VARACT INIT (0x454F74 with -1): re-initialises the global scope-1 declarations whose
   * category (the YSVR flags byte, 1..4) is selected in the mask of their type: bit
   * `category - 1` of `ints`, `floats` or `strings` (VARACT G_INT..G_INT4, G_FLT.., G_STR..).
   */
  reset(
    declarations: readonly YurisVariableDeclaration[],
    ints: number,
    floats: number,
    strings: number,
    stringValue: (expression: Uint8Array) => ByteString,
  ): void {
    for (const declaration of declarations) {
      if (declaration.id >= this.entries.length) throw new YurisError(0xdbbe6);
      const type = declaration.type as number;
      const mask =
        type === YurisType.Int
          ? ints
          : type === YurisType.Float
            ? floats
            : type === YurisType.String
              ? strings
              : 0;
      const category = declaration.flags;
      if (declaration.scope !== 1 || category < 1 || category > 4) continue;
      if (mask & (1 << (category - 1))) this.initializeOne(declaration, stringValue);
    }
  }

  private initializeOne(
    declaration: YurisVariableDeclaration,
    stringValue: (expression: Uint8Array) => ByteString,
  ): void {
    const variable = this.get(declaration.id);
    variable.flags = declaration.flags;
    variable.type = declaration.type as YurisType;
    variable.dimensions = [...declaration.dimensions];
    switch (declaration.type as number) {
      case YurisType.Int:
        this.allocateInt(declaration.id, declaration.value as bigint);
        break;
      case YurisType.Float:
        this.allocateFloat(declaration.id, declaration.value as number);
        break;
      case YurisType.String:
        this.allocateString(declaration.id, stringValue(declaration.value as Uint8Array));
        break;
    }
  }
}
