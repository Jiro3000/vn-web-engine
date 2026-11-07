import {snappyCompress, snappyUncompress} from '../../../formats/snappy.js';
import {zlibCompress, zlibUncompress} from '../../../formats/zlib.js';
import {decodeCp932} from '../../../text/cp932.js';
import type {YurisCg} from './cg.js';
import {YurisError} from './errors.js';
import {type YurisFolderHost, windowsPath} from './fileact.js';
import type {YurisMachine} from './machine.js';
import {type ByteString, cString, isLeadByte} from './numbers.js';
import {endsWithIgnoringCase} from './product.js';
import {YurisType} from './variables.js';

/**
 * Save data: SAVE 0x44BAB4, LOAD 0x444A0C, SAVEEND 0x44DE5C and SAVEINFO 0x44DE84.
 *
 * SAVE DNO n builds data block n (1..0x400) from one variable element or a whole variable
 * (SET), a layer's pixels (ID) or every variable of one category and type (the G_ flags).
 * SAVE FILE writes the blocks to `save\<FILE>.sd`, SAVE MEM n to memory slot n (0..499), and
 * SAVE MEM 99999 compresses the 500 memory slots into block 0x400. LOAD reads one block back
 * into the LET variable, the ID layer or the variables it lists.
 *
 * A block starts with a 12-byte record header: kind (0 variable, 1 layer, 2 group), 1, the
 * 16-bit variable id, the stored size and the uncompressed size. A group block's header
 * carries the total of its records, which follow uncompressed, each with its own header.
 *
 * A save file (and a memory slot) is `YSSD`, version 0x1E0, the block count, 0x400, a table of
 * 0x400 block offsets (0 for a missing block) and from 0x1010 the blocks, each after its
 * 32-bit DNO. The compressors (YSSNP.DLL Snappy, YSZLB.DLL zlib) are chosen by build-time
 * flags; the output bytes differ from the DLLs', the decoded data does not.
 */

const LOAD = 0x36,
  SAVE = 0x56,
  SAVEEND = 0x57,
  SAVEINFO = 0x58;

/** Type names reported by error 0x18EE8: the INT, FLT and STR command names. */
const INT_NAME = 0x32,
  FLT_NAME = 0x19,
  STR_NAME = 0x5c;

/** Argument ids shared by SAVE and LOAD (SET is LET for LOAD; 6..17 are SAVE's G_ flags). */
const enum Arg {
  File,
  Mem,
  Dno,
  Set,
  Id,
  IdNo,
  Groups,
}

/** 0x59B718 (set in .data, never written): variable records use Snappy instead of zlib 9. */
const SNAPPY_VARIABLES = true;
/** 0x872008 (never set): layer records use zlib level 9. */
const SNAPPY_LAYERS = false;
/** 0x872004 (never set): the memory snapshot uses zlib level 1. */
const SNAPPY_MEMORY = false;

const MAGIC = 0x44535359,
  VERSION = 0x1e0,
  BLOCKS = 0x400,
  TABLE = 0x10,
  DATA = 0x1010,
  SLOTS = 500,
  SNAPSHOT = 99999,
  /** 0x445810: the size of the CG object saved before a layer's pixels. */
  CG_STRUCT = 0x690,
  /** 0x445A11: the largest data length of a variable record. */
  MAX_DATA = 0x2625a00,
  /** 0x445A11: the largest string of a whole-string record. */
  MAX_STRING = 0x1000;

const enum Kind {
  Variable,
  Layer,
  Group,
}

/** 0x8798C0: shown when a string in a variable record is longer than 0x1000 bytes. */
const INVALID_SAVE =
  '※不正セーブファイルの可能性※\r\n\r\n[%s]\r\n\r\nこのままこのセーブファイルを読み込むと、予期せぬ動作をおこなう恐れがあります。\r\n読み込みを強制的に中断します。';
/** 0x8799A0: a record of a save file names a DNO beyond 0x400. */
const INVALID_DNO = '( DNO = %d ) 不正なDNO番号を検出しました。';
/** 0x8799F4: zlib reported a full buffer (-4) for the memory snapshot. */
const COMPRESS_ERROR = '圧縮エラー.';
/** 0x8793F8: a restored layer is wider than 0x2000 pixels. */
const CG_TOO_LARGE = 'ＣＧサイズが大きすぎます。X=%d, Y=%d';

