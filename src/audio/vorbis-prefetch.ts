import {openOpusPcm16, readOggOpus} from './opus-pcm16.js';
import {openVorbisPcm16, type VorbisPcm16} from './vorbis-pcm16.js';

/** Speculative decodes kept for files a player expects to open soon. */
const LIMIT = 4;
const entries: {bytes: Uint8Array; opus: boolean; pcm: Promise<VorbisPcm16 | null>}[] = [];

function sameBytes(a: Uint8Array, b: Uint8Array): boolean {
  if (a === b) return true;
  if (a.length !== b.length) return false;
  let i = 0;
  if (a.byteOffset % 4 === 0 && b.byteOffset % 4 === 0) {
    const words = a.length >> 2,
      x = new Uint32Array(a.buffer, a.byteOffset, words),
      y = new Uint32Array(b.buffer, b.byteOffset, words);
    for (; i < words; i++) if (x[i] !== y[i]) return false;
    i = words << 2;
  }
  for (; i < a.length; i++) if (a[i] !== b[i]) return false;
  return true;
}

/**
 * Starts decoding `bytes`, an Ogg Vorbis file on a stream worker or a single-link Ogg Opus
 * file with the browser's decoder, so that a later open of the same contents finds its prefix
 * decoded. The oldest unclaimed decode is cancelled past the limit.
 */
export function prefetchOggPcm16(bytes: Uint8Array): void {
  if (typeof Worker === 'undefined' || entries.some((e) => sameBytes(e.bytes, bytes))) return;
  const opus = readOggOpus(bytes);
  if (opus && (opus.links !== 1 || opus.channels === 0 || opus.frames < 0)) return;
  entries.push({
    bytes,
    opus: !!opus,
    pcm: opus
      ? Promise.resolve(openOpusPcm16(bytes, opus))
      : openVorbisPcm16(bytes).catch(() => null),
  });
  while (entries.length > LIMIT) void entries.shift()!.pcm.then((pcm) => pcm?.close?.());
}

function take(bytes: Uint8Array, opus: boolean): Promise<VorbisPcm16 | null> | undefined {
  const index = entries.findIndex((e) => e.opus === opus && sameBytes(e.bytes, bytes));
  return index < 0 ? undefined : entries.splice(index, 1)[0]!.pcm;
}

/** The prefetched Opus decode of these contents, which the caller then owns, or undefined. */
export function takePrefetchedOpusPcm16(
  bytes: Uint8Array,
): Promise<VorbisPcm16 | null> | undefined {
  return take(bytes, true);
}

/** The prefetched decode of these contents, which the caller then owns, or undefined. */
export function takePrefetchedVorbisPcm16(
  bytes: Uint8Array,
): Promise<VorbisPcm16 | null> | undefined {
  return take(bytes, false);
}
