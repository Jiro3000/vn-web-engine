import {serveWorkerPool} from '../platform/worker-pool.js';
import {decodePng} from '../formats/png/decode.js';
import {decodeBrowserImage} from './browser-image.js';
import {decodeArtemisPsd} from '../formats/artemis/psd.js';
import {decodeOpaqueJpeg} from './browser-jpeg.js';
import {decodeWebp} from '../formats/webp/webp.js';
import {decodeQoi} from '../formats/qoi.js';
import {decodeYdgConcurrently} from '../formats/yuris/ydg.js';
import type {ImageDecodeRequest, ImageDecodeResponse} from './image-decode-offload.js';
import {swapRedBlueInPlace} from './pixel-order.js';
import {createLosslessImageDecoder} from './browser-lossless-image.js';

const lossless = createLosslessImageDecoder();

// Failures are reported as failed jobs; the host reruns the in-thread decoder, which raises
// the original error.
serveWorkerPool<ImageDecodeRequest, ImageDecodeResponse>(async ({format, bytes, png, order}) => {
  // The browser path returns pixels in the requested order; it applies only to strict decodes.
  const browserPng =
    format === 'png' && !png ? await lossless.png(bytes, order === 'bgra' ? 'bgra' : 'rgba') : null;
  const image =
    browserPng ??
    (format === 'png'
      ? await decodePng(bytes, png)
      : format === 'artemis-psd'
        ? decodeArtemisPsd(bytes)
        : format === 'opaque-jpeg'
          ? await decodeOpaqueJpeg(bytes)
          : format === 'legacy-webp' || format === 'webp'
            ? ((await lossless.webp(bytes)) ?? decodeWebp(bytes, format === 'legacy-webp'))
            : format === 'yuris-ydg'
              ? // A whole YDG decodes its strips here in turn; WebP strips (codec 2) take the
                // verified browser path, the others the TS decoders.
                await decodeYdgConcurrently(bytes, async (codec, strip) =>
                  codec === 2 ? ((await lossless.webp(strip))?.pixels ?? null) : null,
                )
              : format === 'qoi'
                ? decodeQoi(bytes)
                : await decodeBrowserImage(bytes, format));
  if (format === 'png' && !browserPng && order === 'bgra') swapRedBlueInPlace(image.pixels);
  const transfer: Transferable[] = [image.pixels.buffer];
  const indices = (image as {indices?: Uint8Array}).indices;
  if (indices) transfer.push(indices.buffer);
  return {response: image, transfer};
});
