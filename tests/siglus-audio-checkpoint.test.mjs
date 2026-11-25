import assert from 'node:assert/strict';
import {test} from 'node:test';
import {BlobSource} from '../dist/core/source.js';
import {SiglusAudio} from '../dist/engines/siglus/audio.js';
import {SiglusVm} from '../dist/engines/siglus/vm.js';
import {ovkIndex} from '../dist/formats/siglus/sound.js';

test('a save sound can finish decoding while a button sound starts on another voice', async () => {
  const started = [];
  let finishSave;
  const save = new Promise((resolve) => { finishSave = resolve; });
  const audio = Object.assign(Object.create(SiglusAudio.prototype), {
    nextSeVoice: 0,
    playing: new Map(),
    fadeEnds: new Map(),
    pendingPlayback: new Map(),
    pendingPromises: new Map(),
    context: {currentTime: 0},
    effectBuffer: (name) => name === 'save' ? save : Promise.resolve({duration: 0.25}),
    start: (voice, _buffer, kind, {resource}) => started.push([voice, kind, resource]),
  });
  const pendingSave = audio.effect('se', 'save');
  await audio.effect('se', 'button');
  assert.equal(audio.channelState('se'), 1);
  finishSave({duration: 0.4});
  await pendingSave;
  assert.deepEqual(started, [['se:1', 'SE', 'button'], ['se:0', 'SE', 'save']]);
  assert.equal(audio.channelState('se'), 0);
});

function mockAudio(t, files, config = []) {
  const document = new EventTarget();
  let context;
  class Context extends EventTarget {
    currentTime = 10;
    destination = {};
    sampleRate = 48000;
    state = 'running';
    sources = [];
    gains = [];

    constructor() {
      super();
      context = this;
    }

    createBuffer(channels, length, sampleRate) {
      const data = Array.from({length: channels}, () => new Float32Array(length));
      return {
        duration: length / sampleRate,
        length,
        numberOfChannels: channels,
        sampleRate,
        getChannelData: (index) => data[index],
      };
    }

    async decodeAudioData(data) {
      const magic = new TextDecoder().decode(new Uint8Array(data, 0, 4));
      assert.ok(magic === 'OggS' || magic === 'RIFF');
      return this.createBuffer(1, magic === 'RIFF' ? 240000 : 480000, this.sampleRate);
    }

    createBufferSource() {
      const source = {
        connect: (destination) => destination,
        disconnect() {},
        start(...args) {
          this.started = args;
        },
        stop(time = 0) {
          this.stopped = time;
        },
      };
      this.sources.push(source);
      return source;
    }

    createGain() {
      const events = [];
      const node = {
        connect() {},
        disconnect() {},
        events,
        gain: {
          setValueAtTime: (...args) => events.push(['set', ...args]),
          linearRampToValueAtTime: (...args) => events.push(['ramp', ...args]),
          cancelScheduledValues: (time) => events.push(['cancel', time]),
          cancelAndHoldAtTime: (time) => events.push(['hold', time]),
        },
      };
      this.gains.push(node);
      return node;
    }

    async close() {}
  }
  for (const [name, value] of Object.entries({
    AudioContext: Context,
    document,
    location: {search: ''},
  })) {
    const previous = Object.getOwnPropertyDescriptor(globalThis, name);
    Object.defineProperty(globalThis, name, {value, configurable: true});
    t.after(() => {
      if (previous) Object.defineProperty(globalThis, name, previous);
      else delete globalThis[name];
    });
  }
  const audio = new SiglusAudio(
    new Map(files),
    new Map(config),
    {ownerDocument: document, dataset: {}},
    '',
  );
  t.after(() => audio.dispose());
  return {audio, context};
}

function source(bytes) {
  return new BlobSource(new Blob([bytes]));
}

function rawNwa(bits, samples, channels = 1) {
  const size = samples.length * (bits / 8);
  const nwa = new Uint8Array(44 + size);
  const head = new DataView(nwa.buffer);
  head.setUint16(0, channels, true);
  head.setUint16(2, bits, true);
  head.setUint32(4, 48000, true);
  head.setInt32(8, -1, true);
  head.setUint32(20, size, true);
  head.setUint32(28, samples.length, true);
  if (bits === 8) nwa.set(samples, 44);
  else samples.forEach((sample, index) => head.setInt16(44 + 2 * index, sample, true));
  return nwa;
}

function vorbisHeader(rate) {
  const ogg = new Uint8Array(44);
  ogg.set(new TextEncoder().encode('OggS'));
  ogg.set([1, 16], 26);
  new DataView(ogg.buffer).setUint32(40, rate, true);
  return ogg;
}

