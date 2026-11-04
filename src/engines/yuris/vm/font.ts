import type {YurisMachine} from './machine.js';
import {type ByteString} from './numbers.js';
import {applyBounded} from './operators.js';
import {YurisError} from './errors.js';
import {charLength} from './sjis.js';

/** FONT and FONTINFO command ids. */
const FONT = 0x1a,
  FONTINFO = 0x1b;

/** Text buffers (0x5B8664 ranges over 0..7). */
export const TEXT_BUFFERS = 8;

/** One EnumFontFamiliesExA callback (0x4038FC): the ENUMLOGFONTEXA fields the engine keeps. */
export interface YurisFontFamily {
  /** elfLogFont.lfFaceName. */
  readonly name: ByteString;
  /** elfLogFont.lfPitchAndFamily. */
  readonly pitchAndFamily: number;
  /** elfScript. */
  readonly script: ByteString;
}

/**
 * A glyph drawn by 0x442390/0x4426E1: CreateFontIndirectA of a LOGFONTA with `height`,
 * width, escapement and orientation 0, `weight`, no italic, underline or strike-out,
 * DEFAULT_CHARSET, default precisions and quality and face `face`; selected into a memory DC
 * with a white `cell` x `cell` 1-bit top-down DIB section (palette black, white), transparent
 * background and black text; TextOutA of `text` at (0, 0).
 */
export interface YurisGlyphRequest {
  readonly face: ByteString;
  readonly height: number;
  readonly weight: number;
  readonly cell: number;
  readonly text: ByteString;
}

export interface YurisFontHost {
  /** The families EnumFontFamiliesExA(DEFAULT_CHARSET, any face) reports, in callback order. */
  fontFamilies(): readonly YurisFontFamily[];
  /**
   * The DIB bits after the TextOutA of `request`: `cell / 8` bytes per row, most significant
   * bit first, 1 for the white background and 0 for ink.
   */
  textOut(request: YurisGlyphRequest): Uint8Array;
}

/**
 * Face names the start-up selection 0x403AF8 tries for every text buffer, in order (the
 * string constants at 0x878008, 0x878018, 0x878028, 0x878038 and 0x878044 of the executable
 * with SHA-256 feb81d5e…a043).
 */
export const DEFAULT_FACES: readonly ByteString[] = [
  'SimHei',
  'SimHei',
  'SimHei',
  'SimHei',
  'SimHei',
];

/** 0x7D6560 (filled by 0x46B7EC): the glyph cell for font size `size`, a multiple of 32. */
export function glyphCell(size: number): number {
  return ((32 + 4 * size) & ~31) + 32;
}

/** The font settings FONTINFO reports (0x8725A4, initialised by 0x465C84). */
export interface YurisFontSettings {
  /** +0, +4. */
  sx: number;
  sy: number;
  /** +8, +0xC. */
  color: number;
  color2: number;
  /** +0x10, +0x11, +0x12, +0x13, +0x14 (signed bytes). */
  gradation: number;
  rotation: number;
  bold: number;
  drawMode: number;
  antialiasing: number;
}

/**
 * The font list 0x5B8634 with its pitch (0x5B8640) and language (0x5B863C) flags, the face
 * selected for each text buffer (0x5B8644) and the per-buffer text settings FONT sets
 * (0x5B8668..0x5B8720, initialised by 0x46B7EC). Text buffer 0 also writes the shared
 * settings FONTINFO reads.
 */
export class YurisFonts {
  readonly names: ByteString[] = [];
  /** 0x5B8640: 1 proportional (variable or default pitch), 0 fixed pitch, -1 otherwise. */
  readonly pitch: number[] = [];
  /** 0x5B863C: 0 for a CHINESE_GB2312 script, 1 otherwise. */
  readonly lang: number[] = [];
  readonly selected = new Int32Array(TEXT_BUFFERS);
  readonly sx = new Int32Array(TEXT_BUFFERS).fill(0x14);
  readonly sy = new Int32Array(TEXT_BUFFERS).fill(0x14);
  readonly bold = new Int32Array(TEXT_BUFFERS);
  readonly color = new Int32Array(TEXT_BUFFERS).fill(0xffffff);
  readonly color2 = new Int32Array(TEXT_BUFFERS).fill(0xffffff);
  readonly gradation = new Int8Array(TEXT_BUFFERS).fill(1);
  readonly rotation = new Int8Array(TEXT_BUFFERS);
  readonly antialiasing = new Int8Array(TEXT_BUFFERS).fill(1);
  readonly drawMode = new Int8Array(TEXT_BUFFERS);
  readonly settings: YurisFontSettings = {
    sx: 20,
    sy: 20,
    color: 0xffffff,
    color2: -1,
    gradation: 1,
    rotation: 0,
    bold: 0,
    drawMode: 0,
    antialiasing: 1,
  };

