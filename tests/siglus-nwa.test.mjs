import assert from 'node:assert/strict';
import test from 'node:test';
import {decodeNwaWasm} from '../dist/formats/siglus/nwa-wasm.js';
import {decodeNwa, openNwa} from '../dist/formats/siglus/sound.js';

function fixture(channels, level, runs) {
  const blockSamples = 32;
  const blocks = 520;
  const lastSamples = 12;
  const samples = (blocks - 1) * blockSamples + lastSamples;
  const width = level <= 2 ? 5 - level : 3 + level;
  const baseShift = Math.max(2, 8 - width);
  const expected = new Int16Array(samples);
  const payloads = [];
  for (let block = 0; block < blocks; block++) {
    const payload = [];
    let position = 0;
    const write = (value, bits) => {
      for (let i = 0; i < bits; i++, position++) {
        const byte = position >>> 3;
        payload[byte] = (payload[byte] ?? 0) | (((value >>> i) & 1) << (position & 7));
      }
    };
    const predictors = Array.from({length: channels}, (_, i) => (i ? -32000 : 32000) - block);
    for (const predictor of predictors) write(predictor, 16);
    const count = block === blocks - 1 ? lastSamples : blockSamples;
    for (let i = 0; i < count;) {
      const channel = i % channels;
      let copies = 1;
      if (i === 4 && runs) {
        const repeat = [0, 1, 2, 5][block % 4];
        write(0, 3);
        write(Number(repeat > 0), 1);
        if (repeat) write(Math.min(3, repeat), 2);
        if (repeat >= 3) write(repeat, 8);
        copies += repeat;
      } else if (i === 3) {
        write(7, 3);
        write(1, 1);
        predictors[channel] = 0;
      } else {
        const code = i % 3 === 2 ? 7 : 1 + (i % 6);
        const bits = code === 7 ? Math.min(8, width + 3) : width;
        const shift = code === 7 ? 17 - bits : baseShift + code - 1;
        const magnitude = (1 << (bits - 1)) - 1;
        const negative = (i & 1) !== 0;
        write(code, 3);
        if (code === 7) write(0, 1);
        write(magnitude | (negative ? 1 << (bits - 1) : 0), bits);
        predictors[channel] += magnitude * (negative ? -1 : 1) * 2 ** shift;
      }
      for (let j = 0; j < copies; j++, i++) {
        expected[block * blockSamples + i] = predictors[i % channels];
      }
    }
    payloads.push(payload);
  }
  const lastBytes = payloads.at(-1).length;
  const start = 44 + blocks * 4;
  const bytes = new Uint8Array(start + payloads.reduce((sum, payload) => sum + payload.length, 0));
  const view = new DataView(bytes.buffer);
  view.setUint16(0, channels, true);
  view.setUint16(2, 16, true);
  view.setUint32(4, 44100, true);
  for (const [offset, value] of [
    [8, level],
    [12, Number(runs)],
    [16, blocks],
    [20, samples * 2],
    [28, samples],
    [32, blockSamples],
    [36, lastSamples],
    [40, lastBytes],
  ]) {
    view.setUint32(offset, value, true);
  }
  let offset = start;
  for (const [index, payload] of payloads.entries()) {
    view.setUint32(44 + index * 4, offset, true);
    bytes.set(payload, offset);
    offset += payload.length;
  }
  const table = new DataView(bytes.buffer, 44, blocks * 4);
  const range = {first: 0, last: blocks, sourceOffset: 0, sourceEnd: bytes.length};
  return {bytes, table, range, format: {channels, level, runs, blockSamples}, expected};
}

test('NWA WebAssembly preserves predictors, runs, and partial final blocks across batches', () => {
  for (let level = 0; level <= 5; level++)
    for (const channels of [1, 2])
      for (const runs of [false, true]) {
        const {bytes, table, range, format, expected} = fixture(channels, level, runs);
        const pcm = new Int16Array(expected.length);
        assert.equal(decodeNwaWasm(bytes, table, range, format, pcm), true);
        assert.deepEqual(pcm, expected);
        assert.deepEqual(decodeNwa(bytes).pcm, expected);
      }
});

test('seekable NWA decodes an unaligned range and keeps truncated block diagnostics', async () => {
  const {bytes, expected} = fixture(2, 5, true);
  const open = () =>
    openNwa({
      size: bytes.length,
      async read(offset, count) {
        return bytes.subarray(offset, offset + count);
      },
    });
  const stream = await open();
  const frame = 17;
  const count = stream.frames - frame;
  assert.deepEqual(await stream.read(frame, count), expected.subarray(frame * 2));
  new DataView(bytes.buffer).setUint32(40, 1, true);
  assert.throws(() => decodeNwa(bytes), /Truncated Siglus NWA predictor/);
  const truncated = await open();
  await assert.rejects(truncated.read(frame, count), /Truncated Siglus NWA predictor/);
});
