import {bgraLuminanceMask} from '../../graphics/bgra-effects-wasm.js';
import {createFanWipeRaster} from './wipe-wasm.js';

type Point = readonly [number, number];

export interface FanWipe {
  softness: number;
  quadrant: number;
  reverse: boolean;
}

export interface CustomMaskWipe {
  softness: number;
  width: number;
  height: number;
  values: Uint8Array;
}

// Native 0x61c210 / 0x61c64c softness band widths for option[0] in 0..8.
export const wipeSoftnessTable = [0, 0.5, 0.75, 0.875, 0.9375, 0.96875, 0.984375, 0.9921875, 1] as const;

export function wipeSoftness(option: number): number {
  if (!Number.isFinite(option) || option <= 0) return 0;
  if (option >= wipeSoftnessTable.length) return 1;
  return wipeSoftnessTable[Math.trunc(option)]!;
}

/** Extracts an 8-bit mask array from a G00 BGRA frame for type-900 mask_wipe (0x61bf60). */
export function g00MaskValues(
  bgra: Uint8Array,
  width: number,
  height: number,
  reverse = false,
): Uint8Array {
  const values = new Uint8Array(width * height);
  if (bgraLuminanceMask(bgra, values, reverse)) return values;
  for (let i = 0; i < values.length; i++) {
    const b = bgra[i * 4]!;
    const g = bgra[i * 4 + 1]!;
    const r = bgra[i * 4 + 2]!;
    const lum = Math.trunc((r * 299 + g * 587 + b * 114) / 1000);
    values[i] = reverse ? 255 - lum : lum;
  }
  return values;
}

/**
 * Native 0x5f9fa0..0x5fa04a C_elm_pcm_event::frame mode-2 (start_random) weighted picker:
 * weights previous index at 1x probability and all other entries at 2x probability.
 */
export function selectPcmEventIndex(
  probabilities: readonly number[],
  previousIndex: number,
  randomUnit: () => number = Math.random,
): number {
  let total = 0;
  for (let i = 0; i < probabilities.length; i++) {
    const p = Math.max(0, probabilities[i]!);
    total += i === previousIndex ? p : p * 2;
  }
  if (total <= 0) return probabilities.length ? 0 : -1;
  let pick = Math.floor(randomUnit() * total);
  for (let i = 0; i < probabilities.length; i++) {
    const p = Math.max(0, probabilities[i]!);
    const w = i === previousIndex ? p : p * 2;
    if (pick < w) return i;
    pick -= w;
  }
  return probabilities.length - 1;
}

/**
 * Procedural mask generator for all verified SSR wipe types (0x61aaa0..0x64ce00,
 * plus 200/214/220 non-mask wipe families approximated via directional/shutter/wave masks).
 * Returns undefined for standard crossfade (type 0) or instant single-pass (type 1).
 */
