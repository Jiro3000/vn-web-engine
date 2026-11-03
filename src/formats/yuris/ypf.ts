import {ByteView, checkRange} from '../../core/binary.js';
import type {ByteSource} from '../../core/source.js';
import {murmurHash2} from './murmur.js';

/**
 * YU-RIS `YPF` archives. Addresses refer to `hajiron.exe` (see the engine README).
 *
 * Header (0x464A3C): `YPF\0`, version, entry count, index size, 16 reserved bytes. Versions
 * 0x22B and 0xEA and later open. Each index entry from offset 0x20 (read by 0x46436C) is: name hash (MurmurHash2 of the stored name), the encoded name length byte, the
 * encoded name, a type byte, a compression flag, the unpacked size, the stored size, a 64-bit
 * data offset and the MurmurHash2 of the stored bytes (checked in 0x41BCA8).
 */
export interface YpfEntry {
  /** Display name, decoded from Shift-JIS. */
  readonly name: string;
  /** The stored name as a byte string (one char per byte), the lookup key. */
  readonly key: string;
  /** Name bytes as stored (Shift-JIS), the key the native lookup hashes and compares. */
  readonly nameBytes: Uint8Array;
  readonly nameHash: number;
  readonly type: number;
  /** 1: zlib stream (inflated by YSZLB's `uncompress`), 0: stored. */
  readonly compression: number;
  readonly size: number;
  readonly storedSize: number;
  readonly offset: number;
  readonly dataHash: number;
}

/**
 * The name length table built by 0x468D20: the identity
 * permutation of 0..255 with twelve pairs swapped. A stored length byte `b` decodes to
 * `table[0xFF - b]` (the native reads `(0x6603FF)[-b]`).
 */
const LENGTH_TABLE = (() => {
  const table = Uint8Array.from({length: 256}, (_, i) => i);
  const pairs = [
    [0x03, 0x0a],
    [0x06, 0x35],
    [0x09, 0x0b],
    [0x0c, 0x10],
    [0x0d, 0x13],
    [0x11, 0x18],
    [0x15, 0x1b],
    [0x1c, 0x1e],
    [0x20, 0x23],
    [0x26, 0x29],
    [0x2c, 0x2f],
    [0x2e, 0x14],
  ];
  for (const [a, b] of pairs) [table[a!], table[b!]] = [table[b!]!, table[a!]!];
  return table;
})();

export function ypfNameLength(encoded: number): number {
  return LENGTH_TABLE[0xff - encoded]!;
}

/** Name bytes are stored as `(0xFF - c) ^ 0x36`. */
function decodeName(bytes: Uint8Array): Uint8Array {
  return bytes.map((b) => ((0xff - b) ^ 0x36) & 0xff);
}

const shiftJis = new TextDecoder('shift-jis');

export class YpfArchive {
  private constructor(
    readonly source: ByteSource,
    readonly version: number,
    readonly entries: readonly YpfEntry[],
  ) {}

  /**
   * Whether `source` starts with the YPF signature. Registration (0x464A3C) skips other files
   * named `*.ypf` without an error; the installation's movies are such files.
   */
  static async isArchive(source: ByteSource): Promise<boolean> {
    if (source.size < 0x20) return false;
    return new ByteView(await source.read(0, 4), {littleEndian: true}).u32(0) === 0x465059;
  }

  static async open(source: ByteSource): Promise<YpfArchive> {
    if (source.size < 0x20) throw new Error('Not a YPF archive');
    const header = new ByteView(await source.read(0, 0x20), {littleEndian: true});
    if (header.u32(0) !== 0x465059) throw new Error('Not a YPF archive');
    const version = header.u32(4),
      count = header.u32(8),
      indexSize = header.u32(12);
    if (version !== 0x22b && version < 0xea)
      throw new Error(`Unsupported YPF version ${version}`);
    checkRange(source.size, 0x20, indexSize);
    const index = new ByteView(await source.read(0x20, indexSize), {littleEndian: true});
    const entries: YpfEntry[] = [];
    let p = 0;
    for (let i = 0; i < count; i++) {
      const nameHash = index.u32(p),
        length = ypfNameLength(index.u8(p + 4));
      const nameBytes = decodeName(index.range(p + 5, length));
      p += 5 + length;
      const offset = index.u64(p + 10);
      if (offset > BigInt(Number.MAX_SAFE_INTEGER)) throw new Error(`YPF entry ${i}: bad offset`);
      const entry: YpfEntry = {
        name: shiftJis.decode(nameBytes),
        key: byteString(nameBytes),
        nameBytes,
        nameHash,
        type: index.u8(p),
        compression: index.u8(p + 1),
        size: index.u32(p + 2),
        storedSize: index.u32(p + 6),
        offset: Number(offset),
        dataHash: index.u32(p + 18),
      };
      checkRange(source.size, entry.offset, entry.storedSize);
      entries.push(entry);
      p += 22;
    }
    return new YpfArchive(source, version, entries);
  }

