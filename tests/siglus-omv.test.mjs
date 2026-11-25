import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import {test} from 'node:test';
import {SiglusPlayer} from '../dist/engines/siglus/player.js';
import {OggPacketAssembler, readOggPage} from '../dist/formats/ogg/page.js';
import {SiglusOmv} from '../dist/formats/siglus/omv.js';
import {readTheoraOgg, TheoraDecoder} from '../dist/formats/theora/index.js';
import {TheoraReconstruction} from '../dist/formats/theora/wasm-reconstruction.js';
import {SiglusOmvPlayback} from '../dist/video/siglus-omv-playback.js';

function indexedOmv(payload, info) {
  const pages = [];
  const frames = [];
  const assembler = new OggPacketAssembler();
  let pendingFrom = 0;
  let keyframe = 0;
  let headers = 3;
  for (let offset = 0; offset < payload.length;) {
    const page = readOggPage(payload, offset);
    const pageNo = pages.length;
    const startPage = assembler.pending ? pendingFrom : pageNo;
    const packets = assembler.push(page);
    if (assembler.pending && (packets.length || startPage === pageNo)) pendingFrom = pageNo;
    const headerPackets = Math.min(headers, packets.length);
    headers -= headerPackets;
    const data = packets.slice(headerPackets);
    pages.push([
      pageNo,
      0,
      page.bytes.length,
      offset,
      startPage,
      packets.length,
      data.length ? frames.length : -1,
    ]);
    for (const [slot, packet] of data.entries()) {
      const frame = frames.length;
      if (packet.length && !(packet[0] & 0x40)) keyframe = frame;
      frames.push([
        frame,
        pageNo,
        slot,
        Number(keyframe === frame),
        keyframe,
        frames[keyframe]?.[1] ?? pageNo,
        0,
        0,
      ]);
    }
    offset += page.bytes.length;
  }
  const offset = 168 + pages.length * 28 + frames.length * 32;
  const bytes = new Uint8Array(offset + payload.length);
  const values = new DataView(bytes.buffer);
  for (const [at, value] of [
    [0, 168],
    [4, 257],
    [44, info.pictureWidth],
    [48, info.pictureHeight],
    [60, 33333],
    [76, pages.length],
    [80, frames.length],
  ])
    values.setUint32(at, value, true);
  let at = 168;
  for (const row of [...pages, ...frames]) {
    for (const value of row) {
      values.setUint32(at, value, true);
      at += 4;
    }
  }
  bytes.set(payload, offset);
  return {bytes, firstData: offset + pages[frames[0][1]][3]};
}

test('indexed OMV opens without reading video packets and seeks to matching pixels', async () => {
  const payload = await readFile(new URL('./fixtures/theora/testsrc2-444.ogv', import.meta.url));
  const {bytes, firstData} = indexedOmv(payload, readTheoraOgg(payload).info);
  const reads = [];
  const source = {
    size: bytes.length,
    async read(offset, length) {
      reads.push({offset, length});
      return bytes.subarray(offset, offset + length);
    },
  };
  const movie = await SiglusOmv.open(source);
  assert.ok(reads.every(({offset, length}) => offset + length <= firstData));
  const reference = new SiglusOmv(bytes);
  assert.equal(movie.frames, reference.frames);
  for (const index of [0, 8, reference.frames - 1, 11, 0])
    assert.deepEqual(await movie.readFrame(index), reference.frame(index));
  assert.ok(reads.every(({length}) => length < source.size));

  // An index with contradictory lengths still plays through the complete Ogg reader.
  bytes[168 + 8]++;
  reads.length = 0;
  const fallback = await SiglusOmv.open(source);
  assert.ok(reads.some(({length}) => length === source.size));
  assert.deepEqual(await fallback.readFrame(11), reference.frame(11));
});

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

test('Siglus full-range YCbCr preserves reference clipping and half-value rounding', async () => {
  const width = 257;
  const pairs = [
    [3, 253],
    [253, 3],
    [78, 178],
    [178, 78],
    [128, 128],
    [0, 0],
    [255, 255],
  ];
  const height = pairs.length;
  const expected = new Uint8ClampedArray(width * height * 4);
  const {setup} = readTheoraOgg(
    await readFile(new URL('./fixtures/theora/testsrc2-444.ogv', import.meta.url)),
  );
  const simd = TheoraReconstruction.create(
    Math.ceil((width * height) / 64) * 3,
    setup,
    expected.length,
  );
  assert.ok(simd);
  const planes = Array.from({length: 3}, () => ({width, height, data: simd.bytes(width * height)}));
  for (const [row, [cb, cr]] of pairs.entries()) {
    for (let col = 0; col < width; col++) {
      const y = col & 255;
      const offset = (height - 1 - row) * width + col;
      planes[0].data[offset] = y;
      planes[1].data[offset] = cb;
      planes[2].data[offset] = cr;
      expected.set(
        [
          y + 1.402 * (cr - 128),
          y - 0.34414 * (cb - 128) - 0.71414 * (cr - 128),
          y + 1.772 * (cb - 128),
          255,
        ],
        (row * width + col) * 4,
      );
      // set() on a clamped array uses the same byte rounding as individual writes.
    }
  }
  const movie = Object.assign(Object.create(SiglusOmv.prototype), {
    width,
    height,
    frames: 1,
    mode: 2,
    decoded: 0,
    keyframes: Int32Array.of(0),
    stream: {info: {pictureWidth: width, pictureHeight: height, pictureX: 0, pictureY: 0}},
    decoder: {frame: planes, omvRgba() {}},
  });
  assert.deepEqual(movie.frame(0), expected);
  assert.deepEqual(simd.rgba(planes, 2, width, height, 0, height - 1), expected);
});

test('Siglus OMV seeks backward from the nearest independent frame', () => {
  const decoded = [];
  const movie = Object.assign(Object.create(SiglusOmv.prototype), {
    width: 1,
    height: 1,
    frames: 6,
    mode: 0,
    decoded: 5,
    keyframes: Int32Array.of(0, 0, 0, 3, 3, 3),
    stream: {
      info: {pictureWidth: 1, pictureHeight: 1, pictureX: 0, pictureY: 0},
      packets: [0, 1, 2, 3, 4, 5],
    },
    decoder: {
      frame: Array.from({length: 3}, () => ({width: 1, height: 1, data: Uint8Array.of(0)})),
      decode: (packet) => decoded.push(packet),
      omvRgba() {},
    },
  });
  assert.deepEqual(movie.frame(4), Uint8ClampedArray.of(0, 0, 0, 255));
  assert.deepEqual(decoded, [3, 4]);
});

test('Siglus check_movie reports prepared and paused OMVs until playback ends', async () => {
  const movie = Object.create(SiglusOmvPlayback.prototype);
  Object.assign(movie, {info: {duration: 4000}, pausedAt: 0, connections: new Set()});
  const player = Object.create(SiglusPlayer.prototype);
  player.objects = [new Map([[0, {movie}]]), new Map()];
  const check = (id) => player.objectCommand({path: [38, 2, -1, id, 127], args: [], named: []});

  assert.equal(await check(1), 0);
  assert.equal(await check(0), 1);
  assert.equal(movie.playing, false);
  movie.seek(500);
  movie.play();
  assert.equal(movie.playing, true);
  movie.pause();
  assert.equal(movie.playing, false);
  assert.equal(await check(0), 1);
  movie.seek(4000);
  assert.equal(await check(0), 0);
});
