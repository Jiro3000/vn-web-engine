import test from 'node:test';
import assert from 'node:assert/strict';
import {parseDxbcContainer} from '../dist/graphics/d3d11-shader/container.js';
import {extractEmoteX64ShaderBlobs} from '../dist/native/emotedriver/runtime/render/shaders.js';

function container() {
  const bytes = new Uint8Array(72),
    view = new DataView(bytes.buffer);
  bytes.set(new TextEncoder().encode('DXBC'));
  view.setUint16(20, 1, true);
  view.setUint32(24, bytes.length, true);
  view.setUint32(28, 2, true);
  view.setUint32(32, 56, true); // Table order deliberately differs from file order.
  view.setUint32(36, 40, true);
  for (const [offset, tag, value] of [
    [40, 'RDEF', 9],
    [56, 'SHDR', 17],
  ]) {
    bytes.set(new TextEncoder().encode(tag), offset);
    view.setUint32(offset + 4, 8, true);
    bytes.fill(value, offset + 8, offset + 16);
  }
  return bytes;
}

test('DXBC parts retain table order and borrow the exact byte view', () => {
  const backing = new Uint8Array(80),
    bytes = backing.subarray(3, 75);
  bytes.set(container());
  const result = parseDxbcContainer(bytes);
  assert.equal(result.major, 1);
  assert.equal(result.minor, 0);
  assert.deepEqual(
    result.parts.map((p) => [p.kind, p.offset]),
    [
      ['SHDR', 56],
      ['RDEF', 40],
    ],
  );
  assert.equal(result.parts[0].data.buffer, backing.buffer);
  assert.equal(result.parts[0].data.byteOffset, 3 + 64);
  assert.deepEqual([...result.parts[0].data], Array(8).fill(17));
  bytes[64] = 21;
  bytes[4] = 7;
  assert.equal(result.parts[0].data[0], 21);
  assert.equal(result.digest[0], 7);
});

test('DXBC rejects invalid envelopes and overlapping or truncated parts before reading payloads', () => {
  assert.throws(() => parseDxbcContainer(new Uint8Array(31)));
  const corrupt = (change) => {
    const bytes = container();
    change(new DataView(bytes.buffer), bytes);
    assert.throws(() => parseDxbcContainer(bytes));
  };
  corrupt((v, b) => b.fill(0, 0, 4));
  corrupt((v) => v.setUint16(20, 2, true));
  corrupt((v) => v.setUint16(22, 1, true));
  corrupt((v) => v.setUint32(24, 71, true));
  corrupt((v) => v.setUint32(28, 0xffffffff, true));
  corrupt((v) => v.setUint32(28, 9, true));
  corrupt((v) => v.setUint32(32, 0, true));
  corrupt((v) => v.setUint32(32, 0xffffffff, true));
  corrupt((v) => v.setUint32(32, 40, true));
  corrupt((v) => v.setUint32(44, 9, true)); // First file part overlaps the next header.
  corrupt((v) => v.setUint32(60, 9, true));
});

test('the x64 embedded-shader reader refuses bytes outside its exact DLL identity', () => {
  assert.equal(extractEmoteX64ShaderBlobs(new Uint8Array()), null);
  assert.equal(extractEmoteX64ShaderBlobs(container()), null);
});
