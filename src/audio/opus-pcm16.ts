import {
  OGG_FIRST_PAGE,
  OggPacketAssembler,
  isOggPageStart,
  readOggPage,
} from '../formats/ogg/page.js';
import {interleavePcm16, type VorbisPcm16} from './vorbis-pcm16.js';

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

/** The OpusHead packet and the audio packets of the first link, in stream order. */
function opusPackets(bytes: Uint8Array): {head: Uint8Array; packets: Uint8Array[]} | null {
  const assembler = new OggPacketAssembler();
  const packets: Uint8Array[] = [];
  let serial = -1;
  for (let offset = 0; offset < bytes.length;) {
    if (!isOggPageStart(bytes, offset)) {
      offset++;
      continue;
    }
    const page = readOggPage(bytes, offset);
    if (!page) break;
    offset += page.bytes.length;
    if (serial === -1) {
      const body = page.bytes.subarray(page.bodyOffset);
      if (
        !(page.flags & OGG_FIRST_PAGE) ||
        String.fromCharCode(...body.subarray(0, 8)) !== 'OpusHead'
      )
        continue;
      serial = page.serial;
    } else if (page.serial !== serial) continue;
    else if (page.flags & OGG_FIRST_PAGE) break;
    packets.push(...assembler.push(page));
  }
  // OpusHead, OpusTags, then audio.
  if (packets.length < 2) return null;
  return {head: packets[0]!, packets: packets.slice(2)};
}

/** Decodes requested ahead of the decoder's output. */
const OPUS_QUEUE = 32;

/**
 * Feeds the packets of a mono or stereo stream (channel mapping family 0, no output gain) to
 * a WebCodecs `AudioDecoder` (libopus, the decoder opusfile wraps) in order and calls `output`
 * with each decoded block's planes and its position in decoded samples, the pre-skip
 * included. Resolves true when the stream has been flushed, false when the decoder failed or
 * is unavailable.
 */
function decodeOpusStream(
  packets: readonly Uint8Array[],
  channels: number,
  output: (planes: Float32Array[], at: number, frames: number) => void,
  cancelled: () => boolean,
): Promise<boolean> {
  if (typeof AudioDecoder === 'undefined' || typeof EncodedAudioChunk === 'undefined')
    return Promise.resolve(false);
  return new Promise<boolean>((resolve) => {
    let position = 0;
    let next = 0;
    let timestamp = 0;
    let settled = false;
    const planes = Array.from({length: channels}, () => new Float32Array(5760));
    const settle = (ok: boolean) => {
      if (settled) return;
      settled = true;
      if (codec.state !== 'closed') codec.close();
      resolve(ok);
    };
    const codec = new AudioDecoder({
      output(data) {
        try {
          if (settled || cancelled()) return;
          const frames = data.numberOfFrames;
          if (data.numberOfChannels !== channels || data.sampleRate !== OPUS_SAMPLE_RATE)
            return settle(false);
          for (let c = 0; c < channels; c++) {
            if (planes[c]!.length < frames) planes[c] = new Float32Array(frames);
            data.copyTo(planes[c]!, {planeIndex: c, format: 'f32-planar'});
          }
          output(planes, position, frames);
          position += frames;
        } catch {
          settle(false);
        } finally {
          data.close();
        }
      },
      error: () => settle(false),
    });
    const feed = () => {
      if (settled) return;
      if (cancelled()) return settle(true);
      try {
        while (next < packets.length && codec.decodeQueueSize < OPUS_QUEUE) {
          const packet = packets[next++]!;
          codec.decode(
            new EncodedAudioChunk({
              type: 'key',
              timestamp: Math.round((timestamp * 1e6) / OPUS_SAMPLE_RATE),
              data: packet,
            }),
          );
          timestamp += opusPacketSamples(packet);
        }
        if (next === packets.length) {
          next++;
          codec.flush().then(
            () => settle(true),
            () => settle(false),
          );
        }
      } catch {
        settle(false);
      }
    };
    try {
      // Without a description the decoder keeps the pre-skip; the caller trims it.
      codec.configure({codec: 'opus', sampleRate: OPUS_SAMPLE_RATE, numberOfChannels: channels});
    } catch {
      return settle(false);
    }
    codec.addEventListener('dequeue', feed);
    feed();
  });
}