/** The block and memory-slot buffers shared by the save commands. */
export class YurisSaveData {
  /** 0x868EDC / 0x869FDC: block n by DNO (1..0x400; block 0x400 holds the memory snapshot). */
  readonly blocks = new Map<number, Uint8Array>();
  /** 0x866F60 / 0x867F20: the bytes written to memory slot n (0..499). */
  readonly slots = new Map<number, Uint8Array>();
  /**
   * The stored (compressed) bytes of a memory slot buffer. Compression starts when SAVE MEM n
   * writes the slot, so SAVE MEM 99999 only waits for slots it has not finished.
   */
  readonly packedSlots = new WeakMap<Uint8Array, Uint8Array | Promise<Uint8Array>>();

  /** SAVE MEM n (0x44BAB4) and LOAD DNO 0x400: stores slot n and begins compressing it. */
  storeSlot(n: number, slot: Uint8Array, stored?: Uint8Array): void {
    this.slots.set(n, slot);
    if (stored) this.packedSlots.set(slot, stored);
    else if (slot.length) {
      const packed = compress(slot, SNAPPY_MEMORY);
      // A failure is reported by the snapshot that awaits it.
      packed.catch(() => {});
      this.packedSlots.set(slot, packed);
    }
  }

  /** 0x469CF0: -1 frees every block, n frees block n + 1. */
  free(n: number): void {
    if (n === -1) this.blocks.clear();
    else this.blocks.delete(n + 1);
  }
}

export function installSave(m: YurisMachine, folder: YurisFolderHost): YurisSaveData {
  const data = new YurisSaveData();
  m.define(SAVE, () => save(m, folder, data));
  m.define(LOAD, () => load(m, folder, data));
  m.define(SAVEEND, () => {
    m.decode();
    data.free(-1);
    return 0;
  });
  m.define(SAVEINFO, () => (m.decode(), 0));
  return data;
}

function low(value: bigint): number {
  return Number(BigInt.asIntN(32, value));
}

function commandName(m: YurisMachine): string {
  return m.commandName(m.instruction.command);
}

/**
 * The FILE checks of SAVE and LOAD: lower case with '/' as '\' (0x4652F8, 0x45C80E), at most
 * 0x20 bytes (error 0x18F10), no '\' (0x18F06), ".sd" appended unless present (0x440DA0), in
 * the save folder (0x5CF080).
 */
function savePath(m: YurisMachine, file: ByteString): ByteString {
  const name = windowsPath(file);
  if (name.length > 0x20) throw new YurisError(0x18f10, [commandName(m), name]);
  for (let i = 0; i < name.length; i += isLeadByte(name.charCodeAt(i)) ? 2 : 1)
    if (name[i] === '\\') throw new YurisError(0x18f06, [commandName(m), name]);
  return m.system.saveFolder + (endsWithIgnoringCase(name, '.sd') ? name : name + '.sd');
}

/** A growable little-endian byte buffer. */
class ByteWriter {
  private buffer = new Uint8Array(256);
  private view = new DataView(this.buffer.buffer);
  length = 0;

  private reserve(n: number): number {
    const at = this.length;
    if (at + n > this.buffer.length) {
      const next = new Uint8Array(Math.max(this.buffer.length * 2, at + n));
      next.set(this.buffer.subarray(0, at));
      this.buffer = next;
      this.view = new DataView(next.buffer);
    }
    this.length += n;
    return at;
  }
  // `reserve` may replace the buffer, so it runs before the buffer is read.
  u8(value: number): void {
    const at = this.reserve(1);
    this.buffer[at] = value;
  }
  u16(value: number): void {
    const at = this.reserve(2);
    this.view.setUint16(at, value, true);
  }
  u32(value: number): void {
    const at = this.reserve(4);
    this.view.setUint32(at, value >>> 0, true);
  }
  i64(value: bigint): void {
    const at = this.reserve(8);
    this.view.setBigInt64(at, value, true);
  }
  f64(value: number): void {
    const at = this.reserve(8);
    this.view.setFloat64(at, value, true);
  }
  bytes(data: Uint8Array): void {
    const at = this.reserve(data.length);
    this.buffer.set(data, at);
  }
  /** Zero bytes up to `length`. */
  pad(length: number): void {
    if (length > this.length) this.reserve(length - this.length);
  }
  setU32(at: number, value: number): void {
    this.view.setUint32(at, value >>> 0, true);
  }
  result(): Uint8Array {
    return this.buffer.slice(0, this.length);
  }
}

