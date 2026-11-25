import assert from 'node:assert/strict';
import test from 'node:test';
import {unpackSiglusLz} from '../dist/formats/siglus/compression.js';
import {G00Image, decodeG00} from '../dist/formats/siglus/g00.js';
import {unpackSiglusLzWasm} from '../dist/formats/siglus/lz-wasm.js';

const literal = (...data) => ({literal: true, data});
const reference = (...data) => ({literal: false, data});

function pack(tokens, size) {
  const payload = [];
  for (let offset = 0; offset < tokens.length; offset += 8) {
    const group = tokens.slice(offset, offset + 8);
    const flags = group.reduce((bits, token, index) => bits | (Number(token.literal) << index), 0);
    payload.push(flags, ...group.flatMap((token) => token.data));
  }
  const bytes = new Uint8Array(8 + payload.length);
  const header = new DataView(bytes.buffer);
  header.setUint32(0, bytes.length, true);
  header.setUint32(4, size, true);
  bytes.set(payload, 8);
  return bytes;
}

test('Siglus LZSS preserves overlapping byte runs and clamps the final reference to the output', () => {
  const tokens = [literal(17), literal(29), literal(47), reference(0x3f, 0)];
  // These nonoverlapping short copies deliberately change the period before the long run.
  tokens.push(reference(0x60, 0), literal(97));
  const size = 65536;
  for (let output = 23; output < size; output += 17) tokens.push(reference(0x1f, 0));
  const bytes = pack(tokens, size);
  const expected = new Uint8Array(size).fill(97);
  expected.set(Uint8Array.from({length: 20}, (_, i) => [17, 29, 47][i % 3]));
  expected.set([47, 17], 20);
  assert.deepEqual(unpackSiglusLzWasm(bytes.subarray(8), size, false), expected);
  assert.deepEqual(unpackSiglusLz(bytes), expected);
});

test('G00 type 0 uses pixel runs and retains opaque BGRA after transferring the decoded resource', () => {
  const width = 128;
  const height = 128;
  const tokens = [literal(3, 7, 11), literal(13, 17, 19), literal(23, 29, 31)];
  for (let count = 3; count < width * height; count += 16) tokens.push(reference(0x3f, 0));
  const packed = pack(tokens, width * height * 4);
  const bytes = new Uint8Array(5 + packed.length);
  const header = new DataView(bytes.buffer);
  header.setUint16(1, width, true);
  header.setUint16(3, height, true);
  bytes.set(packed, 5);

  const resource = decodeG00(bytes);
  const transferred = structuredClone(resource, {transfer: [resource.data.buffer]});
  assert.equal(resource.data.byteLength, 0);
  const frame = new G00Image(transferred).frame(0);
  assert.deepEqual(
    [frame.width, frame.height, frame.centerX, frame.centerY],
    [width, height, 0, 0],
  );
  const period = Uint8Array.of(3, 7, 11, 255, 13, 17, 19, 255, 23, 29, 31, 255);
  const expected = Uint8Array.from(
    {length: frame.bgra.length},
    (_, i) => period[i % period.length],
  );
  assert.deepEqual(frame.bgra, expected);
  assert.deepEqual(new G00Image(bytes).frame(0).bgra, expected);
});

test('Siglus LZSS rejects the same malformed tokens in JavaScript and WebAssembly', () => {
  for (const [tokens, error] of [
    [[], /Truncated Siglus LZSS stream/],
    [[literal()], /Truncated Siglus LZSS literal/],
    [[reference(0x10)], /Truncated Siglus LZSS reference/],
    [[reference(0, 0)], /Invalid Siglus LZSS reference/],
    [[reference(0x10, 0)], /Invalid Siglus LZSS reference/],
  ]) {
    for (const size of [64, 65536]) {
      assert.throws(() => unpackSiglusLz(pack(tokens, size)), error);
    }
  }
});
