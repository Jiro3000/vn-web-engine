import {decodeCp932} from '../../../text/cp932.js';
import {
  recordRasterText,
  type RasterTextBitmap,
  type RasterTextStorage,
} from '../../../text/raster-text.js';
import type {YurisMachine} from './machine.js';

const storage = new WeakMap<Uint8Array, RasterTextStorage>();
const gbk = new TextDecoder('gbk');
const bytes = (raw: string) => Uint8Array.from(raw, (byte) => byte.charCodeAt(0));

function rasterStorage(bytes: Uint8Array): RasterTextStorage {
  let value = storage.get(bytes);
  if (!value) {
    value = {
      bytes,
      cloneRange: (offset, length) => rasterStorage(bytes.slice(offset, offset + length)),
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

const atlasMerge = new WeakMap<
  YurisMachine,
  {script: number; position: number; returnPosition: number} | null
>();
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
  let location = atlasMerge.get(m);
  if (location === undefined) {
    const label = (name: string) =>
      m.project.labels.labels[m.label(new TextEncoder().encode(name))];
    const glyph = label('es.ZENKAKU.DRAW.ONE');
    const draw = label('es.SJISCODE.DRAW.ONE');
    const next = label('es.NOtoSJISCODE.GET');
    location =
      glyph &&
      draw &&
      next &&
      glyph.script === draw.script &&
      draw.script === next.script &&
      draw.position - glyph.position === 42 &&
      next.position - draw.position === 65
        ? {script: draw.script, position: next.position - 2, returnPosition: glyph.position + 29}
        : null;
    atlasMerge.set(m, location);
  }
  if (!location || m.task.script !== location.script || m.position !== location.position) return;
  const caller = m.task.frames[m.task.gosubDepth - 1];
  if (caller?.returnScript !== location.script || caller.returnPosition !== location.returnPosition)
    return;
  const int = (id: number) => Number(m.variables.get(id).ints?.[0] ?? 0n);
  const pass = int(2863);
  if (pass !== 2) {
    recordRasterText(bitmap, '', {decorative: true});
    return;
  }
  const raw = m.variables.get(2847).strings?.[0] ?? '';
  // es.ZENKAKU.LOAD names the atlas family in V$2825. The Sarasa SC
  // atlases index GBK bytes through the same arithmetic as the CP932 ones.
  const atlas = gbk.decode(bytes(m.variables.get(2825).strings?.[int(2826)] ?? ''));
  const chinese = atlas.startsWith('更纱黑体');
  const text = chinese ? gbk.decode(bytes(raw)) : decodeCp932(bytes(raw));
  const size = int(2869);
  if (!text || size <= 0) return;
  recordRasterText(bitmap, text, {
    size,
    width: raw.length === 1 ? size / 2 : size,
    height: size,
    family: chinese ? '"Sarasa Gothic SC", "Noto Sans CJK SC", sans-serif' : 'serif',
    bold: chinese && atlas.includes('_太'),
    color: int(2867) & 0xffffff,
  });
}