  constructor(
    private readonly host: YurisFontHost,
    faces: readonly ByteString[] = DEFAULT_FACES,
  ) {
    // 0x403AF8, callback 0x4038FC.
    for (const family of host.fontFamilies()) {
      this.names.push(family.name);
      this.lang.push(family.script === 'CHINESE_GB2312' ? 0 : 1);
      const pitch = family.pitchAndFamily & 3;
      this.pitch.push(pitch === 0 || pitch === 2 ? 1 : pitch === 1 ? 0 : -1);
    }
    // Every face is tried (only the first result is tested); the last one found wins, and a
    // buffer keeps face 0 when none is installed.
    for (let buffer = 0; buffer < TEXT_BUFFERS; buffer++)
      for (const face of faces) this.selectName(buffer, face);
  }

  get count(): number {
    return this.names.length;
  }

  /** 0x4039E0: selects face `index`; ignored past the list. */
  select(buffer: number, index: number): void {
    if (index < this.count) this.selected[buffer] = index;
  }

  /** 0x403A6C: selects the face named `name` exactly; false when absent. */
  selectName(buffer: number, name: ByteString): boolean {
    const index = this.names.indexOf(name);
    if (index < 0) return false;
    this.selected[buffer] = index;
    return true;
  }

  /** 0x403A04: the face of `buffer`. */
  face(buffer: number): ByteString {
    return this.names[this.selected[buffer]!] ?? '';
  }

  /**
   * 0x442390: the extent of the first character of `text` in font size `sx` x `sy` of
   * `buffer`'s face. Proportional faces are drawn into the glyph cell (four times the size
   * when anti-aliased) and measured from the ink's right-most column and top-most row, a
   * quarter of each plus 4, bounded by the size; fixed-pitch faces are a full (double-byte)
   * or half (single-byte) `sx` wide and `sy` high.
   */
  measure(
    buffer: number,
    text: ByteString,
    sx: number,
    sy: number,
    bold: number,
    antialiasing: number,
  ): [number, number] {
    const cell = glyphCell(sx);
    const length = charLength(text.charCodeAt(0) & 0xff);
    const first = text.slice(0, length).padEnd(length, '\0');
    const bits = this.host.textOut({
      face: this.face(buffer),
      height: antialiasing === 1 ? sx * 4 : sx,
      weight: bold ? 700 : 400,
      cell,
      text: first,
    });
    const pitch = this.pitch[this.selected[buffer]!] ?? 0;
    if (pitch === 0) return [Math.trunc(sx / (3 - length)), sy];
    let right = 0,
      top = 0;
    if (pitch === 1) {
      const stride = cell >> 3;
      for (let y = 0; y < cell; y++)
        for (let x = 0; x < cell; x++) {
          if ((bits[stride * y + (x >> 3)]! & (0x80 >> (x & 7))) !== 0) continue;
          if (right < x) right = x;
          if (top === 0) top = cell - y;
        }
    }
    const width = (right >> 2) + 4,
      height = (top >> 2) + 4;
    return [width <= sx ? width : sx, height <= sy ? height : sy];
  }
}

const enum FontArg {
  Bno,
  No,
  Name,
  Antialiasing,
  Color,
  Color2,
  Gradation,
  Rotation,
  DrawMode,
  Sx,
  Sy,
  Bold,
}

const enum InfoArg {
  No,
  Name,
  Antialiasing,
  Color,
  Color2,
  Gradation,
  Rotation,
  DrawMode,
  Sx,
  Sy,
  Bold,
  Num,
  Pitch,
  Lang,
  X,
  Y,
  Set,
  SetStr,
  Let,
}

type IntField = 'sx' | 'sy' | 'color' | 'color2' | 'bold';
type ByteField = 'gradation' | 'rotation' | 'drawMode';

/** FONT arguments that modify a setting: the setting, its maximum and its shared width. */
const MODIFIED: readonly [FontArg, IntField | ByteField, bigint, 32 | 8][] = [
  [FontArg.Color, 'color', 0xffffffn, 32],
  [FontArg.Color2, 'color2', 0xffffffn, 32],
  [FontArg.Gradation, 'gradation', 8n, 8],
  [FontArg.Rotation, 'rotation', 8n, 8],
  [FontArg.DrawMode, 'drawMode', 1n, 8],
  [FontArg.Sx, 'sx', 0x100n, 32],
  [FontArg.Sy, 'sy', 0x100n, 32],
  [FontArg.Bold, 'bold', 1n, 8],
];

export function installFonts(m: YurisMachine, fonts: YurisFonts): void {
  m.define(FONT, () => font(m, fonts));
  m.define(FONTINFO, () => fontInfo(m, fonts));
}

/**
 * FONT 0x4416FC: BNO picks the text buffer the command changes (back to 0 afterwards), NO the
 * face by number (the index NO itself is selected, so the last face is out of reach) and NAME
 * by name. The other arguments apply their assignment operator to the shared setting and
 * store the result, bounded by 0 and the setting's maximum, for the buffer and, for buffer
 * 0, the shared setting.
 */
