import {test} from 'node:test';
import assert from 'node:assert/strict';
import {xxHash32} from '../dist/core/xxhash32.js';
import {Xoshiro128pp} from '../dist/core/xoshiro128.js';
import {decodeQoi} from '../dist/formats/qoi.js';
import {decodeYdg, decodeYdgConcurrently} from '../dist/formats/yuris/ydg.js';
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

test('YDG stacks its strips and counts the ones it cannot decode', async () => {
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
  const file = Uint8Array.from([...header, ...top, ...bottom]);
  const image = decodeYdg(file);
  assert.equal(image.failedStrips, 1);
  assert.deepEqual([...image.pixels.subarray(0, 8)], [30, 20, 10, 255, 60, 50, 40, 255]);
  assert.deepEqual([...image.pixels.subarray(8, 16)], [0, 0, 0, 0, 0, 0, 0, 0]);
  assert.deepEqual([...image.pixels.subarray(16, 24)], [1, 1, 1, 1, 2, 2, 2, 2]);
  // Concurrent strips stack the same way; a strip the worker declines decodes in-thread.
  const codecs = [];
  const concurrent = await decodeYdgConcurrently(file, async (codec, data) => {
    codecs.push(codec);
    return codecs.length === 1 ? decodeQoi(data).pixels : null;
  });
  assert.deepEqual(codecs, [0, 0]);
  assert.equal(concurrent.failedStrips, 1);
  assert.deepEqual(concurrent.pixels, image.pixels);
});

