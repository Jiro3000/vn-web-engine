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
  const count = byteDataView(await source.read(0, 4)).getUint32(0, true);
  checkRange(source.size, 4, count * 16);
  const table = byteDataView(await source.read(4, count * 16));
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

export function decodeNwa(bytes: Uint8Array): {channels: number; rate: number; pcm: Int16Array} {
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
  const pcm = new Int16Array(samples);
  if (level === -1) {
    checkRange(bytes.length, 44, size);
    // Siglus 1.1.134.0 streams uncompressed 8- and 16-bit PCM directly at 0x71ed90.
    if (bits === 8) {
      for (let i = 0; i < samples; i++) pcm[i] = (bytes[44 + i]! - 128) << 8;
    } else {
      for (let i = 0; i < samples; i++) pcm[i] = view.getInt16(44 + i * 2, true);
    }
    return {channels, rate, pcm};
  }
  checkRange(bytes.length, 44, blocks * 4);
  if (!blocks || (blocks - 1) * blockSamples + lastSamples !== samples)
    throw new Error('Invalid Siglus NWA block sizes');
  const bitsPerDelta = level <= 2 ? 5 - level : 3 + level;
  const baseShift = Math.max(2, 8 - bitsPerDelta);
  let dest = 0;
  for (let i = 0; i < blocks; i++) {
    const start = view.getUint32(44 + i * 4, true);
    const last = i === blocks - 1;
    const end = last ? start + lastBytes : view.getUint32(48 + i * 4, true);
    checkRange(bytes.length, start, end - start);
    if (start + channels * 2 > end) throw new Error('Truncated Siglus NWA predictor');
    const predictor = Array.from({length: channels}, (_, c) => view.getInt16(start + c * 2, true));
    let bit = (start + channels * 2) * 8;
    let repeat = 0;
    const read = (n: number): number => {
      if (bit + n > end * 8) throw new Error('Truncated Siglus NWA code');
      const index = bit >>> 3;
      const word = bytes[index]! | ((index + 1 < end ? bytes[index + 1]! : 0) << 8);
      const value = (word >>> (bit & 7)) & ((1 << n) - 1);
      bit += n;
      return value;
    };
    const count = last ? lastSamples : blockSamples;
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
      pcm[dest++] = predictor[channel]!;
    }
  }
  return {channels, rate, pcm};
}