function font(m: YurisMachine, fonts: YurisFonts): number {
  const a = m.args;
  m.decode();
  const layers = m.layers;
  if (a.has(FontArg.Bno)) layers.textBuffer = Number(BigInt.asIntN(32, a.int(FontArg.Bno)));
  if (a.has(FontArg.No)) {
    const no = Number(BigInt.asIntN(32, a.int(FontArg.No)));
    const name = m.commandName(FONT),
      arg = m.argName(FontArg.No);
    if (no < 1) throw new YurisError(0x18a92, [name, arg, no, 1]);
    if (fonts.count < no) throw new YurisError(0x18b78, [name, arg, no, fonts.count]);
    fonts.select(layers.textBuffer, no);
  }
  if (a.has(FontArg.Name)) fonts.selectName(layers.textBuffer, a.text(FontArg.Name));
  const buffer = layers.textBuffer,
    shared = fonts.settings;
  if (a.has(FontArg.Antialiasing)) {
    const value = Number(BigInt.asIntN(8, a.int(FontArg.Antialiasing)));
    fonts.antialiasing[buffer] = value;
    if (buffer === 0) shared.antialiasing = value;
  }
  for (const [arg, field, max, bits] of MODIFIED) {
    const slot = a.has(arg);
    if (!slot) continue;
    const result = applyBounded(a.op[slot]!, BigInt(shared[field]), a.value[slot]!, 0n, max);
    // The buffer arrays keep the low 32 bits (the byte arrays their low byte); the shared
    // field is a byte for BOLD, GRADATION, ROTATION and DRAWMODE.
    fonts[field][buffer] = Number(BigInt.asIntN(32, result));
    if (buffer === 0) shared[field] = Number(BigInt.asIntN(bits, result));
  }
  layers.textBuffer = 0;
  return 0;
}

/**
 * FONTINFO 0x441FCC: stores one value into LET, the first present of the shared settings
 * ANTIALIASING .. BOLD, NUM = 1 (the face count), PITCH (always 0), X or Y (the measured
 * extent of SETSTR's first character), NAME = 1 or LANG = 1 of face NO (1-based, default the
 * text buffer's face); 0 otherwise.
 */
function fontInfo(m: YurisMachine, fonts: YurisFonts): number {
  const a = m.args;
  m.decode();
  const target = a.has(InfoArg.Let),
    id = a.variable[target]!,
    index = a.variableIndex[target]!;
  const s = fonts.settings,
    buffer = m.layers.textBuffer;
  const put = (value: number) => (m.setInt(id, index, BigInt(value)), 0);
  const isOne = (arg: InfoArg) => a.has(arg) !== 0 && a.int(arg) === 1n;
  if (a.has(InfoArg.Antialiasing)) return put(s.antialiasing);
  if (a.has(InfoArg.Color)) return put(s.color);
  if (a.has(InfoArg.Color2)) return put(s.color2);
  if (a.has(InfoArg.Gradation)) return put(s.gradation);
  if (a.has(InfoArg.Rotation)) return put(s.rotation);
  if (a.has(InfoArg.DrawMode)) return put(s.drawMode);
  if (a.has(InfoArg.Sx)) return put(s.sx);
  if (a.has(InfoArg.Sy)) return put(s.sy);
  if (a.has(InfoArg.Bold)) return put(s.bold);
  if (isOne(InfoArg.Num)) return put(fonts.count);
  if (a.has(InfoArg.Pitch)) return put(0);
  if (a.has(InfoArg.X) || a.has(InfoArg.Y)) {
    // Without SETSTR the native call reads its text through a null pointer.
    if (!a.has(InfoArg.SetStr))
      throw new Error('FONTINFO X/Y without SETSTR: the native engine faults');
    const [width, height] = fonts.measure(
      buffer,
      a.text(InfoArg.SetStr),
      s.sx,
      s.sy,
      s.bold,
      s.antialiasing,
    );
    return put(a.has(InfoArg.X) ? width : height);
  }
  const name = isOne(InfoArg.Name),
    lang = !name && isOne(InfoArg.Lang);
  if (!name && !lang) return put(0);
  const no = a.has(InfoArg.No)
    ? Number(BigInt.asIntN(32, a.int(InfoArg.No)))
    : fonts.selected[buffer]! + 1;
  const command = m.commandName(FONTINFO),
    arg = m.argName(InfoArg.No);
  if (no < 1) throw new YurisError(0x18a92, [command, arg, no, 1]);
  if (fonts.count < no) throw new YurisError(0x18b78, [command, arg, no, fonts.count]);
  if (lang) return put(fonts.lang[no - 1]!);
  // 0x45BDE4 stores the name; a missing entry stores 0.
  m.setString(id, index, fonts.names[no - 1]!);
  return 0;
}
