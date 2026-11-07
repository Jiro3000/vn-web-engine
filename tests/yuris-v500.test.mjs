import {test} from 'node:test';
import assert from 'node:assert/strict';
import {xxHash32} from '../dist/core/xxhash32.js';
import {Xoshiro128pp} from '../dist/core/xoshiro128.js';
import {decodeQoi} from '../dist/formats/qoi.js';
import {decodeYdg} from '../dist/formats/yuris/ydg.js';
import {parseWebm} from '../dist/formats/webm.js';
import {yuvToArgb} from '../dist/video/libyuv.js';
import {Yswbm} from '../dist/engines/yuris/vm/yswbm.js';

const bytes = (text) => new TextEncoder().encode(text);

test('xxHash32 matches the reference vectors', () => {
  assert.equal(xxHash32(bytes('')), 0x02cc5d05);
  assert.equal(xxHash32(bytes('a')), 0x550d7456);
  assert.equal(xxHash32(bytes('abc')), 0x32d153ff);
});

test('xoshiro128++ follows the reference generator', () => {
  const random = new Xoshiro128pp([1, 2, 3, 4]);
  assert.equal(random.next(), 641);
  assert.equal(random.next(), 1573767);
  assert.equal(random.next(), 3222811527);
});

/** A QOI image of `pixels` RGBA quadruples written as QOI_OP_RGBA chunks. */
function qoi(width, height, pixels) {
  const out = [...bytes('qoif'), 0, 0, 0, width, 0, 0, 0, height, 4, 0];
  for (const [r, g, b, a] of pixels) out.push(0xff, r, g, b, a);
  out.push(0, 0, 0, 0, 0, 0, 0, 1);
  return Uint8Array.from(out);
}

test('QOI decodes to BGRA', () => {
  const image = decodeQoi(
    qoi(2, 1, [
      [1, 2, 3, 4],
      [5, 6, 7, 8],
    ]),
  );
  assert.equal(image.channels, 4);
  assert.deepEqual([...image.pixels], [3, 2, 1, 4, 7, 6, 5, 8]);
});

test('YDG stacks its strips and counts the ones it cannot decode', () => {
  const top = qoi(2, 1, [
    [10, 20, 30, 255],
    [40, 50, 60, 255],
  ]);
  const bottom = qoi(2, 1, [
    [1, 1, 1, 1],
    [2, 2, 2, 2],
  ]);
  const header = new Uint8Array(0x34 + 3 * 16);
  header.set(bytes('YDG\0YU-RIS\0\0'));
  const view = new DataView(header.buffer);
  view.setUint16(0x20, 2, true);
  view.setUint16(0x22, 3, true);
  view.setUint16(0x30, 3, true);
  const strip = (i, offset, size, codec) => {
    view.setUint32(0x34 + i * 16, offset, true);
    view.setUint32(0x34 + i * 16 + 4, size, true);
    header[0x34 + i * 16 + 8] = codec;
    view.setUint16(0x34 + i * 16 + 10, 1, true);
  };
  strip(0, header.length, top.length, 0);
  strip(1, 0, 0, 3);
  strip(2, header.length + top.length, bottom.length, 0);
  const image = decodeYdg(Uint8Array.from([...header, ...top, ...bottom]));
  assert.equal(image.failedStrips, 1);
  assert.deepEqual([...image.pixels.subarray(0, 8)], [30, 20, 10, 255, 60, 50, 40, 255]);
  assert.deepEqual([...image.pixels.subarray(8, 16)], [0, 0, 0, 0, 0, 0, 0, 0]);
  assert.deepEqual([...image.pixels.subarray(16, 24)], [1, 1, 1, 1, 2, 2, 2, 2]);
});

test('libyuv BT.601 conversion matches the reference values', () => {
  const out = new Uint8Array(4 * 4);
  const plane = (data, stride) => ({data: Uint8Array.from(data), offset: 0, stride});
  yuvToArgb('i420', plane([16, 128, 235, 128], 4), plane([128, 255], 2), plane([128, 255], 2), {
    out,
    stride: 16,
    width: 4,
    height: 1,
  });
  assert.deepEqual(
    [...out],
    [0, 0, 0, 255, 130, 130, 130, 255, 255, 102, 255, 255, 255, 0, 255, 255],
  );
});

/** EBML element: id bytes, an 8-byte size and the body. */
function element(id, body) {
  const size = [0x01, 0, 0, 0, 0, 0, 0, 0];
  for (let i = 7, n = body.length; i > 0; i--, n = Math.floor(n / 256)) size[i] = n & 0xff;
  return [...id, ...size, ...body];
}

function webm() {
  const header = element([0x1a, 0x45, 0xdf, 0xa3], element([0x42, 0x82], [...bytes('webm')]));
  const info = element(
    [0x15, 0x49, 0xa9, 0x66],
    [
      ...element([0x2a, 0xd7, 0xb1], [0x0f, 0x42, 0x40]),
      ...element([0x44, 0x89], [0x40, 0x59, 0, 0, 0, 0, 0, 0]),
    ],
  );
  const tracks = element(
    [0x16, 0x54, 0xae, 0x6b],
    element(
      [0xae],
      [
        ...element([0xd7], [1]),
        ...element([0x83], [1]),
        ...element([0x86], [...bytes('V_VP8')]),
        ...element([0xe0], [...element([0xb0], [4]), ...element([0xba], [2])]),
      ],
    ),
  );
  // VP8 frame tags: a shown key frame, a hidden frame and a shown frame.
  const block = (time, tag) => element([0xa3], [0x81, 0, time, 0x80, tag, 0, 0]);
  const cluster = element(
    [0x1f, 0x43, 0xb6, 0x75],
    [...element([0xe7], [0]), ...block(0, 0x10), ...block(33, 0x01), ...block(66, 0x11)],
  );
  return Uint8Array.from([
    ...header,
    ...element([0x18, 0x53, 0x80, 0x67], [...info, ...tracks, ...cluster]),
  ]);
}

test('WebM demuxing reads the segment, track and blocks', () => {
  const file = parseWebm(webm());
  assert.equal(file.duration, 100_000_000);
  assert.deepEqual(
    file.tracks.map((t) => [t.codec, t.width, t.height]),
    [['V_VP8', 4, 2]],
  );
  assert.deepEqual(
    file.frames.map((f) => f.time),
    [0, 33_000_000, 66_000_000],
  );
});

test('YSWBM ordinals return the native results', async () => {
  const dll = new Yswbm();
  assert.equal(await dll.decode(new Uint8Array(32)), -1);
  assert.equal(dll.time(), -1n);
  assert.equal(dll.end(), -1);
  assert.equal(dll.preload(null), -1);
  assert.equal(dll.preload(Uint8Array.from([1, 2, 3])), -1);
  assert.equal(dll.preload(webm()), 0);
  assert.deepEqual(dll.size, {width: 4, height: 2});
  assert.equal(dll.duration(), 100n);
  assert.equal(await dll.decode(null), -2);
  // Without a browser decoder only the two shown frames count.
  assert.equal(await dll.decode(new Uint8Array(32)), 0);
  assert.equal(dll.time(), 0n);
  assert.equal(await dll.decode(new Uint8Array(32)), 0);
  assert.equal(dll.time(), 66n);
  assert.equal(await dll.decode(new Uint8Array(32)), 1);
  assert.equal(await dll.decode(new Uint8Array(32)), 1);
  assert.equal(dll.end(), 0);
  assert.equal(dll.end(), -1);
});
