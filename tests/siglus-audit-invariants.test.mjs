import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import {
  parseButtonActionStates,
  parseButtonSe,
  parseMwndAnimation,
  parseMwndColors,
  parseSpaceHideObjectIds,
} from '../dist/engines/siglus/mwnd.js';
import {
  layoutSelbtnItems,
  readSelbtnTemplate,
  selbtnPresentation,
} from '../dist/engines/siglus/selbtn.js';
import {layoutObjectText} from '../dist/engines/siglus/object-text.js';
import {orderedObjects, serializeDrawObject, SiglusDisplay} from '../dist/engines/siglus/display.js';
import {SiglusPlayer} from '../dist/engines/siglus/player.js';
import {SiglusVm} from '../dist/engines/siglus/vm.js';
import {MissingSiglusVoiceError, SiglusAudio} from '../dist/engines/siglus/audio.js';
import {encodeCaptureBmp, readCaptureBmpFlags} from '../dist/engines/siglus/capture.js';
import {BlobSource} from '../dist/core/source.js';
import {unpackSiglusLz, xorByteInPlace} from '../dist/formats/siglus/compression.js';
import {G00Image} from '../dist/formats/siglus/g00.js';
import {readJpegHeader} from '../dist/formats/jpeg/header.js';
import {decodeOwp} from '../dist/formats/siglus/sound.js';
import {AsfDemuxer, readAsfLayout} from '../dist/formats/asf/demux.js';
import {SiglusScenePack} from '../dist/formats/siglus/scene-pack.js';
import {WindowsMediaDecoder} from '../dist/video/windows-media.js';
import {MemoryStore} from '../dist/platform/store.js';

const REPO_ROOT = path.resolve(import.meta.dirname, '..');
const SIGLUS_DIR = path.join(REPO_ROOT, 'src/engines/siglus');
const SSR_DIR = '/Users/paul/Torrents/Games/tsuki no kanata fan disk';
const HAS_SSR = fs.existsSync(`${SSR_DIR}/Gameexe.dat`) && fs.existsSync(`${SSR_DIR}/Scene.pck`);

test('composite layers clamp requested G00 cuts to the decoded range', async () => {
  const display = {
    files: new Map(),
    resource: async (name) => ({count: name === 'single' ? 1 : 4}),
    graphic: async (name, pattern) => ({name, pattern}),
    compositeGraphic: async (name) => ({composite: name}),
  };
  const graphic = SiglusDisplay.prototype.objectGraphic.bind(display);
  assert.deepEqual(await graphic('single', 1, true), {name: 'single', pattern: 0});
  assert.deepEqual(await graphic('atlas', -1, true), {name: 'atlas', pattern: 0});
  assert.deepEqual(await graphic('atlas', 8, true), {name: 'atlas', pattern: 3});
  assert.equal(await graphic('atlas', 8), undefined);
  assert.deepEqual(await graphic('atlas|single(0,0,1)', 0), {composite: 'atlas|single(0,0,1)'});
  const cutCount = SiglusDisplay.prototype.graphicCutCount.bind(display);
  assert.equal(await cutCount('atlas___001'), 4);
  assert.equal(await cutCount('(1024,768)|atlas(0,0,3)'), 1);
});

test('G00 Type 1 expands palette indices with their stored alpha', () => {
  const pixels = [2, 0, 1, 2, 3, 255, 4, 5, 6, 0, 1, 0];
  const literals = [0xff, ...pixels.slice(0, 8), 0xff, ...pixels.slice(8)];
  const bytes = new Uint8Array(13 + literals.length);
  const header = new DataView(bytes.buffer);
  header.setUint8(0, 1);
  header.setUint16(1, 2, true);
  header.setUint16(3, 1, true);
  header.setUint32(5, bytes.length - 5, true);
  header.setUint32(9, pixels.length, true);
  bytes.set(literals, 13);
  const image = new G00Image(bytes);
  assert.deepEqual(image.frame(0).bgra, Uint8Array.of(4, 5, 6, 0, 1, 2, 3, 255));
  bytes[bytes.length - 1] = 2;
  assert.throws(() => new G00Image(bytes).frame(0), /Invalid G00 palette index/);
});

test('G00 Type 3 unscrambles the real SSR JPEG and preserves its dimensions', {skip: !HAS_SSR}, () => {
  const image = new G00Image(fs.readFileSync(path.join(SSR_DIR, 'g00', 'bb_BG303n.g00')));
  assert.equal(image.type, 3);
  const jpeg = readJpegHeader(image.jpeg());
  assert.deepEqual([jpeg.width, jpeg.height], [image.width, image.height]);
  assert.ok(jpeg.components > 0);
});

test('source-clip integer events update only their edge and support the script wait', async () => {
  const object = {type: 2, name: 'atlas', sourceClipBounds: [3, 4, 85, 100]};
  const phases = [];
  const player = Object.assign(Object.create(SiglusPlayer.prototype), {
    objectAddress: () => ({page: new Map([[1, object]]), index: 2}),
    markObjectsDirty: () => {},
    display: {graphicCutCount: async (name) => name === 'atlas' ? 5 : 0},
    renderObjects: async () => { phases.push('render'); },
    delay: async () => { phases.push('wait'); return 0; },
  });
  const command = (tail, ...args) => player.objectCommand({path: [37, 2, -1, 1, ...tail], args, named: []});
  assert.equal(await command([169]), 5);
  assert.equal(await command([157, 0], 400, 400, 0, 0), 0);
  assert.deepEqual(object.sourceClipBounds, [3, 4, 85, 400]);
  assert.equal(object.intEvents.get('sourceClip:3').from, 100);
  assert.equal(await command([157, 4]), 0);
  assert.deepEqual(phases, ['render', 'wait']);
  assert.equal(object.intEvents.size, 0);
  object.type = 1;
  assert.equal(await command([169]), 0);
});

test('object center commands distinguish the sprite origin from the pivot offset', async () => {
  const objects = new Map();
  const player = {
    objectAddress: () => ({page: objects, index: 2}),
    markObjectsDirty: () => {},
  };
  const command = (id, ...args) => SiglusPlayer.prototype.objectCommand.call(player, {path: [37, 2, -1, 1, id], args});
  assert.equal(await command(158, 512, 300), 0);
  assert.equal(await command(159, 30, -10), 0);
  assert.deepEqual(objects.get(1).center, [512, 300]);
  assert.deepEqual(objects.get(1).centerRep, [30, -10]);
});

test('object dimensions select cel zero or the explicit index independently of the displayed cel', async () => {
  const object = {type: 2, name: 'atlas', pattern: 1, frames: [undefined, {width: 30, height: 40}]};
  const loads = [];
  const player = {
    objectAddress: () => ({page: new Map([[1, object]]), index: 2}),
    markObjectsDirty: () => {},
    display: {
      objectGraphic: async (name, index) => {
        loads.push([name, index]);
        return index === 0 ? {width: 10, height: 20} : undefined;
      },
    },
  };
  const query = (id, ...args) => SiglusPlayer.prototype.objectCommand.call(player, {
    path: [37, 2, -1, 1, id], args,
  });
  assert.equal(await query(25), 20);
  assert.equal(await query(24), 10);
  assert.equal(await query(25, 1), 40);
  assert.equal(await query(25, 12), 0);
  assert.equal(await query(24, -1), 0);
  assert.deepEqual(loads, [['atlas', 0], ['atlas', 12]]);
  assert.equal(object.pattern, 1);
});

test('stage object count returns the configured extent of the sparse page', async () => {
  const objects = new Map([[11, {}]]);
  const config = new Map([['OBJECT.CNT', '128']]);
  const player = Object.assign(Object.create(SiglusPlayer.prototype), {
    game: {config},
    objects: [objects, new Map()],
  });
  const count = () => player.command({path: [38, 2, 3], args: [], named: []});
  assert.equal(await count(), 128);
  objects.clear();
  assert.equal(await count(), 128);
  config.delete('OBJECT.CNT');
  assert.equal(await count(), 256);
});

test('immutable stage cels use software-backed canvases', () => {
  const previous = globalThis.document;
  const calls = [];
  const canvas = {
    style: {},
    getContext: (type, options) => {
      calls.push({type, options});
      return {drawImage: (...args) => calls.push(args)};
    },
  };
  globalThis.document = {createElement: () => canvas};
  try {
    const image = {};
    assert.equal(SiglusDisplay.prototype.node({image, x: 0, y: 0, width: 32, height: 32}), canvas);
    assert.deepEqual(calls, [{type: '2d', options: {willReadFrequently: true}}, [image, 0, 0]]);
  } finally {
    globalThis.document = previous;
  }
});

test('tone-curve rendering mixes luminance before looking up RGB channels', () => {
  const previous = globalThis.document;
  const create = (name) => ({
    name,
    attributes: {},
    children: [],
    setAttribute(key, value) { this.attributes[key] = value; },
    append(...elements) { this.children.push(...elements); },
  });
  globalThis.document = {createElementNS: (_, name) => create(name)};
  try {
    const filter = create('filter');
    const display = {
      toneCurves: new Map([[2, {monochrome: 1, channels: [Uint8Array.of(255, 0), Uint8Array.of(64, 128), Uint8Array.of(0, 255)]}]]),
      colorFilterUrl(key, setup) { setup(filter); return `url(#${key})`; },
      appendColorMatrix: SiglusDisplay.prototype.appendColorMatrix,
    };
    assert.equal(SiglusDisplay.prototype.toneCurveFilterUrl.call(display, 2), 'url(#tone:2)');
    assert.equal(SiglusDisplay.prototype.toneCurveFilterUrl.call(display, 3), undefined);
    const [matrix, transfer] = filter.children;
    assert.equal(matrix.name, 'feColorMatrix');
    assert.deepEqual(matrix.attributes.values.split(' ').slice(0, 5).map(Number), [0.2989, 0.5886, 0.1145, 0, 0]);
    assert.equal(transfer.name, 'feComponentTransfer');
    assert.deepEqual(transfer.children.map((child) => child.name), ['feFuncR', 'feFuncG', 'feFuncB']);
    assert.equal(transfer.children[0].attributes.tableValues, '1 0');
  } finally {
    globalThis.document = previous;
  }
});

