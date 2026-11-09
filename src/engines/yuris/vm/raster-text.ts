import {decodeCp932} from '../../../text/cp932.js';
import {cloneBgraTarget} from '../../../graphics/bgra-effects-wasm.js';
import {
  recordRasterText,
  type RasterTextBitmap,
  type RasterTextStorage,
} from '../../../text/raster-text.js';
import type {YurisInstruction, YurisToken} from '../../../formats/yuris/ybn.js';
import {decodeLiteral} from './expression.js';
import type {YurisMachine} from './machine.js';

export const YURIS_SC_ATLAS_FAMILY = '"Sarasa Gothic SC", "Noto Sans CJK SC", sans-serif';
export const YURIS_JP_ATLAS_FAMILY =
  '"Source Han Sans JP", "Noto Sans CJK JP", "Hiragino Sans", "Yu Gothic", sans-serif';

const storage = new WeakMap<Uint8Array, RasterTextStorage>();
const gbk = new TextDecoder('gbk');
const bytes = (raw: string) => Uint8Array.from(raw, (byte) => byte.charCodeAt(0));

function rasterStorage(bytes: Uint8Array): RasterTextStorage {
  let value = storage.get(bytes);
  if (!value) {
    value = {
      bytes,
      cloneRange: (offset, length) => rasterStorage(cloneBgraTarget(bytes, offset, length)),
    };
    storage.set(bytes, value);
  }
  return value;
}

/** A view of the same BGRA allocation, including a crop used by CGACT. */
export function yurisRasterBitmap(
  bytes: Uint8Array,
  stride: number,
  height: number,
  x = 0,
  y = 0,
  width = stride,
): RasterTextBitmap {
  return {
    storage: rasterStorage(bytes),
    offset: (y * stride + x) * 4,
    stride: stride * 4,
    bytesPerPixel: 4,
    width,
    height,
  };
}

interface AtlasLibrary {
  /** The final CGACT MERGE of es.SJISCODE.DRAW.ONE into the caller's layer. */
  readonly script: number;
  readonly position: number;
  /** The instruction after es.ZENKAKU.DRAW.ONE's GOSUB es.SJISCODE.DRAW.ONE. */
  readonly returnScript: number;
  readonly returnPosition: number;
  /** es.ZENKAKU.DRAW.ONE's variables passed as PINT5 (pass), PINT6 (cell size), PINT9 (colour). */
  readonly pass: number;
  readonly size: number;
  readonly color: number;
  /** The character read by VARINFO SJISCODE. */
  readonly raw: number;
  /** The atlas index in the "CGFTX." layer name and the atlas name array of es.ZENKAKU.LOAD. */
  readonly atlasIndex: number;
  readonly atlasNames: number;
  /** es.TX.OUTPUT.ONE's GOSUB es.BT.FONT.CG.DRAW.SET and its text settings array. */
  readonly dialogue: {script: number; returnPosition: number; settings: number} | null;
}

const H = 0x48,
  V = 0x56,
  M = 0x4d,
  INT = 0x40,
  STR = 0x24;
const variable = (token: YurisToken | undefined, kind: number, type: number) =>
  token?.op === kind && token.payload[0] === type && token.payload.length >= 3
    ? token.payload[1]! | (token.payload[2]! << 8)
    : -1;
const literal = (token: YurisToken | undefined) =>
  token?.op === M ? decodeLiteral(token.payload, 0, token.payload.length) : null;
const integer = (token: YurisToken | undefined) => {
  if (!token) return null;
  const view = new DataView(token.payload.buffer, token.payload.byteOffset, token.payload.length);
  if (token.op === 0x42 && token.payload.length >= 1) return view.getInt8(0);
  if (token.op === 0x57 && token.payload.length >= 2) return view.getInt16(0, true);
  if (token.op === 0x49 && token.payload.length >= 4) return view.getInt32(0, true);
  return null;
};

/** The authored routines of the atlas library, read from their YBN code instead of fixed
 * offsets: es.ZENKAKU.LOAD, es.ZENKAKU.DRAW.ONE, es.SJISCODE.DRAW.ONE and es.TX.OUTPUT.ONE
 * differ in variable numbering and length between library revisions. */
