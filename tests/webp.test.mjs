import {test} from 'node:test';
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import {createHash} from 'node:crypto';
import {decodeWebp, decodeAlpha} from '../dist/formats/webp/webp.js';
const fixtures = JSON.parse(
  await readFile(new URL('./fixtures/webp-synthetic.json', import.meta.url)),
);
for (const fixture of fixtures)
  test(`WebP matches dwebp: ${fixture.flags.join(' ')}`, () => {
    const image = decodeWebp(Buffer.from(fixture.base64, 'base64'));
    assert.equal(image.width, 17);
    assert.equal(image.height, 9);
    assert.equal(createHash('sha256').update(image.pixels).digest('hex'), fixture.sha256);
  });
test('WebP ALPH reverses all spatial filters including row boundaries and wrapping', () => {
  const w = 3,
    h = 3,
    original = Uint8Array.of(0, 255, 40, 50, 12, 220, 60, 31, 200);
  for (let filter = 0; filter < 4; filter++) {
    const data = new Uint8Array(1 + w * h);
    data[0] = filter << 2;
    for (let y = 0; y < h; y++)
      for (let x = 0; x < w; x++) {
        const p = y * w + x;
        const predictor = !filter
          ? 0
          : y === 0
            ? x
              ? original[p - 1]
              : 0
            : x === 0 || filter === 2
              ? original[p - w]
              : filter === 1
                ? original[p - 1]
                : Math.max(
                    0,
                    Math.min(255, original[p - 1] + original[p - w] - original[p - w - 1]),
                  );
        data[p + 1] = original[p] - predictor;
      }
    assert.deepEqual(decodeAlpha(data, w, h), original);
  }
});
test('WebP rejects incomplete containers and invalid alpha headers', () => {
  const valid = Buffer.from(fixtures[0].base64, 'base64');
  for (const n of [0, 12, valid.length - 1])
    assert.throws(() => decodeWebp(valid.subarray(0, n)), /WebP/);
  for (const header of [2, 3, 32, 64, 128])
    assert.throws(() => decodeAlpha(Uint8Array.of(header, 0), 1, 1), /ALPH/);
});
