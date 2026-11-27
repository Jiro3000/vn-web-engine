/**
 * Native Siglus math helpers verified from SiglusEngine.exe (0x55a300).
 * - sin (0x55a556) / cos (0x55a59d): angle in tenths of a degree, float(pi/180) = 0x00b0fad4.
 * - tostr_zen (0x55a9f7 -> 0x6afd70): ASCII ' ' -> U+3000, 0x21..0x7e -> +0xfee0.
 */

const PI_OVER_180_F32 = Math.fround(Math.PI / 180);
const RAD_TO_DEG_F32 = Math.fround(180 / Math.PI);

/** Native 1.1.141.3 0x55eea0: round-half-away-from-zero to int32. */
function siglusRoundHalfAway(value: number): number {
  if (value > 0) return Math.trunc(value + 0.5) | 0;
  if (value < 0) return Math.trunc(value - 0.5) | 0;
  return 0;
}

export function siglusSin(deg10: number, scale: number): number {
  const rad = Math.fround((Math.fround(deg10 | 0) * PI_OVER_180_F32) / 10);
  return Math.trunc(Math.fround(Math.sin(rad)) * Math.fround(scale | 0)) | 0;
}

export function siglusCos(deg10: number, scale: number): number {
  const rad = Math.fround((Math.fround(deg10 | 0) * PI_OVER_180_F32) / 10);
  return Math.trunc(Math.fround(Math.cos(rad)) * Math.fround(scale | 0)) | 0;
}

/** Native 1.1.141.3 0x55f165 -> 0x562eb0 (math.tan): angle in tenths of a degree. */
export function siglusTan(deg10: number, scale: number): number {
  const rad = Math.fround((Math.fround(deg10 | 0) * PI_OVER_180_F32) / 10);
  return Math.trunc(Math.fround(Math.tan(rad)) * Math.fround(scale | 0)) | 0;
}

/** Native 1.1.141.3 0x55f187 (math.asin): returns angle in tenths of a degree. */
export function siglusAsin(num: number, den: number): number {
  const d = den | 0;
  if (d === 0) return 0;
  const ratio = Math.max(-1, Math.min(1, (num | 0) / d));
  return siglusRoundHalfAway(Math.asin(ratio) * RAD_TO_DEG_F32 * 10);
}

/** Native 1.1.141.3 0x55f1f7 (math.acos): returns angle in tenths of a degree. */
export function siglusAcos(num: number, den: number): number {
  const d = den | 0;
  if (d === 0) return 0;
  const ratio = Math.max(-1, Math.min(1, (num | 0) / d));
  return siglusRoundHalfAway(Math.acos(ratio) * RAD_TO_DEG_F32 * 10);
}

/** Native 1.1.141.3 0x55f23a (math.atan): returns angle in tenths of a degree. */
export function siglusAtan(num: number, den: number): number {
  const d = den | 0;
  if (d === 0) return 0;
  return siglusRoundHalfAway(Math.atan((num | 0) / d) * RAD_TO_DEG_F32 * 10);
}

/** Native 1.1.141.3 0x55f2c0 (math.angle / atan2): returns [0..3599] tenths of a degree. */
export function siglusAngle(x1: number, y1: number, x2: number, y2: number): number {
  const dx = ((x2 | 0) - (x1 | 0)) | 0;
  const dy = ((y2 | 0) - (y1 | 0)) | 0;
  const rounded = siglusRoundHalfAway(Math.atan2(dy, dx) * RAD_TO_DEG_F32 * 10);
  return ((rounded + 3600) % 3600) | 0;
}

/** Native 1.1.141.3 0x55e8a0: signed int32 formatted with leading padChar after '-' sign. */
export function siglusTostrPad(value: number, width: number, padChar: ' ' | '0'): string {
  const n = value | 0;
  const clampedWidth = Math.min(1024, Math.max(0, width | 0));
  if (n < 0) {
    const absDigits = String(Math.abs(n));
    const padCount = Math.max(0, clampedWidth - absDigits.length - 1);
    return '-' + padChar.repeat(padCount) + absDigits;
  }
  const digits = String(n);
  const padCount = Math.max(0, clampedWidth - digits.length);
  return padChar.repeat(padCount) + digits;
}

function toZenkaku(text: string): string {
  let out = '';
  for (let i = 0; i < text.length; i++) {
    const code = text.charCodeAt(i);
    if (code === 0x20) out += '\u3000';
    else if (code >= 0x21 && code <= 0x7e) out += String.fromCharCode(code + 0xfee0);
    else out += text[i]!;
  }
  return out;
}

export function siglusTostrZen(value: number, width = 0): string {
  let text = String(value | 0);
  if (width > text.length) text = text.padStart(width, ' ');
  return toZenkaku(text);
}

/** Native 1.1.141.3 0x55eed0 case 13 (math.tostr_zen_zero): 0x55e8a0('0') + 0x6bbb40. */
export function siglusTostrZenZero(value: number, width = 0): string {
  return toZenkaku(siglusTostrPad(value, width, '0'));
}