test('resetting a scripted button preserves its sprite for the transition animation', async () => {
  const fields = {name: 'button', frames: [], visible: true, x: 21, y: 32, pattern: 2};
  const object = {
    ...fields,
    button: {id: 3, group: 4, actionNo: 1, seNo: 5},
    buttonState: 'disable',
    disabled: true,
    pushKeep: true,
    alphaTest: true,
  };
  const page = new Map([[3, object]]);
  let dirty = false;
  const player = {
    objectAddress: () => ({page, index: 5}),
    markObjectsDirty: () => {
      dirty = true;
    },
  };
  const path = [38, 2, -1, 31, 93, -1, 3, 61];
  assert.equal(await SiglusPlayer.prototype.objectCommand.call(player, {path, args: []}), 0);
  assert.equal(page.get(3), object);
  assert.ok(dirty);
  assert.deepEqual(
    Object.fromEntries(Object.entries(object).filter(([, value]) => value !== undefined)),
    fields,
  );
});

test('Siglus name references expand to the current script values', () => {
  const player = {
    namaeIds: new Map([
      ['％ｂ', 0],
      ['＊ａａ', 1],
    ]),
    namaeValues: new Map([
      [0, '雪兎'],
      [1, '新見'],
    ]),
  };
  const expand = SiglusPlayer.prototype.expandNamae.bind(player);
  assert.equal(expand('＊ＡＡ ％Ｂ'), '新見 雪兎');
  player.namaeValues.set(0, '春');
  assert.equal(expand('％Ｂと％Ｃ'), '春と％Ｃ');
});

test('absolute save and load commands share the configured quick slots', async () => {
  const sound = [];
  const player = {
    game: {config: new Map([['SAVE.CNT', '171'], ['QUICK_SAVE.CNT', '11']])},
    root: {dataset: {}},
    saves: new Map(),
    quickSaves: new Map([[3, {comment: 'overwrite'}]]),
    saveEnabled: true,
    loadEnabled: true,
    savePoint: {version: 1, vm: {}},
    stagePath: (path) => path,
    saveSlotAddress: SiglusPlayer.prototype.saveSlotAddress,
    saveSlot: SiglusPlayer.prototype.saveSlot,
    writeSlot: async (slots, index, save) => slots.set(index, save),
    playSystemSound: async (id) => sound.push(id),
    loadSave: (save) => { player.loaded = save; },
  };
  const command = (member, args) =>
    SiglusPlayer.prototype.command.call(player, {path: [63, member], args});
  assert.equal(await command(249, [174, 0, 1]), 1);
  assert.equal(player.saves.size, 0);
  assert.deepEqual(player.quickSaves.get(3).vm, player.savePoint.vm);
  assert.equal(player.quickSaves.get(3).comment, 'overwrite');
  assert.deepEqual(sound, [4]);
  assert.equal(await command(69, [174]), 1);
  await command(256, [174, 0, 1]);
  assert.equal(player.loaded, player.quickSaves.get(3));
  assert.equal(player.pendingLoadSound, true);
  assert.equal(await command(18, [4, 0, 0]), 1);
  assert.deepEqual(sound, [4]);
  await command(20, [4, 0, 0]);
  assert.equal(player.loaded, player.quickSaves.get(4));
  assert.equal(player.pendingLoadSound, false);
});

test('the scene-based system call resolves labels and forwards scalar arguments', async () => {
  const calls = [];
  const player = {
    game: {pack: {sceneNames: ['_Scene']}},
    stagePath: (path) => path,
    saveSlot: () => undefined,
    quickSaves: new Map(),
    runSystemScene: async (...call) => calls.push(call),
  };
  const command = (args) =>
    SiglusPlayer.prototype.command.call(player, {path: [63, 236], args});
  assert.equal(await command(['_scene']), 1);
  assert.equal(await command(['_scene', 4, [5, 'text', [27, -1, 1]]]), 1);
  assert.equal(await command(['_missing']), 0);
  assert.deepEqual(calls, [['_Scene', 0, []], ['_Scene', 4, [5, 'text']]]);
});

test('resizing offset event lists preserves the separate position offsets', async () => {
  const object = {
    positionOffsets: {x: [10, 20], y: [30, 40]},
    offsetEvents: {x: new Map([[0, {}], [1, {}]]), y: new Map([[1, {}]])},
  };
  const page = new Map([[3, object]]);
  const player = {
    objectAddress: () => ({page, index: 2}),
    markObjectsDirty: () => {},
  };
  const command = (tail, args) =>
    SiglusPlayer.prototype.objectCommand.call(player, {path: [38, 2, -1, 3, ...tail], args});
  assert.equal(await command([112, 1], [1]), 0);
  assert.deepEqual(object.positionOffsets, {x: [10, 20], y: [30, 40]});
  assert.deepEqual([...object.offsetEvents.x.keys()], [0]);
  assert.deepEqual([...object.offsetEvents.y.keys()], [1]);
  assert.equal(await command([112, -1, 1, 0], [99, 0, 0, 0]), 0);
  assert.equal(object.positionOffsets.x[1], 20);
});

test('ending an object button group removes its sprites from pointer routing', () => {
  const old = {dataset: {siglusGroup: '4'}, inert: false};
  const next = {dataset: {siglusGroup: '0'}, inert: true};
  const display = {stage: {querySelectorAll: () => [old, next]}};
  const player = {
    display: Object.assign(display, {syncObjectButtonGroups: SiglusDisplay.prototype.syncObjectButtonGroups}),
    activeGroups: new Set([4]),
    cancelGroups: new Set(),
    decisions: new Map(),
  };
  const command = (group, member) => SiglusPlayer.prototype.groupCommand.call(player, group, member);
  command(4, 5);
  command(0, 2);
  assert.equal(old.inert, true);
  assert.equal(next.inert, false);
});

test('script shortcut suppression applies only to the named virtual key', async () => {
  const display = {
    disabledShortcutKeys: new Set(),
    setShortcutKeyDisabled: SiglusDisplay.prototype.setShortcutKeyDisabled,
  };
  const player = {display, stagePath: (path) => path};
  const command = (member, key) =>
    SiglusPlayer.prototype.command.call(player, {path: [64, member], args: [key]});
  assert.equal(await command(40, 32), 0);
  assert.equal(await command(40, 256), 0);
  assert.deepEqual([...display.disabledShortcutKeys], [32]);
  assert.equal(await command(41, 32), 0);
  assert.equal(display.disabledShortcutKeys.size, 0);
});

test('return-to-selection availability requires both flags and a checkpoint', async () => {
  const player = {
    selectionSaves: [],
    selectionReturnFlags: [true, true],
    stagePath: (path) => path,
    saveSlot: () => undefined,
    quickSaves: new Map(),
  };
  const command = (member, ...args) =>
    SiglusPlayer.prototype.command.call(player, {path: [63, member], args});
  assert.equal(await command(234), 0);
  player.selectionSaves.push({});
  assert.equal(await command(234), 1);
  await command(230, 0);
  assert.equal(await command(231), 0);
  assert.equal(await command(234), 0);
  await command(230, 1);
  await command(232, 0);
  assert.equal(await command(233), 0);
  assert.equal(await command(234), 0);
  await command(232, 1);
  assert.equal(await command(234), 1);
});

test('system-call status and mouse-coordinate references follow the active player state', async () => {
  const writes = [];
  const player = {
    stagePath: (path) => path,
    systemCallActive: true,
    excallAllocated: false,
    display: {pointerPosition: (axis) => [240, 360][axis]},
    vm: {assign: (...write) => writes.push(write)},
  };
  const command = (path, args = []) => SiglusPlayer.prototype.command.call(player, {path, args});
  assert.equal(await command([65, 12]), 1);
  assert.equal(await command([65, 8]), 0);
  await command([46, 9], [[26, -1, 5], [26, -1, 6]]);
  assert.deepEqual(writes, [[[26, -1, 5], 240], [[26, -1, 6], 360]]);
});

test('a message-window button can be hidden and shown independently in each window', () => {
  const refreshed = [];
  const display = {
    windowIndex: 0,
    messageButtonStates: new Map(),
    messageButtonState: SiglusDisplay.prototype.messageButtonState,
    setMessageButtonProperty: SiglusDisplay.prototype.setMessageButtonProperty,
    activeFrameActions: [{
      action: {id: 3},
      element: {dataset: {}},
      refresh: () => refreshed.push(display.messageButtonState(0, 3).visible),
    }],
  };
  const player = {stagePath: (path) => path, display};
  const visible = (window, value) => SiglusPlayer.prototype.property.call(
    player, [38, 3, -1, window, 32, -1, 3, 0], value,
  );
  assert.equal(visible(0), 1);
  assert.equal(visible(0, 0), 0);
  assert.equal(visible(1), 1);
  assert.equal(visible(0), 0);
  assert.equal(visible(0, 1), 1);
  assert.deepEqual(refreshed, [false, true]);
});

test('a generated capture is reported only in the game capture folder', async () => {
  const store = new MemoryStore();
  const offsets = [];
  const png = new Uint8Array([1, 2, 3]);
  const player = Object.assign(Object.create(SiglusPlayer.prototype), {
    game: {files: new Map()},
    stagePath: (path) => path,
    saveSlot: () => undefined,
    quickSaves: new Map(),
    display: {capturePng: async (x, y) => { offsets.push([x, y]); return png; }},
    controller: new AbortController(),
    saveStore: store,
  });
  const command = (path, ...args) => player.command({path, args});
  assert.equal(await command([92, 12], 'Album/Test.png'), 0);
  assert.equal(await command([63, 290], -3, 2, 'Album/Test'), 0);
  assert.deepEqual(offsets, [[-3, 2]]);
  assert.deepEqual((await store.snapshot()).get('capture:album/test.png'), png);
  assert.equal(await command([92, 12], 'ALBUM\\TEST.PNG'), 1);
  assert.equal(await command([92, 6], 'Album/Test.png'), 0);
  assert.equal(await command([63, 290], 0, 0, '../Outside'), 0);
  assert.equal((await store.snapshot()).size, 1);
});

