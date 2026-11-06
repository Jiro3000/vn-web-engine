import {decodeBrowserImage} from '../../../graphics/browser-image.js';
import {serveWorkerPool} from '../../../platform/worker-pool.js';
import type {YurisImage} from '../vm/cg.js';

export interface YmvJpegs {
  readonly color: Uint8Array;
  readonly alpha: Uint8Array | null;
}

serveWorkerPool<YmvJpegs, YurisImage>(async ({color, alpha}) => {
  if (color[0] !== 255 || color[1] !== 216 || (alpha && (alpha[0] !== 255 || alpha[1] !== 216)))
    throw new Error('YMV: expected JPEG');
  const [image, mask] = await Promise.all([
    decodeBrowserImage(color, 'image/jpeg'),
    alpha && decodeBrowserImage(alpha, 'image/jpeg'),
  ]);
  if (mask && (image.width !== mask.width || image.height !== mask.height))
    throw new Error('YMV: alpha JPEG dimensions differ from color');
  if (image.width * image.height > 0x4000000) throw new Error('YMV: unsupported JPEG dimensions');
  const {pixels} = image;
  for (let i = 0; i < pixels.length; i += 4) {
    const red = pixels[i]!;
    pixels[i] = pixels[i + 2]!;
    pixels[i + 2] = red;
    if (mask) pixels[i + 3] = mask.pixels[i + 2]!;
  }
  return {response: image, transfer: [pixels.buffer]};
});
