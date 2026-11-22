import assert from 'node:assert/strict';
import {test} from 'node:test';
import {siglusVolumeGain} from '../dist/engines/siglus/audio.js';
import {
  orderedObjects,
  serializeDrawObject,
  SiglusDisplay,
} from '../dist/engines/siglus/display.js';
import {SiglusPlayer} from '../dist/engines/siglus/player.js';
import {G00Image} from '../dist/formats/siglus/g00.js';

test('Phase 3 AUDIO-01: siglusVolumeGain matches native DirectSound dB curve (0x6e0bd0)', () => {
  assert.equal(siglusVolumeGain(0), 0);
  assert.equal(siglusVolumeGain(-0.5), 0);
  assert.equal(siglusVolumeGain(Number.NaN), 0);
  assert.equal(siglusVolumeGain(1), 1);
  assert.equal(siglusVolumeGain(1.5), 1);

  // Midpoint 0.5 -> dB = trunc(log10(0.5) * 5000) = -1505 -> 10^(-1505/2000) ≈ 0.1768
  const mid = siglusVolumeGain(0.5);
  assert.ok(Math.abs(mid - Math.pow(10, -1505 / 2000)) < 1e-6, `Expected ~0.1768, got ${mid}`);

  // Native 128/255 ≈ 0.50196 -> slightly above 0.5^2.5; 1/255 (< 0.01) clamps to -10000 (silence = 0)
  const g128 = siglusVolumeGain(128 / 255);
  const g64 = siglusVolumeGain(64 / 255);
  const g16 = siglusVolumeGain(16 / 255);
  assert.equal(siglusVolumeGain(1 / 255), 0);
  assert.ok(
    g16 > 0 && g16 < g64 && g64 < g128 && g128 < 1,
    'Volume curve must be strictly monotonic above silence floor',
  );
  assert.equal(siglusVolumeGain(0.009), 0);
  assert.ok(siglusVolumeGain(0.02) > 0);
});

test('Phase 3 STORE-05: serializeDrawObject deep-clones full DrawObject trees cleanly for JSON save/load', () => {
  const child = {
    type: 1,
    name: '',
    frames: [],
    x: 10,
    y: 20,
    visible: true,
    pattern: 0,
    rect: {left: 0, top: 0, right: 120, bottom: 40, r: 255, g: 128, b: 0, a: 200},
    text: {
      value: 'Hello',
      size: 32,
      bold: true,
      shadow: 1,
      spaceX: 2,
      spaceY: 4,
      maxChars: 20,
      color: 1,
      shadowColor: 2,
      outlineColor: 3,
      shadowMode: 2,
    },
    button: {id: 5, group: 2, actionNo: 23, seNo: 5},
  };

  const root = {
    type: 2,
    name: 'bg01',
    frames: [],
    x: 100,
    y: 50,
    visible: true,
    layer: 3,
    order: 7,
    transparency: 200,
    trOffsets: [255, 180],
    flags: [1, 2, 3],
    pattern: 1,
    scale: [1200, 800],
    rotateX: 10,
    rotateY: 20,
    rotateZ: 450,
    center: [320, 240],
    centerRep: [10, -10],
    colorProps: {bright: 10, dark: 5, mono: 20, colorR: 255, colorG: 0, colorB: 0, colorRate: 128},
    tonecurveNo: 30,
    wipeCopy: true,
    weather: {mode: 1, params: {0: 40, 3: 1000}, started: 999},
    gan: {file: 'ef_01', sequence: 2, loop: true, started: 999},
    number: {value: 42, ketaMax: 4, dispZero: 1, dispSign: 0, tumeruSign: 0, spaceMod: 0, space: 2},
    sourceClipEnabled: true,
    sourceClipBounds: [1, 2, 300, 400],
    children: new Map([[0, child]]),
  };

  const serialized = serializeDrawObject(root, 1500);
  const roundTripped = JSON.parse(JSON.stringify(serialized));

  // Mutating original must NOT mutate serialized snapshot
  root.trOffsets[1] = 0;
  root.flags[0] = 99;
  root.colorProps.colorRate = 0;
  child.button.seNo = -1;

  assert.deepEqual(roundTripped.trOffsets, [255, 180]);
  assert.deepEqual(roundTripped.flags, [1, 2, 3]);
  assert.equal(roundTripped.colorProps.colorRate, 128);
  assert.equal(roundTripped.tonecurveNo, 30);
  assert.equal(roundTripped.order, 7);
  assert.deepEqual(roundTripped.center, [320, 240]);
  assert.deepEqual(roundTripped.centerRep, [10, -10]);
  assert.deepEqual(roundTripped.weather, {mode: 1, params: {0: 40, 3: 1000}});
  assert.deepEqual(roundTripped.gan, {file: 'ef_01', sequence: 2, loop: true, elapsed: 501});
  assert.equal(roundTripped.children.length, 1);
  assert.equal(roundTripped.children[0][0], 0);
  assert.deepEqual(roundTripped.children[0][1].button, {id: 5, group: 2, actionNo: 23, seNo: 5});
  assert.deepEqual(roundTripped.children[0][1].rect, {
    left: 0,
    top: 0,
    right: 120,
    bottom: 40,
    r: 255,
    g: 128,
    b: 0,
    a: 200,
  });
});

