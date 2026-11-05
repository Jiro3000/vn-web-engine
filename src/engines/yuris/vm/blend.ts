/**
 * Software layer blending of the CPU compositor (0x404A51) and the filters it applies.
 *
 * Pixels are straight BGRA bytes. A layer's MODE (0..18) selects a per-channel function
 * F(source, destination); its tables are built once by 0x4626FC from the signed product tables
 * of 0x4686F9. The row blitters come from four tables indexed by MODE (and A>>8): 0x789A00
 * (no alpha mask), 0x789AA0 (MID alpha mask), 0x789B40 (TID rule) and 0x789BE0 (alpha mask
 * and rule). Every native blitter is a scalar loop around F; modes 0 and 1 and the opaque
 * variants of several modes also have MMX/SSE bodies (selected by the yscfg.dat SIMD flags and
 * 0x403588) whose rounding of the alpha product differs by at most one step from the scalar
 * loops. The scalar formulas are used for every pixel.
 */

export const BLEND_MODES = 19;

/** The source layer of a blit: its buffer and blend state (+0x88, +0xC0, +0xA2, +0xA8, +0xA9). */
export interface BlendSource {
  readonly pixels: Uint8Array;
  readonly width: number;
  readonly mode: number;
  /** 0..256; 256 selects the opaque blitters. */
  readonly a: number;
  /** The alpha channel weights the colour channels. */
  readonly masked: boolean;
}

export interface BlendRule {
  /** The TID image, the same size as the source; its first byte of each pixel is the rule. */
  readonly pixels: Uint8Array;
  /** 0x40646C's weights by rule value. */
  readonly weights: Int32Array;
}

let tables: Uint8Array[] | null = null;

/** 0x4686F9: trunc(c * x / 255) for c 0..256 and x -255..256 (0x60FE00, rows of 0x200). */
function product(c: number, x: number): number {
  return Math.trunc((c * x) / 255);
}

const clamp = (v: number): number => (v < 0 ? 0 : v > 255 ? 255 : v);

/** 0x4626FC: the F tables, indexed `source * 256 + destination`. */
function blendTables(): Uint8Array[] {
  if (tables) return tables;
  const t: Uint8Array[] = [];
  const build = (f: (s: number, d: number) => number): Uint8Array => {
    const table = new Uint8Array(0x10000);
    for (let s = 0; s < 256; s++) for (let d = 0; d < 256; d++) table[s * 256 + d] = f(s, d) & 0xff;
    return table;
  };
  // 0 normal; 1 0x668100 saturated sum; 2 0x668300 saturated difference source - destination.
  t[0] = build((s) => s);
  t[1] = build((s, d) => Math.min(255, s + d));
  t[2] = build((s, d) => Math.max(0, s - d));
  // 3 0x668500 multiply.
  t[3] = build((s, d) => Math.floor((s * d) / 255));
  // 4 0x678600 divide: source * 255 / destination.
  t[4] = build((s, d) => Math.min(255, d === 0 ? s * 255 : Math.trunc((s * 255) / d)));
  // 5 0x688700 screen.
  t[5] = build((s, d) => s + d - product(d, s));
  // 6 0x749300 lighten, 7 0x759400 darken.
  t[6] = build((s, d) => Math.max(s, d));
  t[7] = build((s, d) => Math.min(s, d));
  // 8 0x698800 difference.
  t[8] = build((s, d) => Math.abs(s - d));
  // 9 0x6A8900 exclusion.
  t[9] = build((s, d) => s + d - 2 * Math.trunc((d * s) / 255));
  // 10 0x729100 overlay, by the destination.
  t[10] = build((s, d) =>
    d < 0x80 ? product(s, 2 * d) : d === 0x80 ? s : product(s, 512 - 2 * d) + 2 * d - 1,
  );
  // 11 0x6B8A00 dodge, 12 0x6C8B00 burn.
  t[11] = build((s, d) => Math.min(255, Math.trunc((d * 256) / (256 - s))));
  t[12] = build((s, d) => Math.max(0, 255 - Math.trunc(((255 - d) * 256) / (s + 1))));
  // 13 0x719000 linear burn.
  t[13] = build((s, d) => clamp(s + d - 255));
  // 14 0x6D8C00 hard light, by the source.
  t[14] = build((s, d) =>
    s < 0x80 ? product(d, 2 * s) : s === 0x80 ? d : product(d, 512 - 2 * s) + 2 * s - 1,
  );
  // 15 0x6E8D00 soft light; the x87 results are truncated (control word | 0xC00).
  t[15] = build((s, d) => {
    let g: number, shift: number;
    if (s < 0x80 || d > 0x20) {
      g = Math.trunc(16384 - Math.sqrt(256 - d));
      shift = s < 0x80 ? 15 : 16;
    } else {
      g = Math.trunc(16384 - Math.sqrt(256 - d) * (0x300 - 8 * d));
      shift = 15;
    }
    return clamp((((s - 0x80) * g) >> shift) + d);
  });
  // 16 0x6F8E00 vivid light.
  t[16] = build((s, d) => {
    if (s < 0x80)
      return s === 0 ? 0 : Math.max(0, Math.trunc((255 * d + 510 * s - 0xfe01) / (2 * s)));
    if (s === 0xff) return 0xff;
    return Math.min(255, Math.trunc((255 * d) / (510 - 2 * s)));
  });
  // 17 0x708F00 linear light.
  t[17] = build((s, d) => clamp(2 * s + d - 256));
  // 18 0x739200 pin light.
  t[18] = build((s, d) => (s < 0x80 ? Math.min(d, 2 * s) : Math.max(d, 2 * s - 255)));
  return (tables = t);
}

