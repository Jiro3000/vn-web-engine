import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import {test} from 'node:test';
import {SiglusOmv} from '../dist/formats/siglus/omv.js';
import {readTheoraOgg, TheoraDecoder} from '../dist/formats/theora/index.js';

test('Siglus OMV restores BGR and all three alpha segments from a 4:4:4 stream', async () => {
  const payload = await readFile(new URL('./fixtures/theora/testsrc2-444.ogv', import.meta.url));
  const {info, setup, packets} = readTheoraOgg(payload);
  const width = info.pictureWidth;
  const height = Math.floor((info.pictureHeight * 3) / 4);
  const alphaRows = Math.ceil(height / 3);
  assert.equal(info.pictureHeight, height + alphaRows);

  const offset = 168 + 28 + 32;
  const bytes = new Uint8Array(offset + payload.length);
  const header = new DataView(bytes.buffer);
  for (const [at, value] of [
    [0, 168],
    [4, 257],
    [40, 1],
    [44, width],
    [48, height],
    [60, 33333],
    [76, 1],
    [80, 1],
  ])
    header.setUint32(at, value, true);
  bytes.set(payload, offset);
  const movie = new SiglusOmv(bytes);
  assert.equal(movie.frames, packets.length);
  const rgba = movie.frame(0);

  const decoder = new TheoraDecoder(info, setup);
  decoder.decode(packets[0]);
  const planes = decoder.frame.map((plane, index) => {
    const pixels = new Uint8Array(plane.width * plane.height);
    decoder.copyPlane(index, pixels);
    return pixels;
  });
  const stride = decoder.frame[0].width;
  const top = decoder.frame[0].height - info.pictureHeight - info.pictureY;
  for (const y of [0, alphaRows, alphaRows * 2, height - 1]) {
    const x = Math.floor(width / 2);
    const color = (top + y) * stride + info.pictureX + x;
    const alpha = (top + height + (y % alphaRows)) * stride + info.pictureX + x;
    const pixel = (y * width + x) * 4;
    assert.deepEqual(
      [...rgba.subarray(pixel, pixel + 4)],
      [
        planes[2][color],
        planes[1][color],
        planes[0][color],
        planes[Math.floor(y / alphaRows)][alpha],
      ],
    );
  }
  movie.frame(packets.length - 1);
  assert.deepEqual(movie.frame(0), rgba);
});