test('a failed BGM replacement leaves the playing track available and can be retried', async (t) => {
  const {audio} = mockAudio(t, [['bgm/theme.ogg', source(vorbisHeader(48000))]]);
  await audio.bgm('theme');
  await assert.rejects(audio.bgm('missing'));
  assert.equal(audio.bgmName(), 'theme');
  assert.equal(audio.root.dataset.bgm, 'theme');
  audio.files.set('bgm/missing.ogg', source(vorbisHeader(48000)));
  await audio.bgm('missing');
  assert.equal(audio.bgmName(), 'missing');
});

test('a BGM prepare supersedes an in-flight play and is cancelled by reset', async (t) => {
  const {audio, context} = mockAudio(t, []);
  const track = {
    name: 'theme',
    buffer: context.createBuffer(1, 48000, 48000),
    loop: true,
    start: 0,
    loopStart: 0,
    loopEnd: 1,
    sourceRate: 48000,
  };
  const pending = new Map();
  audio.loadBgm = (name) => new Promise((resolve) => pending.set(name, resolve));
  const playing = audio.bgm('old');
  const preparing = audio.readyBgm('theme', true);
  pending.get('old')({...track, name: 'old'});
  await playing;
  assert.equal(context.sources.length, 0);

  audio.resetPlayback();
  pending.get('theme')(track);
  await preparing;
  assert.equal(audio.bgmCheckpoint(), undefined);
  audio.resumeBgm();
  assert.equal(context.sources.length, 0);
});

test('non-looping PCM using a BGM alias stops at its configured end sample', async (t) => {
  const {audio, context} = mockAudio(t, [['bgm/shared.ogg', source(vorbisHeader(48000))]], [
    ['BGM.000', '"excerpt", "shared", 48000, 144000, 96000'],
  ]);
  await audio.pcm(2, {resource: 'excerpt', bgmName: 'excerpt', loop: false});
  assert.deepEqual(context.sources.at(-1).started, [10, 1, 2]);
  assert.equal(audio.channelRemainingMs('pcm2'), 2000);
});

test('a checkpoint preserves a looping PCM request before its audio is decoded', async (t) => {
  const {audio, context} = mockAudio(t, []);
  const ambient = {resource: 'rain', loop: true};
  let finishDecode;
  audio.effectBuffer = () => new Promise((resolve) => { finishDecode = resolve; });
  const starting = audio.pcm(2, ambient);
  const checkpoint = audio.pcmCheckpoint();
  audio.resetPlayback();
  const buffer = context.createBuffer(1, 48000, 48000);
  finishDecode(buffer);
  await starting;
  assert.deepEqual(checkpoint, [{channel: 2, level: 255, source: ambient}]);
  assert.equal(context.sources.length, 0);
  audio.effectBuffer = async () => buffer;
  await audio.restorePcm(checkpoint);
  assert.equal(context.sources.at(-1).loop, true);
});

test('starting and stopping voice leaves unrelated PCM gain ramps intact', async (t) => {
  const {audio, context} = mockAudio(t, [['bgm/theme.ogg', source(vorbisHeader(48000))]]);
  const buffer = context.createBuffer(1, 48000, 48000);
  audio.effectBuffer = async () => buffer;
  audio.voiceBuffer = async () => buffer;
  await audio.bgm('theme');
  await audio.pcm(2, {resource: 'rain', loop: true}, false, 1000);
  const ambient = context.gains[1];
  const originalRamp = [...ambient.events];
  await audio.voice(1);
  audio.stop('voice');
  assert.deepEqual(ambient.events, originalRamp);

  audio.setVoiceDuck(128);
  await audio.voice(2);
  assert.deepEqual(ambient.events, originalRamp);
  assert.ok(context.gains[0].events.some(([op, value]) => op === 'set' && value > 0 && value < 1));
});