test('a numbered capture is stored, reopened as an object, and restored from a checkpoint', async () => {
  const store = new MemoryStore();
  const captures = [];
  const frame = {width: 1280, height: 720};
  const png = Uint8Array.of(1, 2, 3);
  const objects = new Map();
  const player = Object.assign(Object.create(SiglusPlayer.prototype), {
    stagePath: (path) => path,
    objectAddress: () => ({page: objects, index: 2}),
    markObjectsDirty: () => {},
    display: {
      capturePng: async (...args) => { captures.push(args); return png; },
      capturedGraphic: async (bytes) => { assert.deepEqual(bytes, png); return frame; },
    },
    controller: new AbortController(),
    saveStore: store,
  });
  const photoId = await player.command({path: [144], args: [99], named: [0]});
  assert.ok(photoId > 0);
  assert.deepEqual(captures, [[0, 0, {limit: [99, 0x7fffffff]}]]);
  assert.equal(await player.command({path: [92, 12], args: [`${photoId}.png`]}), 1);
  assert.equal(await player.objectCommand({path: [37, 2, -1, 3, 170], args: [photoId, 1, 158, 280]}), 0);
  const photo = objects.get(3);
  assert.deepEqual(photo, {type: 11, name: `${photoId}.png`, frames: [frame], x: 158, y: 280, visible: true, pattern: 0});
  const restored = await player.deserializeDrawObject(serializeDrawObject(photo));
  assert.equal(restored.frames[0], frame);
  assert.equal(await player.objectCommand({path: [37, 2, -1, 4, 170], args: [1, 0]}), 0);
  assert.deepEqual(objects.get(4).frames, []);
  assert.equal(objects.get(4).visible, false);
});

test('the save and share capture commands keep independent buffers and preserve capture dimensions', async () => {
  const store = new MemoryStore();
  const captures = [];
  const dialogs = [];
  const png = Uint8Array.of(1, 2, 3);
  const player = Object.assign(Object.create(SiglusPlayer.prototype), {
    game: {config: new Map([['TWITTER.OVERLAP_IMAGE', '"watermark"'], ['TWITTER.INITIAL_TWEET_TEXT', '"Draft"']])},
    stagePath: (path) => path,
    saveSlot: () => undefined,
    quickSaves: new Map(),
    display: {
      capturePng: async (...args) => { captures.push(args); return png; },
      stage: {focus() {}},
    },
    configuration: {shareCapture: async (...args) => { dialogs.push(args); return true; }},
    controller: new AbortController(),
    saveStore: store,
  });
  const command = (path, ...args) => player.command({path, args});
  assert.equal(await command([63, 286], 640, 360), 0);
  assert.equal(await command([63, 290], 4, -9, 'Album/Test'), 0);
  assert.equal(await command([164]), 0);
  assert.equal(await command([63, 287]), 0);
  assert.equal(await command([63, 327]), 0);
  assert.equal(await command([165]), 0);
  assert.equal(await command([63, 327]), 0);
  assert.equal(await command([63, 316], 0, 0), 0);
  assert.equal(await player.command({path: [63, 314], args: ['test', 'png', 1], named: [0]}), 1);
  assert.deepEqual(captures, [[4, -9, {size: [640, 360]}], [0, 0, {overlay: 'watermark'}], [0, 0, {size: undefined}]]);
  assert.equal(dialogs.length, 2);
  assert.deepEqual(dialogs[0], [png, 'Draft']);
  const [preview, text, file] = dialogs[1];
  assert.equal(preview, png);
  assert.equal(text, undefined);
  assert.equal(file.name, 'test.png');
  assert.equal(file.type, 'image/png');
  assert.deepEqual(new Uint8Array(await file.arrayBuffer()), png);
});

test('BMP capture exports append signed flags after the native image size and import a bounded range', async () => {
  const image = {width: 1, height: 1, data: Uint8ClampedArray.of(11, 22, 33, 255)};
  const list = [30];
  const savedFlags = [-42, 0, 0x7fffffff];
  const loads = [];
  const store = new MemoryStore();
  const player = Object.assign(Object.create(SiglusPlayer.prototype), {
    stagePath: (path) => path,
    saveSlot: () => undefined,
    quickSaves: new Map(),
    game: {files: new Map(), config: new Map([['FLAG.CNT', '10']])},
    captureBuffer: Uint8Array.of(1),
    display: {captureBmp: async (_png, flags) => encodeCaptureBmp(image, flags)},
    vm: {
      readIntList: (path, offset, count) => {
        assert.deepEqual([path, offset, count], [list, 7, 3]);
        return savedFlags;
      },
      writeIntList: (...args) => loads.push(args),
    },
    saveStore: store,
    controller: new AbortController(),
  });
  const command = (member, start, count) => player.command({
    path: [63, member], args: ['flags', 'bmp', list, start, count], named: [2, 3, 4],
  });
  assert.equal(await command(314, 7, 5), 1);
  const bytes = (await store.snapshot()).get('capture:flags.bmp');
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  assert.equal(view.getUint32(2, true), 58);
  assert.equal(view.getInt32(22, true), -1);
  assert.deepEqual([...bytes.subarray(54, 58)], [33, 22, 11, 255]);
  assert.equal(await command(315, -1, 3), 1);
  assert.deepEqual(loads, [[list, 0, [-42, 0]]]);
  view.setUint32(2, 10, true);
  assert.deepEqual(await readCaptureBmpFlags(new BlobSource(new Blob([bytes])), 2), []);
});

test('a scene-counter wait renders pending objects before waiting for input', async () => {
  const calls = [];
  const player = {
    stagePath: (path) => path,
    renderObjects: async () => { calls.push('render'); },
    counter: () => 30,
    delay: async (ms, skippable) => { calls.push([ms, skippable]); return 1; },
  };
  assert.equal(await SiglusPlayer.prototype.command.call(player, {
    path: [40, -1, 0, 8], args: [100],
  }), 1);
  assert.deepEqual(calls, ['render', [70, true]]);
});

test('a finite Siglus wait completes when animation frames run ahead of a delayed timer', async (t) => {
  let tick;
  const previousRequest = globalThis.requestAnimationFrame;
  globalThis.requestAnimationFrame = (callback) => { tick = callback; return 1; };
  t.after(() => { globalThis.requestAnimationFrame = previousRequest; });
  const previousCancel = globalThis.cancelAnimationFrame;
  globalThis.cancelAnimationFrame = () => {};
  t.after(() => { globalThis.cancelAnimationFrame = previousCancel; });
  const player = {controller: new AbortController(), skipping: false};
  const pending = SiglusPlayer.prototype.delay.call(player, 2000, true);
  assert.equal(typeof player.wait, 'function');
  tick(performance.now() + 2001);
  assert.equal(await pending, 0);
  assert.equal(player.wait, undefined);
  Object.assign(player, {systemCallActive: true, decisions: new Map(), activeGroups: new Set()});
  const poll = SiglusPlayer.prototype.nextInput.call(player);
  assert.equal(typeof player.decisionReady, 'function');
  tick(performance.now() + 17);
  assert.equal(await poll, 0);
  assert.equal(player.decisionReady, undefined);
});

test('the scripted no-wait flag overrides the configured character reveal interval', async () => {
  const printed = [];
  const player = Object.assign(Object.create(SiglusPlayer.prototype), {
    stagePath: (path) => path,
    speed: -1,
    playback: {messageSpeed: 90},
    pageCharacters: 0,
    display: {append: (text) => printed.push([text]), messageWindow: 0},
    revealRun: (text, _characters, speed) => printed.push([text, speed]),
  });
  assert.equal(await player.command({path: [64, 28], args: [1]}), 0);
  assert.equal(await player.command({path: [64, 29], args: []}), 1);
  player.print('instant');
  assert.equal(await player.command({path: [64, 28], args: [0]}), 0);
  assert.equal(await player.command({path: [64, 25], args: [0]}), 0);
  assert.equal(await player.command({path: [64, 26], args: []}), 0);
  player.print('zero interval');
  assert.equal(await player.command({path: [64, 27], args: []}), 0);
  assert.equal(await player.command({path: [64, 26], args: []}), -1);
  player.print('paced');
  assert.deepEqual(printed, [['instant'], ['zero interval'], ['paced', 90]]);
});

test('script flags independently control history recording and automatic page checkpoints', async () => {
  const pages = [];
  const snapshots = [];
  const player = Object.assign(Object.create(SiglusPlayer.prototype), {
    stagePath: (path) => path,
    root: {dataset: {}},
    pages: 0,
    saveEnabled: true,
    loadEnabled: true,
    pageReadFlags: [],
    pageVoices: [],
    display: {
      finishMessageSlide() {},
      saveMessage: () => ({name: '', text: [{text: 'sample'}]}),
    },
    historyPoints: new WeakMap(),
    backlog: [],
    addHistory: (entry) => pages.push(entry),
    systemOption: () => true,
    captureSave: () => {
      const snapshot = {};
      snapshots.push(snapshot);
      return snapshot;
    },
    attachHistoryToSave: (snapshot) => snapshot,
    tracePage() {},
    async waitAtPage() {},
  });
  const flag = (member) => player.command({path: [64, member], args: [], named: []});
  const page = async () => {
    player.pendingText = true;
    await player.pageInput();
  };
  await flag(34);
  await page();
  assert.equal(pages.length, 0);
  assert.ok(!player.scriptMsgBackDisabled);
  assert.equal(player.savePoint, snapshots[0]);
  await flag(35);
  await flag(38);
  await page();
  assert.equal(pages.length, 1);
  assert.equal(snapshots.length, 1);
  assert.equal(player.savePoint, snapshots[0]);
  await flag(39);
  await page();
  assert.equal(pages.length, 2);
  assert.equal(player.savePoint, snapshots[1]);
  player.backlog.push(...pages);
  await flag(12);
  await player.openHistory();
  assert.equal(player.backlog.length, 2);
});

test('BGM stop and pause use the native default fade while preserving explicit zero', async () => {
  const actions = [];
  const player = {
    stagePath: (path) => path,
    audio: {
      stop: (channel, fade) => actions.push(['stop', channel, fade]),
      pauseBgm: (fade) => actions.push(['pause', fade]),
    },
  };
  const command = (member, args) => SiglusPlayer.prototype.command.call(player, {path: [42, member], args, named: []});
  await command(4, []);
  await command(10, []);
  await command(4, [0]);
  assert.deepEqual(actions, [['stop', 'bgm', 100], ['pause', 100], ['stop', 'bgm', 0]]);
});

