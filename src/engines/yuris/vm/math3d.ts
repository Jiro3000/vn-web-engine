import type {YurisMachine} from './machine.js';

const MATH3D = 0x3d;

/** MATH3D argument ids (`ysc.ybn`). */
const enum Arg {
  Int,
  Flt,
}

/** The four results of 0x446DC8 (0x871F88..0x871FA0): a position and two scale factors. */
export type Projection = [x: number, y: number, scaleX: number, scaleY: number];

export function installMath3d(m: YurisMachine): void {
  m.define(MATH3D, () => math3d(m));
}

/**
 * MATH3D 0x446A80: projects with the int array INT and the float array FLT (0x446DC8, ECX 0)
 * and stores the results in FLT elements 31..34 through the bounds-checked element store, so
 * an int array receives them rounded and a string array is error 0x18B14. Nothing happens
 * unless both arguments are given.
 */
function math3d(m: YurisMachine): number {
  const a = m.args;
  m.decode();
  const intSlot = a.has(Arg.Int),
    fltSlot = a.has(Arg.Flt);
  if (!intSlot || !fltSlot) return 0;
  const floats = a.variable[fltSlot]!;
  const result = project(m, a.variable[intSlot]!, floats, false);
  for (let k = 0; k < 4; k++) m.setFloat(floats, BigInt(31 + k), result[k]!);
  return 0;
}

/**
 * 0x446DC8. The int array holds flags: [1] and [2] differ when a second plane applies, [4]
 * selects its second depth, [5] and [6] add half their value to X and Y, and [7] non-zero
 * takes the flat formula. The float array holds coordinates: [3]/[4] an offset, [5] + [30]
 * the camera depth, [6]/[7] a position, [8] its depth, [9]/[10] its origin, [11]/[12] a
 * shift scaled by [20]/[21] in hundredths, [13]/[14] the flat position, [15] and [24] the
 * plane depths, [16]/[17] the scale in percent, [18]/[19] the anchor, [22]..[26] the second
 * plane's offsets and [27] the eye depth, with [28]/[29] adding to [3]/[4]. A depth difference
 * d scales by 2^(d / 100) (CRT pow at 0x470A59). `zeroOffset` (ECX 1) clears [3], [4], [28]
 * and [29]. Elements past either array read 0.
 *
 * The native keeps the second pow result and the sums in x87 registers; these are doubles.
 */
export function project(
  m: YurisMachine,
  ints: number,
  floats: number,
  zeroOffset: boolean,
): Projection {
  const i = (k: number) => m.getInt(ints, BigInt(k));
  const f = (k: number) => m.getFloat(floats, BigInt(k));
  const i1 = i(1),
    i2 = i(2);
  i(3);
  const i4 = i(4),
    i5 = i(5),
    i6 = i(6),
    i7 = i(7);
  const v = new Float64Array(31);
  for (let k = 3; k <= 30; k++) v[k] = f(k);
  v[20] = v[20]! / 100;
  v[21] = v[21]! / 100;
  if (zeroOffset) v[3] = v[4] = v[28] = v[29] = 0;
  const e = (k: number): number => v[k]!;
  if (i7 !== 0n)
    return [e(13) - (e(18) * e(16)) / 100, e(14) - (e(19) * e(17)) / 100, e(16), e(17)];
  const ox = e(3) + e(28),
    oy = e(4) + e(29),
    camera = e(5) + e(30);
  const scale = (depth: number) => Math.pow(2, (e(27) - depth + camera) / 100);
  const s1 = scale(e(8));
  let s2 = scale(e(15));
  let x = (e(6) - e(9) - ox * e(20)) * s1 + e(11) * e(20) + Number(i5) * 0.5;
  let y = e(12) * e(21) + Number(i6) * 0.5 + (e(7) - e(10) - oy * e(21)) * s1;
  if (i1 !== i2) {
    x += e(9) * s1;
    y += e(10) * s1;
    if (i4 === 0n) {
      x += (e(13) * e(20) - e(18)) * s2;
      y += (e(14) * e(21) - e(19)) * s2;
    } else {
      s2 = scale(e(24));
      x += ((e(13) + e(22)) * e(20) - e(18) - e(25)) * s2;
      y += ((e(14) + e(23)) * e(21) - e(19) - e(26)) * s2;
    }
  }
  x += (e(18) * (100 - e(16)) * s2) / 100;
  y += (e(19) * (100 - e(17)) * s2) / 100;
  return [x, y, e(16) * s2, e(17) * s2];
}
