import assert from 'node:assert/strict';
import {test} from 'node:test';
import {BlobSource} from '../dist/core/source.js';
import {SiglusAudio} from '../dist/engines/siglus/audio.js';

function mockAudio(t, files, config = []) {
  const document = new EventTarget();
  let context;
  class Context extends EventTarget {
    currentTime = 10;
    destination = {};
    sampleRate = 48000;
    state = 'running';
    sources = [];

    constructor() {
      super();
      context = this;
    }

    createBuffer(channels, length, sampleRate) {
      const data = Array.from({length: channels}, () => new Float32Array(length));
      return {
        duration: length / sampleRate,
        length,
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
      return {
        connect() {},
        gain: {setValueAtTime() {}, linearRampToValueAtTime() {}, cancelScheduledValues() {}},
      };
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
      ['BGM.001', '"alt", "shared", 88200, 220500, 132300'],
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