function bytesOf(text: ByteString): Uint8Array {
  const bytes = new Uint8Array(text.length);
  for (let i = 0; i < text.length; i++) bytes[i] = text.charCodeAt(i);
  return bytes;
}

function textOf(data: Uint8Array): ByteString {
  let out = '';
  for (let i = 0; i < data.length; i += 0x2000)
    out += String.fromCharCode(...data.subarray(i, i + 0x2000));
  return out;
}

/** The bytes of `array` as stored natively. */
function rawBytes(array: BigInt64Array | Float64Array): Uint8Array {
  return new Uint8Array(array.buffer, array.byteOffset, array.byteLength);
}

/**
 * 0x44D4B1: the uncompressed variable data. The type, then for one element a dimension count
 * of 0 and the 8-byte value or the length-prefixed string; for a whole variable the dimension
 * count and sizes, the data length and every element (strings as length and bytes).
 */
function serializeVariable(m: YurisMachine, id: number, index: bigint, whole: boolean): Uint8Array {
  const variable = m.variables.get(id),
    w = new ByteWriter();
  w.u32(variable.type);
  if (!whole) {
    w.u32(0);
    if (variable.type === YurisType.Int) {
      w.u32(8);
      w.i64(m.getInt(id, index));
    } else if (variable.type === YurisType.Float) {
      w.u32(8);
      w.f64(m.getFloat(id, index));
    } else if (variable.type === YurisType.String) {
      const text = bytesOf(cString(m.getString(id, index)));
      w.u32(text.length + 4);
      w.u32(text.length);
      w.bytes(text);
    }
    return w.result();
  }
  w.u32(variable.dimensions.length);
  for (const dimension of variable.dimensions) w.u32(dimension);
  if (variable.type === YurisType.Int || variable.type === YurisType.Float) {
    const array =
      variable.type === YurisType.Int
        ? (variable.ints ?? new BigInt64Array(variable.count))
        : (variable.floats ?? new Float64Array(variable.count));
    w.u32(variable.count * 8);
    w.bytes(rawBytes(array));
  } else if (variable.type === YurisType.String) {
    const at = w.length;
    let total = 0;
    w.u32(0);
    for (let i = 0; i < variable.count; i++) {
      const text = bytesOf(cString(m.getString(id, BigInt(i))));
      w.u32(text.length);
      w.bytes(text);
      total += 4 + text.length;
    }
    w.setU32(at, total);
  }
  return w.result();
}

/** The 12-byte record header followed by the stored data. */
function record(kind: Kind, id: number, rawLength: number, stored: Uint8Array): Uint8Array {
  const w = new ByteWriter();
  w.u8(kind);
  w.u8(1);
  w.u16(id);
  w.u32(stored.length);
  w.u32(rawLength);
  w.bytes(stored);
  return w.result();
}

async function compress(data: Uint8Array, snappy: boolean): Promise<Uint8Array> {
  return snappy ? snappyCompress(data) : zlibCompress(data);
}

/** 0x44CF61 without a layer: a variable record (synchronous when Snappy compresses it). */
function variableRecord(
  m: YurisMachine,
  id: number,
  index: bigint,
  whole: boolean,
): Uint8Array | Promise<Uint8Array> {
  const raw = serializeVariable(m, id, index, whole);
  // A record depends only on the variable id and its uncompressed bytes, so unchanged data
  // reuses the record built last time instead of compressing it again.
  let records = variableRecords.get(m);
  if (!records) variableRecords.set(m, (records = new Map()));
  const key = id * 2 + (whole ? 1 : 0),
    cached = records.get(key);
  if (cached && sameBytes(cached.raw, raw)) return cached.record;
  const remember = (block: Uint8Array): Uint8Array => {
    records.set(key, {raw, record: block});
    return block;
  };
  if (SNAPPY_VARIABLES) return remember(record(Kind.Variable, id, raw.length, snappyCompress(raw)));
  return zlibCompress(raw).then((stored) =>
    remember(record(Kind.Variable, id, raw.length, stored)),
  );
}

/** The last record built per variable (id * 2, plus 1 for a whole variable) and its input. */
const variableRecords = new WeakMap<
  YurisMachine,
  Map<number, {readonly raw: Uint8Array; readonly record: Uint8Array}>
>();