test('only the key-enabled quake commands let input interrupt their wait', async () => {
  const waits = [];
  const player = {
    stagePath: (path) => path,
    display: {startQuake: () => 450},
    delay: async (duration, byKey) => { waits.push([duration, byKey]); return 0; },
  };
  for (const member of [0, 1, 2, 4, 5, 6]) {
    const command = {path: [70, 25, -1, 0, member], args: [0, 150, 1, 2, [20, 6]], named: []};
    assert.equal(await SiglusPlayer.prototype.command.call(player, command), 0);
  }
  assert.deepEqual(waits, [[450, false], [450, true], [450, false], [450, true]]);
});

test('message-window timing queries retain the configured defaults after runtime overrides', async () => {
  const player = {
    stagePath: (path) => path,
    game: {config: new Map([
      ['MWND.003.OPEN_ANIME_TIME', '240'],
      ['MWND.003.CLOSE_ANIME_TIME', '180'],
    ])},
    messageOpenAnimations: new Map(),
    messageCloseAnimations: new Map(),
  };
  const command = (member, ...args) => SiglusPlayer.prototype.command.call(player, {
    path: [38, 3, -1, 3, member], args, named: [],
  });
  await command(34, 120);
  await command(35, 90);
  assert.equal(await command(33), 240);
  assert.equal(await command(39), 180);
  assert.equal(player.messageOpenAnimations.get(3).time, 120);
  assert.equal(player.messageCloseAnimations.get(3).time, 90);
});

test('camera input can stop and resume its EXCALL counter without resetting elapsed time', async () => {
  const player = Object.assign(Object.create(SiglusPlayer.prototype), {systemCounters: new Map()});
  const command = (member) => player.command({path: [65, -1, 0, 6, -1, 0, member], args: [], named: []});
  assert.equal(await command(9), 0);
  const counter = player.systemCounters.get(0);
  counter.start -= 500;
  assert.equal(await command(4), 0);
  const stopped = await command(1);
  assert.ok(stopped >= 500);
  assert.equal(await command(14), 0);
  assert.equal(await command(1), stopped);
  assert.equal(await command(5), 0);
  assert.equal(counter.pausedAt, undefined);
  assert.equal(await command(14), 1);
  assert.ok(await command(1) >= stopped);
});

test('an object frame action still addresses its own child during a modal display command', async () => {
  const owner = [38, 2, -1, 89, 93, -1, 1];
  const stageObject = {y: 0};
  const modalObject = {y: 0};
  const page = (child) => new Map([[89, {children: new Map([[1, child]])}]]);
  const player = Object.assign(Object.create(SiglusPlayer.prototype), {
    systemCallDepth: 0,
    objects: [page(stageObject)],
    frameActions: new Map(),
    game: {pack: {commandNames: ['update']}},
    vm: {callScene: async (_scene, _label, [_event, ref, y]) => player.property([...ref, 4], y)},
  });
  player.startFrameAction([...owner, 52], '_animation', -1, 'update', [41], false);
  player.systemCallDepth = 1;
  player.systemFrontObjects = page(modalObject);
  player.startFrameAction([...owner, 52], '_animation', -1, 'update', [62], false);
  await player.tickFrameActions();
  assert.equal(stageObject.y, 41);
  assert.equal(modalObject.y, 62);
  assert.equal(player.objectsDirty, true);
  assert.equal(player.systemFrontObjectsDirty, true);
  player.endFrameAction([...owner, 52]);
  assert.equal(player.frameActions.size, 1);
});

test('parseButtonActionStates parses BUTTON.ACTION.nnn.SELECT and falls back to normal when absent', () => {
  const cfg = new Map([
    ['BUTTON.ACTION.001.NORMAL', '0, 0, 0, 255, 0, 0'],
    ['BUTTON.ACTION.001.HIT', '1, 0, 0, 255, 0, 0'],
    ['BUTTON.ACTION.001.PUSH', '2, 0, 0, 255, 0, 0'],
    ['BUTTON.ACTION.001.SELECT', '3, 2, -1, 200, 64, 0'],
    ['BUTTON.ACTION.001.DISABLE', '4, 0, 0, 128, 0, 0'],
    ['BUTTON.ACTION.002.NORMAL', '0, 0, 0, 255, 0, 0'],
  ]);
  const a1 = parseButtonActionStates(cfg, 1);
  assert.deepEqual(a1.select, {cutOffset: 3, dx: 2, dy: -1, alpha: 200, bright: 64, dark: 0});
  const a2 = parseButtonActionStates(cfg, 2);
  assert.deepEqual(a2.select, a2.normal);
});

test('parseButtonSe resolves BUTTON.SE.nnn.{HIT,PUSH,DECIDE} and falls back cleanly on legacy configs', () => {
  const withTable = new Map([
    ['BUTTON.SE.CNT', '10'],
    ['BUTTON.SE.007.HIT', '13'],
    ['BUTTON.SE.007.PUSH', '-1'],
    ['BUTTON.SE.007.DECIDE', '14'],
    ['BUTTON.SE.008.HIT', '13'],
    ['BUTTON.SE.008.PUSH', '-1'],
    ['BUTTON.SE.008.DECIDE', '-1'],
  ]);
  assert.deepEqual(parseButtonSe(withTable, 7), {hit: 13, push: -1, decide: 14});
  assert.deepEqual(parseButtonSe(withTable, 8), {hit: 13, push: -1, decide: -1});
  assert.deepEqual(parseButtonSe(withTable, -1), {hit: -1, push: -1, decide: -1});

  // Minimal legacy fixture with no BUTTON.SE.* entries maps seNo directly to decide
  const legacy = new Map([['SE.003', '"click"']]);
  assert.deepEqual(parseButtonSe(legacy, 3), {hit: -1, push: -1, decide: 3});
});

test('parseSpaceHideObjectIds and parseMwndColors resolve config keys accurately', () => {
  const cfg = new Map([
    ['OBJECT.47.SPACE_HIDE', '1'],
    ['OBJECT.58.SPACE_HIDE', '1'],
    ['OBJECT.99.SPACE_HIDE', '0'],
    ['MWND.MOJI_COLOR', '0'],
    ['MWND.SHADOW_COLOR', '1'],
    ['MWND.FUCHI_COLOR', '2'],
    ['MWND.003.MOJI_COLOR', '12'],
  ]);
  assert.deepEqual([...parseSpaceHideObjectIds(cfg)].sort((a, b) => a - b), [47, 58]);
  assert.deepEqual(parseMwndColors(cfg, 0), {mojiColor: 0, shadowColor: 1, fuchiColor: 2});
  assert.deepEqual(parseMwndColors(cfg, 3), {mojiColor: 12, shadowColor: 1, fuchiColor: 2});
});

test('Audit B: DrawObject persistent field parity across SerializedDrawObject, serialize/deserialize, and copyObject', () => {
  const displaySrc = fs.readFileSync(path.join(SIGLUS_DIR, 'display.ts'), 'utf8');
  const playerSrc = fs.readFileSync(path.join(SIGLUS_DIR, 'player.ts'), 'utf8');

  const extractInterfaceFields = (src, name) => {
    const start = src.indexOf(`export interface ${name} {`);
    assert.ok(start >= 0, `Missing interface ${name}`);
    let depth = 0;
    let bodyStart = -1;
    let bodyEnd = -1;
    for (let i = start; i < src.length; i++) {
      if (src[i] === '{') {
        if (depth === 0) bodyStart = i + 1;
        depth++;
      } else if (src[i] === '}') {
        depth--;
        if (depth === 0) {
          bodyEnd = i;
          break;
        }
      }
    }
    const body = src.slice(bodyStart, bodyEnd);
    const fields = [];
    let brace = 0;
    for (const line of body.split('\n')) {
      if (brace === 0) {
        const m = /^\s+([a-zA-Z_]\w*)\??:/.exec(line);
        if (m) fields.push(m[1]);
      }
      for (const ch of line) {
        if (ch === '{') brace++;
        else if (ch === '}') brace--;
      }
    }
    return fields;
  };

  const drawFields = extractInterfaceFields(displaySrc, 'DrawObject');
  const serFields = new Set(extractInterfaceFields(displaySrc, 'SerializedDrawObject'));
  const ephemeralFields = new Set([
    'frames',
    'movie',
    'slotId',
    'intEvents',
    'scaleEvents',
    'positionEvents',
    'offsetEvents',
    'patternCycle',
    'opacity',
    'opacityStarted',
    'horizontalMotion',
    'movement',
  ]);

  const serFnStart = displaySrc.indexOf('export function serializeDrawObject(');
  const serFnEnd = displaySrc.indexOf('\n}\n', serFnStart);
  const serFnBody = displaySrc.slice(serFnStart, serFnEnd);

  const deserStart = playerSrc.indexOf('private async deserializeDrawObject(');
  const deserEnd = playerSrc.indexOf('\n  private saveSlotAddress(', deserStart);
  const deserBody = playerSrc.slice(deserStart, deserEnd);

  for (const field of drawFields) {
    if (ephemeralFields.has(field)) continue;
    assert.ok(
      serFields.has(field),
      `Persistent DrawObject.${field} missing from SerializedDrawObject`,
    );
    assert.ok(
      new RegExp(`\\b${field}:`).test(serFnBody),
      `Persistent DrawObject.${field} missing from serializeDrawObject()`,
    );
    assert.ok(
      new RegExp(`\\b${field}:`).test(deserBody) || new RegExp(`object\\.${field}\\s*=`).test(deserBody),
      `Persistent DrawObject.${field} missing from deserializeDrawObject()`,
    );
  }

  // Verify copyObject deep-clones every mutable array/object field so back/front never alias
  const copyStart = playerSrc.indexOf('private copyObject(');
  const copyEnd = playerSrc.indexOf('\n  private backgroundName(', copyStart);
  const copyBody = playerSrc.slice(copyStart, copyEnd);
  for (const mutableField of [
    'text',
    'number',
    'weather',
    'gan',
    'rect',
    'movieMeta',
    'button',
    'flags',
    'trOffsets',
    'scale',
    'center',
    'centerRep',
    'sourceClipBounds',
    'colorProps',
    'intEvents',
    'clip',
    'positionOffsets',
    'offsetEvents',
    'children',
  ]) {
    assert.ok(
      new RegExp(`\\b${mutableField}:`).test(copyBody),
      `Mutable DrawObject.${mutableField} must be cloned in copyObject() to prevent wipe aliasing`,
    );
  }
});