/**
 * 0x40646C: the rule weights for T (+0xA4), TA (+0xA6, 256 = a hard threshold) and A (+0xA2).
 * A weight at most 1 leaves the pixel unchanged.
 */
export function ruleWeights(t: number, ta: number, a: number): Int32Array {
  const w = new Int32Array(256);
  if (ta === 0x100) {
    for (let k = 0; k < 256; k++) w[k] = k < 0x100 - t ? 0 : 0x100;
  } else {
    for (let k = 0; k < 256; k++) {
      const v = ((k * ta) >> 1) + (ta >> 1) * t - ta * 0x80 + t;
      w[k] = Math.min(v, 0xff) + 1;
    }
  }
  for (let k = 0; k < 256; k++) w[k] = (w[k]! * a) >> 8;
  return w;
}

/**
 * Blends `width` x `height` source pixels at (sx, sy) onto the destination at (dx, dy). The
 * blitter follows 0x41FC84 (0x65), 0x41FA24 (0x67), 0x41FB2C (0x66) and 0x41F8E0 (0x68).
 */
export function blendRect(
  dst: Uint8Array,
  dstWidth: number,
  dx: number,
  dy: number,
  src: BlendSource,
  sx: number,
  sy: number,
  width: number,
  height: number,
  rule: BlendRule | null,
): void {
  const f = blendTables()[src.mode] ?? blendTables()[0]!;
  const mode = src.mode,
    a = src.a;
  const s = src.pixels,
    r = rule?.pixels,
    w = rule?.weights;
  for (let row = 0; row < height; row++) {
    let di = ((dy + row) * dstWidth + dx) * 4;
    let si = ((sy + row) * src.width + sx) * 4;
    const end = di + width * 4;
    if (!rule) {
      if (!src.masked) {
        if (a >= 0x100) {
          // 0x412CF4 and the opaque blitters: every byte, alpha included.
          for (; di < end; di++, si++) dst[di] = f[s[si]! * 256 + dst[di]!]!;
        } else if (mode === 1) {
          // 0x401124: the scaled source is added with saturation.
          for (; di < end; di++, si++) dst[di] = Math.min(255, dst[di]! + ((s[si]! * a) >> 8));
        } else if (mode === 8) {
          // 0x413EE0: the alpha product comes from 0x5CFA00, truncated toward zero.
          for (; di < end; di++, si++) {
            const d = dst[di]!;
            dst[di] = d + Math.trunc((a * (f[s[si]! * 256 + d]! - d)) / 256);
          }
        } else {
          for (; di < end; di++, si++) {
            const d = dst[di]!;
            dst[di] = d + (((f[s[si]! * 256 + d]! - d) * a) >> 8);
          }
        }
        continue;
      }
      for (; di < end; di += 4, si += 4) {
        const sa = s[si + 3]!;
        if (mode === 1 && a < 0x100) {
          // 0x4011E4.
          const k = (sa * a) >> 8;
          for (let c = 0; c < 3; c++)
            dst[di + c] = Math.min(255, dst[di + c]! + ((s[si + c]! * k) >> 8));
          continue;
        }
        const k = a >= 0x100 ? sa + 1 : mode === 0 ? ((sa * a) >> 8) + 1 : (sa * a + a) >> 8;
        for (let c = 0; c < 3; c++) {
          const d = dst[di + c]!;
          dst[di + c] = d + (((f[s[si + c]! * 256 + d]! - d) * k) >> 8);
        }
      }
      continue;
    }
    let ri = si;
    for (; di < end; di += 4, si += 4, ri += 4) {
      const k = w![r![ri]!]!;
      if (k <= 1) continue;
      if (src.masked) {
        // 0x412E24 (mode 0) and the 0x789BE0 blitters.
        const q = mode === 0 ? s[si + 3]! * k : s[si + 3]! * k + k;
        for (let c = 0; c < 3; c++) {
          const d = dst[di + c]!;
          dst[di + c] = d + (((f[s[si + c]! * 256 + d]! - d) * q) >> 16);
        }
      } else if (mode === 0 && a >= 0x100) {
        // 0x403418: the difference is taken from the destination.
        for (let c = 0; c < 3; c++) {
          const d = dst[di + c]!;
          dst[di + c] = d - (((d - s[si + c]!) * k) >> 8);
        }
      } else {
        for (let c = 0; c < 3; c++) {
          const d = dst[di + c]!;
          dst[di + c] = d + (((f[s[si + c]! * 256 + d]! - d) * k) >> 8);
        }
      }
    }
  }
}

