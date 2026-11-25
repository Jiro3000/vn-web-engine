import {openWorkerSource, type WorkerSource} from '../../core/worker-source.js';
import {decodeG00, type G00Resource} from '../../formats/siglus/g00.js';
import {serveWorkerPool} from '../../platform/worker-pool.js';

serveWorkerPool<WorkerSource, G00Resource>(async (descriptor) => {
  const source = openWorkerSource(descriptor);
  const response = decodeG00(await source.read(0, source.size));
  return {response, transfer: [response.data.buffer]};
});
