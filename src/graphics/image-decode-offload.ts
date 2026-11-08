import type {DecodedPng, PngDecodeOptions} from '../formats/png/decode.js';
import {WorkerPool, WorkerPoolLane} from '../platform/worker-pool.js';
import {beginRuntimeSpan} from '../platform/runtime-performance.js';

/** Named formats use pure byte decoders; MIME types use the browser-owned codec. */
export type ImageDecodeFormat =
  | 'png'
  | 'artemis-psd'
  | 'opaque-jpeg'
  | 'legacy-webp'
  | 'webp'
  | 'yuris-ydg'
  | 'qoi'
  | 'image/webp'
  | 'image/jpeg';

export interface ImageDecodeRequest {
  readonly format: ImageDecodeFormat;
  readonly bytes: Uint8Array;
  readonly png?: PngDecodeOptions;
  /** 'bgra' swaps a PNG's RGBA pixels to BGRA on the worker. */
  readonly order?: 'rgba' | 'bgra';
}

export type ImageDecodeResponse =
  DecodedPng | {readonly width: number; readonly height: number; readonly pixels: Uint8Array};

let pool: WorkerPool<ImageDecodeRequest, ImageDecodeResponse> | null = null;
let stripPool: WorkerPool<ImageDecodeRequest, ImageDecodeResponse> | null = null;

const createWorker = () =>
  new Worker(new URL('./image-decode-worker.js', import.meta.url), {type: 'module'});

/**
 * Whole-image decodes: one worker more than speculative decodes may occupy, so a load the
 * page waits for always finds an idle worker.
 */
function decodePool() {
  const threads = typeof navigator === 'undefined' ? 1 : navigator.hardwareConcurrency || 1;
  const size = Math.max(1, Math.min(3, threads - 1));
  return (pool ??= new WorkerPool(createWorker, size, Math.max(1, size - 1)));
}

/**
 * Workers for the strips of one image, which decode independently: YU-RIS starts 16 strip
 * decode threads (Relirium.exe 0x44C370, created with ideal processors 0–15). The browser
 * keeps one hardware thread for the page; background strips run at the ordinary pool limit.
 */
function stripDecodePool() {
  const threads = typeof navigator === 'undefined' ? 1 : navigator.hardwareConcurrency || 1;
  return (stripPool ??= new WorkerPool(createWorker, Math.max(1, Math.min(16, threads - 1))));
}

/**
 * A lane for speculative decodes: they start only on idle decode workers, a few at a time, so
 * a decode the page waits for never queues behind them, until `promote` makes them ordinary.
 * An `urgent` lane's jobs start before other speculative jobs.
 */
export function backgroundImageDecodes(urgent = false): WorkerPoolLane {
  return new WorkerPoolLane(urgent);
}

/**
 * Decodes a snapshot of `bytes` on a worker, so large images never block the page. Resolves
 * null when the caller must decode in-thread: workers are unavailable (including non-browser
 * hosts) or the decode failed, in which case the in-thread decoder raises the original error.
 * Worker results are identical to the in-thread decoders'.
 */
export function decodeImageOffThread(
  bytes: Uint8Array,
  format: 'png',
  png?: PngDecodeOptions,
  order?: 'rgba' | 'bgra',
  lane?: WorkerPoolLane,
): Promise<DecodedPng | null>;
export function decodeImageOffThread(
  bytes: Uint8Array,
  format: Exclude<ImageDecodeFormat, 'png'>,
  png?: undefined,
  order?: undefined,
  lane?: WorkerPoolLane,
): Promise<{width: number; height: number; pixels: Uint8Array} | null>;
export async function decodeImageOffThread(
  bytes: Uint8Array,
  format: ImageDecodeFormat,
  png?: PngDecodeOptions,
  order?: 'rgba' | 'bgra',
  lane?: WorkerPoolLane,
): Promise<ImageDecodeResponse | null> {
  return decodeOn(decodePool(), bytes, format, png, order, lane);
}

/** Decodes one strip of an image on the strip workers; see `decodeImageOffThread`. */
export function decodeImageStripOffThread(
  bytes: Uint8Array,
  format: 'qoi' | 'webp',
  lane?: WorkerPoolLane,
): Promise<{width: number; height: number; pixels: Uint8Array} | null> {
  return decodeOn(stripDecodePool(), bytes, format, undefined, undefined, lane) as Promise<{
    width: number;
    height: number;
    pixels: Uint8Array;
  } | null>;
}

/**
 * Decodes a whole YDG image on one strip worker, which decodes its strips in turn and returns
 * the stacked image (see `decodeYdgConcurrently`). It suits many images requested together,
 * which keep the strip workers busy without the page stacking each image's strips.
 */
export function decodeYdgOffThread(
  bytes: Uint8Array,
  lane?: WorkerPoolLane,
): Promise<{width: number; height: number; pixels: Uint8Array} | null> {
  return decodeOn(stripDecodePool(), bytes, 'yuris-ydg', undefined, undefined, lane) as Promise<{
    width: number;
    height: number;
    pixels: Uint8Array;
  } | null>;
}

async function decodeOn(
  workers: WorkerPool<ImageDecodeRequest, ImageDecodeResponse>,
  bytes: Uint8Array,
  format: ImageDecodeFormat,
  png: PngDecodeOptions | undefined,
  order: 'rgba' | 'bgra' | undefined,
  lane: WorkerPoolLane | undefined,
): Promise<ImageDecodeResponse | null> {
  if (!workers.available) return null;
  // Records the time until the decoded image is back, worker queueing included.
  const finish = beginRuntimeSpan(`graphics.decode.${format.replace('/', '-')}`, {
    bytes: bytes.length,
  });
  // A Uint8Array subclass (for example Node Buffer) may implement slice as a borrowed view;
  // the typed-array constructor always copies into a plain Uint8Array.
  const snapshot = new Uint8Array(bytes);
  try {
    return (
      (await workers.run({format, bytes: snapshot, png, order}, [snapshot.buffer], lane)) ?? null
    );
  } finally {
    finish?.();
  }
}
