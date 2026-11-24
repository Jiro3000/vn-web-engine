import {byteDataView, checkRange} from '../../core/binary.js';
import type {ByteSource} from '../../core/source.js';
import {xorByteInPlace} from './compression.js';

/** OWP stores an Ogg bitstream with a constant bytewise XOR mask. */
export function decodeOwp(bytes: Uint8Array<ArrayBuffer>): Uint8Array<ArrayBuffer> {
  const key = (bytes[0] ?? 0) ^ 0x4f;
  if (
    bytes.length < 4 ||
    (bytes[1]! ^ key) !== 0x67 ||
    (bytes[2]! ^ key) !== 0x67 ||
    (bytes[3]! ^ key) !== 0x53
  )
    throw new Error('Invalid Siglus OWP stream');
  if (key === 0) return bytes;
  const out = new Uint8Array(bytes.length);
  out.set(bytes);
  xorByteInPlace(out, key);
  return out;
}

export interface OvKEntry {
  offset: number;
  size: number;
}

export async function ovkIndex(source: ByteSource): Promise<Map<number, OvKEntry>> {
  checkRange(source.size, 0, 4);
  const initial = await source.read(0, Math.min(source.size, 16384));
  const count = byteDataView(initial).getUint32(0, true);
  const tableBytes = count * 16;
  checkRange(source.size, 4, tableBytes);
  let table: DataView;
  if (4 + tableBytes <= initial.byteLength) {
    table = byteDataView(initial.subarray(4, 4 + tableBytes));
  } else {
    const combined = new Uint8Array(tableBytes);
    const have = initial.byteLength - 4;
    combined.set(initial.subarray(4));
    combined.set(await source.read(initial.byteLength, tableBytes - have), have);
    table = byteDataView(combined);
  }
  const entries = new Map<number, OvKEntry>();
  for (let i = 0; i < table.byteLength; i += 16) {
    const size = table.getUint32(i, true);
    const offset = table.getUint32(i + 4, true);
    checkRange(source.size, offset, size);
    entries.set(table.getUint32(i + 8, true), {offset, size});
  }
  return entries;
}

export async function readOvk(
  source: ByteSource,
  entry: OvKEntry,
): Promise<Uint8Array<ArrayBuffer>> {
  const bytes = new Uint8Array(await source.read(entry.offset, entry.size));
  const key = bytes[0]! ^ 0x4f;
  if (key) xorByteInPlace(bytes, key);
  if (byteDataView(bytes).getUint32(0, false) !== 0x4f676753)
    throw new Error('Invalid Siglus OVK stream');
  return bytes;
}

const nwaHeaderSize = 44;

function nwaHeader(bytes: Uint8Array) {
  checkRange(bytes.length, 0, nwaHeaderSize);
  const view = byteDataView(bytes);
  const channels = view.getUint16(0, true);
  const bits = view.getUint16(2, true);
  const rate = view.getUint32(4, true);
  const level = view.getInt32(8, true);
  const runs = view.getInt32(12, true);
  const blocks = view.getUint32(16, true);
  const size = view.getUint32(20, true);
  const samples = view.getUint32(28, true);
  const blockSamples = view.getUint32(32, true);
  const lastSamples = view.getUint32(36, true);
  const lastBytes = view.getUint32(40, true);
  const sampleBytes = bits / 8;
  if (
    (channels !== 1 && channels !== 2) ||
    (bits !== 16 && !(bits === 8 && level === -1)) ||
    !rate ||
    size !== samples * sampleBytes ||
    samples * 2 > 128 * 1024 * 1024 ||
    samples % channels ||
    level < -1 ||
    level > 5
  )
    throw new Error('Invalid Siglus NWA header');
  if (level >= 0 && (!blocks || !blockSamples || blockSamples % channels ||
      !lastSamples || lastSamples > blockSamples || (blocks - 1) * blockSamples + lastSamples !== samples))
    throw new Error('Invalid Siglus NWA block sizes');
  return {channels, bits, rate, level, runs, blocks, size, samples, blockSamples, lastSamples, lastBytes, sampleBytes};
}

type NwaHeader = ReturnType<typeof nwaHeader>;

function nwaPcm(bytes: Uint8Array, sampleBytes: number, output: Int16Array): void {
  if (sampleBytes === 1) {
    for (let i = 0; i < output.length; i++) output[i] = (bytes[i]! - 128) << 8;
  } else {
    const view = byteDataView(bytes);
    for (let i = 0; i < output.length; i++) output[i] = view.getInt16(i * 2, true);
  }
}