export function proceduralWipeMask(
  type: number,
  width: number,
  height: number,
  options: readonly number[] = [],
): CustomMaskWipe | undefined {
  if (type === 0 || type === 1) return undefined;
  const opt = (i: number, fallback = 0) => Number(options[i] ?? fallback) | 0;
  const softness = wipeSoftness(opt(0, 0));
  const values = new Uint8Array(width * height);
  const cx = (width - 1) / 2;
  const cy = (height - 1) / 2;
  const clamp255 = (v: number) => Math.max(0, Math.min(255, Math.round(v)));

  switch (type) {
    case 10:
    case 11: {
      // Raster / Mosaic mask (0x644f30 / 0x645000): tiled 1..128 (255 reveals first, matching fanWipeMask)
      const tile = Math.max(2, Math.min(128, opt(1, 16) || 16));
      const reverse = Boolean(opt(2, 0));
      for (let y = 0; y < height; y++) {
        for (let x = 0; x < width; x++) {
          const tx = type === 11 ? y % tile : x % tile;
          const ty = type === 11 ? x % tile : y % tile;
          const v = clamp255(((tx + ty) / Math.max(1, (tile - 1) * 2)) * 255);
          values[y * width + x] = reverse ? v : 255 - v;
        }
      }
      return {softness, width, height, values};
    }
    case 60: {
      const quadrant = opt(1, 0);
      const reverse = Boolean(opt(2, 0));
      const fan = fanWipeMask(width, height, {
        softness,
        quadrant: quadrant >= 0 && quadrant < 4 ? quadrant : 0,
        reverse,
      });
      return {softness, width, height, values: fan};
    }
    case 70:
    case 72:
    case 73: {
      // Tiled fan masks (0x64bda0, 0x64c100, 0x64c2d0): tile 4..128
      const tile = Math.max(4, Math.min(128, opt(1, 32) || 32));
      const quadrant = Math.max(0, Math.min(3, opt(2, 0)));
      const reverse = Boolean(opt(3, 0));
      const base = fanWipeMask(tile, tile, {softness, quadrant, reverse});
      for (let y = 0; y < height; y++) {
        const ty = Math.floor(y / tile);
        const ly = y % tile;
        for (let x = 0; x < width; x++) {
          const tx = Math.floor(x / tile);
          const lx = x % tile;
          const flipX = (type === 72 && (tx & 1) === 1) || (type === 73 && ((tx + ty) & 1) === 1);
          const flipY = type === 73 && (ty & 1) === 1;
          const sx = flipX ? tile - 1 - lx : lx;
          const sy = flipY ? tile - 1 - ly : ly;
          values[y * width + x] = base[sy * tile + sx]!;
        }
      }
      return {softness, width, height, values};
    }
    case 80:
    case 81:
    case 83: {
      // Radial / Burst masks (0x6485b0, 0x648a60, 0x649150)
      const reverse = Boolean(opt(1, 0));
      const maxR = Math.hypot(cx, cy) || 1;
      for (let y = 0; y < height; y++) {
        const dy = y - cy;
        for (let x = 0; x < width; x++) {
          const dx = x - cx;
          let t: number;
          if (type === 80) {
            t = Math.hypot(dx, dy) / maxR;
          } else if (type === 81) {
            t = (Math.abs(dx) / (cx || 1) + Math.abs(dy) / (cy || 1)) / 2;
          } else {
            const r = Math.hypot(dx, dy) / maxR;
            const ang = (Math.atan2(dy, dx) + Math.PI) / (Math.PI * 2);
            t = (r * 0.75 + ((ang * 4) % 1) * 0.25);
          }
          const v = clamp255(t * 255);
          values[y * width + x] = reverse ? v : 255 - v;
        }
      }
      return {softness, width, height, values};
    }
    case 100:
    case 200: {
      // 4-direction linear ramp (0x6492f0 / slide 0x61d040): dir 0..3 (255 reveals first)
      const dir = type === 200 ? opt(0, 0) & 3 : opt(1, 0) & 3;
      const effSoftness = type === 200 ? 0 : softness;
      for (let y = 0; y < height; y++) {
        const ny = height > 1 ? y / (height - 1) : 0;
        for (let x = 0; x < width; x++) {
          const nx = width > 1 ? x / (width - 1) : 0;
          const t = dir === 0 ? nx : dir === 1 ? 1 - nx : dir === 2 ? ny : 1 - ny;
          values[y * width + x] = 255 - clamp255(t * 255);
        }
      }
      return {softness: effSoftness, width, height, values};
    }
    case 101:
    case 214: {
      // Linear split / curtain (0x649530) & stretch/shutter (0x61e4b0)
      const vertical = (opt(1, 0) & 1) === 1;
      const reverse = Boolean(opt(2, 0));
      for (let y = 0; y < height; y++) {
        const ny = cy ? Math.abs(y - cy) / cy : 0;
        for (let x = 0; x < width; x++) {
          const nx = cx ? Math.abs(x - cx) / cx : 0;
          const v = clamp255((vertical ? ny : nx) * 255);
          values[y * width + x] = reverse ? v : 255 - v;
        }
      }
      return {softness, width, height, values};
    }
    case 102: {
      // Linear blinds / stripes (0x6495f0)
      const dir = opt(1, 0) & 3;
      const band = Math.max(4, Math.min(256, opt(2, 24) || 24));
      for (let y = 0; y < height; y++) {
        for (let x = 0; x < width; x++) {
          const pos = dir < 2 ? (x % band) / (band - 1) : (y % band) / (band - 1);
          const t = (dir & 1) === 1 ? 1 - pos : pos;
          values[y * width + x] = 255 - clamp255(t * 255);
        }
      }
      return {softness, width, height, values};
    }
    case 110: {
      // 4-corner diagonal directional wipe (0x6498e0)
      const dir = opt(1, 0) & 3;
      for (let y = 0; y < height; y++) {
        const ny = height > 1 ? y / (height - 1) : 0;
        for (let x = 0; x < width; x++) {
          const nx = width > 1 ? x / (width - 1) : 0;
          const a = dir === 0 || dir === 2 ? nx : 1 - nx;
          const b = dir === 0 || dir === 1 ? ny : 1 - ny;
          values[y * width + x] = 255 - clamp255(((a + b) / 2) * 255);
        }
      }
      return {softness, width, height, values};
    }
    case 120: {
      // Box / Iris wipe (0x64a070): Chebyshev distance from center
      const reverse = Boolean(opt(1, 0));
      for (let y = 0; y < height; y++) {
        const ny = cy ? Math.abs(y - cy) / cy : 0;
        for (let x = 0; x < width; x++) {
          const nx = cx ? Math.abs(x - cx) / cx : 0;
          const v = clamp255(Math.max(nx, ny) * 255);
          values[y * width + x] = reverse ? v : 255 - v;
        }
      }
      return {softness, width, height, values};
    }
    case 150: {
      // Checker / pattern tiled mask (0x64ce00)
      const tile = Math.max(4, Math.min(128, opt(1, 32) || 32));
      const reverse = Boolean(opt(2, 0));
      for (let y = 0; y < height; y++) {
        const ty = Math.floor(y / tile);
        const ly = (y % tile) / Math.max(1, tile - 1);
        for (let x = 0; x < width; x++) {
          const tx = Math.floor(x / tile);
          const lx = (x % tile) / Math.max(1, tile - 1);
          const parity = (tx + ty) & 1;
          const base = parity * 0.5 + ((lx + ly) / 2) * 0.5;
          const v = clamp255(base * 255);
          values[y * width + x] = reverse ? v : 255 - v;
        }
      }
      return {softness, width, height, values};
    }
    case 220: {
      // Raster wave / ripple wipe (0x61c9a0)
      const waves = Math.max(1, opt(1, 6) || 6);
      for (let y = 0; y < height; y++) {
        const ny = height > 1 ? y / (height - 1) : 0;
        const shift = Math.sin(ny * Math.PI * 2 * waves) * 0.15;
        for (let x = 0; x < width; x++) {
          const nx = width > 1 ? x / (width - 1) : 0;
          values[y * width + x] = 255 - clamp255((nx + shift) * 255);
        }
      }
      return {softness: Math.max(0.25, softness), width, height, values};
    }
    default:
      return undefined;
  }
}

