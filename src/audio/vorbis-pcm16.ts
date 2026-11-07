import {streamVorbis} from './vorbis-decoder.js';

export interface VorbisPcm16 {
  readonly bytes: Uint8Array;
  readonly frames: number;
  readonly sampleRate: number;
  readonly channels: number;
  /** Returns a promise only while the requested prefix is still being decoded. */
  waitForFrames?(end: number): Promise<boolean> | undefined;
  close?(): void;
}

const littleEndian = new Uint8Array(new Uint16Array([1]).buffer)[0] === 1;

/**
 * vorbisfile's signed 16-bit little-endian ov_read quantisation (round half to even, clamped)
 * of `frames` frames of `planes` into `bytes` at byte offset `at`.
 */
export function interleavePcm16(
  bytes: Uint8Array,
  at: number,
  planes: readonly Float32Array[],
  frames: number,
): void {
  const channels = planes.length;
  const out = new Int16Array(bytes.buffer, bytes.byteOffset + at, frames * channels);
  for (let channel = 0; channel < channels; channel++) {
    const plane = planes[channel]!;
    for (let i = 0, o = channel; i < frames; i++, o += channels) {
      const x = Math.fround(plane[i]! * 32768);
      let value = Math.round(x);
      if (value - x === 0.5 && (value & 1) !== 0) value -= 1;
      out[o] = value > 32767 ? 32767 : value < -32768 ? -32768 : value;
    }
  }
  if (!littleEndian)
    for (let i = at; i < at + out.byteLength; i += 2)
      [bytes[i], bytes[i + 1]] = [bytes[i + 1]!, bytes[i]!];
}

export function vorbisPcm16(
  planes: readonly Float32Array[],
  frames: number,
  sampleRate: number,
): VorbisPcm16 {
  const channels = planes.length;
  const bytes = new Uint8Array(frames * channels * 2);
  interleavePcm16(bytes, 0, planes, frames);
  return {bytes, frames, sampleRate, channels};
}

/** Opens a seekable PCM buffer from the headers while a worker fills its decoded prefix. */
export async function openVorbisPcm16(encoded: Uint8Array): Promise<VorbisPcm16 | null> {
  if (typeof Worker === 'undefined') return null;
  let pcm: VorbisPcm16 | undefined;
  let written = 0;
  let finished = false;
  let notify!: () => void;
  const next = () => new Promise<void>((resolve) => (notify = resolve));
  let changed = next();
  function wake(): void {
    notify();
    changed = next();
  }
  async function wait(end: number): Promise<boolean> {
    while (written < end && !finished) await changed;
    return written >= end;
  }
  let opened!: (value: VorbisPcm16 | null) => void;
  const header = new Promise<VorbisPcm16 | null>((resolve) => (opened = resolve));
  const stream = streamVorbis(encoded, 32768, 65536, {
    onOpen({sampleRate, channels, finalGranule}) {
      const size = (finalGranule ?? 0) * channels * 2;
      if (finalGranule === null || size === 0 || size > 128 * 1024 * 1024) {
        opened(null);
        return;
      }
      let bytes: Uint8Array;
      try {
        bytes = new Uint8Array(size);
      } catch {
        opened(null);
        return;
      }
      pcm = {
        bytes,
        frames: finalGranule,
        sampleRate,
        channels,
        waitForFrames: (end) => (written >= end ? undefined : wait(end)),
        close: () => stream.cancel(),
      };
      opened(pcm);
    },
    onChunk(planes, frames) {
      if (!pcm) return;
      const count = Math.min(frames, pcm.frames - written);
      interleavePcm16(pcm.bytes, written * pcm.channels * 2, planes, count);
      written += count;
      wake();
    },
  });
  const finish = () => {
    finished = true;
    if (!pcm) opened(null);
    wake();
  };
  void stream.done.then(finish, finish);
  const result = await header;
  if (!result) stream.cancel();
  return result;
}