test('SSR object GAN load resumes the saved phase, including child objects and legacy slots', async (t) => {
  const words = [
    10000, 10000, 20000, 1, 30000, 2, 30100, 0, 30103, 120, 999999, 30100, 1, 30103, 120, 999999,
  ];
  const bytes = new Uint8Array(words.length * 4);
  const view = new DataView(bytes.buffer);
  words.forEach((word, i) => view.setInt32(i * 4, word, true));
  const graphic = {x: 0, y: 0, centerX: 0, centerY: 0};
  const display = {
    files: new Map([['gan/effect.gan', {size: bytes.length, read: async () => bytes}]]),
    objectGraphic: async () => graphic,
    node: () => ({
      style: {},
      animate() {
        return (this.animation = {currentTime: null});
      },
    }),
  };
  const originalDocument = Object.getOwnPropertyDescriptor(globalThis, 'document');
  Object.defineProperty(globalThis, 'document', {
    configurable: true,
    value: {
      createElement() {
        return {
          dataset: {},
          style: {},
          children: [],
          append(child) {
            this.children.push(child);
          },
        };
      },
    },
  });
  t.after(() => {
    if (originalDocument) Object.defineProperty(globalThis, 'document', originalDocument);
    else delete globalThis.document;
  });
  const base = {name: '', frames: [], x: 0, y: 0, visible: true, pattern: 0};
  const parent = {
    ...base,
    children: new Map([
      [0, {...base, gan: {file: 'effect', sequence: 0, loop: true, started: 639}}],
      [1, {...base, gan: {file: 'effect', sequence: 0, loop: false, started: 639}}],
    ]),
  };
  const save = JSON.parse(JSON.stringify(serializeDrawObject(parent, 1000)));
  const player = Object.create(SiglusPlayer.prototype);
  const phase = async (object) => {
    const layer = await SiglusDisplay.prototype.objectGanLayer.call(display, object);
    return layer.children.map((child) => child.animation.currentTime);
  };
  const restored = await player.deserializeDrawObject(save);
  assert.deepEqual(await phase(restored.children.get(0)), [121, 121]);
  assert.deepEqual(await phase(restored.children.get(1)), [240, 240]);
  const looping = restored.children.get(0);
  assert.equal(serializeDrawObject(looping, looping.gan.started + 40).gan.elapsed, 401);

  delete save.children[0][1].gan.elapsed;
  const legacy = await player.deserializeDrawObject(save);
  assert.deepEqual(await phase(legacy.children.get(0)), [0, 0]);
});

test('Phase 3 display orderedObjects sorts by order, then layer, then slot id', () => {
  const m = new Map([
    [10, {name: 'a', frames: [], x: 0, y: 0, visible: true, pattern: 0, order: 2, layer: 0}],
    [2, {name: 'b', frames: [], x: 0, y: 0, visible: true, pattern: 0, order: 1, layer: 5}],
    [5, {name: 'c', frames: [], x: 0, y: 0, visible: true, pattern: 0, order: 1, layer: 1}],
    [1, {name: 'd', frames: [], x: 0, y: 0, visible: true, pattern: 0, order: 1, layer: 1}],
  ]);
  assert.deepEqual(
    orderedObjects(m).map((o) => o.name),
    ['d', 'c', 'b', 'a'],
  );
});

test('Phase 3 G00Image decodes Type 2 deduplicated cuts with negative signed length (0x6de3bc)', () => {
  // Build minimal uncompressed (flag=0xff literal runs) Type 2 G00 with 2 cuts sharing the same block:
  // cut[0]: offset=20, length=+212; cut[1]: offset=20, length=-212 (deduplicated)
  const blockLen = 116 + 92 + 4; // 1x1 chip = 4 BGRA bytes
  const inner = new Uint8Array(20 + blockLen);
  const iv = new DataView(inner.buffer);
  iv.setUint32(0, 2, true); // innerCount = 2
  iv.setUint32(4, 20, true);
  iv.setInt32(8, blockLen, true);
  iv.setUint32(12, 20, true);
  iv.setInt32(16, -blockLen, true); // negative signed length!
  // Cut header at offset 20
  iv.setUint16(20 + 2, 1, true); // 1 chip
  iv.setInt32(20 + 28, 1, true); // w = 1
  iv.setInt32(20 + 32, 1, true); // h = 1
  // Chip header at offset 20 + 116
  iv.setUint16(20 + 116 + 6, 1, true); // cw = 1
  iv.setUint16(20 + 116 + 8, 1, true); // ch = 1
  // Pixel BGRA at offset 20 + 116 + 92
  inner.set([10, 20, 30, 255], 20 + 116 + 92);

  // Pack with Siglus LZ literals (8 literals per 0xff flag byte)
  const packedBody = [];
  for (let i = 0; i < inner.length; i += 8) {
    packedBody.push(0xff);
    for (let j = 0; j < 8 && i + j < inner.length; j++) packedBody.push(inner[i + j]);
  }
  const lz = new Uint8Array(8 + packedBody.length);
  const lzv = new DataView(lz.buffer);
  lzv.setUint32(0, lz.length, true);
  lzv.setUint32(4, inner.length, true);
  lz.set(packedBody, 8);

  const file = new Uint8Array(9 + 2 * 24 + lz.length);
  const fv = new DataView(file.buffer);
  fv.setUint8(0, 2); // type 2
  fv.setUint16(1, 1, true);
  fv.setUint16(3, 1, true);
  fv.setUint32(5, 2, true); // count = 2
  file.set(lz, 9 + 2 * 24);

  const img = new G00Image(file);
  const f0 = img.frame(0);
  const f1 = img.frame(1);
  assert.deepEqual([...f0.bgra], [10, 20, 30, 255]);
  assert.deepEqual([...f1.bgra], [10, 20, 30, 255]);
});
