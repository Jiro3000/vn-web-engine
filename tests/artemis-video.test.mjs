import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {readTheoraOgg, TheoraDecoder} from '../dist/formats/theora/index.js';
import {ArtemisTheoraVideo} from '../dist/engines/artemis/video.js';
import {ArtemisLayers} from '../dist/engines/artemis/layers.js';
import {ArtemisTimedWait} from '../dist/engines/artemis/wait.js';
import {ArtemisModes} from '../dist/engines/artemis/modes.js';
import {ArtemisSave} from '../dist/engines/artemis/save.js';
import {ArtemisVariables} from '../dist/engines/artemis/variables.js';
import {ARTEMIS_3179_EXECUTABLE_SHA256 as HASH} from '../dist/engines/artemis/revision.js';

const fixture = (name) => readFileSync(new URL(`./fixtures/theora/${name}.ogv`, import.meta.url));
const clip = fixture('testsrc2-420');
const FRAME_MS = Math.fround(1000 / 30);
const tag = (name, args) => ({
  kind: 'tag',
  name,
  sourceLine: -1,
  args: new Map(Object.entries(args)),
});

/** Independent statement of the native table conversion for one decoded frame. */
function expectedPixels(stream, decoder, mask) {
  const info = stream.info,
    frameWidth = info.macroblockWidth * 16,
    frameHeight = info.macroblockHeight * 16;
  const plane = (source, index, width, height) => {
    const data = new Uint8Array(width * height);
    source.copyPlane(index, data);
    return data;
  };
  const y = plane(decoder, 0, frameWidth, frameHeight),
    u = plane(decoder, 1, frameWidth / 2, frameHeight / 2),
    v = plane(decoder, 2, frameWidth / 2, frameHeight / 2);
  const alpha = mask ? plane(mask, 0, frameWidth, frameHeight) : null;
  const picX = info.pictureX,
    picY = frameHeight - info.pictureHeight - info.pictureY;
  const clamp = (n) => Math.max(0, Math.min(255, n));
  const out = new Uint8Array(info.pictureWidth * info.pictureHeight * 4);
  for (let row = 0; row < info.pictureHeight; row++)
    for (let column = 0; column < info.pictureWidth; column++) {
      const l = y[(picY + row) * frameWidth + picX + column];
      const c = ((picY >> 1) + (row >> 1)) * (frameWidth / 2) + (picX >> 1) + (column >> 1);
      const cb = u[c],
        cr = v[c],
        o = (row * info.pictureWidth + column) * 4;
      out[o] = clamp(l + ((cr * 0x166e9 - 0xb2f480) >> 16));
      out[o + 1] = clamp(l + ((0x2c8c80 - cb * 0x5819 + (0x5b6900 - cr * 0xb6d2)) >> 16));
      out[o + 2] = clamp(l + ((cb * 0x1c5a2 - 0xe25100) >> 16));
      out[o + 3] = alpha ? alpha[(picY + row) * frameWidth + picX + column] : 255;
    }
  return out;
}

test('Video frames follow the native CTheora clock, conversion tables and mask alpha', () => {
  const stream = readTheoraOgg(clip);
  const reference = new TheoraDecoder(stream.info, stream.setup);
  const video = ArtemisTheoraVideo.open(HASH, clip, false, clip);
  assert.equal(video.width, 72);
  assert.equal(video.height, 40);
  assert.equal(video.hasMask, true);
  let finished = 0;
  video.onFinish = () => finished++;
  const start = 5000;
  // One update per frame period shows frame k at start + k * frameMs.
  for (let frame = 0; frame < stream.packets.length; frame++) {
    video.update(start + Math.ceil(frame * FRAME_MS));
    assert.deepEqual(video.frame, {decoded: frame, target: frame + 1});
    if (stream.packets[frame].length) reference.decode(stream.packets[frame]);
    assert.deepEqual(video.pixels, expectedPixels(stream, reference, reference), `frame ${frame}`);
  }
  assert.equal(video.playing, true);
  // The next update finds the data exhausted with target > decoded: close, then finish.
  video.update(start + Math.ceil(stream.packets.length * FRAME_MS));
  assert.equal(video.playing, false);
  assert.equal(finished, 1);
  video.update(start + 100000);
  assert.equal(finished, 1);
});