test('a handed-off YDG preload gives its pixels to the first load only', async (t) => {
  const {LegacyImageCodec, YDG_MIME} = await import('../dist/graphics/legacy-image-codec.js');
  const strip = qoi(2, 1, [
    [10, 20, 30, 255],
    [40, 50, 60, 255],
  ]);
  const header = new Uint8Array(0x34 + 16);
  header.set(bytes('YDG\0YU-RIS\0\0'));
  const view = new DataView(header.buffer);
  view.setUint16(0x20, 2, true);
  view.setUint16(0x22, 1, true);
  view.setUint16(0x30, 1, true);
  view.setUint32(0x34, header.length, true);
  view.setUint32(0x38, strip.length, true);
  view.setUint16(0x3e, 1, true);
  const file = Uint8Array.from([...header, ...strip]);
  const codec = new LegacyImageCodec();
  const decode = t.mock.method(codec, 'decode');
  const expected = [30, 20, 10, 255, 60, 50, 40, 255];
  for (const handOff of [true, false]) {
    const path = `page${handOff}.ydg`;
    await codec.preload(file, YDG_MIME, path, true, {handOff, immutable: true});
    const first = await codec.decodeCached(file, YDG_MIME, true, path);
    assert.deepEqual([...first.pixels], expected);
    first.pixels.fill(0);
    // A hand-off leaves no decode behind; a shared preload keeps its own copy.
    const second = await codec.decodeCached(file, YDG_MIME, true, path);
    assert.deepEqual([...second.pixels], expected);
    assert.notEqual(second.pixels, first.pixels);
    // Only the load after the hand-off decodes in the foreground.
    assert.equal(decode.mock.callCount(), 1);
  }
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

test('Ogg Opus PCM streams in order with the pre-skip and end trim, or falls back to the whole file', async () => {
  const {readOggOpus, openOpusPcm16} = await import('../dist/audio/opus-pcm16.js');
  const page = (flags, granule, packets, sequence) => {
    const lacing = [];
    for (const p of packets) {
      let n = p.length;
      for (; n >= 255; n -= 255) lacing.push(255);
      lacing.push(n);
    }
    const body = packets.reduce((a, p) => a + p.length, 0);
    const out = new Uint8Array(27 + lacing.length + body);
    const view = new DataView(out.buffer);
    out.set(bytes('OggS'), 0);
    out[5] = flags;
    view.setBigInt64(6, BigInt(granule), true);
    view.setUint32(14, 7, true);
    view.setUint32(18, sequence, true);
    out[26] = lacing.length;
    out.set(lacing, 27);
    let at = 27 + lacing.length;
    for (const p of packets) out.set(p, (at += p.length) - p.length);
    return out;
  };
  const opusFile = (gain = 0) => {
    const head = new Uint8Array(19);
    head.set(bytes('OpusHead'));
    head[8] = 1;
    head[9] = 2;
    head[10] = 312 & 255;
    head[11] = 312 >> 8;
    new DataView(head.buffer).setUint32(12, 48000, true);
    head[16] = gain;
    const tags = new Uint8Array(16);
    tags.set(bytes('OpusTags'));
    // CELT fullband 20 ms (config 31), one frame: 960 samples each.
    const audio = Array.from({length: 5}, (_, i) => Uint8Array.of(0xf8, i));
    const pages = [
      page(2, 0, [head], 0),
      page(0, 0, [tags], 1),
      page(0, 2880, audio.slice(0, 3), 2),
      page(4, 4700, audio.slice(3), 3),
    ];
    const file = new Uint8Array(pages.reduce((a, p) => a + p.length, 0));
    let at = 0;
    for (const p of pages) file.set(p, (at += p.length) - p.length);
    return file;
  };
  const value = (index, channel) => index - 2000 + channel * 3;
  const saved = {
    AudioDecoder: globalThis.AudioDecoder,
    EncodedAudioChunk: globalThis.EncodedAudioChunk,
    OfflineAudioContext: globalThis.OfflineAudioContext,
  };
  let failDecoder = false;
  const configured = [];
  globalThis.EncodedAudioChunk = class {
    constructor(init) {
      Object.assign(this, init);
    }
  };
  globalThis.AudioDecoder = class extends EventTarget {
    decodeQueueSize = 0;
    state = 'unconfigured';
    position = 0;
    pending = Promise.resolve();
    constructor({output, error}) {
      super();
      this.output = output;
      this.error = error;
    }
    configure(config) {
      configured.push(config);
      this.state = 'configured';
    }
    decode() {
      const at = this.position;
      this.position += 960;
      this.pending = this.pending.then(() => {
        if (failDecoder && at > 0) return this.error(new Error('decode'));
        this.output({
          numberOfFrames: 960,
          numberOfChannels: 2,
          sampleRate: 48000,
          copyTo: (plane, {planeIndex}) => {
            for (let i = 0; i < 960; i++) plane[i] = value(at + i, planeIndex) / 32768;
          },
          close() {},
        });
      });
    }
    flush() {
      return this.pending;
    }
    close() {
      this.state = 'closed';
    }
  };
  let wholeDecodes = 0;
  globalThis.OfflineAudioContext = class {
    async decodeAudioData() {
      wholeDecodes++;
      const planes = [0, 1].map((c) =>
        Float32Array.from({length: 4388}, (_, i) => value(i + 312, c) / 32768),
      );
      return {numberOfChannels: 2, length: 4388, getChannelData: (c) => planes[c]};
    }
  };
  const expectPcm = (pcm) => {
    const samples = new Int16Array(pcm.bytes.buffer);
    for (let i = 0; i < pcm.frames; i++)
      for (let c = 0; c < 2; c++) assert.equal(samples[i * 2 + c], value(i + 312, c));
  };
  try {
    const file = opusFile();
    const info = readOggOpus(file);
    assert.deepEqual(info, {links: 1, channels: 2, preSkip: 312, frames: 4388});
    const pcm = openOpusPcm16(file, info);
    assert.equal(pcm.frames, 4388);
    // The first block (960 decoded samples less the pre-skip) is enough for an early read.
    assert.equal(await pcm.waitForFrames(600), true);
    assert.equal(pcm.waitForFrames(600), undefined);
    assert.equal(await pcm.waitForFrames(4388), true);
    expectPcm(pcm);
    assert.equal(wholeDecodes, 0);
    assert.equal(configured.at(-1).description, undefined);

    failDecoder = true;
    const fallback = openOpusPcm16(file, info);
    assert.equal(await fallback.waitForFrames(4388), true);
    expectPcm(fallback);
    assert.equal(wholeDecodes, 1);
    failDecoder = false;

    // An output gain is left to the browser's whole-file decoder.
    const decodes = configured.length;
    const gained = openOpusPcm16(opusFile(1), info);
    assert.equal(await gained.waitForFrames(1), true);
    assert.equal(configured.length, decodes);
    assert.equal(wholeDecodes, 2);
  } finally {
    Object.assign(globalThis, saved);
  }
});