/**
 * Opens an Ogg Opus file as 16-bit PCM of `info.frames` frames, opusfile's `op_read` range:
 * decoded samples from the pre-skip on, cut at the final granule. A WebCodecs `AudioDecoder`
 * fills the buffer in order and `waitForFrames` holds a reader only until its frames are
 * decoded. Without one, or when it fails, the browser's `decodeAudioData` at 48 kHz (which
 * applies the same trims) fills the whole buffer first. Without a browser decoder the PCM
 * stays silent at its full length.
 */
export function openOpusPcm16(bytes: Uint8Array, info: OggOpusInfo): VorbisPcm16 {
  const frames = Math.max(0, info.frames);
  const channels = Math.max(1, info.channels);
  const pcm = new Uint8Array(frames * channels * 2);
  const context = opusDecoder();
  const packets = context && frames > 0 ? opusPackets(bytes) : null;
  // OpusHead: channel count at 9, output gain at 16, mapping family at 18 (RFC 7845 5.1).
  const head = packets?.head;
  const stream =
    head &&
    head.length >= 19 &&
    head[9] === channels &&
    channels <= 2 &&
    head[16] === 0 &&
    head[17] === 0 &&
    head[18] === 0
      ? packets
      : null;
  if (!context || frames === 0) return {bytes: pcm, frames, sampleRate: OPUS_SAMPLE_RATE, channels};
  let written = 0;
  let finished = false;
  let closed = false;
  let notify!: () => void;
  const next = () => new Promise<void>((resolve) => (notify = resolve));
  let changed = next();
  const wake = () => {
    notify();
    changed = next();
  };
  const wait = async (end: number): Promise<boolean> => {
    while (written < end && !finished) await changed;
    // A file the browser cannot decode plays as silence of its native length.
    return true;
  };
  const whole = async () => {
    try {
      const buffer = await context.decodeAudioData(bytes.slice().buffer);
      if (closed) return;
      const planes = Array.from({length: Math.min(channels, buffer.numberOfChannels)}, (_, c) =>
        buffer.getChannelData(c),
      );
      const count = Math.min(frames, buffer.length);
      if (planes.length === channels) interleavePcm16(pcm, 0, planes, count);
      else interleaveSome(pcm, planes, channels, count);
    } catch {
      // Silence of the native length.
    }
  };
  void (async () => {
    const skip = info.preSkip;
    const streamed =
      stream &&
      (await decodeOpusStream(
        stream.packets,
        channels,
        (planes, at, count) => {
          // Decoded sample `at` is PCM frame `at - preSkip`; only the next frames in order
          // are written, so a reader never sees a gap.
          const from = Math.max(at, skip + written),
            to = Math.min(at + count, skip + frames);
          if (to <= from || from !== skip + written) return;
          interleavePcm16(
            pcm,
            written * channels * 2,
            planes.map((plane) => plane.subarray(from - at, to - at)),
            to - from,
          );
          written = to - skip;
          wake();
        },
        () => closed,
      ));
    if (!streamed && !closed) {
      written = 0;
      await whole();
    }
    finished = true;
    written = frames;
    wake();
  })();
  return {
    bytes: pcm,
    frames,
    sampleRate: OPUS_SAMPLE_RATE,
    channels,
    waitForFrames: (end) => (finished || written >= end ? undefined : wait(end)),
    close: () => {
      closed = true;
    },
  };
}

/** The decoded planes when the browser returned fewer channels than the OpusHead names. */
function interleaveSome(
  pcm: Uint8Array,
  planes: readonly Float32Array[],
  channels: number,
  frames: number,
): void {
  const one = new Uint8Array(frames * 2);
  for (let c = 0; c < planes.length; c++) {
    interleavePcm16(one, 0, [planes[c]!], frames);
    for (let i = 0; i < frames; i++) {
      pcm[(i * channels + c) * 2] = one[i * 2]!;
      pcm[(i * channels + c) * 2 + 1] = one[i * 2 + 1]!;
    }
  }
}