  /** The stored bytes of `entry`. */
  readStored(entry: YpfEntry, signal?: AbortSignal): Promise<Uint8Array> {
    return this.source.read(entry.offset, entry.storedSize, signal);
  }

  /** The file contents: stored bytes, inflated when the entry is compressed (0x41B7F0). */
  async read(entry: YpfEntry, signal?: AbortSignal): Promise<Uint8Array> {
    const stored = await this.readStored(entry, signal);
    if (entry.compression === 0) return stored;
    if (entry.compression !== 1)
      throw new Error(`${entry.name}: unknown YPF compression ${entry.compression}`);
    const bytes = await inflateZlib(stored);
    if (bytes.length !== entry.size)
      throw new Error(`${entry.name}: inflated ${bytes.length} bytes, expected ${entry.size}`);
    return bytes;
  }
}

/** Whether the stored bytes match the index's data hash. */
export function ypfDataMatches(entry: YpfEntry, stored: Uint8Array): boolean {
  return murmurHash2(stored) === entry.dataHash;
}

/** Whether the index's name hash is the hash of the stored name. */
export function ypfNameMatches(entry: YpfEntry): boolean {
  return murmurHash2(entry.nameBytes) === entry.nameHash;
}

async function inflateZlib(bytes: Uint8Array): Promise<Uint8Array> {
  const stream = new Blob([bytes as Uint8Array<ArrayBuffer>])
    .stream()
    .pipeThrough(new DecompressionStream('deflate'));
  return new Uint8Array(await new Response(stream).arrayBuffer());
}

export interface YpfFileRef {
  readonly archive: YpfArchive;
  readonly archiveIndex: number;
  readonly entry: YpfEntry;
}

/**
 * The game's archive set. 0x46436C registers `pac\*.ypf` first (directory order, 0x464D50)
 * and then `update1.ypf`..`update9.ypf`; an entry whose hash and name repeat one from an
 * earlier archive of an `updateN` archive disables the earlier one, any other duplicate is
 * an error (message 0x196D6). Lookup (0x440858) hashes the requested name exactly and then
 * compares the stored name with `_stricmp` (0x46F350), so a hit needs the exact stored bytes.
 */
export class YpfFileSystem {
  private readonly byName = new Map<string, YpfFileRef>();
  constructor(
    readonly archives: readonly {readonly name: string; readonly archive: YpfArchive}[],
  ) {
    archives.forEach(({name, archive}, archiveIndex) => {
      const update = /^update[1-9]\.ypf$/i.test(name);
      for (const entry of archive.entries) {
        if (this.byName.has(entry.key) && !update)
          throw new Error(`Duplicate YPF entry ${entry.name} in ${name}`);
        this.byName.set(entry.key, {archive, archiveIndex, entry});
      }
    });
  }
  get size(): number {
    return this.byName.size;
  }
  files(): IterableIterator<YpfFileRef> {
    return this.byName.values();
  }
  /** `name` is a byte string of the Shift-JIS path (ASCII paths are themselves). */
  find(name: string): YpfFileRef | undefined {
    return this.byName.get(name);
  }
  async read(name: string): Promise<Uint8Array> {
    const ref = this.find(name);
    if (!ref) throw new Error(`File not found: ${shiftJis.decode(byteStringBytes(name))}`);
    return ref.archive.read(ref.entry);
  }
}

/** One char per byte, for Shift-JIS keys that must compare byte for byte. */
export function byteString(bytes: Uint8Array): string {
  let s = '';
  for (let i = 0; i < bytes.length; i += 0x2000)
    s += String.fromCharCode(...bytes.subarray(i, i + 0x2000));
  return s;
}
export function byteStringBytes(s: string): Uint8Array {
  return Uint8Array.from(s, (c) => c.charCodeAt(0) & 0xff);
}