test('Video delaymargin skips inter frames up to the frame-rate cap; loop restarts', () => {
  const late = ArtemisTheoraVideo.open(HASH, clip, false, null);
  late.update(1000);
  late.update(1000 + Math.ceil(10 * FRAME_MS));
  // Without delaymargin (-1) the target advances one frame per update.
  assert.deepEqual(late.frame, {decoded: 1, target: 2});

  const skipping = ArtemisTheoraVideo.open(HASH, clip, false, null);
  skipping.setDelayMargin(0);
  skipping.update(1000);
  skipping.update(1000 + Math.ceil(10 * FRAME_MS));
  // diff = 10 - 1: target = min(9, ceil(30)) + 2.
  assert.deepEqual(skipping.frame, {decoded: 1, target: 11});
  skipping.update(1000 + Math.ceil(11 * FRAME_MS));
  assert.deepEqual(skipping.frame, {decoded: 11, target: 12});

  const capped = ArtemisTheoraVideo.open(HASH, clip, true, null);
  capped.setDelayMargin(0);
  capped.update(1000);
  capped.update(1000 + Math.ceil(100 * FRAME_MS));
  assert.deepEqual(capped.frame, {decoded: 1, target: 32});

  const looping = ArtemisTheoraVideo.open(HASH, clip, true, null);
  const frames = readTheoraOgg(clip).packets.length;
  for (let frame = 0; frame <= frames + 2; frame++)
    looping.update(1000 + Math.ceil(frame * FRAME_MS));
  assert.equal(looping.playing, true);
  assert.deepEqual(looping.frame, {decoded: frames + 2, target: frames + 3});
});

test('Video tag opens file, .mja, .ogv and its _m mask, then replaces the layer', async () => {
  const reads = [],
    effects = [];
  const files = new Map([
    ['mov/clip.ogv', clip],
    ['mov/clip_m.ogv', clip],
    ['bad.ogv', new TextEncoder().encode('OggS not a theora page')],
    ['raw', new Uint8Array([1, 2, 3, 4])],
  ]);
  const host = {
    creationMode: () => 0,
    readVideoFile: async (path) => {
      reads.push(path);
      return files.get(path) ?? null;
    },
    createVideoLayer: (video, anchor) => ({video, anchor}),
    videoError: (input, error) => effects.push({error, file: input.args.get('file')}),
    releaseImageLayer: (layer) => effects.push({release: layer.video.width}),
    resetLayerCommands: (id) => effects.push({reset: id}),
    clearLayerCommands: (ids) => effects.push({clear: ids}),
  };
  const layers = new ArtemisLayers(HASH, {load: async () => null}, host);
  assert.equal(
    await layers.dispatch(
      tag('video', {id: '1.0', file: 'mov/clip', loop: '', delaymargin: '100'}),
    ),
    true,
  );
  assert.deepEqual(reads, ['mov/clip', 'mov/clip.mja', 'mov/clip.ogv', 'mov/clip_m.ogv']);
  const layer = layers.scene.entry('1.0').value;
  assert.deepEqual(layer.anchor, {x: 36, y: 20});
  assert.equal(layer.video.hasMask, true);
  assert.deepEqual(effects, [{reset: '1.0'}]);

  // Replay: the old layer goes without recording, no command reset.
  effects.length = reads.length = 0;
  await layers.dispatch(tag('video', {id: '1.0', file: 'mov/clip.ogv', loop: '0'}), false);
  assert.deepEqual(reads, ['mov/clip.ogv', 'mov/clip_m.ogv']);
  assert.deepEqual(effects, [{release: 72}]);

  effects.length = 0;
  await layers.dispatch(tag('video', {id: '2', file: 'missing'}));
  await layers.dispatch(tag('video', {id: '2', file: 'bad'}));
  assert.deepEqual(effects, [
    {error: 'not-found', file: 'missing'},
    {error: 'unsupported', file: 'bad'},
  ]);
  assert.equal(layers.scene.entry('2'), undefined);
  await assert.rejects(layers.dispatch(tag('video', {id: '2', file: 'raw'})), /MJA/);
  await assert.rejects(layers.dispatch(tag('video', {file: 'mov/clip'})), /fullscreen/);
});

test('wait video= holds without a text display until the layer stops playing', () => {
  const modes = new ArtemisModes({
    writeStatus: () => {},
    commandSkipChanged: () => {},
    controlSkipChanged: () => {},
    automodeChanged: () => {},
    releaseScheduler: () => {},
  });
  const unexpected = () => assert.fail('unexpected effect');
  const save = new ArtemisSave(new ArtemisVariables(), {
    reportEventError: unexpected,
    beforeScenario: unexpected,
    writeScenario: unexpected,
    writeGlobal: unexpected,
    writeSystem: unexpected,
  });
  const effects = [];
  let playing = true;
  const wait = new ArtemisTimedWait(modes, save, {
    now: () => 1,
    debugSkipActive: () => false,
    startTextDisplay: unexpected,
    textDisplayComplete: () => true,
    finishTextDisplay: unexpected,
    writeClickSkip: unexpected,
    beginWait: (input) => effects.push({begin: input}),
    endWait: () => effects.push('end'),
    clickWaitEvent: unexpected,
    resumeMessageState: () => effects.push('resume'),
    videoPlaying: (id) => {
      effects.push({query: id});
      return playing;
    },
  });
  assert.equal(wait.dispatch(tag('wait', {video: '1.0', time: '50', scenario: '1'})), true);
  assert.equal(wait.videoPending, true);
  assert.deepEqual(wait.reason, {video: '1.0'});
  assert.equal(wait.tick(1000), false);
  playing = false;
  assert.equal(wait.tick(1016), true);
  assert.equal(wait.pending, false);
  assert.deepEqual(effects, [{begin: false}, {query: '1.0'}, {query: '1.0'}, 'end', 'resume']);
});
