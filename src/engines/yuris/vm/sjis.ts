import {type ByteString, isLeadByte} from './numbers.js';

/**
 * Shift-JIS byte-string operations of the YU-RIS string commands and the code page 932 MBCS
 * routines of the statically linked MSVC runtime they call.
 */

/** Byte length of the character starting with `byte` (lead byte table 0x59B0C0). */
export function charLength(byte: number): number {
  return isLeadByte(byte) ? 2 : 1;
}

/** Number of characters, a trailing lone lead byte counting as one. */
export function charCount(text: ByteString): number {
  let count = 0;
  for (let i = 0; i < text.length; i += charLength(text.charCodeAt(i))) count++;
  return count;
}

/** 0x454A90: ASCII `a`-`z` to upper case, skipping double-byte characters. */
export function asciiUpper(text: ByteString): ByteString {
  return mapSingle(text, (c) => (c > 0x60 && c < 0x7b ? c - 0x20 : c));
}

/** 0x4652F8: ASCII `A`-`Z` to lower case, skipping double-byte characters. */
export function asciiLower(text: ByteString): ByteString {
  return mapSingle(text, (c) => (c > 0x40 && c < 0x5b ? c + 0x20 : c));
}

function mapSingle(text: ByteString, map: (c: number) => number): ByteString {
  let out = '';
  for (let i = 0; i < text.length; ) {
    const c = text.charCodeAt(i);
    if (isLeadByte(c)) {
      out += text.slice(i, i + 2);
      i += 2;
    } else {
      out += String.fromCharCode(map(c));
      i++;
    }
  }
  return out;
}

/**
 * Case pairs of `LCMapStringA` under code page 932, which `_mbsupr` (0x472115) and `_mbslwr`
 * (0x47219F) use for double-byte characters: full-width Latin, Greek and Cyrillic. Each entry
 * is [first upper, first lower, count].
 */
const DOUBLE_BYTE_CASE: readonly (readonly [number, number, number])[] = [
  [0x8260, 0x8281, 26],
  [0x839f, 0x83bf, 24],
  [0x8440, 0x8470, 15],
  [0x844f, 0x8480, 18],
];

function doubleByteCase(code: number, upper: boolean): number {
  for (const [high, low, count] of DOUBLE_BYTE_CASE) {
    const from = upper ? low : high;
    if (code >= from && code < from + count) return code - from + (upper ? high : low);
  }
  return code;
}

/** `_mbsupr` / `_mbslwr`: single bytes by the ASCII case, double bytes by `LCMapStringA`. */
export function mbsCase(text: ByteString, upper: boolean): ByteString {
  let out = '';
  for (let i = 0; i < text.length; ) {
    const c = text.charCodeAt(i);
    if (isLeadByte(c) && i + 1 < text.length) {
      const code = doubleByteCase((c << 8) | text.charCodeAt(i + 1), upper);
      out += String.fromCharCode(code >> 8, code & 0xff);
      i += 2;
    } else {
      out += String.fromCharCode(
        upper ? (c > 0x60 && c < 0x7b ? c - 0x20 : c) : c > 0x40 && c < 0x5b ? c + 0x20 : c,
      );
      i++;
    }
  }
  return out;
}

/** `_mbbtombc` table 0x59C090: full-width forms of 0x20..0x7E. */
const WIDE_ASCII = [
  0x8140, 0x8149, 0x8168, 0x8194, 0x8190, 0x8193, 0x8195, 0x8166, 0x8169, 0x816a, 0x8196, 0x817b,
  0x8143, 0x817c, 0x8144, 0x815e, 0x824f, 0x8250, 0x8251, 0x8252, 0x8253, 0x8254, 0x8255, 0x8256,
  0x8257, 0x8258, 0x8146, 0x8147, 0x8183, 0x8181, 0x8184, 0x8148, 0x8197, 0x8260, 0x8261, 0x8262,
  0x8263, 0x8264, 0x8265, 0x8266, 0x8267, 0x8268, 0x8269, 0x826a, 0x826b, 0x826c, 0x826d, 0x826e,
  0x826f, 0x8270, 0x8271, 0x8272, 0x8273, 0x8274, 0x8275, 0x8276, 0x8277, 0x8278, 0x8279, 0x816d,
  0x818f, 0x816e, 0x814f, 0x8151, 0x8165, 0x8281, 0x8282, 0x8283, 0x8284, 0x8285, 0x8286, 0x8287,
  0x8288, 0x8289, 0x828a, 0x828b, 0x828c, 0x828d, 0x828e, 0x828f, 0x8290, 0x8291, 0x8292, 0x8293,
  0x8294, 0x8295, 0x8296, 0x8297, 0x8298, 0x8299, 0x829a, 0x816f, 0x8162, 0x8170, 0x8150,
];

/**
 * `_mbbtombc` kana table 0x59C150: [half-width byte, run length, first full-width code]. A run
 * covers the voiced forms that follow its base character.
 */
