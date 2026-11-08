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
test('Browser lossless images are used only after the verification images match', async () => {
  const {createLosslessImageDecoder, losslessWebpSize, simplePngHeader} =
    await import('../dist/graphics/browser-lossless-image.js');
  const {decodePng} = await import('../dist/formats/png/decode.js');
  const {crc32} = await import('../dist/core/crc32.js');
  const {deflateSync} = await import('node:zlib');
  const [lossless, lossy] = fixtures.map((fixture) => Buffer.from(fixture.base64, 'base64'));
  const chunk = (type, data) => {
    const body = Buffer.concat([Buffer.from(type, 'latin1'), data]);
    const out = Buffer.alloc(12 + data.length);
    out.writeUInt32BE(data.length, 0);
    body.copy(out, 4);
    out.writeUInt32BE(crc32(body) >>> 0, 8 + data.length);
    return out;
  };
  const png = (extra = []) =>
    Buffer.concat([
      Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]),
      chunk('IHDR', Buffer.from([0, 0, 0, 2, 0, 0, 0, 1, 8, 6, 0, 0, 0])),
      ...extra,
      chunk('IDAT', deflateSync(Buffer.from([0, 255, 0, 0, 7, 9, 200, 100, 0]))),
      chunk('IEND', Buffer.alloc(0)),
    ]);
  const truecolour = png();
  assert.deepEqual(losslessWebpSize(lossless), {width: 17, height: 9});
  assert.equal(losslessWebpSize(lossy), null);
  assert.deepEqual(simplePngHeader(truecolour), {width: 2, height: 1, colorType: 6});
  // Gamma, a bad CRC or trailing bytes keep the TS decoder.
  assert.equal(simplePngHeader(png([chunk('gAMA', Buffer.from([0, 0, 0xb1, 0x8f]))])), null);
  const corrupt = Buffer.from(truecolour);
  corrupt[corrupt.length - 20] ^= 1;
  assert.equal(simplePngHeader(corrupt), null);
  assert.equal(simplePngHeader(Buffer.concat([truecolour, Buffer.from([0])])), null);
  const swap = (p) => p.map((v, i) => (i % 4 === 0 ? p[i + 2] : i % 4 === 2 ? p[i - 2] : v));
  let decodes = 0;
  // A stand-in for WebCodecs that decodes with the TS decoders, then applies `alter`.
  const fake = (alter) =>
    class {
      constructor({data, type}) {
        this.data = data;
        this.type = type;
      }
      async decode() {
        decodes++;
        const bgra = alter(
          this.type === 'image/webp'
            ? decodeWebp(this.data).pixels
            : swap((await decodePng(this.data)).pixels),
        );
        const opaque = bgra.every((v, i) => i % 4 !== 3 || v === 255);
        const {width, height} =
          this.type === 'image/webp' ? losslessWebpSize(this.data) : simplePngHeader(this.data);
        return {
          image: {
            format: opaque ? 'BGRX' : 'BGRA',
            displayWidth: width,
            displayHeight: height,
            allocationSize: () => bgra.length,
            copyTo: async (to, {format}) => to.set(format === 'BGRA' ? bgra : swap(bgra)),
            close() {},
          },
        };
      }
      close() {}
    };
  const saved = globalThis.ImageDecoder;
  try {
    delete globalThis.ImageDecoder;
    assert.equal(await createLosslessImageDecoder().webp(lossless), null);
    globalThis.ImageDecoder = fake((p) => p);
    const exact = createLosslessImageDecoder();
    assert.deepEqual((await exact.webp(lossless)).pixels, decodeWebp(lossless).pixels);
    const decoded = await exact.png(truecolour, 'rgba');
    const {indices, ...reference} = await decodePng(truecolour);
    assert.equal(indices, undefined);
    assert.deepEqual(decoded, reference);
    assert.deepEqual((await exact.png(truecolour, 'bgra')).pixels, swap(decoded.pixels));
    decodes = 0;
    assert.equal(await exact.webp(lossy), null);
    assert.equal(decodes, 0);
    // A decoder that premultiplies is never used.
    globalThis.ImageDecoder = fake((p) =>
      p.map((v, i) => (i % 4 === 3 ? v : Math.round((v * p[i - (i % 4) + 3]) / 255))),
    );
    const wrong = createLosslessImageDecoder();
    assert.equal(await wrong.webp(lossless), null);
    assert.equal(await wrong.png(truecolour, 'rgba'), null);
  } finally {
    if (saved) globalThis.ImageDecoder = saved;
    else delete globalThis.ImageDecoder;
  }
});