export function analyzeAtlasLibrary(m: YurisMachine): AtlasLibrary | null {
  const label = (name: string) => m.project.labels.labels[m.label(new TextEncoder().encode(name))];
  const routine = (name: string) => {
    const at = label(name),
      code = at && m.scriptInstructions(at.script);
    if (!at || !code) return null;
    let end = at.position;
    while (end < code.length && m.commandName(code[end]!.command) !== 'RETURN') end++;
    return end < code.length ? {script: at.script, start: at.position, end, code} : null;
  };
  const argument = (instruction: YurisInstruction, name: string) =>
    instruction.args.find(
      (arg) => m.project.commands.commands[instruction.command]?.args[arg.id]?.name === name,
    );
  const gosub = (
    body: NonNullable<ReturnType<typeof routine>>,
    target: string,
  ): [number, YurisInstruction] | null => {
    for (let i = body.start; i < body.end; i++) {
      const instruction = body.code[i]!;
      if (
        m.commandName(instruction.command) === 'GOSUB' &&
        literal(instruction.args[0]?.tokens?.[0]) === target
      )
        return [i, instruction];
    }
    return null;
  };
  const single = (instruction: YurisInstruction, name: string, type: number) => {
    const tokens = argument(instruction, name)?.tokens;
    return tokens?.length === 1 ? variable(tokens[0], H, type) : -1;
  };

  const glyph = routine('es.ZENKAKU.DRAW.ONE'),
    draw = routine('es.SJISCODE.DRAW.ONE'),
    load = routine('es.ZENKAKU.LOAD');
  if (!glyph || !draw || !load) return null;
  const call = gosub(glyph, 'es.SJISCODE.DRAW.ONE');
  if (!call) return null;
  const pass = single(call[1], 'PINT5', INT),
    size = single(call[1], 'PINT6', INT),
    color = single(call[1], 'PINT9', INT);
  let raw = -1;
  for (let i = glyph.start; i < glyph.end && raw < 0; i++) {
    const instruction = glyph.code[i]!;
    if (m.commandName(instruction.command) === 'VARINFO' && argument(instruction, 'SJISCODE'))
      raw = single(instruction, 'SET', STR);
  }
  const merge = draw.code[draw.end - 1]!;
  if (m.commandName(merge.command) !== 'CGACT' || !argument(merge, 'MERGE')) return null;
  let atlasIndex = -1;
  for (let i = draw.start; i < draw.end && atlasIndex < 0; i++) {
    const tokens = draw.code[i]!.args[1]?.tokens ?? [];
    for (let t = 0; t + 1 < tokens.length && atlasIndex < 0; t++)
      if (literal(tokens[t]) === 'CGFTX.') atlasIndex = variable(tokens[t + 1], H, INT);
  }
  let atlasNames = -1;
  for (let i = load.start; i < load.end && atlasNames < 0; i++) {
    const instruction = load.code[i]!;
    if (m.commandName(instruction.command) !== 'LET') continue;
    const [target, value] = instruction.args;
    if (value?.tokens?.length === 1 && literal(value.tokens[0]) !== null)
      atlasNames = variable(target?.tokens?.[0], V, STR);
  }
  if ([pass, size, color, raw, atlasIndex, atlasNames].some((id) => id < 0)) return null;

  let dialogue: AtlasLibrary['dialogue'] = null;
  const output = routine('es.TX.OUTPUT.ONE');
  const button = output && gosub(output, 'es.BT.FONT.CG.DRAW.SET');
  if (output && button) {
    // The layout settings row: V@n[36, k] (es.FONT.COLOR.SET reads V@n[36,16]).
    let settings = -1;
    for (let i = output.start; i < output.end && settings < 0; i++)
      for (const {tokens} of output.code[i]!.args)
        for (let t = 0; tokens && t + 2 < tokens.length && settings < 0; t++)
          if (integer(tokens[t + 1]) === 36 && tokens[t + 2]!.op === 0x2c)
            settings = variable(tokens[t], V, INT);
    if (settings >= 0) dialogue = {script: output.script, returnPosition: button[0] + 1, settings};
  }
  return {
    script: draw.script,
    position: draw.end - 1,
    returnScript: glyph.script,
    returnPosition: call[0] + 1,
    pass,
    size,
    color,
    raw,
    atlasIndex,
    atlasNames,
    dialogue,
  };
}