test('Audit B: serializeDrawObject deep-copies all fields cleanly including buttonState and children', () => {
  const child = {
    type: 1,
    name: 'child_sprite',
    frames: [],
    x: 10,
    y: 20,
    visible: true,
    layer: 1,
    order: 2,
    pattern: 0,
  };
  const original = {
    type: 1,
    name: 'cfg_btn',
    frames: [],
    x: 100,
    y: 200,
    visible: true,
    layer: 3,
    order: 4,
    transparency: 220,
    trOffsets: [128],
    flags: [1, 2],
    pattern: 2,
    scale: [1200, 1100],
    rotateX: 10,
    rotateY: 20,
    rotateZ: 30,
    center: [50, 60],
    centerRep: [5, -5],
    colorProps: {bright: 32, reverse: 128},
    mask: 1,
    blend: 1,
    tonecurveNo: 2,
    wipeCopy: true,
    positionOffsets: {x: [3, 4], y: [-2]},
    button: {id: 7, group: 2, actionNo: 1, seNo: 7},
    buttonState: 'select',
    childCount: 1,
    children: new Map([[0, child]]),
    clip: [1, 0, 0, 500, 500],
    sourceClipEnabled: true,
    sourceClipBounds: [10, 10, 100, 100],
    pushKeep: true,
    alphaTest: true,
    disabled: false,
  };
  const saved = serializeDrawObject(original);
  // Mutate original to prove isolation
  original.scale[0] = 9999;
  original.center[0] = 9999;
  original.colorProps.bright = 255;
  original.positionOffsets.x[0] = 999;
  assert.equal(saved.buttonState, 'select');
  assert.deepEqual(saved.scale, [1200, 1100]);
  assert.deepEqual(saved.center, [50, 60]);
  assert.equal(saved.colorProps.bright, 32);
  assert.deepEqual(saved.positionOffsets.x, [3, 4]);
  assert.equal(saved.children.length, 1);
  assert.equal(saved.children[0][1].name, 'child_sprite');

  const ordered = orderedObjects(new Map([[47, original]]), true);
  assert.equal(ordered[0].slotId, 47);
});