function sameBytes(a: Uint8Array, b: Uint8Array): boolean {
  const length = a.length;
  if (length !== b.length) return false;
  let i = 0;
  if (((a.byteOffset | b.byteOffset) & 3) === 0) {
    const words = length >>> 2,
      x = new Uint32Array(a.buffer, a.byteOffset, words),
      y = new Uint32Array(b.buffer, b.byteOffset, words);
    for (; i < words; i++) if (x[i] !== y[i]) return false;
    i = words << 2;
  }
  for (; i < length; i++) if (a[i] !== b[i]) return false;
  return true;
}

/**
 * 0x44CF61 with a layer (0x44D404): 0x690, the pixel byte count, the CG object and the
 * pixels. Only the buffer size of the object (+0x88, +0x8C; +0xF0, +0xF4 the texture size) is
 * read back by LOAD; the rest of it is written as zeros.
 */
async function layerRecord(cg: YurisCg): Promise<Uint8Array> {
  const size = cg.width * 4 * cg.height,
    w = new ByteWriter();
  w.u32(CG_STRUCT);
  w.u32(size);
  const struct = w.length;
  w.pad(struct + CG_STRUCT);
  w.setU32(struct + 0x88, cg.width);
  w.setU32(struct + 0x8c, cg.height);
  w.setU32(struct + 0xf0, cg.textureWidth);
  w.setU32(struct + 0xf4, cg.textureHeight);
  const pixels = cg.pixels ?? new Uint8Array(0);
  w.bytes(pixels.subarray(0, size));
  w.pad(struct + CG_STRUCT + size);
  const raw = w.result();
  return record(Kind.Layer, 0, raw.length, await compress(raw, SNAPPY_LAYERS));
}

/**
 * 0x44DA6C: block 0x400 from the memory slots. A variable header (kind 0, id 0) whose sizes
 * are the totals, then per slot its length, the stored length and the stored bytes.
 */
async function memorySnapshot(m: YurisMachine, data: YurisSaveData): Promise<number> {
  const w = new ByteWriter();
  w.u8(0);
  w.u8(1);
  w.u16(0);
  w.u32(0);
  let raw = 0,
    stored = 0;
  for (let n = 0; n < SLOTS; n++) raw += 8 + (data.slots.get(n)?.length ?? 0);
  w.u32(raw);
  // Slots are replaced, never written in place, so a slot's stored bytes are reused until
  // SAVE MEM n or LOAD replaces it.
  const packed: (Uint8Array | Promise<Uint8Array> | undefined)[] = [];
  for (let n = 0; n < SLOTS; n++) {
    const slot = data.slots.get(n);
    if (slot?.length) packed[n] = data.packedSlots.get(slot) ?? compress(slot, SNAPPY_MEMORY);
  }
  let results: (Uint8Array | undefined)[];
  try {
    results = await Promise.all(packed);
  } catch {
    m.messageBox(COMPRESS_ERROR);
    return 0;
  }
  for (let n = 0; n < SLOTS; n++) {
    const slot = data.slots.get(n),
      bytes = results[n];
    if (!slot?.length || !bytes) {
      w.u32(0);
      w.u32(0);
      stored += 8;
      continue;
    }
    data.packedSlots.set(slot, bytes);
    w.u32(slot.length);
    w.u32(bytes.length);
    w.bytes(bytes);
    stored += 8 + bytes.length;
  }
  w.setU32(4, stored);
  data.blocks.set(BLOCKS, w.result());
  return 0;
}

/** The group selected by the G_ flags: the category (1..4) and the type (1..3), highest first. */
function groupOf(m: YurisMachine): {category: number; type: number} | null {
  const a = m.args;
  let category = 0,
    type = 0;
  for (let flag = 0; flag < 12; flag++)
    if (a.has(Arg.Groups + flag)) {
      category = Math.max(category, (flag % 4) + 1);
      type = Math.max(type, Math.floor(flag / 4) + 1);
    }
  return category === 0 ? null : {category, type};
}

/**
 * SAVE DNO: the block for one element, a whole variable, a layer or a group. Variable blocks
 * are built synchronously when their records are; a layer block is compressed asynchronously.
 */