/** Sarasa SC atlas names are GBK and index GBK glyphs. */
export function gbkAtlasDecoder(name: string): TextDecoder | undefined {
  return gbk.decode(bytes(name)).startsWith('更纱黑体') ? gbk : undefined;
}

/** A browser face for the atlas family named by es.ZENKAKU.LOAD. */
function atlasFace(name: string): {chinese: boolean; family: string; bold: boolean} {
  const decoder = gbkAtlasDecoder(name);
  const chinese = decoder !== undefined;
  const decoded = decoder ? decoder.decode(bytes(name)) : decodeCp932(bytes(name));
  const gothic = chinese || /ゴシック|ｺﾞｼｯｸ|gothic|sans/i.test(decoded);
  return {
    chinese,
    family: chinese ? YURIS_SC_ATLAS_FAMILY : gothic ? YURIS_JP_ATLAS_FAMILY : 'serif',
    bold: gothic && decoded.includes('_太'),
  };
}

const atlasLibrary = new WeakMap<YurisMachine, AtlasLibrary | null>();
/** Presentation provenance for the standard atlas library's final CGACT MERGE.
 * The VM still performs 0x439A30 with the original pixels. The authored YBN
 * routines es.ZENKAKU.DRAW.ONE and es.SJISCODE.DRAW.ONE supply the glyph and
 * its decorative passes independently of the installation's script index.
 */
export function recordAtlasGlyph(
  m: YurisMachine,
  sourceName: string,
  bitmap: RasterTextBitmap,
): void {
  if (!m.tracksRasterText || sourceName !== 'TX.TMP') return;
  let library = atlasLibrary.get(m);
  if (library === undefined) {
    library = analyzeAtlasLibrary(m);
    atlasLibrary.set(m, library);
  }
  if (!library || m.task.script !== library.script || m.position !== library.position) return;
  const caller = m.task.frames[m.task.gosubDepth - 1];
  if (
    caller?.returnScript !== library.returnScript ||
    caller.returnPosition !== library.returnPosition
  )
    return;
  const int = (id: number) => Number(m.variables.get(id).ints?.[0] ?? 0n);
  if (int(library.pass) !== 2) {
    recordRasterText(bitmap, '', {decorative: true});
    return;
  }
  const raw = m.variables.get(library.raw).strings?.[0] ?? '';
  const face = atlasFace(
    m.variables.get(library.atlasNames).strings?.[int(library.atlasIndex)] ?? '',
  );
  const text = face.chinese ? gbk.decode(bytes(raw)) : decodeCp932(bytes(raw));
  // es.ZENKAKU.DRAW.ONE replaces a zero size by 8 before the call.
  const size = int(library.size) || 8;
  if (!text) return;
  // es.TX.OUTPUT.ONE draws one glyph per button blit. The dialogue layout advances
  // a full-width cell by its size plus the spacing in settings[36,19].
  const dialogue = library.dialogue,
    parent = m.task.frames[m.task.gosubDepth - 3];
  let pitch = 0;
  if (
    dialogue &&
    parent?.returnScript === dialogue.script &&
    parent.returnPosition === dialogue.returnPosition
  ) {
    const settings = m.variables.get(dialogue.settings);
    pitch = size + Number(settings.ints?.[36 * (settings.dimensions[1] ?? 0) + 19] ?? 0n);
  }
  recordRasterText(bitmap, text, {
    size,
    ...(pitch > 0 ? {pitch} : {}),
    width: raw.length === 1 ? size / 2 : size,
    height: size,
    family: face.family,
    bold: face.bold,
    color: int(library.color) & 0xffffff,
  });
}
