import type {YurisCgNode, YurisLayers} from './cg.js';
import type {YurisFonts, YurisGlyph} from './font.js';
import {charLength} from './sjis.js';

/** 0x42ADF6's gradient permutation for each glyph rotation. */
const GRADIENTS = [
  [0, 1, 2, 3, 4, 5, 6, 7, 8],
  [0, 3, 4, 2, 1, 8, 5, 6, 7],
  [0, 2, 1, 4, 3, 7, 8, 5, 6],
  [0, 4, 3, 1, 2, 6, 7, 8, 5],
];

/** 0x42ADF6: TL, BL, TR, BR in BGR order, with midpoint truncation before interpolation. */
function corners(first: number, second: number, gradation: number, rotation: number): number[][] {
  if (second === -1) second = first;
  const color = (value: number) => [value & 255, (value >>> 8) & 255, (value >>> 16) & 255];
  const a = color(first),
    b = color(second),
    mid = a.map((value, i) => value + Math.trunc((b[i]! - value) / 2));
  switch (GRADIENTS[rotation]?.[gradation] ?? gradation) {
    case 1:
      return [a, a, b, b];
    case 2:
      return [b, b, a, a];
    case 3:
      return [a, b, a, b];
    case 4:
      return [b, a, b, a];
    case 5:
      return [a, mid, mid, b];
    case 6:
      return [mid, a, b, mid];
    case 7:
      return [b, mid, mid, a];
    case 8:
      return [mid, b, a, mid];
    default:
      return [a, a, a, a];
  }
}

/** CGACT TEXT dispatch 0x427D0F and per-character wrapper 0x429130. */
export function drawCgText(
  layers: YurisLayers,
  fonts: YurisFonts,
  node: YurisCgNode,
  text: string,
  x: number,
  y: number,
  set: number,
): void {
  const buffer = layers.textBuffer,
    cg = node.payload!;
  const sx = fonts.sx[buffer]!,
    sy = fonts.sy[buffer]!,
    aa = fonts.antialiasing[buffer] === 1;
  const rotation = fonts.rotation[buffer]!,
    mode = fonts.drawMode[buffer]!;
  const colors = corners(
    fonts.color[buffer]!,
    fonts.color2[buffer]!,
    fonts.gradation[buffer]!,
    rotation,
  );
  for (let at = 0; at < text.length;) {
    const glyph = fonts.glyph(buffer, text.slice(at), sx, sy, fonts.bold[buffer]!, aa ? 1 : 0);
    const pass = (dx: number, dy: number) => {
      // Both workers mark the CG as masked before testing whether the whole box fits.
      cg.masked = 1;
      if (!cg.pixels || dx < 0 || dy < 0 || dx + sx - 1 >= cg.width || dy + sy - 1 >= cg.height)
        return;
      raster(cg.pixels, cg.width, glyph, sx, sy, dx, dy, rotation, mode, aa, colors);
      layers.markDirty(node);
    };
    if (set === 0) pass(x, y);
    else if (set < 11) {
      // Offset order matters when replacement mode erases the preceding pass's background.
      pass((x + set) | 0, y);
      pass(x, (y - set) | 0);
      pass(x, y);
      pass(x, (y + set) | 0);
      pass((x - set) | 0, y);
    } else {
      const offset = (set - 10) | 0;
      pass((x + offset) | 0, y);
      pass(x, (y + offset) | 0);
      pass((x + offset) | 0, (y + offset) | 0);
    }
    x = (x + glyph.width) | 0;
    at += charLength(text.charCodeAt(at) & 255);
  }
}

/** 0x4298D0 (4x4 coverage) / 0x42B444 (one-bit glyphs), both writing +0xC0. */
function raster(
  to: Uint8Array,
  width: number,
  glyph: YurisGlyph,
  sx: number,
  sy: number,
  x0: number,
  y0: number,
  rotation: number,
  mode: number,
  aa: boolean,
  colors: number[][],
): void {
  if (sx === 0) throw new RangeError('YU-RIS glyph dimensions divide by zero');
  if (sx < 0 || sy <= 0) return;
  const ratio = Math.trunc((sy * 100) / sx),
    stride = glyph.cell >> 3;
  if (!ratio || sy === 1 || (!aa && sx === 1))
    throw new RangeError('YU-RIS glyph dimensions divide by zero');
  const ink = (x: number, y: number) => {
    const at = y * stride + (x >> 3);
    return (
      x >= 0 &&
      x < glyph.cell &&
      y >= 0 &&
      y < glyph.cell &&
      at < glyph.bits.length &&
      (glyph.bits[at]! & (128 >> (x & 7))) === 0
    );
  };
  const lerp = (a: number, b: number, t: number, length: number) =>
    (a + Math.trunc(((b - a) * t) / (length - 1))) & 255;
  for (let y = 0; y < sy; y++) {
    const gy = Math.trunc((y * (aa ? 400 : 100)) / ratio);
    if (gy * stride >= glyph.bits.length) continue;
    const left = colors[0]!.map((v, c) => lerp(v, colors[1]![c]!, y, sy)),
      right = colors[2]!.map((v, c) => lerp(v, colors[3]![c]!, y, sy));
    if (sx === 1 && left.some((v, c) => v !== right[c]))
      throw new RangeError('YU-RIS glyph dimensions divide by zero');
    for (let x = 0; x < sx; x++) {
      let alpha = 0;
      if (aa) {
        for (let yy = 0; yy < 4; yy++)
          for (let xx = 0; xx < 4; xx++) if (ink(x * 4 + xx, gy + yy)) alpha++;
        // 0x46B7EC's coverage table, indexed by the black-bit count.
        alpha = Math.min(255, alpha * 18);
      } else alpha = ink(x, gy) ? 255 : 0;
      let dx = x0 + x,
        dy = y0 + y;
      if (rotation === 1) {
        dx = x0 + sy - 1 - y;
        dy = y0 + x;
      } else if (rotation === 2) {
        dx = x0 + sx - 1 - x;
        dy = y0 + sy - 1 - y;
      } else if (rotation === 3) {
        dx = x0 + y;
        dy = y0 + sx - 1 - x;
      }
      const at = (dy * width + dx) * 4;
      if (at < 0 || at + 3 >= to.length) continue;
      if (!aa && mode !== 0 && !alpha) continue;
      const color = left.map((v, c) => (sx === 1 ? v : lerp(v, right[c]!, x, sx)));
      if (aa && mode !== 0) {
        const weight = alpha + 1,
          da = to[at + 3]!,
          out = (da + weight - ((da * weight) >> 8) - 1) & 255;
        for (let c = 0; c < 3; c++)
          to[at + c] = to[at + c]! + Math.trunc(((color[c]! - to[at + c]!) * weight) / (out + 1));
        to[at + 3] = out;
      } else {
        // The mono replacement worker's background dword is 0xFF000000 (0x42B9AB).
        for (let c = 0; c < 3; c++) to[at + c] = !aa && !alpha ? 0 : color[c]!;
        to[at + 3] = aa ? alpha : 255;
      }
    }
  }
}
