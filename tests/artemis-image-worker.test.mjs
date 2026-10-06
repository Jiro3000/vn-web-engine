import test from 'node:test';
import assert from 'node:assert/strict';
import {Worker as ThreadWorker} from 'node:worker_threads';
import {createArtemisImageLoader} from '../dist/engines/artemis/image-loader.js';
import {ARTEMIS_3179_EXECUTABLE_SHA256} from '../dist/engines/artemis/revision.js';
import {png} from './png-fixtures.mjs';

const bootstrap = `
const {parentPort, workerData} = require('node:worker_threads');
let handler = null;
const queued = [];
Object.defineProperty(globalThis, 'onmessage', {get: () => handler, set(value) {
  handler = value; for (const data of queued.splice(0)) handler({data});
}});
globalThis.postMessage = (message, transfer) => parentPort.postMessage(message, transfer);
parentPort.on('message', data => handler ? handler({data}) : queued.push(data));
import(workerData);
`;

test(
  'Artemis PNG resource pipeline uses the real shared worker without detaching archive bytes',
  {timeout: 15000},
  async () => {
    const workers = [];
    const originalWorker = globalThis.Worker;
    let applied = 0;
    class ModuleWorker {
      constructor(url) {
        this.thread = new ThreadWorker(bootstrap, {eval: true, workerData: url.href});
        workers.push(this.thread);
        this.thread.on('message', (data) => {
          if (data.response) applied++;
          this.onmessage?.({data});
          this.thread.unref();
        });
        this.thread.on('error', (error) => {
          this.onerror?.({error, preventDefault() {}});
          this.thread.unref();
        });
        this.thread.unref();
      }
      postMessage(message, transfer) {
        this.thread.ref();
        this.thread.postMessage(message, transfer);
      }
      terminate() {
        this.thread.terminate();
      }
    }
    globalThis.Worker = ModuleWorker;
    const original = png({
      width: 2,
      height: 1,
      raw: Buffer.from([0, 255, 0, 0, 0, 0, 255, 0, 128]),
    });
    const snapshot = original.slice();
    const loader = createArtemisImageLoader(ARTEMIS_3179_EXECUTABLE_SHA256, async (path) =>
      path === 'fixture.png' ? original : null,
    );
    try {
      const loaded = await loader.load('fixture');
      assert.equal(applied, 1);
      assert.equal(workers.length, 1);
      assert.equal(loaded.image.width, 2);
      assert.deepEqual([...loaded.image.pixels], [255, 0, 0, 0, 0, 255, 0, 128]);
      assert.deepEqual(original, snapshot);
      assert.equal(original.byteLength, snapshot.byteLength);
      const corrupt = original.slice();
      corrupt[corrupt.length - 1] ^= 1;
      const failing = createArtemisImageLoader(ARTEMIS_3179_EXECUTABLE_SHA256, async (path) =>
        path === 'corrupt.png' ? corrupt : null,
      );
      await assert.rejects(() => failing.load('corrupt'), /CRC/);
      assert.deepEqual(original, snapshot);
    } finally {
      globalThis.Worker = originalWorker;
      await Promise.all(workers.map((worker) => worker.terminate()));
    }
  },
);