const WIDE_KANA: readonly (readonly [number, number, number])[] = [
  ...'a7:1:8340 b1:1:8341 a8:1:8342 b2:1:8343 a9:1:8344 b3:1:8345 aa:1:8346 b4:1:8347 ab:1:8348 b5:1:8349 b6:2:834a b7:2:834c b8:2:834e b9:2:8350 ba:2:8352 bb:2:8354 bc:2:8356 bd:2:8358 be:2:835a bf:2:835c c0:2:835e c1:2:8360 af:1:8362 c2:2:8363 c3:2:8365 c4:2:8367 c5:1:8369 c6:1:836a c7:1:836b c8:1:836c c9:1:836d ca:3:836e cb:3:8371 cc:3:8374 cd:3:8377 ce:3:837a cf:1:837d d0:1:837e d1:1:8380 d2:1:8381 d3:1:8382 ac:1:8383 d4:1:8384 ad:1:8385 d5:1:8386 ae:1:8387 d6:1:8388 d7:1:8389 d8:1:838a d9:1:838b da:1:838c db:1:838d dc:2:838e b2:1:8390 b4:1:8391 a6:1:8392 dd:1:8393 b3:1:8394 b6:1:8395 b9:1:8396 a7:1:829f b1:1:82a0 a8:1:82a1 b2:1:82a2 a9:1:82a3 b3:1:82a4 aa:1:82a5 b4:1:82a6 ab:1:82a7 b5:1:82a8 b6:2:82a9 b7:2:82ab b8:2:82ad b9:2:82af ba:2:82b1 bb:2:82b3 bc:2:82b5 bd:2:82b7 be:2:82b9 bf:2:82bb c0:2:82bd c1:2:82bf af:1:82c1 c2:2:82c2 c3:2:82c4 c4:2:82c6 c5:1:82c8 c6:1:82c9 c7:1:82ca c8:1:82cb c9:1:82cc ca:3:82cd cb:3:82d0 cc:3:82d3 cd:3:82d6 ce:3:82d9 cf:1:82dc d0:1:82dd d1:1:82de d2:1:82df d3:1:82e0 ac:1:82e1 d4:1:82e2 ad:1:82e3 d5:1:82e4 ae:1:82e5 d6:1:82e6 d7:1:82e7 d8:1:82e8 d9:1:82e9 da:1:82ea db:1:82eb dc:2:82ec b2:1:82ee b4:1:82ef a6:1:82f0 dd:1:82f1 20:1:8140 a1:1:8142 a2:1:8175 a3:1:8176 a4:1:8141 a5:1:8145 b0:1:815b de:1:814a df:1:814b'
    .split(' ')
    .map((entry) => {
      const [byte, run, code] = entry.split(':');
      return [parseInt(byte!, 16), Number(run), parseInt(code!, 16)] as const;
    }),
];

/** `_mbbtombc` (0x472027) under code page 932. */
export function mbbtombc(c: number): number {
  if (c > 0x1f && c < 0x7f) return WIDE_ASCII[c - 0x20]!;
  if (c === 0xdc) return 0x838f;
  if (c > 0xa0 && c < 0xe0) for (const [byte, , code] of WIDE_KANA) if (byte === c) return code;
  return c;
}

/** `_mbctombb` (0x472095) under code page 932. */
export function mbctombb(c: number): number {
  const ascii = WIDE_ASCII.indexOf(c);
  if (ascii >= 0) return ascii + 0x20;
  if (c < 0x8397)
    for (const [byte, run, code] of WIDE_KANA) {
      const d = c - code;
      if (d === 0 || (code >> 8 === c >> 8 && d > 0 && d - run < 0)) return byte;
    }
  return c;
}

/**
 * VARACT HANTOZEN (0x45353C): single bytes through `_mbbtombc`. The byte is passed sign
 * extended and compared as a signed char, so bytes above 0x7F that are not lead bytes come
 * out as the two bytes 0xFF and the byte.
 */
export function toFullWidth(text: ByteString): ByteString {
  let out = '';
  for (let i = 0; i < text.length; ) {
    const c = text.charCodeAt(i);
    if (isLeadByte(c)) {
      out += text.slice(i, i + 2);
      i += 2;
      continue;
    }
    const signed = c << 24 >> 24;
    const wide = (signed >= 0 ? mbbtombc(signed) : signed) & 0xffff;
    out += wide === signed ? text[i] : String.fromCharCode(wide >> 8, wide & 0xff);
    i++;
  }
  return out.slice(0, 0xfff);
}

/** VARACT ZENTOHAN: double-byte characters through `_mbctombb`. */
export function toHalfWidth(text: ByteString): ByteString {
  let out = '';
  for (let i = 0; i < text.length; ) {
    const c = text.charCodeAt(i);
    if (!isLeadByte(c)) {
      out += text[i];
      i++;
      continue;
    }
    const code = (c << 8) | (text.charCodeAt(i + 1) || 0);
    const narrow = mbctombb(code);
    out += narrow === code ? text.slice(i, i + 2) : String.fromCharCode(narrow & 0xff);
    i += 2;
  }
  return out;
}