function buildBlock(
  m: YurisMachine,
  data: YurisSaveData,
  dno: number,
  cg: YurisCg | null,
): void | Promise<void> {
  const a = m.args;
  if (data.blocks.get(dno)?.length)
    throw new YurisError(0x18f1a, [commandName(m), m.argName(Arg.Dno), dno]);
  const group = groupOf(m);
  if (!group) {
    if (cg) return layerRecord(cg).then((block) => void data.blocks.set(dno, block));
    const slot = a.has(Arg.Set);
    const block = variableRecord(m, a.variable[slot]!, a.variableIndex[slot]!, a.whole[slot] === 1);
    if (block instanceof Uint8Array) data.blocks.set(dno, block);
    else return block.then((b) => void data.blocks.set(dno, b));
    return;
  }
  // Every record is serialized now; only the compression may finish later.
  const entries: (Uint8Array | Promise<Uint8Array>)[] = [];
  for (let id = 0; id < m.variables.entries.length; id++) {
    const variable = m.variables.entries[id]!;
    if (variable.flags !== group.category || variable.type !== group.type) continue;
    entries.push(variableRecord(m, id, 0n, true));
  }
  const finish = (records: readonly Uint8Array[]): void => {
    let total = 0,
      raw = 0;
    for (const entry of records) {
      total += entry.length;
      raw += new DataView(entry.buffer, entry.byteOffset).getUint32(8, true) + 0xc;
    }
    const w = new ByteWriter();
    w.u8(Kind.Group);
    w.u8(1);
    w.u16(0);
    w.u32(total);
    w.u32(raw);
    for (const entry of records) w.bytes(entry);
    data.blocks.set(dno, w.result());
  };
  if (entries.every((e) => e instanceof Uint8Array)) finish(entries as Uint8Array[]);
  else return Promise.all(entries).then(finish);
}

/** The file image of the blocks 1..`last` in DNO order, as a new save file or memory slot. */
function writeBlocks(data: YurisSaveData, last: number): Uint8Array {
  const w = new ByteWriter();
  w.u32(MAGIC);
  w.u32(VERSION);
  w.pad(DATA);
  let count = 0;
  for (let dno = 1; dno <= last; dno++) {
    const block = data.blocks.get(dno);
    if (!block?.length) continue;
    w.setU32(TABLE + (dno - 1) * 4, w.length);
    w.u32(dno);
    w.bytes(block);
    count++;
  }
  w.setU32(8, count);
  w.setU32(12, BLOCKS);
  return w.result();
}

function save(
  m: YurisMachine,
  folder: YurisFolderHost,
  data: YurisSaveData,
): number | Promise<number> {
  const a = m.args;
  m.decode();
  let cg: YurisCg | null = null;
  if (a.has(Arg.Id)) {
    const target = m.layers.target(Arg.Id, Arg.IdNo);
    cg = m.layers.lookup(target.path, target.group)?.payload ?? null;
    if (!cg) throw new YurisError(0x18b82, [commandName(m), target.path]);
  }
  let path: ByteString | null = null;
  if (a.has(Arg.File)) path = savePath(m, a.text(Arg.File));
  let mem = -1;
  if (a.has(Arg.Mem)) {
    mem = low(a.int(Arg.Mem));
    if (mem === SNAPSHOT) return memorySnapshot(m, data);
  }
  // Variable blocks and memory slots complete within the command; only layer compression and
  // file I/O continue asynchronously.
  const built = a.has(Arg.Dno) ? buildBlock(m, data, low(a.int(Arg.Dno)), cg) : undefined;
  return built
    ? built.then(() => store(m, folder, data, mem, path))
    : store(m, folder, data, mem, path);
}

function store(
  m: YurisMachine,
  folder: YurisFolderHost,
  data: YurisSaveData,
  mem: number,
  path: ByteString | null,
): number | Promise<number> {
  if (mem !== -1) {
    // Blocks 1..0x3FE go to the slot (0x3FF and the snapshot 0x400 never do).
    data.storeSlot(mem, writeBlocks(data, BLOCKS - 2));
    data.free(-1);
    return 0;
  }
  if (path === null) return 0;
  return saveFile(m, folder, data, path);
}

async function saveFile(
  m: YurisMachine,
  folder: YurisFolderHost,
  data: YurisSaveData,
  path: ByteString,
): Promise<number> {
  const existing = await folder.readFile(path);
  if (!existing) {
    // 0x44DE10: the save folder is created, then the file is written ("wb").
    await folder.createDirectory(m.system.saveFolder.replace(/\\$/, ''));
    await folder.writeFile(path, writeBlocks(data, BLOCKS));
    data.free(-1);
    return 0;
  }
  return updateFile(m, folder, data, path, existing);
}