function nwaBlock(
  bytes: Uint8Array,
  view: DataView,
  start: number,
  end: number,
  {channels, level, runs}: NwaHeader,
  pcm: Int16Array,
  destination: number,
  count: number,
): void {
  checkRange(bytes.length, start, end - start);
  if (start + channels * 2 > end) throw new Error('Truncated Siglus NWA predictor');
  const bitsPerDelta = level <= 2 ? 5 - level : 3 + level;
  const baseShift = Math.max(2, 8 - bitsPerDelta);
  const predictor = Array.from({length: channels}, (_, c) => view.getInt16(start + c * 2, true));
  let bit = channels * 16;
  const bitLength = (end - start) * 8;
  let repeat = 0;
  const read = (n: number): number => {
    if (bit + n > bitLength) throw new Error('Truncated Siglus NWA code');
    const index = start + (bit >>> 3);
    const word = bytes[index]! | ((index + 1 < end ? bytes[index + 1]! : 0) << 8);
    const value = (word >>> (bit & 7)) & ((1 << n) - 1);
    bit += n;
    return value;
  };
  for (let sample = 0; sample < count; sample++) {
    const channel = sample % channels;
    if (repeat) repeat--;
    else {
      const code = read(3);
      if (code === 0) {
        if (runs) {
          repeat = read(1);
          if (repeat) repeat = read(2);
          if (repeat === 3) repeat = read(8);
        }
      } else if (code === 7 && read(1)) predictor[channel] = 0;
      else {
        const width = code === 7 ? Math.min(8, bitsPerDelta + 3) : bitsPerDelta;
        const shift = code === 7 ? 17 - width : baseShift + code - 1;
        const sign = 1 << (width - 1);
        const raw = read(width);
        const delta = (raw & (sign - 1)) << shift;
        predictor[channel] = predictor[channel]! + (raw & sign ? -delta : delta);
      }
    }
    pcm[destination + sample] = predictor[channel]!;
  }
}

export function decodeNwa(bytes: Uint8Array): {channels: number; rate: number; pcm: Int16Array} {
  const header = nwaHeader(bytes);
  const {channels, rate, level, samples, blocks, blockSamples, lastSamples, lastBytes, sampleBytes, size} = header;
  const pcm = new Int16Array(samples);
  if (level === -1) {
    checkRange(bytes.length, nwaHeaderSize, size);
    nwaPcm(bytes.subarray(nwaHeaderSize), sampleBytes, pcm);
    return {channels, rate, pcm};
  }
  checkRange(bytes.length, nwaHeaderSize, blocks * 4);
  const view = byteDataView(bytes);
  for (let i = 0; i < blocks; i++) {
    const start = view.getUint32(nwaHeaderSize + i * 4, true);
    const last = i === blocks - 1;
    const end = last ? start + lastBytes : view.getUint32(nwaHeaderSize + (i + 1) * 4, true);
    nwaBlock(bytes, view, start, end, header, pcm, i * blockSamples, last ? lastSamples : blockSamples);
  }
  return {channels, rate, pcm};
}

/** Seekable interleaved PCM. A read fetches only the encoded blocks it overlaps. */
export async function openNwa(source: ByteSource, signal?: AbortSignal) {
  const header = nwaHeader(await source.read(0, nwaHeaderSize, signal));
  const {channels, rate, blocks, samples, size, sampleBytes, blockSamples, lastBytes, level} = header;
  const frames = samples / channels;
  let table: DataView | undefined;
  if (level === -1) checkRange(source.size, nwaHeaderSize, size);
  else {
    checkRange(source.size, nwaHeaderSize, blocks * 4);
    table = byteDataView(await source.read(nwaHeaderSize, blocks * 4, signal));
    let previous = nwaHeaderSize + blocks * 4 - 1;
    for (let i = 0; i < blocks; i++) {
      const offset = table.getUint32(i * 4, true);
      if (offset <= previous) throw new Error('Invalid Siglus NWA block offsets');
      previous = offset;
    }
    checkRange(source.size, previous, lastBytes);
  }

  return {
    channels, rate, frames,
    async read(frame: number, count: number, signal?: AbortSignal): Promise<Int16Array> {
      checkRange(frames, frame, count);
      signal?.throwIfAborted();
      if (!count) return new Int16Array();
      const first = frame * channels;
      const length = count * channels;
      if (!table) {
        const pcm = new Int16Array(length);
        const bytes = await source.read(nwaHeaderSize + first * sampleBytes, length * sampleBytes, signal);
        nwaPcm(bytes, sampleBytes, pcm);
        return pcm;
      }
      const from = Math.floor(first / blockSamples);
      const to = Math.ceil((first + length) / blockSamples);
      const start = table.getUint32(from * 4, true);
      const end = to === blocks ? table.getUint32((to - 1) * 4, true) + lastBytes : table.getUint32(to * 4, true);
      const bytes = await source.read(start, end - start, signal);
      const view = byteDataView(bytes);
      const pcm = new Int16Array(Math.min(samples, to * blockSamples) - from * blockSamples);
      for (let i = from; i < to; i++) {
        const offset = table.getUint32(i * 4, true) - start;
        const limit = i + 1 === to ? bytes.length : table.getUint32((i + 1) * 4, true) - start;
        const destination = (i - from) * blockSamples;
        nwaBlock(bytes, view, offset, limit, header, pcm, destination, Math.min(blockSamples, pcm.length - destination));
      }
      const cursor = first - from * blockSamples;
      return pcm.subarray(cursor, cursor + length);
    },
  };
}
