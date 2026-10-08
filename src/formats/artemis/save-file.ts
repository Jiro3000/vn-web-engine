/** Artemis save files (saveg.dat, system.dat and scenario saves).
 *
 * Container (writer 0x14013f940, reader 0x14013fde0): "BOW", a one-byte kind ('G' global,
 * 'X' system, 'S' scenario), uint32 version, then for version 1002 and later the uint32
 * archive size and the zlib-wrapped archive (deflateInit2 level 9, window 15). Versions
 * 1001 store the archive uncompressed after the version. The writer emits 1003. Readers
 * accept 1000..1099; 1000 uses the scope-less legacy archive, which is not supported here.
 *
 * Archive (0x140008940, 0x14018e1e0, 0x14018d6c0, 0x14018d9f0): little-endian uint32 values
 * and length-prefixed byte strings. Sections record the stream offset for a numeric id in
 * the current scope. Closing the archive appends the scope table (uint32 scope count; per
 * scope uint32 start, uint32 section count, then id/offset pairs) and the table offset.
 */

export type ArtemisSaveKind = 'G' | 'X' | 'S';
export const ARTEMIS_SAVE_VERSION = 1003;

export class ArtemisSaveArchiveWriter {
  private bytes = new Uint8Array(256);
  private length = 0;
  private readonly sections = new Map<number, number>();
  private reserve(count: number): void {
    if (this.length + count <= this.bytes.length) return;
    let size = this.bytes.length * 2;
    while (size < this.length + count) size *= 2;
    const grown = new Uint8Array(size);
    grown.set(this.bytes.subarray(0, this.length));
    this.bytes = grown;
  }
  /** 0x140008940 with a nonzero id: id → current offset in the current scope. */
  section(id: number): void {
    this.sections.set(id >>> 0, this.length);
  }
  u32(value: number): void {
    this.reserve(4);
    new DataView(this.bytes.buffer).setUint32(this.length, value >>> 0, true);
    this.length += 4;
  }
  /** 0x14009d150: uint32 length, then the bytes. */
  string(value: Uint8Array): void {
    this.u32(value.length);
    this.reserve(value.length);
    this.bytes.set(value, this.length);
    this.length += value.length;
  }
  /** 0x14013f940 archive close: the single root scope (start 0) and the table offset. */
  finish(): Uint8Array {
    const table = this.length;
    this.u32(1);
    this.u32(0);
    this.u32(this.sections.size);
    for (const [id, offset] of this.sections) {
      this.u32(id);
      this.u32(offset);
    }
    this.u32(table);
    return this.bytes.slice(0, this.length);
  }
}

export class ArtemisSaveArchiveReader {
  private offset = 0;
  private readonly view: DataView;
  private readonly sections = new Map<number, number>();
  constructor(private readonly bytes: Uint8Array) {
    this.view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
    if (bytes.length < 4) throw new Error('Truncated Artemis save archive');
    this.offset = this.view.getUint32(bytes.length - 4, true);
    const scopes = this.u32();
    // 0x14018d6c0 orders scopes by start and makes the first one current.
    let first: {start: number; sections: Map<number, number>} | null = null;
    for (let scope = 0; scope < scopes; scope++) {
      const start = this.u32(),
        count = this.u32(),
        sections = new Map<number, number>();
      for (let index = 0; index < count; index++) {
        const id = this.u32();
        sections.set(id, this.u32());
      }
      if (!first || start < first.start) first = {start, sections};
    }
    if (scopes !== 1 || !first || first.start !== 0)
      throw new Error('Unsupported nested Artemis save archive scopes');
    for (const [id, offset] of first.sections) this.sections.set(id, offset);
    this.offset = 0;
  }
  /** 0x14018d9f0: false when the current scope has no such section. */
  seek(id: number): boolean {
    const offset = this.sections.get(id >>> 0);
    if (offset === undefined) return false;
    this.offset = offset;
    return true;
  }
  u32(): number {
    if (this.offset + 4 > this.bytes.length) throw new Error('Truncated Artemis save archive');
    const value = this.view.getUint32(this.offset, true);
    this.offset += 4;
    return value;
  }
  string(): Uint8Array {
    const length = this.u32();
    if (this.offset + length > this.bytes.length) throw new Error('Truncated Artemis save archive');
    const value = this.bytes.slice(this.offset, this.offset + length);
    this.offset += length;
    return value;
  }
}

async function transform(bytes: Uint8Array, stream: TransformStream<BufferSource, Uint8Array>) {
  const output = new Blob([Uint8Array.from(bytes)]).stream().pipeThrough(stream);
  return new Uint8Array(await new Response(output).arrayBuffer());
}

export async function packArtemisSaveFile(
  kind: ArtemisSaveKind,
  archive: Uint8Array,
): Promise<Uint8Array> {
  const compressed = await transform(archive, new CompressionStream('deflate'));
  const file = new Uint8Array(12 + compressed.length);
  file.set([0x42, 0x4f, 0x57, kind.charCodeAt(0)]);
  const view = new DataView(file.buffer);
  view.setUint32(4, ARTEMIS_SAVE_VERSION, true);
  view.setUint32(8, archive.length, true);
  file.set(compressed, 12);
  return file;
}

export interface ArtemisSaveFile {
  readonly kind: string;
  readonly version: number;
  readonly archive: Uint8Array;
}

/** Null where 0x14013fde0 returns failure: short files, unknown headers and versions
 * outside 1000..1099 (headerless legacy files read as version 0 and are refused too). */
export async function unpackArtemisSaveFile(bytes: Uint8Array): Promise<ArtemisSaveFile | null> {
  if (bytes.length < 8) return null;
  if (bytes[0] !== 0x42 || bytes[1] !== 0x4f || bytes[2] !== 0x57) return null;
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const version = view.getUint32(4, true),
    kind = String.fromCharCode(bytes[3]!);
  if (version - 1000 > 99 || version < 1000) return null;
  if (version === 1000) throw new Error('Unsupported legacy Artemis save archive version 1000');
  if (version < 1002) return {kind, version, archive: bytes.slice(8)};
  if (bytes.length < 12) throw new Error('Truncated Artemis save file');
  const size = view.getUint32(8, true);
  const archive = await transform(bytes.subarray(12), new DecompressionStream('deflate'));
  if (archive.length !== size) throw new Error('Artemis save archive size mismatch');
  return {kind, version, archive};
}
