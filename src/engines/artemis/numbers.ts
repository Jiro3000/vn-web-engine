/** Windows unsigned-long hexadecimal prefix conversion, used by this revision's colors. */
export function artemisHexUint32(value: string): number {
  const token = /^[\t\n\v\f\r ]*([+-]?)(?:0[xX])?([0-9a-fA-F]+)/.exec(value);
  const digits = token?.[2]?.replace(/^0+/, '') ?? '';
  const overflow = digits.length > 8;
  const magnitude = overflow ? 0xffffffff : digits ? Number.parseInt(digits, 16) : 0;
  return (overflow ? magnitude : token?.[1] === '-' ? -magnitude : magnitude) >>> 0;
}