test('Siglus restores scheduled tracks immediately and preserves their prepared state and levels', async (t) => {
  const ogg = vorbisHeader(48000);
  const {audio, context} = mockAudio(
    t,
    [
      ['bgm/theme.ogg', source(ogg)],
      ['bgm/legacy.owp', source(ogg.map((byte) => byte ^ 0x39))],
      ['wav/chime.nwa', source(rawNwa(16, [0]))],
    ],
    [['BGM.000', '"theme", "theme", 48000, 480000, 96000']],
  );
  const chime = {resource: 'chime', loop: false};
  await audio.pcm(3, chime, true);
  audio.setChannelLevel('pcm3', 128, 0);
  await audio.readyBgm('theme', false);
  assert.equal(context.sources.length, 0);
  assert.equal(audio.pcmCheckpoint()[0].ready, true);
  assert.equal(audio.bgmCheckpoint().ready, true);

  audio.resumePcm(3, 0, 500);
  audio.resumeBgm(0, 750);
  assert.deepEqual(
    context.sources.map(({started}) => started),
    [
      [10.5, 0],
      [10.75, 1],
    ],
  );
  const pcm = audio.pcmCheckpoint();
  const bgm = audio.bgmCheckpoint();
  assert.deepEqual(pcm, [{channel: 3, level: 128, source: chime, pendingResume: true}]);
  assert.equal(bgm.pendingResume, true);

  audio.resetPlayback();
  context.currentTime = 20;
  await audio.restoreBgm(bgm);
  await audio.restorePcm(pcm);
  assert.deepEqual(
    context.sources.slice(-2).map(({started}) => started),
    [
      [20, 1],
      [20, 0],
    ],
  );
  assert.deepEqual(audio.pcmCheckpoint(), [{channel: 3, level: 128}]);
  assert.equal(audio.bgmCheckpoint(), undefined);

  await audio.bgm('theme');
  context.currentTime = 22;
  audio.pauseBgm(0);
  assert.equal(audio.bgmCheckpoint().ready, true);
  audio.resumeBgm();
  assert.deepEqual(context.sources.at(-1).started, [22, 3]);
  const fading = context.sources.at(-1);
  audio.stop('bgm', 500);
  assert.equal(fading.stopped, 22.5);
  assert.equal(audio.bgmCheckpoint(), undefined);
  assert.equal(audio.channelState('bgm'), 2);
  context.currentTime = 22.5;
  assert.equal(audio.channelState('bgm'), 0);
  await audio.bgm('legacy');
  assert.equal(audio.bgmName(), 'legacy');
  assert.equal(audio.channelState('bgm'), 1);
});

test('Siglus BGM aliases share decoded audio and keep distinct source-rate sample ranges', async (t) => {
  const {audio, context} = mockAudio(
    t,
    [['bgm/shared.ogg', source(vorbisHeader(44100))]],
    [
      ['BGM.000', '"intro", "shared", 44100, 176400, 88200'],
      ['BGM.001', '"alt", "shared", 88200, 220500, 132300\t/alternate mix'],
    ],
  );
  await audio.bgm('intro');
  const intro = context.sources.at(-1);
  assert.deepEqual(intro.started, [10, 1]);
  assert.equal(intro.loopStart, 2);
  assert.equal(intro.loopEnd, 4);
  context.currentTime = 11;
  assert.equal(audio.bgmPlayPosition(), 88200);
  context.currentTime = 14;
  assert.equal(audio.bgmPlayPosition(), 132300);

  await audio.bgm('alt', false);
  const alt = context.sources.at(-1);
  assert.equal(alt.buffer, intro.buffer);
  assert.deepEqual(alt.started, [14, 2, 3]);
  assert.equal(alt.loopStart, 3);
  assert.equal(alt.loopEnd, 5);
  assert.equal(audio.channelRemainingMs('bgm'), 3000);

  await audio.bgm('intro', true, 0, 0, 0, 220500);
  assert.deepEqual(context.sources.at(-1).started, [14, 2]);
});

test('large NWA BGM schedules a bounded PCM window with a sample-exact loop', async (t) => {
  const frames = 6_000_000;
  const header = rawNwa(16, []);
  const view = new DataView(header.buffer);
  view.setUint32(20, frames * 2, true);
  view.setUint32(28, frames, true);
  const reads = [];
  const file = {
    size: 44 + frames * 2,
    async read(offset, length) {
      reads.push([offset, length]);
      if (offset === 0 && length === header.length) return header;
      const bytes = new Uint8Array(length);
      const pcm = new DataView(bytes.buffer);
      const start = (offset - 44) / 2;
      for (let i = 0; i < bytes.length / 2; i++) pcm.setInt16(i * 2, (start + i) % 16384, true);
      return bytes;
    },
  };
  const {audio, context} = mockAudio(t, [['bgm/shared.nwa', file]], [
    ['BGM.000', '"intro", "shared", 90000, 96000, 95998'],
  ]);
  await audio.bgm('intro');
  await new Promise(setImmediate);
  const playback = context.sources[0];
  assert.deepEqual(playback.started, [10.075, 0]);
  const samples = playback.buffer.getChannelData(0);
  assert.equal(samples[0], (90000 % 16384) / 32768);
  assert.equal(samples[5999], (95999 % 16384) / 32768);
  assert.equal(samples[6000], (95998 % 16384) / 32768);
  assert.equal(samples[6001], samples[5999]);
  assert.equal(samples[6002], samples[6000]);
  assert.deepEqual(reads, [[0, 44], [180044, 12000], [192040, 4]]);
  assert.ok(context.sources.length > 1 && context.sources.length <= 4);
  audio.stop('bgm');
  assert.equal(audio.channelState('bgm'), 0);
});

