import assert from 'node:assert/strict';
import test from 'node:test';
import {WmaProDecoder} from '../dist/formats/wma/pro.js';
import {proConfig, proPacket} from './helpers/wma-pro-packet.mjs';

test('WMA Pro skips its first frame, preserves end trim and has no drain output', () => {
  const decoder = new WmaProDecoder(proConfig());
  const out = decoder.decode(proPacket({endTrim: 17}), 100);
  assert.equal(out.length, 2);
  assert.deepEqual(
    out.map((x) => [x.time, x.channels[0].length]),
    [
      [-1, 2048],
      [-1, 2031],
    ],
  );
  for (const frame of out)
    for (const c of frame.channels) assert.deepEqual(c, new Float32Array(c.length));
  assert.deepEqual(decoder.decode(null), []);
  assert.deepEqual(decoder.decode(null), []);
  decoder.close();
  decoder.close();
  assert.throws(() => decoder.decode(null), /closed/);
});

test('WMA Pro instances isolate the first-frame delay and reject unsupported input', () => {
  const a = new WmaProDecoder(proConfig()),
    b = new WmaProDecoder(proConfig());
  assert.deepEqual(a.decode(proPacket({frames: 1})), []);
  assert.equal(b.decode(proPacket()).length, 2);
  a.close();
  b.close();
  assert.throws(() => new WmaProDecoder({...proConfig(), sampleRate: 48000}), /Unsupported/);
  assert.throws(() => new WmaProDecoder({...proConfig(), extra: new Uint8Array(3)}), /extradata/);
  assert.throws(() => new WmaProDecoder(proConfig()).decode(new Uint8Array(10)), /Truncated/);
});