/**
 * SAVE FILE on an existing file ("r+b"). When none of the new blocks is in the file already
 * they are appended after its end and listed in its table; otherwise the file is rewritten
 * with each replaced block in place of the old one and the other new blocks after the rest.
 */
async function updateFile(
  m: YurisMachine,
  folder: YurisFolderHost,
  data: YurisSaveData,
  path: ByteString,
  file: Uint8Array,
): Promise<number> {
  const view = new DataView(file.buffer, file.byteOffset, file.byteLength);
  const u32 = (at: number): number => (at + 4 <= file.length ? view.getUint32(at, true) : 0);
  if (u32(0) !== MAGIC) throw new YurisError(0x1a5fe);
  if (u32(4) !== VERSION) throw new YurisError(0x1a608);
  const count = u32(8);
  const table = new Uint32Array(BLOCKS);
  for (let i = 0; i < BLOCKS; i++) table[i] = u32(TABLE + i * 4);
  const fresh = [...data.blocks.keys()].filter(
    (dno) => dno >= 1 && dno <= BLOCKS && data.blocks.get(dno)!.length > 0,
  );
  fresh.sort((x, y) => x - y);
  const header = (w: ByteWriter, total: number): void => {
    w.setU32(8, total);
    w.setU32(12, BLOCKS);
    for (let i = 0; i < BLOCKS; i++) w.setU32(TABLE + i * 4, table[i]!);
  };
  if (!fresh.some((dno) => (table[dno - 1]! | 0) > 0)) {
    // 0x44CBF7: appended at the end. Each offset advances by the block only, not by its
    // DNO word, so the entries after the first one point 4 bytes early per earlier block.
    const w = new ByteWriter();
    w.bytes(file);
    let at = file.length;
    for (const dno of fresh) {
      table[dno - 1] = at;
      const block = data.blocks.get(dno)!;
      at += block.length;
      w.u32(dno);
      w.bytes(block);
    }
    header(w, count + fresh.length);
    await folder.writeFile(path, w.result());
    data.free(-1);
    return 0;
  }
  // 0x44C897: rewritten from the copy read into memory.
  const w = new ByteWriter();
  w.bytes(file.subarray(0, TABLE));
  w.pad(DATA);
  for (let at = DATA; file.length > DATA && at < file.length;) {
    const dno = u32(at) | 0;
    if (dno > BLOCKS) {
      // The file is already truncated ("wb") when the bad record is found.
      await folder.writeFile(path, w.result());
      m.messageBox(INVALID_DNO.replace('%d', String(dno)));
      return -1;
    }
    const replacement = data.blocks.get(dno);
    table[dno - 1] = w.length;
    w.u32(dno);
    const stored = u32(at + 8);
    if (replacement?.length) {
      w.bytes(replacement);
      data.free(dno - 1);
    } else w.bytes(file.subarray(at + 4, at + 0x10 + stored));
    at += 0x10 + stored;
  }
  let added = 0;
  for (let dno = 1; dno <= BLOCKS; dno++) {
    const block = data.blocks.get(dno);
    if (!block?.length) continue;
    table[dno - 1] = w.length;
    w.u32(dno);
    w.bytes(block);
    added++;
  }
  header(w, added > 0 ? count + added : count);
  await folder.writeFile(path, w.result());
  data.free(-1);
  return 0;
}

/** A cursor over a save file or a memory slot (fread / 0x445578..0x445608). */
class ByteReader {
  private readonly view: DataView;
  constructor(
    private readonly data: Uint8Array,
    public at = 0,
  ) {
    this.view = new DataView(data.buffer, data.byteOffset, data.byteLength);
  }
  u8(): number {
    return this.at < this.data.length ? this.data[this.at++]! : (this.at++, 0);
  }
  u16(): number {
    const value = this.at + 2 <= this.data.length ? this.view.getUint16(this.at, true) : 0;
    this.at += 2;
    return value;
  }
  u32(): number {
    const value = this.at + 4 <= this.data.length ? this.view.getUint32(this.at, true) : 0;
    this.at += 4;
    return value;
  }
  bytes(n: number): Uint8Array {
    const out = this.data.subarray(this.at, this.at + n);
    this.at += n;
    return out;
  }
}