test('Siglus resolves loose audio before lower-priority BGM and voice formats', async (t) => {
  const wave = new Uint8Array(44);
  const wav = new DataView(wave.buffer);
  const encoder = new TextEncoder();
  for (const [offset, tag] of [
    [0, 'RIFF'],
    [8, 'WAVEfmt '],
    [36, 'data'],
  ])
    wave.set(encoder.encode(tag), offset);
  wav.setUint32(4, 36, true);
  wav.setUint32(16, 16, true);
  wav.setUint16(20, 1, true);
  wav.setUint16(22, 1, true);
  wav.setUint32(24, 22050, true);
  wav.setUint32(28, 44100, true);
  wav.setUint16(32, 2, true);
  wav.setUint16(34, 16, true);
  const ogg = vorbisHeader(44100);
  const ovk = new Uint8Array(20 + ogg.length);
  const index = new DataView(ovk.buffer);
  [1, ogg.length, 20, 7].forEach((value, field) => index.setUint32(field * 4, value, true));
  ovk.set(ogg, 20);
  const bank = source(ovk);
  let failRead = true;
  const retryingBank = {
    size: bank.size,
    async read(...args) {
      if (!failRead) return bank.read(...args);
      failRead = false;
      throw new Error('Temporarily unavailable');
    },
  };
  const nwa = rawNwa(8, [0, 255, 128, 64], 2);
  const {audio, context} = mockAudio(
    t,
    [
      ['bgm/theme.wav', source(wave)],
      ['bgm/theme.nwa', source(nwa)],
      ['bgm/theme.ogg', source(ogg)],
      ['bgm/short.nwa', source(nwa)],
      ['bgm/short.ogg', source(ogg)],
      ['koe/0001/z000100007.wav', source(wave)],
      ['koe/0001/z000100007.nwa', source(nwa)],
      ['koe/0001/z000100008.nwa', source(nwa)],
      ['koe/z0001.ovk', source(ovk)],
      ['koe/z0002.ovk', retryingBank],
    ],
    [['BGM.000', '"theme", "theme", 22050, -1, 0']],
  );
  await audio.bgm('theme');
  assert.equal(context.sources.at(-1).buffer.duration, 5);
  assert.deepEqual(context.sources.at(-1).started, [10, 1]);

  await audio.bgm('short');
  assert.equal(context.sources.at(-1).buffer.length, 2);

  await audio.voice(100007);
  assert.equal(context.sources.at(-1).buffer.duration, 5);
  await audio.voice(100008);
  const stereo = context.sources.at(-1).buffer;
  assert.deepEqual([...stereo.getChannelData(0)], [-1, 0]);
  assert.deepEqual([...stereo.getChannelData(1)], [127 / 128, -0.5]);
  await assert.rejects(audio.voice(200007), /Temporarily unavailable/);
  await audio.voice(200007);
  assert.equal(context.sources.at(-1).buffer.duration, 10);
});

test('ovkIndex reads <= 1023-entry tables in one read and > 1023-entry tables in two bounded reads', async () => {
  const buildOvk = (count) => {
    const headerSize = 4 + count * 16;
    const payloadOffset = headerSize + 32;
    const total = payloadOffset + 64;
    const reads = [];
    const bytes = new Uint8Array(headerSize);
    const dv = new DataView(bytes.buffer);
    dv.setUint32(0, count, true);
    for (let i = 0; i < count; i++) {
      dv.setUint32(4 + i * 16, 64, true);
      dv.setUint32(4 + i * 16 + 4, payloadOffset, true);
      dv.setUint32(4 + i * 16 + 8, i + 1, true);
    }
    const backing = new Uint8Array(total);
    backing.set(bytes);
    return {
      reads,
      source: {
        size: total,
        async read(offset, length) {
          reads.push([offset, length]);
          return backing.slice(offset, offset + length);
        },
      },
    };
  };

  const small = buildOvk(100);
  const idxSmall = await ovkIndex(small.source);
  assert.equal(idxSmall.size, 100);
  assert.deepEqual(idxSmall.get(100), {offset: 4 + 100 * 16 + 32, size: 64});
  assert.deepEqual(small.reads, [[0, small.source.size]]);

  const large = buildOvk(1025);
  const idxLarge = await ovkIndex(large.source);
  assert.equal(idxLarge.size, 1025);
  assert.deepEqual(idxLarge.get(1025), {offset: 4 + 1025 * 16 + 32, size: 64});
  assert.deepEqual(large.reads, [
    [0, 16384],
    [16384, 4 + 1025 * 16 - 16384],
  ]);
});

