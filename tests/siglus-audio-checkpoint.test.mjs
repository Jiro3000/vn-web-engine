import assert from 'node:assert/strict';
import {test} from 'node:test';
import {BlobSource} from '../dist/core/source.js';
import {SiglusAudio} from '../dist/engines/siglus/audio.js';

test('Siglus restores scheduled tracks immediately and preserves their prepared state and levels', async (t) => {
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
      return {duration: length / sampleRate, sampleRate, getChannelData: (index) => data[index]};
    }

    async decodeAudioData(data) {
      assert.equal(new TextDecoder().decode(new Uint8Array(data, 0, 4)), 'OggS');
      return this.createBuffer(1, 480000, this.sampleRate);
    }

    createBufferSource() {
      const source = {
        connect: (destination) => destination,
        start(time, offset) {
          this.started = [time, offset];
        },
        stop(time = 0) {
          this.stopped = time;
        },
      };
      this.sources.push(source);
      return source;
    }

    createGain() {
      return {connect() {}, gain: {setValueAtTime() {}, linearRampToValueAtTime() {}}};
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
  const nwa = new Uint8Array(46);
  const head = new DataView(nwa.buffer);
  head.setUint16(0, 1, true);
  head.setUint16(2, 16, true);
  head.setUint32(4, 48000, true);
  head.setInt32(8, -1, true);
  head.setUint32(20, 2, true);
  head.setUint32(28, 1, true);
  const ogg = new Uint8Array(44);
  ogg.set(new TextEncoder().encode('OggS'));
  ogg.set([1, 16], 26);
  new DataView(ogg.buffer).setUint32(40, 48000, true);
  const audio = new SiglusAudio(
    new Map([
      ['bgm/theme.ogg', new BlobSource(new Blob([ogg]))],
      ['bgm/legacy.owp', new BlobSource(new Blob([ogg.map((byte) => byte ^ 0x39)]))],
      ['wav/chime.nwa', new BlobSource(new Blob([nwa]))],
    ]),
    new Map([['BGM.000', '"theme", "theme", 48000, 480000, 96000']]),
    {ownerDocument: document, dataset: {}},
    '',
  );
  t.after(() => audio.dispose());
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
