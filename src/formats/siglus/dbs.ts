import {byteDataView} from '../../core/binary.js';
import {unpackSiglusLz} from './compression.js';
import {dbsMask} from './tables.js';

// Verified against SiglusEngine.exe 1.1.134.0 (0x5b9860, 0x5b97f0, 0x6bde00, 0x5b9e00, 0x5b9eb0).
const dbsKeyOuter = 0x89f4622d;
const dbsKeyEven = 0x7190c70e;
const dbsKeyOdd = 0x499bf135;

export interface SiglusDbsColumn {
  readonly id: number;
  readonly type: 'V' | 'S' | string;
}

/**
 * Decodes a Siglus .dbs binary database table (0x5b9860) and provides ID-keyed
 * linear-scan lookups (0x5b9e00 get_num, 0x5b9eb0 get_str) preserving first-match
 * semantics on duplicate row IDs.
 */
export class SiglusDbs {
  readonly bytes: Uint8Array<ArrayBuffer>;
  readonly rowCount: number;
  readonly columnCount: number;
  readonly rowIds: readonly number[];
  readonly columns: readonly SiglusDbsColumn[];
  private readonly view: DataView;
  private readonly dataOffset: number;
  private readonly stringOffset: number;
  private readonly encodingType: number;

  constructor(raw: Uint8Array) {
    if (raw.byteLength < 8) throw new Error('Truncated Siglus DBS file');
    const rawView = byteDataView(raw);
    this.encodingType = rawView.getUint32(0, true);
    const outer = new Uint8Array(raw.subarray(4));
    const outerView = byteDataView(outer);
    for (let i = 0; i + 4 <= outer.length; i += 4) {
      outerView.setUint32(i, (outerView.getUint32(i, true) ^ dbsKeyOuter) >>> 0, true);
    }
    const unpacked = unpackSiglusLz(outer);
    const view = byteDataView(unpacked);
    const totalDwords = Math.floor(unpacked.length / 4);
    for (let i = 0; i < totalDwords; i++) {
      const row = Math.floor(i / 16);
      const col = i % 16;
      const key = dbsMask[(row % 5) * 5 + (col % 5)]! >= 0x80 ? dbsKeyEven : dbsKeyOdd;
      view.setUint32(i * 4, (view.getUint32(i * 4, true) ^ key) >>> 0, true);
    }

    this.bytes = unpacked;
    this.view = view;
    this.rowCount = view.getUint32(4, true);
    this.columnCount = view.getUint32(8, true);
    const rowHeaderOffset = view.getUint32(12, true);
    const colHeaderOffset = view.getUint32(16, true);
    this.dataOffset = view.getUint32(20, true);
    this.stringOffset = view.getUint32(24, true);

    const rowIds: number[] = [];
    for (let r = 0; r < this.rowCount; r++) {
      rowIds.push(view.getInt32(rowHeaderOffset + r * 4, true));
    }
    this.rowIds = rowIds;

    const columns: SiglusDbsColumn[] = [];
    for (let c = 0; c < this.columnCount; c++) {
      columns.push({
        id: view.getInt32(colHeaderOffset + c * 8, true),
        type: String.fromCharCode(view.getUint32(colHeaderOffset + c * 8 + 4, true)),
      });
    }
    this.columns = columns;
  }

  /** Native 0x5983a0 (database[n].check_item_no): returns true if any row matches rowId. */
  hasRow(rowId: number): boolean {
    return this.rowIds.includes(rowId);
  }

  /** Native 0x5983f0 (database[n].check_column_no): 0=missing, 2=int ('V'), 1=string/other. */
  checkColumn(colId: number): number {
    const col = this.columns.find((c) => c.id === colId);
    if (!col) return 0;
    return col.type === 'V' ? 2 : 1;
  }

  /** Native 0x5b9e00: linear-scan first-match rowId & colId guarded by type === 'V'. */
  getNum(rowId: number, colId: number): number {
    const rIdx = this.rowIds.indexOf(rowId);
    const cIdx = this.columns.findIndex((c) => c.id === colId);
    if (rIdx < 0 || cIdx < 0 || this.columns[cIdx]!.type !== 'V') return 0;
    return this.view.getInt32(this.dataOffset + (rIdx * this.columnCount + cIdx) * 4, true);
  }

  /** Native 0x5b9eb0: linear-scan first-match rowId & colId guarded by type === 'S'. */
  getStr(rowId: number, colId: number): string {
    const rIdx = this.rowIds.indexOf(rowId);
    const cIdx = this.columns.findIndex((c) => c.id === colId);
    if (rIdx < 0 || cIdx < 0 || this.columns[cIdx]!.type !== 'S') return '';
    const rel = this.view.getUint32(this.dataOffset + (rIdx * this.columnCount + cIdx) * 4, true);
    const start = this.stringOffset + rel;
    if (start >= this.bytes.length) return '';
    if (this.encodingType === 1) {
      let end = start;
      while (end + 1 < this.bytes.length && this.view.getUint16(end, true) !== 0) end += 2;
      return new TextDecoder('utf-16le').decode(this.bytes.subarray(start, end));
    }
    let end = start;
    while (end < this.bytes.length && this.bytes[end] !== 0) end++;
    return new TextDecoder('shift_jis').decode(this.bytes.subarray(start, end));
  }
}
