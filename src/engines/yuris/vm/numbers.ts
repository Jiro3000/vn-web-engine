/**
 * Numeric and string primitives of the YU-RIS VM. Integers are signed 64-bit (`bigint`,
 * wrapped with `BigInt.asIntN`), floats are doubles and strings are byte strings: one char per
 * Shift-JIS byte, the representation the native `char` buffers compare and copy. Addresses
 * refer to `hajiron.exe` (see the engine README).
 */

/** A string of byte values 0..255, one char per byte. */
export type ByteString = string;

/** Native string buffers are 0x1000 bytes with the terminator. */
export const STRING_CAPACITY = 0x1000;

export const INT64_MIN = -(1n << 63n);

export function i64(value: bigint): bigint {
  return BigInt.asIntN(64, value);
}

/**
 * x87 `FISTP` under the default control word: round half to even; NaN, infinities and out of
 * range values store the integer indefinite 0x8000000000000000.
 */
export function fistp(value: number): bigint {
  if (!Number.isFinite(value)) return INT64_MIN;
  let rounded = Math.round(value);
  if (rounded - value === 0.5 && rounded % 2 !== 0) rounded -= 1;
  if (rounded >= 9223372036854775808 || rounded < -9223372036854775808) return INT64_MIN;
  return BigInt(rounded);
}

/** `(double)int64`. */
export function toDouble(value: bigint): number {
  return Number(value);
}

/**
 * The Shift-JIS lead byte table at 0x59B0C0: every byte 0x81..0xFE, half-width katakana
 * included, starts a two-byte character.
 */
export function isLeadByte(byte: number): boolean {
  return byte >= 0x81 && byte <= 0xfe;
}

/** `sprintf("%f")` of the MSVC runtime (format string at 0x8792F4). */
export function formatFloat(value: number): ByteString {
  if (Number.isNaN(value)) return '-1.#IND00';
  if (value === Infinity) return '1.#INF00';
  if (value === -Infinity) return '-1.#INF00';
  if (Object.is(value, -0)) return '-0.000000';
  if (Math.abs(value) < 1e21) return value.toFixed(6);
  // Exact decimal expansion of a double beyond the range of toFixed: it is an integer.
  const integer = BigInt(value);
  return `${integer}.000000`;
}

/** `_i64toa(value, buffer, 10)`. */
export function formatInt(value: bigint): ByteString {
  return value.toString();
}

/** `_atoi64` (0x470798): optional whitespace and sign, then decimal digits. */
export function atoi64(text: ByteString): bigint {
  let p = 0;
  while (p < text.length && isSpace(text.charCodeAt(p))) p++;
  let negative = false;
  const sign = text[p];
  if (sign === '-' || sign === '+') {
    negative = sign === '-';
    p++;
  }
  let value = 0n;
  for (; p < text.length; p++) {
    const c = text.charCodeAt(p);
    if (c < 0x30 || c > 0x39) break;
    value = value * 10n + BigInt(c - 0x30);
  }
  return i64(negative ? -value : value);
}

/**
 * 0x42245C: the hex digits after a `0x` prefix, at most 16; null when there are none or more.
 */
export function parseHex(text: ByteString): bigint | null {
  const digits = /^[0-9A-Fa-f]*/.exec(text.slice(2))![0];
  if (digits.length === 0 || digits.length > 16) return null;
  return i64(BigInt(`0x${digits}`));
}

/** `strtod(text, NULL)` (0x471417): the longest decimal floating prefix. */
export function strtod(text: ByteString): number {
  const match = /^[ \t\n\v\f\r]*([+-]?(?:\d+\.?\d*|\.\d+)(?:[eE][+-]?\d+)?)/.exec(text);
  return match ? Number(match[1]) : 0;
}

function isSpace(c: number): boolean {
  return c === 0x20 || (c >= 0x09 && c <= 0x0d);
}

/** Byte-wise `strcmp` sign. */
export function compareBytes(a: ByteString, b: ByteString): number {
  return a === b ? 0 : a < b ? -1 : 1;
}

/** The first `NUL`-terminated run, as C string functions see a buffer. */
export function cString(text: ByteString): ByteString {
  const end = text.indexOf('\0');
  return end < 0 ? text : text.slice(0, end);
}
