import {openWorkerSource, type WorkerSource} from '../../core/worker-source.js';
import {BlobSource} from '../../core/source.js';
import {decodeNwa, openNwa} from '../../formats/siglus/sound.js';
import {serveWorkerPool} from '../../platform/worker-pool.js';

export interface NwaRequest {
  source: WorkerSource;
  range?: {key: string; frame: number; count: number};
}

const readers = new Map<string, Awaited<ReturnType<typeof openNwa>>>();

serveWorkerPool<NwaRequest, ReturnType<typeof decodeNwa>>(async ({source: descriptor, range}) => {
  let response: ReturnType<typeof decodeNwa>;
  if (range) {
    let reader = readers.get(range.key);
    if (reader) readers.delete(range.key);
    else reader = await openNwa(descriptor.kind === 'blob'
      ? new BlobSource(descriptor.blob, 0)
      : openWorkerSource(descriptor));
    readers.set(range.key, reader);
    if (readers.size > 8) readers.delete(readers.keys().next().value!);
    response = {channels: reader.channels, rate: reader.rate, pcm: await reader.read(range.frame, range.count)};
  } else {
    const source = openWorkerSource(descriptor);
    response = decodeNwa(await source.read(0, source.size));
  }
  return {response, transfer: [response.pcm.buffer as ArrayBuffer]};
});
