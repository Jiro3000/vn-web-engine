import {byteDataView} from '../../core/binary.js';
import type {ByteSource} from '../../core/source.js';
import {isOggPageStart, OggPacketAssembler, readOggPage, OGG_CONTINUED} from '../ogg/page.js';
import {readTheoraOgg, type TheoraStream} from '../theora/index.js';

export const omvHeaderSize = 168;
const pageEntrySize = 28;
const frameEntrySize = 32;
const readAheadFrames = 15;
const maxLookaheadBytes = 2 << 20;

export function readOmvHeader(bytes: Uint8Array, size = bytes.length) {
  const header = byteDataView(bytes);
  if (
    bytes.length < omvHeaderSize ||
    header.getUint32(0, true) !== omvHeaderSize ||
    header.getUint16(4, true) !== 257
  )
    throw new Error('Unsupported Siglus OMV header');
  const mode = header.getUint32(40, true);
  const width = header.getUint32(44, true);
  const height = header.getUint32(48, true);
  const frameTime = header.getUint32(60, true) / 1000;
  const pages = header.getUint32(76, true);
  const frames = header.getUint32(80, true);
  const offset = omvHeaderSize + pages * pageEntrySize + frames * frameEntrySize;
  if (mode > 2 || !width || !height || !frameTime || width * height > 16_777_216 || offset >= size)
    throw new Error('Invalid Siglus OMV dimensions or indexes');
  return {mode, width, height, frameTime, pages, frames, offset};
}

type OmvHeader = ReturnType<typeof readOmvHeader>;
interface PageIndex {
  offset: number;
  end: number;
  startPage: number;
  firstFrame: number;
  count: number;
}

/** Reads the indexed pages containing a requested run of frames from the source. */
export class SiglusOmvIndex {
  readonly keyframes: Int32Array;
  private readonly pages: PageIndex[] = [];
  private readonly framePages: Uint32Array;
  private cacheAt = 0;
  private cache: Uint8Array[] = [];

  static async open(
    source: ByteSource,
    header: OmvHeader,
    prefix: Uint8Array,
  ): Promise<{
    index: SiglusOmvIndex;
    stream: TheoraStream;
  }> {
    const table =
      header.offset <= prefix.length
        ? prefix.subarray(omvHeaderSize, header.offset)
        : await source.read(omvHeaderSize, header.offset - omvHeaderSize);
    const index = new SiglusOmvIndex(source, header, byteDataView(table), prefix);
    const firstDataPage = index.pages[index.framePages[0]!]!.startPage;
    const endOfHeaders = index.pages[firstDataPage]!.offset;
    if (endOfHeaders === header.offset) throw new Error('Missing indexed OMV header pages');
    const stream = readTheoraOgg(await index.read(header.offset, endOfHeaders));
    if (stream.packets.length) throw new Error('Unexpected data in indexed OMV header pages');
    index.serial = stream.serial;
    return {index, stream};
  }

  private serial = 0;

  private constructor(
    readonly source: ByteSource,
    header: OmvHeader,
    table: DataView,
    private readonly prefix: Uint8Array,
  ) {
    if (!header.frames || !header.pages) throw new Error('Missing OMV index');
    let offset = header.offset;
    let indexedFrames = 0;
    for (let page = 0; page < header.pages; page++) {
      const entry = page * pageEntrySize;
      const end = offset + table.getUint32(entry + 8, true);
      const startPage = table.getUint32(entry + 16, true);
      const count = table.getUint32(entry + 20, true);
      const firstFrame = table.getInt32(entry + 24, true);
      if (
        table.getUint32(entry + 12, true) !== offset - header.offset ||
        end <= offset ||
        end > source.size ||
        startPage > page
      )
        throw new Error('Invalid OMV page index');
      if (firstFrame >= 0) {
        if (firstFrame !== indexedFrames || !count) throw new Error('Noncontiguous OMV frames');
        indexedFrames += count;
      }
      this.pages.push({offset, end, startPage, firstFrame, count});
      offset = end;
    }
    if (indexedFrames !== header.frames || offset !== source.size)
      throw new Error('Incomplete OMV index');
    this.framePages = new Uint32Array(header.frames);
    this.keyframes = new Int32Array(header.frames);
    let keyframe = -1;
    for (let frame = 0; frame < header.frames; frame++) {
      const entry = header.pages * pageEntrySize + frame * frameEntrySize;
      const page = table.getUint32(entry + 4, true);
      const record = this.pages[page];
      const slot = table.getUint32(entry + 8, true);
      if (
        !record ||
        slot >= record.count ||
        record.firstFrame + slot !== frame ||
        page < (this.framePages[frame - 1] ?? 0)
      )
        throw new Error('Invalid OMV frame index');
      if (table.getUint32(entry + 12, true) & 1) keyframe = frame;
      if (
        keyframe < 0 ||
        keyframe !== table.getUint32(entry + 16, true) ||
        table.getUint32(entry + 20, true) !==
          (keyframe === frame ? page : this.framePages[keyframe])
      )
        throw new Error('Invalid OMV keyframe index');
      this.keyframes[frame] = keyframe;
      this.framePages[frame] = page;
    }
  }

  packet(frame: number): Uint8Array {
    const packet = this.cache[frame - this.cacheAt];
    if (!packet) throw new Error('Missing indexed OMV frame');
    return packet;
  }

  private read(offset: number, end: number): Promise<Uint8Array> {
    if (end <= this.prefix.length) return Promise.resolve(this.prefix.subarray(offset, end));
    return this.source.read(offset, end - offset);
  }

  async load(first: number, last: number): Promise<void> {
    if (first >= this.cacheAt && last < this.cacheAt + this.cache.length) return;
    const start = this.pages[this.framePages[first]!]!.startPage;
    const offset = this.pages[start]!.offset;
    const requiredEnd = this.pages[this.framePages[last]!]!.end;
    const lookahead = last === 0 ? 0 : readAheadFrames;
    let endFrame = Math.min(last + lookahead, this.framePages.length - 1);
    while (this.pages[this.framePages[endFrame]!]!.end > requiredEnd + maxLookaheadBytes)
      endFrame--;
    const end = this.framePages[endFrame]!;
    const bytes = await this.read(offset, this.pages[end]!.end);
    const assembler = new OggPacketAssembler();
    const cache: Uint8Array[] = [];
    for (let number = start; number <= end; number++) {
      const entry = this.pages[number]!;
      const at = entry.offset - offset;
      const page = isOggPageStart(bytes, at) ? readOggPage(bytes, at) : null;
      if (!page || page.bytes.length !== entry.end - entry.offset || page.serial !== this.serial)
        throw new Error('Invalid indexed OMV page');
      const packets = assembler.push(page);
      if (packets.length && (entry.firstFrame < 0 || packets.length !== entry.count))
        throw new Error('Invalid indexed OMV packet count');
      for (const [slot, packet] of packets.entries()) {
        const frame = entry.firstFrame + slot;
        if (frame < first || frame > endFrame) continue;
        if (
          (number === start && slot === 0 && page.flags & OGG_CONTINUED) ||
          frame !== first + cache.length ||
          (packet.length > 0 && !(packet[0]! & 0x40)) !== (this.keyframes[frame] === frame)
        )
          throw new Error('Invalid indexed OMV packet');
        cache.push(packet);
      }
    }
    if (cache.length !== endFrame - first + 1)
      throw new Error('Incomplete indexed OMV frame range');
    this.cache = cache;
    this.cacheAt = first;
  }
}
