import {byteDataView} from '../../core/binary.js';
import {unpackSiglusLz, xorCycle} from './compression.js';
import {cgmXor} from './tables.js';

export interface SiglusCgTableEntry {
  name: string;
  flagNo: number;
  codes: number[];
}

export interface SiglusCgTable {
  version: 1 | 2;
  entries: SiglusCgTableEntry[];
  /** Lowercased CG name -> flag number. */
  byName: Map<string, number>;
}

const asciiDecoder = new TextDecoder('latin1');

/**
 * Parses a VisualArt's SiglusEngine / RealLive `.cgm` CG table (`CGTABLE` or `CGTABLE2`).
 *
 * Native `SiglusEngine.exe` (`0x516be0`) unconditionally decrypts (`cgmXor`) and LZSS-unpacks
 * payloads at `bytes + 32` regardless of `header[20..23]` (for example `Angel Beats! -1st beat-`
 * has `header[20..23] === 0` on an XOR+LZSS `CGTABLE2`), while raw synthetic tables set `0` with
 * `bytes.length === 32 + count * stride`.
 *
 * Header (32 bytes):
 *   0..15  ASCII magic ("CGTABLE\0..." or "CGTABLE2\0...")
 *   16..19 int32 LE entry count
 *   20..23 int32 LE flag / version word (`1` or `0`)
 *   24..31 reserved
 *
 * Unpacked record layout:
 *   CGTABLE  (v1): 36 bytes = name[32] + int32 flagNo
 *   CGTABLE2 (v2): 60 bytes = name[32] + int32 flagNo + int32 codeExistCnt + int32 codes[5]
 */
function hasXorPackedLzHeader(bytes: Uint8Array, expectedOrgSize: number): boolean {
  if (bytes.length < 40) return false;
  const packSize =
    ((bytes[32]! ^ cgmXor[0]!) |
      ((bytes[33]! ^ cgmXor[1]!) << 8) |
      ((bytes[34]! ^ cgmXor[2]!) << 16) |
      ((bytes[35]! ^ cgmXor[3]!) << 24)) >>>
    0;
  const orgSize =
    ((bytes[36]! ^ cgmXor[4]!) |
      ((bytes[37]! ^ cgmXor[5]!) << 8) |
      ((bytes[38]! ^ cgmXor[6]!) << 16) |
      ((bytes[39]! ^ cgmXor[7]!) << 24)) >>>
    0;
  return packSize === bytes.length - 32 && orgSize === expectedOrgSize;
}

export function parseCgTable(bytes: Uint8Array): SiglusCgTable {
  if (bytes.length < 32) throw new Error('Truncated Siglus CGTABLE header');
  const magic = asciiDecoder.decode(bytes.subarray(0, 16)).replace(/\0+$/, '');
  let version: 1 | 2;
  let stride: number;
  if (magic === 'CGTABLE2') {
    version = 2;
    stride = 60;
  } else if (magic === 'CGTABLE') {
    version = 1;
    stride = 36;
  } else {
    throw new Error(`Unsupported Siglus CGTABLE magic: ${JSON.stringify(magic)}`);
  }

  const header = byteDataView(bytes);
  const count = header.getInt32(16, true);
  const packedFlag = header.getInt32(20, true);
  if (count < 0 || count > 1_000_000) throw new Error(`Invalid Siglus CGTABLE count: ${count}`);

  let data: Uint8Array;
  if (packedFlag === 1 || hasXorPackedLzHeader(bytes, count * stride)) {
    const payload = bytes.slice(32);
    xorCycle(payload, cgmXor);
    data = unpackSiglusLz(payload);
  } else {
    data = bytes.subarray(32);
  }

  if (data.length < count * stride) {
    throw new Error(
      `Truncated Siglus CGTABLE payload: expected ${count * stride} bytes, got ${data.length}`,
    );
  }

  const view = byteDataView(data);
  const entries: SiglusCgTableEntry[] = [];
  const byName = new Map<string, number>();

  for (let i = 0; i < count; i++) {
    const off = i * stride;
    let end = off;
    while (end < off + 32 && data[end] !== 0) end++;
    const name = asciiDecoder.decode(data.subarray(off, end));
    const flagNo = view.getInt32(off + 32, true);
    const codes: number[] = [];
    if (version === 2) {
      const codeExistCnt = Math.min(5, Math.max(0, view.getInt32(off + 36, true)));
      for (let c = 0; c < codeExistCnt; c++) {
        codes.push(view.getInt32(off + 40 + c * 4, true));
      }
    }
    entries.push({name, flagNo, codes});
    if (name) byName.set(name.toLowerCase(), flagNo);
  }

  return {version, entries, byName};
}
