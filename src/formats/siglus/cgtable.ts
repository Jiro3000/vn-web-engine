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
 * Header (32 bytes):
 *   0..15  ASCII magic ("CGTABLE\0..." or "CGTABLE2\0...")
 *   16..19 int32 LE entry count
 *   20..23 int32 LE encrypted/compressed flag (1 = cgmXor + Siglus LZSS, 0 = raw)
 *   24..31 reserved
 *
 * Unpacked record layout:
 *   CGTABLE  (v1): 36 bytes = name[32] + int32 flagNo
 *   CGTABLE2 (v2): 60 bytes = name[32] + int32 flagNo + int32 codeExistCnt + int32 codes[5]
 */
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
  if (packedFlag === 1) {
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