// The native mode-60 generator (0x646ab0, 0x646da0) uses a different
// integer origin for each quadrant and assigns 64 values to each sweep.
export function fanWipeMask(
  width: number,
  height: number,
  {quadrant, reverse}: FanWipe,
): Uint8Array {
  const mask = new Uint8Array(width * height);
  const raster = createFanWipeRaster(width, height, mask);
  const x = Math.floor(width / 2);
  const y = Math.floor(height / 2);
  const radius = Math.floor(Math.SQRT2 * (Math.max(x, y) + 64));
  const centers: Point[] = [
    [x - 1, y - 1],
    [x, y - 1],
    [x, y],
    [x - 1, y],
  ];
  const axes: Point[] = [
    [-1, 0],
    [0, -1],
    [1, 0],
    [0, 1],
  ];
  for (let band = 0; band < 4; band++) {
    const index = (quadrant + band) % 4;
    const [cx, cy] = centers[index]!;
    const [dx, dy] = axes[index]!;
    let previous: Point | undefined;
    for (let step = 0; step < 64; step++) {
      // The PE converts degrees with its stored 3.1415 constant.
      const angle = (3.1415 / 2) * (step / 63);
      const sin = Math.sin(angle);
      const cos = Math.cos(angle);
      const next: Point = [
        cx + Math.trunc(radius * (dx * cos - dy * sin) + 0.5),
        cy + Math.trunc(radius * (dy * cos + dx * sin) + 0.5),
      ];
      const level = band * 64 + step;
      if (previous && (previous[0] !== next[0] || previous[1] !== next[1])) {
        const alpha = reverse ? level : 255 - level;
        if (raster) raster.triangle([cx, cy], previous, next, alpha);
        else fillTriangle(mask, width, height, [cx, cy], previous, next, alpha);
      }
      previous = next;
    }
  }
  raster?.finish();
  return mask;
}

function fillTriangle(
  mask: Uint8Array,
  width: number,
  height: number,
  origin: Point,
  first: Point,
  second: Point,
  level: number,
): void {
  const edges = [
    [origin, first],
    [first, second],
    [second, origin],
  ] as const;
  const top = Math.max(0, Math.min(origin[1], first[1], second[1]));
  const bottom = Math.min(height - 1, Math.max(origin[1], first[1], second[1]));
  for (let y = top; y <= bottom; y++) {
    let left = width;
    let right = -1;
    for (const [[x0, y0], [x1, y1]] of edges) {
      if (y < Math.min(y0, y1) || y > Math.max(y0, y1)) continue;
      if (y0 === y1) {
        left = Math.min(left, x0, x1);
        right = Math.max(right, x0, x1);
      } else {
        const x = x0 + ((x1 - x0) * (y - y0)) / (y1 - y0);
        left = Math.min(left, x);
        right = Math.max(right, x);
      }
    }
    left = Math.max(0, Math.round(left));
    right = Math.min(width - 1, Math.round(right));
    if (right >= left) mask.fill(level, y * width + left, y * width + right + 1);
  }
}