/** 0x445504: the uncompressed bytes, or null after the message box of a failed decoder. */
async function uncompress(
  m: YurisMachine,
  stored: Uint8Array,
  zlib: boolean,
): Promise<Uint8Array | null> {
  if (zlib) {
    try {
      return await zlibUncompress(stored);
    } catch {
      m.messageBox('Uncompress Error.');
      return null;
    }
  }
  const out = snappyUncompress(stored);
  if (!out) m.messageBox('Snp Uncompress Error.');
  return out;
}

async function load(
  m: YurisMachine,
  folder: YurisFolderHost,
  data: YurisSaveData,
): Promise<number> {
  const a = m.args;
  m.decode();
  let node: ReturnType<YurisMachine['layers']['lookup']> = null,
    nodePath: ByteString = '';
  if (a.has(Arg.Id)) {
    const target = m.layers.target(Arg.Id, Arg.IdNo);
    nodePath = target.path;
    node = m.layers.lookup(target.path, target.group);
    if (!node) throw new YurisError(0x18b82, [commandName(m), target.path]);
  }
  const mem = a.has(Arg.Mem) ? low(a.int(Arg.Mem)) : -1;
  const slot = a.has(Arg.Set);
  const to = {
    id: slot ? a.variable[slot]! : 0,
    index: slot ? a.variableIndex[slot]! : 0n,
    whole: slot ? a.whole[slot] === 1 : false,
  };
  const dno = low(a.int(Arg.Dno));
  let source: ByteString, reader: ByteReader;
  if (mem === -1) {
    source = savePath(m, a.has(Arg.File) ? a.text(Arg.File) : '');
    const file = await folder.readFile(source);
    if (!file) throw new YurisError(0x18ed4, [commandName(m), m.argName(Arg.File), source]);
    reader = new ByteReader(file);
  } else {
    source = '(mem)';
    reader = new ByteReader(data.slots.get(mem) ?? new Uint8Array(0));
  }
  if (reader.u32() !== MAGIC) throw new YurisError(0x1a5fe);
  if (reader.u32() !== VERSION) throw new YurisError(0x1a608);
  reader.at = dno * 4 + 0xc;
  const offset = reader.u32();
  if (offset === 0) throw new YurisError(0x18ede, [commandName(m), m.argName(Arg.Dno)]);
  reader.at = offset + 4;
  if (mem === -1 && dno === BLOCKS) return restoreMemory(m, data, reader);
  const kind = reader.u8();
  reader.u8();
  reader.u16();
  const storedLength = reader.u32();
  reader.u32();
  const stored = reader.bytes(storedLength);
  const zlib = !SNAPPY_VARIABLES || (kind === Kind.Layer && !SNAPPY_LAYERS);
  const name = decodeCp932(bytesOf(source));
  if (kind !== Kind.Group) {
    const raw = await uncompress(m, stored, zlib);
    if (!raw) return -1;
    if (!node) {
      if (kind === Kind.Layer) throw new YurisError(0x1a612);
      return applyVariable(m, to.id, to.whole, low(to.index), raw, name);
    }
    if (kind === Kind.Variable) throw new YurisError(0x1a644);
    const result = restoreLayer(m, node, nodePath, raw);
    if (result !== 0) return result;
    m.pacer.rebase(m.now());
    return 0;
  }
  const view = new DataView(stored.buffer, stored.byteOffset, stored.byteLength);
  for (let at = 0; at < stored.length;) {
    if (at + 0xc > stored.length) break;
    const id = view.getInt16(at + 2, true),
      length = view.getUint32(at + 4, true);
    const raw = await uncompress(m, stored.subarray(at + 0xc, at + 0xc + length), zlib);
    if (!raw) return -1;
    const result = applyVariable(m, id, true, 0, raw, name);
    if (result !== 0) return result;
    at += 0xc + length;
  }
  // A group load yields the task (0x444EC7).
  return -1;
}

/**
 * 0x445638: LOAD DNO 0x400 from a file refills the memory slots from the snapshot (12
 * header bytes, then per slot its length, the stored length and the zlib data).
 */
async function restoreMemory(
  m: YurisMachine,
  data: YurisSaveData,
  reader: ByteReader,
): Promise<number> {
  reader.at += 12;
  for (let n = 0; n < SLOTS; n++) {
    const length = reader.u32(),
      storedLength = reader.u32();
    if (length === 0) {
      data.slots.delete(n);
      continue;
    }
    const stored = reader.bytes(storedLength);
    let slot: Uint8Array | null = null;
    if (SNAPPY_MEMORY) slot = snappyUncompress(stored);
    else
      try {
        slot = await zlibUncompress(stored);
      } catch {
        slot = null;
      }
    if (!slot) return m.messageBox(SNAPPY_MEMORY ? 'Uncompress Status Error 4.' : 'Load Error.');
    const restored = slot.subarray(0, length);
    data.storeSlot(n, restored, restored.length === slot.length ? stored.slice() : undefined);
  }
  return 0;
}