test('Audit C: player.ts persists bgmtable, pcmEvents, namaeValues, messageFilterFiles, messageButtonOffsets, objectMasks, and mask offsets', () => {
  const playerSrc = fs.readFileSync(path.join(SIGLUS_DIR, 'player.ts'), 'utf8');
  assert.match(playerSrc, /localStorage\.getItem\(game\.saveKey \+ ':bgmtable'\)/);
  assert.match(playerSrc, /recordBgmListened\(/);
  assert.match(playerSrc, /setMessageFilterFile\(/);
  assert.match(playerSrc, /setObjectMaskOffset\(/);
  assert.match(playerSrc, /saveObjectMasks\(/);
  assert.match(playerSrc, /restoreObjectMasks\(/);
  assert.match(playerSrc, /object\.buttonState = 'select'/);
  for (const saveKey of [
    'pcmEvents:',
    'namaeValues:',
    'messageFilterFiles:',
    'messageButtonOffsets:',
    'objectMasks:',
  ]) {
    assert.ok(playerSrc.includes(saveKey), `captureSave/PlayerSave must include ${saveKey}`);
  }
});

test(
  'Audit A (SSR Gameexe.dat): verifies BUTTON.ACTION.SELECT, BUTTON.SE, SPACE_HIDE, MWND colors, and zero unclassified unread keys',
  {skip: !HAS_SSR},
  () => {
    const pack = new SiglusScenePack(new Uint8Array(fs.readFileSync(`${SSR_DIR}/Scene.pck`)));
    const cfg = pack.configuration(new Uint8Array(fs.readFileSync(`${SSR_DIR}/Gameexe.dat`)));

    // 1. Concrete SSR value checks
    assert.deepEqual([...parseSpaceHideObjectIds(cfg)].sort((a, b) => a - b), [47, 58, 79, 120, 121]);
    assert.deepEqual(parseMwndColors(cfg, 0), {mojiColor: 0, shadowColor: 1, fuchiColor: 1});
    assert.deepEqual(parseButtonSe(cfg, 7), {hit: 13, push: -1, decide: 14});
    assert.deepEqual(parseButtonSe(cfg, 8), {hit: 13, push: -1, decide: -1});
    assert.equal(parseButtonActionStates(cfg, 1).select.cutOffset, 3);
    assert.equal(parseButtonActionStates(cfg, 2).select.cutOffset, 2);
    assert.equal(parseButtonActionStates(cfg, 0).select.bright, 128);
    assert.deepEqual(parseMwndAnimation(cfg, 0, 'open'), {type: 1, time: 200});
    assert.deepEqual(parseMwndAnimation(cfg, 2, 'close'), {type: 1, time: 500});
    assert.deepEqual(parseMwndAnimation(cfg, 0, 'close', {time: 75}), {type: 1, time: 75});
    assert.deepEqual(parseMwndAnimation(cfg, 0, 'close', {type: 0}), {type: 0, time: 200});
    const sel0 = readSelbtnTemplate(cfg, 0);
    assert.deepEqual(sel0.openAnime, [6, 500]);
    assert.deepEqual(sel0.closeAnime, [6, 500]);
    assert.deepEqual(sel0.decideAnime, [2, 500]);

    // 2. Permanent Gameexe.dat key coverage gate:
    // Every key schema in SSR Gameexe.dat must either be referenced by src/engines/siglus/*.ts
    // OR belong to the explicitly audited allowlist (host-only dialogs, metadata, unused optional features).
    const engineCode = fs
      .readdirSync(SIGLUS_DIR)
      .filter((f) => f.endsWith('.ts'))
      .map((f) => fs.readFileSync(path.join(SIGLUS_DIR, f), 'utf8'))
      .join('\n');

    const auditedAllowlist = [
      /^DIALOG(?:_EXIST|_TAB_EXIST|_STYLE)?\./,
      /^(?:SAVEINFO|LOADINFO|WARNINGINFO|SAVELOAD_DIALOG)\./,
      /^SYSCOMMENU\./,
      /^TWITTER\./,
      /^NAMAE(?:\.NNN)?$/, // Scene-pack parsing preserves the repeated alias declarations.
      /^(?:DISCMARK|DUMMY_CHECK.*|GAMEVERSION|MANUAL_PATH|MOUSE_CURSOR\.(?:DEFAULT|CNT)|SAVE\.NO_DATA_STR)$/,
      /^(?:FLAG|GLOBAL_FLAG|CALL_FLAG|COUNTER|OBJBTNGROUP|FRAME_ACTION_CH|PCMCH|PCMEVENT|MASK|CHRKOE|BGM|FONT_FILE)\.CNT$/, // JS Maps grow dynamically; C++ capacity hints unnecessary
      /^FONT_FILE\.NNN\.NAME$/, // SiglusDisplay auto-loads all bundled font files directly
      /^CHRKOE\.NOT_LOOK_NAME_STR$/, // Windows config dialog label
      /^CONFIG\.GLOBAL_EXTRA_MODE\./, // Unused by SSR Scene.pck
      /^EMOJI\./, // 0 emoji occurrences in SSR Scene.pck
      /^SHAKE\./, // SSR uses screen.quake[] directly, 0 SHAKE.nnn calls
      /^SYSTEM\.EXTRA_STR_VALUE\./, // Build-time / editor metadata in Gameexe
      /^LOAD\.WIPE$/, // Load transitions use immediate restore
      /^(?:EXCALL|MSGBK|MWND)\.ORDER$/, // Layer z-order is encoded in DOM layer tree
      /^MWND\.(?:FACE|FILTER|FUCHI|MOJI|SHADOW|WAKU)_LAYER_REP$/, // Layer z-order in DOM tree
      /^MWND\.DEFAULT_SEL_MWND_NO$/, // SSR uses SELBTN, not inline sel_mwnd
      /^MWND\.NNN\.(?:MSG_BACK_INSERT_NL|NAME_WINDOW_SIZE|NOVEL_MODE|OVERFLOW_CHECK_SIZE|TALK_MARGIN)$/,
      /^MSGBK\.(?:ACTIVE_MOJI_(?:FUCHI|SHADOW)_COLOR|DEBUG_MOJI_.*|FILTER_MARGIN|MOJI_SHADOW_COLOR)$/,
      /^MESSAGE_BACK_SAVE\.INTERVAL$/,
      /^WAKU\.NNN\.FILTER_MARGIN$/,
    ];

    const schemas = new Set([...cfg.keys()].map((k) => k.replace(/\.\d+(?=\.|$)/g, '.NNN')));
    const unclassified = [];
    for (const schema of schemas) {
      if (auditedAllowlist.some((re) => re.test(schema))) continue;
      const tokens = schema.split('.').filter((t) => t !== 'NNN');
      const last = tokens.at(-1);
      const first = tokens[0];
      const matched =
        engineCode.includes(schema) ||
        (tokens.length >= 2 && engineCode.includes(tokens.slice(-2).join('.'))) ||
        (first && (engineCode.includes(first + '.') || engineCode.includes(first + '\\.'))) ||
        (last && last.length > 4 && engineCode.includes(last));
      if (!matched) unclassified.push(schema);
    }
    assert.deepEqual(
      unclassified,
      [],
      `Unclassified unread Gameexe.dat schemas detected: ${unclassified.join(', ')}`,
    );
  },
);

test('Full-route crawl regressions: frame_action owner ref, mask intevents, skipTriggerPending, input.next, and 0-size drawImage guards', () => {
  const playerSrc = fs.readFileSync(path.join(SIGLUS_DIR, 'player.ts'), 'utf8');
  const displaySrc = fs.readFileSync(path.join(SIGLUS_DIR, 'display.ts'), 'utf8');

  // 1. Object-owned frame_action passes (faPath, ownerPath, ...args) & promotes 37->38 on wipe
  assert.match(playerSrc, /const ownerPath =[\s\S]*p\.at\(-1\) === 52[\s\S]*p\.at\(-3\) === 115/);
  assert.match(playerSrc, /const frontPath = \[38, \.\.\.action\.path\.slice\(1\)\]/);
  // 2. Mask x_eve/y_eve intevents & unreached commands (object.free, bgm.wait, auto_mode, msg_back, owari)
  assert.match(playerSrc, /root === 135 &&[\s\S]*path\[3\] === 2 \|\| path\[3\] === 3/);
  assert.match(playerSrc, /if \(command === 35 \|\| command === 36\)/);
  assert.match(playerSrc, /if \(member === 3 \|\| member === 14\) return this\.waitAudio\('bgm', member === 14\)/);
  assert.match(playerSrc, /if \(root === 64 && \(member === 0 \|\| member === 1\)\)/);
  assert.match(playerSrc, /if \(root === 64 && \(member === 34 \|\| member === 35\)\)/);
  // 3. skipTriggerPending does not clobber physical Ctrl skip
  assert.match(playerSrc, /this\.skip \|\| this\.readSkipEnabled \|\| this\.skipTriggerPending/);
  // 4. input.next yields a frame even outside system scenes & keys record outside systemInput
  assert.match(playerSrc, /await this\.nextInput\(true\)/);
  assert.match(displaySrc, /const pushKey = \(index: number, down: boolean\): void =>/);
  // 5. Zero-dimension drawImage guards
  assert.match(displaySrc, /if \(graphic\.width > 0 && graphic\.height > 0\)/);
  // 6. Native 0x6a7cd0 EXCALL wipe isolation: wiping while excallAllocated only updates systemLayer
  assert.match(playerSrc, /if \(this\.excallAllocated && this\.systemBackObjects\) \{[\s\S]*?return;\s*\}/);
  assert.match(displaySrc, /async showSystemObjects\([\s\S]*?duration = 0/);
});

test('Native G_excall / excall_flag / G_syscom xref sweep invariants in player.ts', () => {
  const playerSrc = fs.readFileSync(path.join(SIGLUS_DIR, 'player.ts'), 'utf8');
  // 1. Nested EXCALL support via depth counter (0x65f260 / 0x65f400 / 0x65f6a0) + cursor forced visible (0x621ec0)
  assert.match(playerSrc, /private systemCallDepth = 0;/);
  assert.doesNotMatch(playerSrc, /Nested Siglus system scene/);
  // 2. Native 0x622e70 / 0x625c10: time_stop freezes main frame_actions while EXCALL frame_actions tick
  assert.match(playerSrc, /if \(isExcallAction \? !this\.excallAllocated : this\.timeStopped\) continue;/);
  // 3. Native 0x5bb820 (excall.free): releaseSystemObjects clears 65.* frameActions, systemCounters, systemFont
  assert.match(playerSrc, /if \(action\.path\[0\] === 65\) this\.frameActions\.delete\(key\);/);
  // 4. Native 0x6321f0 -> 0x5bb740: restoreSave and return_to_menu (63.235) reinit EXCALL & modal state
  assert.match(playerSrc, /private async restoreSave\(save: PlayerSave\)[\s\S]*?this\.releaseSystemObjects\(\);/);
  assert.match(playerSrc, /if \(member === 235\)[\s\S]*?this\.releaseSystemObjects\(\);/);
  // 5. Native 0x56aba0 / 0x6a7e50 / 0x6a7ff0: wipe_end (33) and mask_wipe_all (50) handled
  assert.match(playerSrc, /case 33:[\s\S]*?this\.display\.finishWipe\(\);/);
  assert.match(playerSrc, /case 50:[\s\S]*?case 51:/);
  // 6. Native 0x55f290: excall.script font overrides (0x57..0x5f = 87..95)
  assert.match(playerSrc, /case 88:\s*font\.name = undefined;\s*return 0;\s*case 89:\s*return font\.name \?\? '';/);
  assert.match(playerSrc, /case 92:\s*return font\.bold === undefined \? -1 : Number\(font\.bold\);/);
  assert.match(playerSrc, /case 95:\s*return font\.shadow \?\? -1;/);
  // 7. Native 0x625960 / 0x624dd0 / 0x6614b0 / 0x6615a0: cancel skip & auto on right-click, hide, backlog
  assert.match(playerSrc, /if \(result === 3\) \{\s*this\.readSkipEnabled = this\.autoEnabled = false;/);
  // 8. Native 0x623b80: VK_SPACE (0x20) toggles hide_mwnd without advancing dialogue
  assert.match(playerSrc, /0x623b80[\s\S]{0,600}this\.setUserMessageHidden\(true\)/);
  // 9. Native 0x54f140 / 0x650bd0 (global 115), 0x559a80 (cgtable 78.*), 0x55fe50 (pcmevent 52.* oneshot/loop)
  assert.match(playerSrc, /case 115:[\s\S]{0,200}await this\.pageInput\(true\)/);
  assert.match(playerSrc, /private startPcmEventSequence\(/);
});

test(
  'Full-route crawl regression: WmaProDecoder decodes 48kHz stereo 24-bit SSR OP.wmv identically across JS and WASM',
  {skip: !fs.existsSync(`${SSR_DIR}/mov/OP.wmv`)},
  () => {
    const buf = new Uint8Array(fs.readFileSync(`${SSR_DIR}/mov/OP.wmv`));
    const layout = readAsfLayout(buf);
    const audioStream = layout.streams.find((s) => s.kind === 'audio');
    assert.ok(audioStream && audioStream.kind === 'audio');
    assert.equal(audioStream.codec, 0x162);
    assert.equal(audioStream.sampleRate, 48000);
    const jsDec = new WindowsMediaDecoder(audioStream, {wasm: false});
    const wasmDec = new WindowsMediaDecoder(audioStream, {wasm: true});
    const demux = new AsfDemuxer(layout);
    let frames = 0;
    let maxAbs = 0;
    let maxDiff = 0;
    for (
      let off = layout.dataOffset, count = 0;
      off + layout.packetSize <= buf.length && count < Math.min(layout.packetCount, 30);
      off += layout.packetSize, count++
    ) {
      for (const pkt of demux.packet(buf.subarray(off, off + layout.packetSize))) {
        if (pkt.stream !== audioStream.number) continue;
        const a = jsDec.decode(pkt.data, pkt.time, pkt.key);
        const b = wasmDec.decode(pkt.data, pkt.time, pkt.key);
        assert.equal(a.length, b.length);
        for (let i = 0; i < a.length; i++) {
          frames++;
          for (let ch = 0; ch < a[i].channels.length; ch++) {
            for (let j = 0; j < a[i].channels[ch].length; j++) {
              const va = a[i].channels[ch][j];
              const vb = b[i].channels[ch][j];
              assert.ok(Number.isFinite(va) && Number.isFinite(vb));
              if (Math.abs(va) > maxAbs) maxAbs = Math.abs(va);
              const d = Math.abs(va - vb);
              if (d > maxDiff) maxDiff = d;
            }
          }
        }
      }
    }
    assert.ok(frames >= 5, `Expected decoded WMA Pro frames, got ${frames}`);
    assert.ok(maxAbs > 0.01 && maxAbs < 2.0, `Unexpected PCM peak ${maxAbs}`);
    assert.equal(maxDiff, 0, 'JS and WASM WMA Pro 48kHz outputs must match bit-for-bit');
  },
);

test('Optimized unpackSiglusLz, xorByteInPlace, and decodeOwp preserve exact byte parity across aligned/unaligned buffers', () => {
  // 1. Unaligned subarray xorByteInPlace matches byte-by-byte XOR
  const backing = new Uint8Array(103);
  for (let i = 0; i < backing.length; i++) backing[i] = (i * 37 + 11) & 0xff;
  for (const offset of [0, 1, 2, 3]) {
    const view = backing.slice().subarray(offset, offset + 97);
    const expected = Uint8Array.from(view, (b) => b ^ 0x39);
    xorByteInPlace(view, 0x39);
    assert.deepEqual(view, expected);
  }

  // 2. decodeOwp matches OggS magic across arbitrary lengths
  const oggPlain = new Uint8Array(259);
  oggPlain.set([0x4f, 0x67, 0x67, 0x53], 0);
  for (let i = 4; i < oggPlain.length; i++) oggPlain[i] = (i * 13 + 7) & 0xff;
  const owpEncoded = Uint8Array.from(oggPlain, (b) => b ^ 0x39);
  assert.deepEqual(decodeOwp(owpEncoded), oggPlain);

  // 3. unpackSiglusLz byte mode: literal + overlapping distance=1 RLE + non-overlapping copyWithin
  // Emit 'A','B', then RLE distance=1 count=5 ('B'x5), then copy distance=7 count=4 ('A','B','B','B')
  const payload = [
    0x03, // flags: bits 0,1 literal; bits 2,3 backrefs
    0x41, // 'A'
    0x42, // 'B'
    (1 << 4) | 3, 0, // dist=1, count=3+2=5 -> 'B'x5
    (7 << 4) | 2, 0, // dist=7, count=2+2=4 -> 'A','B','B','B'
  ];
  const packed = new Uint8Array(8 + payload.length);
  const dv = new DataView(packed.buffer);
  dv.setUint32(0, packed.length, true);
  dv.setUint32(4, 11, true);
  packed.set(payload, 8);
  const unpacked = unpackSiglusLz(packed, false);
  assert.equal(Buffer.from(unpacked).toString('ascii'), 'ABBBBBBABBB');

  // 4. unpackSiglusLz pixel mode: literal BGR -> BGRA (A=255) + pixel backref
  const pxPayload = [
    0x01, // bit 0 literal (3 bytes BGR), bit 1 backref
    10, 20, 30,
    (1 << 4) | 1, 0, // dist=1 pixel (4 bytes), count=1+1=2 pixels (8 bytes)
  ];
  const pxPacked = new Uint8Array(8 + pxPayload.length);
  const pdv = new DataView(pxPacked.buffer);
  pdv.setUint32(0, pxPacked.length, true);
  pdv.setUint32(4, 12, true);
  pxPacked.set(pxPayload, 8);
  const pxOut = unpackSiglusLz(pxPacked, true);
  assert.deepEqual(
    [...pxOut],
    [10, 20, 30, 255, 10, 20, 30, 255, 10, 20, 30, 255],
  );
});

test('G00 Type 2 skips 24-byte outer atlas crop table (0x6de310/0x6de430) and display.ts propagates parent clip (0x629c70)', () => {
  // 1. Build a synthetic G00 Type 2 with non-zero outer (left=510, top=720) crop rect
  const cutW = 2;
  const cutH = 2;
  const cutBlock = new Uint8Array(116 + 92 + cutW * cutH * 4);
  const cbv = new DataView(cutBlock.buffer);
  cbv.setUint16(2, 1, true); // 1 chip
  cbv.setInt32(4, 0, true); // disp_left
  cbv.setInt32(8, 0, true); // disp_top
  cbv.setInt32(12, cutW, true); // disp_width
  cbv.setInt32(16, cutH, true); // disp_height
  cbv.setInt32(20, 1, true); // centerX
  cbv.setInt32(24, 1, true); // centerY
  cbv.setInt32(28, cutW, true); // width
  cbv.setInt32(32, cutH, true); // height
  cbv.setUint16(116, 0, true); // chip left
  cbv.setUint16(118, 0, true); // chip top
  cbv.setUint16(122, cutW, true); // chip width
  cbv.setUint16(124, cutH, true); // chip height
  cutBlock.fill(255, 116 + 92);

  // Decompressed inner payload: [cut_cnt=1][offset=12][len=cutBlock.length][cutBlock]
  const rawInner = new Uint8Array(12 + cutBlock.length);
  const riv = new DataView(rawInner.buffer);
  riv.setUint32(0, 1, true);
  riv.setUint32(4, 12, true);
  riv.setInt32(8, cutBlock.length, true);
  rawInner.set(cutBlock, 12);

  // Pack rawInner using literal-only Siglus LZ chunks (0xff flag byte + 8 literal bytes)
  const chunks = [];
  for (let i = 0; i < rawInner.length; i += 8) {
    chunks.push(0xff);
    for (let j = 0; j < 8 && i + j < rawInner.length; j++) chunks.push(rawInner[i + j]);
  }
  const lzBody = new Uint8Array(8 + chunks.length);
  const lzv = new DataView(lzBody.buffer);
  lzv.setUint32(0, lzBody.length, true);
  lzv.setUint32(4, rawInner.length, true);
  lzBody.set(chunks, 8);

  // Outer G00 Type 2 file: type=2, w=1020, h=1020, count=1, outerRect=[510,720,539,749,0,0], lzBody
  const g00Bytes = new Uint8Array(9 + 24 + lzBody.length);
  const gv = new DataView(g00Bytes.buffer);
  gv.setUint8(0, 2);
  gv.setUint16(1, 1020, true);
  gv.setUint16(3, 1020, true);
  gv.setUint32(5, 1, true);
  gv.setInt32(9, 510, true); // outer atlas left — MUST be ignored
  gv.setInt32(13, 720, true); // outer atlas top — MUST be ignored
  gv.setInt32(17, 539, true);
  gv.setInt32(21, 749, true);
  g00Bytes.set(lzBody, 9 + 24);

  const img = new G00Image(g00Bytes);
  const frame = img.frame(0);
  assert.equal(frame.x, 0);
  assert.equal(frame.y, 0);
  assert.equal(frame.width, cutW);
  assert.equal(frame.height, cutH);
  assert.equal(frame.centerX, 1);
  assert.equal(frame.centerY, 1);

  // 2. Verify real Tsukikana & SSR smartphone bitmap-font and multi-cut UI G00 files when installed
  const TK_DIR = '/Volumes/Transcend/Torrents/1GAMES/Tsuki no Kanata de Aimashou';
  for (const [label, dir] of [
    ['Tsukikana', TK_DIR],
    ['SSR', SSR_DIR],
  ]) {
    if (!fs.existsSync(`${dir}/g00/_mj_SE30_0010.g00`)) continue;
    const glyphImg = new G00Image(new Uint8Array(fs.readFileSync(`${dir}/g00/_mj_SE30_0010.g00`)));
    const glyphCut = glyphImg.frame(833);
    assert.equal(glyphCut.x, 0, `${label} _mj_SE30_0010 cut 833 leaked outer X`);
    assert.equal(glyphCut.y, 0, `${label} _mj_SE30_0010 cut 833 leaked outer Y`);
    assert.equal(glyphCut.width, 30);
    assert.equal(glyphCut.height, 30);
    if (fs.existsSync(`${dir}/g00/_chr_menu_btn01.g00`)) {
      const btnImg = new G00Image(new Uint8Array(fs.readFileSync(`${dir}/g00/_chr_menu_btn01.g00`)));
      const btnCut2 = btnImg.frame(2);
      assert.equal(btnCut2.x, 0, `${label} _chr_menu_btn01 cut 2 leaked outer X`);
      assert.equal(btnCut2.y, 0, `${label} _chr_menu_btn01 cut 2 leaked outer Y`);
    }
  }

  // 3. Verify display.ts propagates parent dst_clip in appendChildren (0x629c70) and guards object.text outline
  const displaySrc = fs.readFileSync(path.join(SIGLUS_DIR, 'display.ts'), 'utf8');
  assert.match(displaySrc, /applyDstClip\(/);
  assert.match(displaySrc, /appendChildren\([\s\S]{0,600}if \(object\.clip\?\.\[0\]\) \{[\s\S]{0,500}this\.applyDstClip\(clipBox/);
  assert.match(displaySrc, /applyClip\([\s\S]{0,250}this\.applyDstClip\(element, object, parentOrigin\[0\] \+ x, parentOrigin\[1\] \+ y/);
  assert.match(displaySrc, /shadowMode === 2 \|\|\s*\(shadowMode === undefined && outlineColor !== undefined && outlineColor >= 0\)/);
});

test('Native 0x650980/0x650bd0 pageInput waits without pendingText (smartphone LIME) and 0x661af0/cf0/c20/e70 play save/load SE', () => {
  const playerSrc = fs.readFileSync(path.join(SIGLUS_DIR, 'player.ts'), 'utf8');
  // 1. pageInput must NOT early-return on !this.pendingText, must flush objectsDirty, and honor autoModeMojiCnt
  assert.doesNotMatch(playerSrc, /private async pageInput\([^)]*\): Promise<void> \{\s*if \(!this\.pendingText\) return;/);
  assert.match(playerSrc, /private async pageInput\([\s\S]{0,350}if \(this\.objectsDirty\) await this\.renderObjects\(\);/);
  assert.match(playerSrc, /const autoChars = this\.autoModeMojiCnt \|\| this\.pageCharacters;/);
  // 2. Restore playback before playing the pending load confirmation.
  assert.match(playerSrc, /this\.audio\.resetPlayback\(\);\s*if \(this\.pendingLoadSound\)/);
});

test('Native 0x52ff18 object int-event dispatch separates dstClip 105..108 from color/center/pattern events', async () => {
  const object = {type: 2, name: 'cutin', x: 0, y: 0, pattern: 0, frames: [], visible: true};
  const page = new Map([[1, object]]);
  const player = Object.assign(Object.create(SiglusPlayer.prototype), {
    objectAddress: () => ({page, index: 2}),
    markObjectsDirty: () => {},
    renderObjects: async () => {},
    delay: async () => 0,
  });
  const call = (command, op, ...args) =>
    player.objectCommand({path: [37, 2, -1, 1, command, op], args, named: []});

  // 105..108 animate dst_clip_left/top/right/bottom_eve onto object.clip[1..4] without tinting colorProps
  await call(105, 0, 100, 500, 0, 2);
  await call(106, 0, 280, 500, 0, 2);
  await call(107, 0, 1280, 500, 0, 2);
  await call(108, 0, 420, 500, 0, 2);
  assert.deepEqual(object.clip, [0, 100, 280, 1280, 420]);
  assert.equal(object.colorProps, undefined);
  for (let edge = 0; edge < 4; edge++) assert.equal(object.intEvents?.has(`dstClip:${edge}`), true);

  // 69..90 map rotateX/Y/Z, mono/reverse/bright/dark, center/centerRep, colorRate, addRGB, colorRGB, pattern
  await call(69, 0, 15, 0, 0, 0);
  await call(70, 0, 25, 0, 0, 0);
  await call(71, 0, 35, 0, 0, 0);
  await call(73, 0, 120, 0, 0, 0);
  await call(74, 0, 80, 0, 0, 0);
  await call(75, 0, 40, 0, 0, 0);
  await call(76, 0, 30, 0, 0, 0);
  await call(77, 0, 12, 0, 0, 0);
  await call(78, 0, 34, 0, 0, 0);
  await call(80, 0, 56, 0, 0, 0);
  await call(81, 0, 78, 0, 0, 0);
  await call(83, 0, 255, 600, 300, 0);
  await call(84, 0, 10, 0, 0, 0);
  await call(85, 0, 20, 0, 0, 0);
  await call(86, 0, 30, 0, 0, 0);
  await call(87, 0, 200, 0, 0, 0);
  await call(88, 0, 150, 0, 0, 0);
  await call(89, 0, 100, 0, 0, 0);
  await call(90, 0, 3, 0, 0, 0);

  assert.equal(object.rotateX, 15);
  assert.equal(object.rotateY, 25);
  assert.equal(object.rotateZ, 35);
  assert.deepEqual(object.center, [12, 34]);
  assert.deepEqual(object.centerRep, [56, 78]);
  assert.equal(object.pattern, 3);
  assert.deepEqual(object.colorProps, {
    mono: 120,
    reverse: 80,
    bright: 40,
    dark: 30,
    colorRate: 255,
    addR: 10,
    addG: 20,
    addB: 30,
    colorR: 200,
    colorG: 150,
    colorB: 100,
  });
});

test('layoutObjectText interprets ## escapes, #D resets, #<n>C/S/X/Y/RX/RY codes, and maxChars width wrapping', () => {
  const runs = layoutObjectText('##1#22Sあ#3Cい\r\n#D#4X#5RYえ#10RXお', {
    size: 18,
    spaceX: 2,
    spaceY: 4,
    color: 1,
  });
  assert.deepEqual(runs, [
    {text: '#1', x: 0, y: 0, size: 18, color: 1},
    {text: 'あ', x: 22, y: 0, size: 22, color: 1},
    {text: 'い', x: 46, y: 0, size: 22, color: 3},
    {text: 'え', x: 4, y: 57, size: 22, color: 3},
    {text: 'お', x: 38, y: 57, size: 22, color: 3},
  ]);

  const wrapped = layoutObjectText('ABCDEFGH漢', {size: 20, maxChars: 4});
  assert.deepEqual(
    wrapped.map((r) => [r.text, r.x, r.y]),
    [
      ['ABCDEFGH', 0, 0],
      ['漢', 0, 20],
    ],
  );
});

test('selbtnPresentation and layoutSelbtnItems omit dispFlag=0 spacers while preserving hidden spacer slots', () => {
  assert.equal(selbtnPresentation(0), 'hidden');
  assert.equal(selbtnPresentation(1), 'enabled');
  assert.equal(selbtnPresentation(2), 'disabled');
  assert.equal(selbtnPresentation(3), 'hidden');
  const template = readSelbtnTemplate(
    new Map([
      ['SELBTN.000.BASE_POS', '640,360'],
      ['SELBTN.000.REP_POS', '0,80'],
      ['SELBTN.000.ALIGN', '0,0'],
    ]),
    0,
  );
  const items = [
    {index: 0, text: '■位置ずらし用■', dispFlag: 0, colorMode: -1},
    {index: 1, text: '選択肢A', dispFlag: 1, colorMode: -1},
    {index: 2, text: '■位置ずらし用■', dispFlag: 3, colorMode: -1},
    {index: 3, text: '選択肢B', dispFlag: 1, colorMode: -1},
  ];
  const laid = layoutSelbtnItems(items, template, 200, 40);
  assert.deepEqual(
    laid.map((p) => [p.item.index, selbtnPresentation(p.item.dispFlag), p.x, p.y]),
    [
      [1, 'enabled', 640, 360],
      [2, 'hidden', 640, 440],
      [3, 'enabled', 640, 520],
    ],
  );
});

test('get_save_message strips newlines, messagePointerAction round-trips captureSave/restoreSave, waitAtPage gates hover polling on showControls, and DOM text options stay enabled', async () => {
  const vm = {checkpoint: () => ({frames: []}), callScene: async () => {}};
  const player = Object.assign(Object.create(SiglusPlayer.prototype), {
    stagePath: (path) => path,
    game: {config: new Map([['SAVE.CNT', '10'], ['QUICK_SAVE.CNT', '10']])},
    root: {dataset: {}},
    saves: new Map([[0, {message: {text: [{text: '一行目\r\n'}, {text: '二行目\n三行目'}]}}]]),
    quickSaves: new Map([[0, {message: {text: [{text: 'クイック\nテキスト'}]}}]]),
    vm,
    stageProperties: new Map(),
    display: {
      saveMessage: () => ({}),
      restoreMessage: () => {},
      loadMessage: async () => {},
      closeMessage: () => {},
      setMessageSlide: () => {},
      clearMessageFilterFiles: () => {},
      saveGans: () => [],
      saveMovieEffects: () => [],
      saveRectangleEffects: () => [],
      loadStageEffects: async () => {},
      sceneCovered: false,
      saveObjectMasks: () => [],
      restoreObjectMasks: async () => {},
      syncObjectButtonGroups: () => {},
      setScenePaused: () => {},
      setMessageDisplayed: () => {},
      stage: {style: {}},
      endEffect: () => {},
      clearObjects: () => {},
      setBackground: async () => {},
      setCast: async () => {},
      renderMessageObjects: async () => {},
    },
    audio: {
      bgmCheckpoint: () => undefined,
      channelLevel: () => 255,
      pcmCheckpoint: () => [],
      resetPlayback: () => {},
      restoreBgm: async () => {},
      setChannelLevel: () => {},
      restorePcm: async () => {},
    },
    currentCast: [],
    currentCastCostumes: [],
    speed: -1,
    saveTitle: '',
    history: [],
    backlog: [],
    historyPoints: new Map(),
    pageVoices: [],
    pageReadFlags: [],
    systemMenuEnabled: true,
    messageButtonsEnabled: true,
    disabledMessageButtons: new Set(),
    saveEnabled: true,
    loadEnabled: true,
    selectionReturnFlags: [true, true],
    skipAllowed: true,
    localExtraSwitches: new Set(),
    msgBackEnabled: true,
    hideMwndEnabled: true,
    mwndBtnTouchEnabled: true,
    objects: [new Map(), new Map()],
    noSaveObjectIds: new Set(),
    stageEffects: new Map(),
    excallFlags: new Set(),
    pcmEvents: new Map(),
    namaeValues: new Map(),
    namaeIds: new Map(),
    messageFilterFiles: new Map(),
    messageButtonOffsets: new Map(),
    frameActions: new Map(),
    maskEvents: new Map(),
    activeGroups: new Set(),
    cancelGroups: new Set(),
    decisions: new Map(),
    sceneCounters: new Map(),
    readFlags: new Map(),
    releaseSystemObjects: () => {},
    clearDayObjects: () => {},
    applyScreenEffects: () => {},
    cast: async () => {},
    renderObjects: async () => {},
    renderMessageObjects: async () => {},
    restoreCastCostumes: async () => {},
    restoreCustomValues: () => {},
    restoreObjectMasks: async () => {},
    applyMessageControls: () => {},
    deserializeDrawObject: async (o) => o,
    messagePointerAction: {channel: 0, scene: '_04mwbtn_hide', command: 't_mwnd_btn_check'},
  });

  // 1. syscom get_save_message / get_quick_save_message strip embedded newlines
  assert.equal(await player.command({path: [63, 129], args: [0], named: []}), '一行目二行目三行目');
  assert.equal(await player.command({path: [63, 130], args: [0], named: []}), 'クイックテキスト');

  // 2. captureSave / restoreSave preserves and clears messagePointerAction
  const captured = player.captureSave(false);
  assert.deepEqual(captured.messagePointerAction, {
    channel: 0,
    scene: '_04mwbtn_hide',
    command: 't_mwnd_btn_check',
  });
  player.messagePointerAction = undefined;
  await player.restoreSave({...captured, background: undefined});
  assert.deepEqual(player.messagePointerAction, captured.messagePointerAction);
  await player.restoreSave({...captured, messagePointerAction: undefined, background: undefined});
  assert.equal(player.messagePointerAction, undefined);

  // 3. waitAtPage only queues message-frame hover input when showControls is true (source + behavior)
  const playerSrc = fs.readFileSync(path.join(SIGLUS_DIR, 'player.ts'), 'utf8');
  assert.match(
    playerSrc,
    /const showControls = this\.messageButtonsEnabled && \(!this\.skipping \|\| readSkipping\);\s*if \(showControls\) \{\s*this\.queueMessageFrameInput\(\);/,
  );

  // 4. Sidebar exposes DomTextStyle unconditionally and display.ts guards 0px baseline measurement
  const sidebarSrc = fs.readFileSync(path.join(REPO_ROOT, 'ui/player/Sidebar.svelte'), 'utf8');
  assert.match(sidebarSrc, /<DomTextStyle\s*\/>/);
  const displaySrc = fs.readFileSync(path.join(SIGLUS_DIR, 'display.ts'), 'utf8');
  assert.match(displaySrc, /size > 0 \? `\$\{size \* scale\}px` : ''/);
  assert.match(displaySrc, /if \(this\.messageTextSize > 0\) this\.alignDomText\(\);/);
  assert.match(displaySrc, /if \(Number\.parseFloat\(fontSize\) <= 0\) continue;/);
});

test('SiglusVm stringCommand implements 1.1.80.8 (0x6459d0) display-column string methods', () => {
  const stringCommand = SiglusVm.prototype.stringCommand;
  const sample = 'AあBいC';

  // member 6: cnt (UTF-16 length), member 5: len (1-col halfwidth, 2-col fullwidth)
  assert.equal(stringCommand(sample, 6, []), 5);
  assert.equal(stringCommand(sample, 5, []), 7);
  assert.equal(stringCommand('ｱｲAあ', 5, []), 5);

  // member 7: left_len
  assert.equal(stringCommand(sample, 7, [2]), 'A');
  assert.equal(stringCommand(sample, 7, [3]), 'Aあ');
  assert.equal(stringCommand(sample, 7, [4]), 'AあB');

  // member 8: mid_len [startCols, maxCols] (1.1.80.8 0x645ea4: col <= startCols + maxCols)
  assert.equal(stringCommand(sample, 8, [1, 3]), 'あB');
  assert.equal(stringCommand(sample, 8, [2, 3]), 'B');
  assert.equal(stringCommand(sample, 8, [2, 4]), 'Bい');
  assert.equal(stringCommand('あいう', 8, [1, 2]), '');
  assert.equal(stringCommand('あいう', 8, [1, 3]), 'い');

  // member 9: right_len
  assert.equal(stringCommand(sample, 9, [2]), 'C');
  assert.equal(stringCommand(sample, 9, [3]), 'いC');
  assert.equal(stringCommand(sample, 9, [4]), 'BいC');
  assert.equal(stringCommand(sample, 9, [7]), sample);
  assert.equal(stringCommand(sample, 9, [0]), '');
  assert.equal(stringCommand(sample, 9, [-1]), '');
});

test('SiglusAudio/Player handle missing koe/ voice banks gracefully via MissingSiglusVoiceError', async () => {
  const audio = {files: new Map(), decodeSound: async () => { throw new Error('unexpected decode'); }};
  await assert.rejects(
    () => SiglusAudio.prototype.loadVoice.call(audio, 100001),
    (error) => error instanceof MissingSiglusVoiceError && /koe\/z0001\.ovk/.test(error.message),
  );

  const playerMissing = {
    audio: {
      voice: async (id) => {
        throw new MissingSiglusVoiceError(id);
      },
    },
  };
  assert.equal(await SiglusPlayer.prototype.playVoiceSafe.call(playerMissing, 100001, 'voice', 0), false);

  const playerCrash = {
    audio: {
      voice: async () => {
        throw new Error('corrupt voice packet');
      },
    },
  };
  await assert.rejects(
    () => SiglusPlayer.prototype.playVoiceSafe.call(playerCrash, 100001, 'voice', 0),
    /corrupt voice packet/,
  );
});
