import {OGG_FIRST_PAGE, isOggPageStart, readOggPage} from '../formats/ogg/page.js';
import type {VorbisPcm16} from './vorbis-pcm16.js';

/** Opus always decodes at 48 kHz (`op_read`). */
export const OPUS_SAMPLE_RATE = 48000;

/** The parts of an Ogg Opus file that `op_open_callbacks` and `op_pcm_total` report. */
export interface OggOpusInfo {
  /** Chained Opus streams (`op_link_count`). */
  readonly links: number;
  /** OpusHead of the first link. */
  readonly channels: number;
  readonly preSkip: number;
  /** `op_pcm_total(of, -1)` in 48 kHz samples; negative when the granules are invalid. */
  readonly frames: number;
}

/**
 * The number of 48 kHz samples in an Opus packet from its TOC byte (RFC 6716 3.1,
 * `opus_packet_get_nb_samples`); 0 for an empty or malformed packet.
 */
export function opusPacketSamples(packet: Uint8Array): number {
  if (packet.length === 0) return 0;
  const toc = packet[0]!;
  const config = toc >> 3;
  const frameSize =
    config < 12
      ? [480, 960, 1920, 2880][config & 3]!
      : config < 16
        ? [480, 960][config & 1]!
        : [120, 240, 480, 960][config & 3]!;
  const code = toc & 3;
  let frames: number;
  if (code === 0) frames = 1;
  else if (code !== 3) frames = 2;
  else if (packet.length < 2) return 0;
  else frames = packet[1]! & 0x3f;
  const samples = frames * frameSize;
  return samples > 5760 ? 0 : samples;
}

/**
 * Reads the OpusHead, the link count and the PCM length the way opusfile does: the first
 * link's start is the granule of its first audio page less the samples of the packets that end
 * on it (`op_find_initial_pcm_offset`, at least 0), and the total is the final granule less
 * that start and the pre-skip. Returns null when the file has no Opus stream.
 */
export function readOggOpus(bytes: Uint8Array): OggOpusInfo | null {
  let serial = -1;
  let channels = 0;
  let preSkip = 0;
  let links = 0;
  let headers = 0;
  let start: bigint | null = null;
  let last = -1n;
  let pending = 0;
  let packet: number[] = [];
  for (let offset = 0; offset < bytes.length;) {
    if (!isOggPageStart(bytes, offset)) {
      offset++;
      continue;
    }
    const page = readOggPage(bytes, offset);
    if (!page) break;
    offset += page.bytes.length;
    const body = page.bytes.subarray(page.bodyOffset);
    if (page.flags & OGG_FIRST_PAGE) {
      const head =
        body.length >= 19 &&
        String.fromCharCode(...body.subarray(0, 8)) === 'OpusHead' &&
        (body[8]! & 0xf0) === 0;
      if (!head) continue;
      if (serial !== -1 && links > 0 && headers < 2) continue;
      links++;
      if (links === 1) {
        channels = body[9]!;
        preSkip = body[10]! | (body[11]! << 8);
      }
      serial = page.serial;
      headers = 1;
      packet = [];
      continue;
    }
    if (page.serial !== serial) continue;
    if (headers < 2) {
      // OpusTags ends on the first page whose last segment is shorter than 255 bytes.
      if (page.lacing.length > 0 && page.lacing[page.lacing.length - 1]! < 255) headers = 2;
      continue;
    }
    if (links === 1 && start === null) {
      let p = 0;
      for (const length of page.lacing) {
        for (let i = 0; i < length; i++) packet.push(body[p + i]!);
        p += length;
        if (length < 255) {
          pending += opusPacketSamples(Uint8Array.from(packet));
          packet = [];
        }
      }
      if (page.granule >= 0n) {
        start = page.granule - BigInt(pending);
        if (start < 0n) start = 0n;
      }
    }
    if (page.granule >= 0n) last = page.granule;
  }
  if (links === 0) return null;
  const frames = start === null || last < 0n ? -1 : Number(last - start) - preSkip;
  return {links, channels, preSkip, frames};
}

let decoder: OfflineAudioContext | null = null;

/** A shared context for `decodeAudioData` at 48 kHz, or null outside a browser. */
function opusDecoder(): OfflineAudioContext | null {
  if (decoder) return decoder;
  if (typeof OfflineAudioContext === 'undefined') return null;
  try {
    decoder = new OfflineAudioContext(1, 1, OPUS_SAMPLE_RATE);
  } catch {
    return null;
  }
  return decoder;
}

/** Signed 16-bit quantisation, round half to even and clamped. */
function interleave(out: Int16Array, buffer: AudioBuffer, frames: number): void {
  const channels = Math.min(buffer.numberOfChannels, out.length / Math.max(frames, 1));
  for (let channel = 0; channel < channels; channel++) {
    const plane = buffer.getChannelData(channel);
    const count = Math.min(frames, plane.length);
    for (let i = 0, o = channel; i < count; i++, o += channels) {
      const x = Math.fround(plane[i]! * 32768);
      let value = Math.round(x);
      if (value - x === 0.5 && (value & 1) !== 0) value -= 1;
      out[o] = value > 32767 ? 32767 : value < -32768 ? -32768 : value;
    }
  }
}

/**
 * Opens an Ogg Opus file as 16-bit PCM of `info.frames` frames. The browser's decoder
 * (`decodeAudioData` at 48 kHz, which applies the pre-skip and end trim) fills the buffer
 * after it opens; `waitForFrames` holds readers until then. Without a browser decoder the
 * PCM stays silent at its full length.
 */
export function openOpusPcm16(bytes: Uint8Array, info: OggOpusInfo): VorbisPcm16 {
  const frames = Math.max(0, info.frames);
  const channels = Math.max(1, info.channels);
  const pcm = new Uint8Array(frames * channels * 2);
  const context = opusDecoder();
  if (!context || frames === 0) return {bytes: pcm, frames, sampleRate: OPUS_SAMPLE_RATE, channels};
  let done = false;
  let closed = false;
  const ready = context
    .decodeAudioData(bytes.slice().buffer)
    .then((buffer) => {
      if (closed) return;
      const samples = new Int16Array(pcm.buffer, 0, frames * channels);
      interleave(samples, buffer, frames);
      if (new Uint8Array(new Uint16Array([1]).buffer)[0] !== 1)
        for (let i = 0; i < pcm.length; i += 2) [pcm[i], pcm[i + 1]] = [pcm[i + 1]!, pcm[i]!];
    })
    .catch(() => {
      // A file the browser cannot decode plays as silence of its native length.
    })
    .finally(() => {
      done = true;
    });
  return {
    bytes: pcm,
    frames,
    sampleRate: OPUS_SAMPLE_RATE,
    channels,
    waitForFrames: () => (done ? undefined : ready.then(() => true)),
    close: () => {
      closed = true;
    },
  };
}