/**
 * 0x406848: MD, a per-channel colour shift (0x808080 neutral; bytes R G B). Rows y0..y1 and
 * columns x0..x1 of the source are written to the destination starting at its first pixel;
 * alpha is copied.
 */
export function colourShift(
  dst: Uint8Array,
  dstWidth: number,
  src: Uint8Array,
  srcWidth: number,
  x0: number,
  y0: number,
  x1: number,
  y1: number,
  md: number,
): void {
  const shift = (channel: number): Int32Array => {
    const down = Math.max(0, 0x80 - channel),
      up = Math.max(0, channel - 0x80);
    const table = new Int32Array(256);
    for (let v = 0; v < 256; v++) table[v] = (((255 - v) * up) >> 7) - ((v * down) >> 7);
    return table;
  };
  const b = shift(md & 0xff),
    g = shift((md >> 8) & 0xff),
    r = shift((md >> 16) & 0xff);
  for (let y = y0; y <= y1; y++) {
    let di = (y - y0) * dstWidth * 4;
    for (let x = x0, si = (y * srcWidth + x0) * 4; x <= x1; x++, si += 4, di += 4) {
      dst[di] = src[si]! + b[src[si]!]!;
      dst[di + 1] = src[si + 1]! + g[src[si + 1]!]!;
      dst[di + 2] = src[si + 2]! + r[src[si + 2]!]!;
      dst[di + 3] = src[si + 3]!;
    }
  }
}

/**
 * 0x406B28: SD, saturation (0x80 neutral). Below 0x80 the channels move toward their mean;
 * above it they move away, limited so that no channel leaves 0..255. The region and alpha are
 * handled as in `colourShift`.
 */
export function saturation(
  dst: Uint8Array,
  dstWidth: number,
  src: Uint8Array,
  srcWidth: number,
  x0: number,
  y0: number,
  x1: number,
  y1: number,
  sd: number,
): void {
  for (let y = y0; y <= y1; y++) {
    let di = (y - y0) * dstWidth * 4;
    for (let x = x0, si = (y * srcWidth + x0) * 4; x <= x1; x++, si += 4, di += 4) {
      const b = src[si]!,
        g = src[si + 1]!,
        r = src[si + 2]!;
      const mean = Math.trunc((b + g + r) / 3);
      if (sd < 0x80) {
        const k = 0x80 - sd;
        dst[di] = b + (((mean - b) * k) >> 7);
        dst[di + 1] = g + (((mean - g) * k) >> 7);
        dst[di + 2] = r + (((mean - r) * k) >> 7);
      } else {
        // Every bound is tested with the unclamped factor; the smallest limit wins.
        const full = sd - 0x80;
        let k = full;
        const db = b - mean,
          dg = g - mean,
          dr = r - mean;
        const bound = (v: number, delta: number, high: boolean): void => {
          const out = ((full * delta) >> 7) + v;
          if (high ? out > 0xff : out < 0) {
            const m = Math.trunc(((high ? 0xff - v : -v) * 0x80) / delta);
            if (m < k) k = m;
          }
        };
        bound(b, db, true);
        bound(g, dg, true);
        bound(r, dr, true);
        bound(b, db, false);
        bound(g, dg, false);
        bound(r, dr, false);
        dst[di] = b + ((db * k) >> 7);
        dst[di + 1] = g + ((dg * k) >> 7);
        dst[di + 2] = r + ((dr * k) >> 7);
      }
      dst[di + 3] = src[si + 3]!;
    }
  }
}