test('SiglusAudio reads large OVK banks with zero read-ahead and prefetchVoice warms voiceCache', async (t) => {
  const ogg = vorbisHeader(44100);
  const voiceOffset = 9 << 20;
  const totalSize = voiceOffset + ogg.length + 1024;
  const sliceCalls = [];
  const fakeFile = Object.setPrototypeOf(
    {
      size: totalSize,
      slice(start, end) {
        sliceCalls.push([start, end]);
        return {
          async arrayBuffer() {
            const out = new Uint8Array(end - start);
            if (start === 0) {
              const dv = new DataView(out.buffer);
              dv.setUint32(0, 1, true);
              dv.setUint32(4, ogg.length, true);
              dv.setUint32(8, voiceOffset, true);
              dv.setUint32(12, 42, true);
            } else if (start === voiceOffset) {
              out.set(ogg);
            }
            return out.buffer;
          },
        };
      },
    },
    File.prototype,
  );

  const {audio, context} = mockAudio(t, [['koe/z0001.ovk', new BlobSource(fakeFile)]]);
  let decodeCount = 0;
  const origDecode = context.decodeAudioData.bind(context);
  context.decodeAudioData = async (data) => {
    decodeCount++;
    return origDecode(data);
  };

  audio.prefetchVoice(100042);
  await audio.voice(100042);

  assert.deepEqual(sliceCalls, [
    [0, 16384],
    [voiceOffset, voiceOffset + ogg.length],
  ]);
  assert.equal(decodeCount, 1);
  assert.equal(context.sources.at(-1).buffer.duration, 10);

  // Calling voice() again reuses decoded buffer cleanly with zero additional reads or decodes
  await audio.voice(100042);
  assert.equal(sliceCalls.length, 2);
  assert.equal(decodeCount, 1);
});

test('SiglusVm.peekUpcomingVoices extracts upcoming literal koe IDs without mutating VM state', () => {
  const bytes = [];
  const u8 = (v) => bytes.push(v & 255);
  const i32 = (v) => {
    const b = new ArrayBuffer(4);
    new DataView(b).setInt32(0, v | 0, true);
    bytes.push(...new Uint8Array(b));
  };
  const pushInt = (v) => { u8(2); i32(10); i32(v); };
  const cmdKoe = (id, ch = 5) => {
    u8(8); // CD_ELM_POINT
    pushInt(18); // global.koe
    pushInt(id);
    pushInt(ch);
    u8(48); // CD_COMMAND
    i32(0); // overload
    i32(2); i32(10); i32(10); // args: (int, int)
    i32(0); // named count
    i32(0); // retForm = void
    i32(0); // trailing readFlag (0x12 is in readFlagGlobalRoots)
  };

  // Label 0 starts right after pause (pc=0); first koe 110100067, then jump to label0 -> koe 110100072, then branch op 17 stops scan before 110100999
  cmdKoe(110100067);
  u8(16); i32(0); // unconditional jump to label 0 (later in stream -> exercises label follow cleanly)
  const label0 = bytes.length;
  cmdKoe(110100072);
  pushInt(0);
  u8(17); i32(0); // conditional jump stops scan
  cmdKoe(110100999);
  u8(0);

  const vm = Object.create(SiglusVm.prototype);
  const fakeFrame = {
    scene: {name: 'test_scene', labels: [label0], strings: []},
    pc: 0,
    line: 1,
    stack: ['keep'],
    points: [0],
    code: new DataView(Uint8Array.from(bytes).buffer),
  };
  Object.assign(vm, {
    frames: [fakeFrame],
    sceneJumps: new Map(),
  });

  assert.deepEqual(vm.peekUpcomingVoices(4), [110100067, 110100072]);
  assert.equal(fakeFrame.pc, 0);
  assert.deepEqual(fakeFrame.stack, ['keep']);
  assert.deepEqual(fakeFrame.points, [0]);
});
