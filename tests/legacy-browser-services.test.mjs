import {test} from 'node:test';
import assert from 'node:assert/strict';
import {MemoryStore} from '../dist/platform/store.js';
import {LegacyFolder} from '../dist/platform/legacy-folder.js';
import {PcmBufferRenderCore} from '../dist/audio/mutable-pcm-core.js';

test('legacy working folder overlays read-only installation data and keeps writes in its store', async () => {
  const original = Uint8Array.of(1, 2, 3),
    source = {size: 3, read: async (o, n) => original.slice(o, o + n)},
    store = new MemoryStore();
  const folder = new LegacyFolder(
    new Map([['base.dat', source]]),
    store,
    (s) => s,
    (s) => s,
  );
  await folder.initialize();
  assert.equal(folder.existsFile('BASE.DAT'), true);
  // A file the folder cannot hold is a miss without a store snapshot.
  const snapshot = store.snapshot.bind(store);
  let snapshots = 0;
  store.snapshot = () => (snapshots++, snapshot());
  assert.equal(await folder.readFile('archived.ybn'), null);
  assert.equal(snapshots, 0);
  assert.deepEqual([...(await folder.readFile('base.dat'))], [1, 2, 3]);
  store.snapshot = snapshot;
  await folder.createDirectory('save');
  await folder.setCurrentDirectory('save');
  await folder.copyFile('..\\base.dat', 'slot.dat');
  await folder.appendFile('slot.dat', Uint8Array.of(4));
  // A file written here reads back without a store snapshot, as a copy.
  snapshots = 0;
  store.snapshot = () => (snapshots++, snapshot());
  const written = await folder.readFile('slot.dat');
  assert.deepEqual([...written], [1, 2, 3, 4]);
  written[0] = 9;
  assert.deepEqual([...(await folder.readFile('slot.dat'))], [1, 2, 3, 4]);
  assert.equal(snapshots, 0);
  store.snapshot = snapshot;
  assert.deepEqual([...original], [1, 2, 3]);
  assert.equal(folder.existsFile('slot.dat'), true);
  const reopened = new LegacyFolder(
    new Map([['base.dat', source]]),
    store,
    (s) => s,
    (s) => s,
  );
  await reopened.initialize();
  assert.equal(reopened.existsFile('save\\slot.dat'), true);
  await folder.deleteFile('slot.dat');
  assert.equal(await folder.readFile('slot.dat'), null);
  await folder.setCurrentDirectory('..');
  await folder.removeDirectory('save');
  assert.equal(await folder.stat('save'), null);
});

test('mutable PCM frequency changes real render consumption while status remains observational', () => {
  const core = new PcmBufferRenderCore(
    {sampleRate: 24000, channels: 1, bits: 16, byteLength: 16},
    48000,
  );
  const bytes = new Uint8Array(16),
    v = new DataView(bytes.buffer);
  for (let i = 0; i < 8; i++) v.setInt16(i * 2, i * 1000, true);
  core.command({kind: 'write', offset: 0, bytes, initialized: new Uint8Array(16).fill(1)});
  core.command({kind: 'play', loop: true});
  core.render([new Float32Array(4), new Float32Array(4)]);
  assert.equal(core.status().byteCursor, 4);
  core.command({kind: 'frequency', hz: 48000});
  const left = new Float32Array(4),
    right = new Float32Array(4);
  core.render([left, right]);
  assert.equal(core.status().byteCursor, 12);
  assert.equal(core.status().byteCursor, 12);
  assert.deepEqual(left, right);
  assert.ok(left[3] > left[0]);
});