/**
 * 0x445A11: a variable record into variable `id`. The record's type must be the variable's
 * (error 0x18EE8 names the expected type), its dimension count 0..8, and for a whole variable
 * its dimensions those of the variable. Numbers are copied from element `index` on (clamped
 * to the variable here; natively unchecked). Strings fill elements 0.. in order regardless of
 * `index`, each at most 0x1000 bytes.
 */
function applyVariable(
  m: YurisMachine,
  id: number,
  whole: boolean,
  index: number,
  raw: Uint8Array,
  source: string,
): number {
  const variable = m.variables.get(id);
  const view = new DataView(raw.buffer, raw.byteOffset, raw.byteLength);
  const u32 = (at: number): number => (at + 4 <= raw.length ? view.getInt32(at, true) : 0);
  const type = u32(0);
  if (type !== variable.type) {
    if (type < 1 || type > 3) throw new YurisError(900000);
    const name = [0, INT_NAME, FLT_NAME, STR_NAME][variable.type];
    if (name) throw new YurisError(0x18ee8, [commandName(m), m.commandName(name)]);
    return -1;
  }
  const dimensions = u32(4);
  if (dimensions < 0 || dimensions > 8) throw new YurisError(900000);
  const length = u32(8 + dimensions * 4) >>> 0;
  if (length > MAX_DATA) throw new YurisError(0x1a626);
  let elements = 1;
  if (whole) {
    if (dimensions !== variable.dimensions.length) throw new YurisError(0x1a630);
    for (let i = 0; i < dimensions; i++) {
      if (u32(8 + i * 4) !== variable.dimensions[i]) throw new YurisError(0x1a63a);
      elements *= variable.dimensions[i]!;
    }
  } else if (dimensions > 0) throw new YurisError(0x1a630);
  const data = 0xc + dimensions * 4;
  if (variable.type === YurisType.Int || variable.type === YurisType.Float) {
    const array = variable.type === YurisType.Int ? variable.ints : variable.floats;
    if (!array || index < 0) return 0;
    const target = rawBytes(array),
      start = index * 8,
      n = Math.min(length, target.length - start, raw.length - data);
    if (n > 0) target.set(raw.subarray(data, data + n), start);
    return 0;
  }
  if (variable.type !== YurisType.String) return 0;
  for (let i = 0, at = data; i < elements; i++) {
    const n = u32(at);
    if (n > MAX_STRING) return m.messageBox(INVALID_SAVE.replace('%s', source));
    const text = cString(textOf(raw.subarray(at + 4, at + 4 + n)));
    at += 4 + n;
    // 0x445D48: elements outside the variable are skipped.
    if (variable.has(i)) m.setString(id, BigInt(i), text);
  }
  return 0;
}

/**
 * 0x445810: a layer record replaces the ID layer with a new one of the saved size and pixels.
 * A width above 0x2000 shows a message and reports error 0x186AA.
 */
function restoreLayer(
  m: YurisMachine,
  node: NonNullable<ReturnType<YurisMachine['layers']['lookup']>>,
  path: ByteString,
  raw: Uint8Array,
): number {
  const view = new DataView(raw.buffer, raw.byteOffset, raw.byteLength);
  if (raw.length < 8 || view.getUint32(0, true) !== CG_STRUCT) throw new YurisError(0x1a64e);
  const size = view.getUint32(4, true),
    width = view.getInt32(8 + 0x88, true),
    height = view.getInt32(8 + 0x8c, true);
  if (width > 0x2000) {
    m.messageBox(CG_TOO_LARGE.replace('%d', String(width)).replace('%d', String(height)));
    throw new YurisError(0x186aa, [], false);
  }
  const pixels = new Uint8Array(Math.max(width, 0) * 4 * Math.max(height, 0));
  const from = 8 + CG_STRUCT;
  pixels.set(raw.subarray(from, from + Math.min(size, pixels.length)));
  m.layers.restore(node, path, width, height, pixels);
  return 0;
}
