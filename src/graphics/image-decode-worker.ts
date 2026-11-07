import {serveWorkerPool} from '../platform/worker-pool.js';
import {decodePng} from '../formats/png/decode.js';
import {decodeBrowserImage} from './browser-image.js';
import {decodeArtemisPsd} from '../formats/artemis/psd.js';
import {decodeOpaqueJpeg} from './browser-jpeg.js';
import {decodeWebp} from '../formats/webp/webp.js';
import type {ImageDecodeRequest, ImageDecodeResponse} from './image-decode-offload.js';
import {swapRedBlueInPlace} from './pixel-order.js';

// Failures are reported as failed jobs; the host reruns the in-thread decoder, which raises
// the original error.
serveWorkerPool<ImageDecodeRequest, ImageDecodeResponse>(async ({format, bytes, png, order}) => {
  const image =
    format === 'png'
      ? await decodePng(bytes, png)
      : format === 'artemis-psd'
        ? decodeArtemisPsd(bytes)
        : format === 'opaque-jpeg'
          ? await decodeOpaqueJpeg(bytes)
          : format === 'legacy-webp'
            ? decodeWebp(bytes, true)
            : await decodeBrowserImage(bytes, format);
  if (format === 'png' && order === 'bgra') swapRedBlueInPlace(image.pixels);
  const transfer: Transferable[] = [image.pixels.buffer];
  const indices = (image as {indices?: Uint8Array}).indices;
  if (indices) transfer.push(indices.buffer);
  return {response: image, transfer};
});
