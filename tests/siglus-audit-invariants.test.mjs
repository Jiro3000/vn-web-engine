import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import {
  parseButtonActionStates,
  parseButtonSe,
  parseMwndAnimation,
  parseMwndColors,
  parseMwndLayout,
  parseSpaceHideObjectIds,
} from '../dist/engines/siglus/mwnd.js';
import {
  layoutSelbtnItems,
  readSelbtnTemplate,
  selbtnPresentation,
} from '../dist/engines/siglus/selbtn.js';
import {layoutObjectText} from '../dist/engines/siglus/object-text.js';
import {measureSiglusFlick, siglusFlickScene} from '../dist/engines/siglus/flick.js';
import {SiglusJoypad} from '../dist/engines/siglus/joypad.js';
import {SiglusConfiguration} from '../dist/engines/siglus/configuration.js';
import {
  isSiglusInstallation,
  siglusDirectory,
} from '../dist/engines/siglus/installation-markers.js';
import {
  layoutSiglusCompositeLayers,
  orderedObjects,
  parseSiglusCompositeSpec,
  serializeDrawObject,
  SiglusDisplay,
} from '../dist/engines/siglus/display.js';
import {SiglusPlayer} from '../dist/engines/siglus/player.js';
import {SiglusVm} from '../dist/engines/siglus/vm.js';
import {MissingSiglusVoiceError, SiglusAudio} from '../dist/engines/siglus/audio.js';
import {encodeCaptureBmp, readCaptureBmpFlags} from '../dist/engines/siglus/capture.js';
import {BlobSource} from '../dist/core/source.js';
import {unpackSiglusLz, xorByteInPlace, xorCycle} from '../dist/formats/siglus/compression.js';
import {parseCgTable} from '../dist/formats/siglus/cgtable.js';
import {SiglusDbs} from '../dist/formats/siglus/dbs.js';
import {G00Image} from '../dist/formats/siglus/g00.js';
import {readJpegHeader} from '../dist/formats/jpeg/header.js';
import {decodeOwp} from '../dist/formats/siglus/sound.js';
import {cgmXor, dbsMask} from '../dist/formats/siglus/tables.js';
import {AsfDemuxer, readAsfLayout} from '../dist/formats/asf/demux.js';
import {SiglusScenePack} from '../dist/formats/siglus/scene-pack.js';
import {WindowsMediaDecoder} from '../dist/video/windows-media.js';
import {MemoryStore} from '../dist/platform/store.js';

const REPO_ROOT = path.resolve(import.meta.dirname, '..');
const SIGLUS_DIR = path.join(REPO_ROOT, 'src/engines/siglus');
const SSR_DIR = '/Users/paul/Torrents/Games/tsuki no kanata fan disk';
const HAS_SSR = fs.existsSync(`${SSR_DIR}/Gameexe.dat`) && fs.existsSync(`${SSR_DIR}/Scene.pck`);

test('Siglus flick dispatch uses the configured regions after the native velocity threshold', () => {
  const config = new Map([['FLICK_SCENE.CNT', '4']]);
  for (let index = 0; index < 4; index++) {
    const prefix = `FLICK_SCENE.00${index}`;
    config.set(`${prefix}.ANGLE`, String(5 + index));
    config.set(`${prefix}.SCENE`, `"menu", ${index}`);
  }
  // 1.1.141.3 0x633ec3–0x633f3b: 5=up, 6=right, 7=down, 8=left.
  assert.equal(siglusFlickScene(config, measureSiglusFlick(0, -12, 10)), 'FLICK_SCENE.000.SCENE');
  assert.equal(siglusFlickScene(config, measureSiglusFlick(12, 0, 10)), 'FLICK_SCENE.001.SCENE');
  assert.equal(siglusFlickScene(config, measureSiglusFlick(0, 12, 10)), 'FLICK_SCENE.002.SCENE');
  assert.equal(siglusFlickScene(config, measureSiglusFlick(-12, 0, 10)), 'FLICK_SCENE.003.SCENE');
  assert.equal(siglusFlickScene(config, measureSiglusFlick(0, -4, 10)), undefined);
});

test('Siglus joypad commands report press, hold, and release in native button order', () => {
  const joypad = new SiglusJoypad();
  const buttons = Array.from({length: 16}, () => ({pressed: false, value: 0}));
  const gamepad = {mapping: 'standard', buttons, axes: [0, 0, 0, 0]};
  joypad.sample(gamepad);
  assert.equal(joypad.active, false);
  assert.equal(joypad.state(4, 7), 1);

  buttons[0] = {pressed: true, value: 1};
  buttons[12] = {pressed: true, value: 1};
  gamepad.axes[2] = -0.7;
  joypad.sample(gamepad);
  assert.equal(joypad.active, true);
  for (const index of [0, 4, 22]) {
    assert.equal(joypad.state(index, 1), 1);
    assert.equal(joypad.state(index, 6), 1);
    assert.equal(joypad.state(index, 5), 0);
  }

  joypad.sample(gamepad);
  assert.equal(joypad.state(4, 1), 0);
  assert.equal(joypad.state(4, 6), 1);
  joypad.sample(undefined);
  assert.equal(joypad.state(4, 5), 1);
  assert.equal(joypad.state(4, 7), 1);
  assert.equal(joypad.active, false);

  joypad.settings = {swapAB: true, swapXY: true};
  buttons[2] = {pressed: true, value: 1};
  joypad.sample(gamepad);
  assert.equal(joypad.state(4, 6), 0);
  assert.equal(joypad.state(5, 6), 1);
  assert.equal(joypad.state(6, 6), 0);
  assert.equal(joypad.state(7, 6), 1);
});

test('Siglus message text color commands address the active or explicitly indexed window', async () => {
  const display = Object.assign(Object.create(SiglusDisplay.prototype), {
    windowIndex: 2,
    messageTextColors: new Map(),
    currentText: [],
  });
  const player = Object.assign(Object.create(SiglusPlayer.prototype), {display});
  const invoke = (path, ...args) => player.command({path, args, named: []});
  await invoke([17], 4);
  await invoke([38, 3, -1, 1, 8], 7);
  const message = display.saveMessage();
  assert.deepEqual(message.textColors, [[2, 4], [1, 7]]);
  await invoke([17]);
  assert.deepEqual(display.saveMessage().textColors, [[1, 7]]);
  display.restoreMessageTextColors(message.textColors);
  assert.deepEqual(display.saveMessage().textColors, message.textColors);
});

test('Siglus vertical text swaps the message inline and block extents', () => {
  const config = new Map([
    ['MWND.000.MOJI_CNT', '8, 3'],
    ['MWND.000.MOJI_SIZE', '20'],
    ['MWND.000.MOJI_SPACE', '1, 7'],
  ]);
  const horizontal = parseMwndLayout(config, 0);
  assert.deepEqual([horizontal.vertical, horizontal.textWidth, horizontal.textHeight], [false, 168, 81]);
  config.set('TATEYOKO_MODE', '1');
  const vertical = parseMwndLayout(config, 0);
  assert.deepEqual([vertical.vertical, vertical.textWidth, vertical.textHeight], [true, 81, 168]);
});

test('Siglus saves and copies an inner checkpoint within the configured slot count', async () => {
  const original = {title: 'checkpoint'};
  const player = Object.assign(Object.create(SiglusPlayer.prototype), {
    game: {config: new Map([['INNER_SAVE.CNT', '2']])},
    innerSaves: new Map(),
    saves: new Map(),
    quickSaves: new Map(),
    savePoint: original,
    loadEnabled: true,
    loadSave: (save) => assert.deepEqual(save, {title: 'checkpoint'}),
  });
  const call = (member, ...args) => player.command({path: [63, member], args, named: []});
  await call(272, 2);
  assert.equal(await call(275, 2), 0);
  await call(272, 0);
  original.title = 'new checkpoint';
  assert.equal(await call(275, 0), 1);
  await call(274, 0, 1);
  await call(276, 0);
  assert.equal(await call(275, 0), 0);
  assert.equal(await call(273, 1, 0, 1), 1);
  assert.equal(player.pendingLoadSound, true);
});

test('Siglus resolves position events on message buttons and restores indexed object events', async () => {
  const display = Object.assign(Object.create(SiglusDisplay.prototype), {
    messageButtonStates: new Map(),
    windowIndex: 0,
    activeFrameActions: [],
  });
  const player = Object.assign(Object.create(SiglusPlayer.prototype), {display});
  const button = [38, 3, -1, 0, 32, -1, 4];
  const call = (path, ...args) => player.command({path: [...button, ...path], args, named: []});
  await call([51, 7], 75, 500, 0, 0);
  assert.equal(await call([51, 5]), 1);
  assert.equal(player.property([...button, 3]), 75);
  assert.equal(player.property([...button, 3], 40), 40);
  assert.equal(await call([51, 5]), 0);

  const time = {duration: 100, delay: 10, easing: 'linear'};
  const original = {
    name: '', frames: [], x: 0, y: 0, visible: false, pattern: 0,
    offsetEvents: {x: new Map([[0, {from: 10, started: 40, time}]])},
    offsetEventCounts: {x: 1}, positionOffsets: {x: [80]},
  };
  const saved = serializeDrawObject(original, 100);
  assert.deepEqual(saved.offsetEvents, {x: [[0, {from: 10, elapsed: 60, time}]]});
  const restored = await player.deserializeDrawObject(saved);
  const event = restored.offsetEvents.x.get(0);
  assert.equal(event.from, 10);
  assert.deepEqual(event.time, time);
  assert.deepEqual(restored.positionOffsets, {x: [80], y: undefined});
  assert.equal(serializeDrawObject(restored, event.started + 110).offsetEvents, undefined);
});

test('Siglus reads the base button number from a restored child object', async () => {
  const object = {name: '', frames: [], x: 0, y: 0, visible: false, pattern: 0};
  const parent = {
    ...object,
    children: new Map([[2, {...object, button: {id: 37, group: 100_001}}]]),
  };
  const player = Object.create(SiglusPlayer.prototype);
  player.systemObjects = new Map([[4, await player.deserializeDrawObject(serializeDrawObject(parent))]]);
  const readNumber = (child) => player.command({
    path: [65, 1, 2, -1, 4, 93, -1, child, 188], args: [], named: [],
  });
  assert.equal(await readNumber(2), 37);
  assert.equal(await readNumber(3), 0);
  assert.equal(player.systemObjectsDirty, undefined);
});

test('Siglus object.get_button_hit_state (123) reports normal, hover, and push without dirtying stage', async () => {
  const active = {
    name: '',
    frames: [],
    x: 0,
    y: 0,
    visible: true,
    pattern: 0,
    button: {id: 39, group: 100_001},
  };
  let hoveredId = -1;
  let pressedId = -1;
  const player = Object.assign(Object.create(SiglusPlayer.prototype), {
    excallAllocated: true,
    systemBackObjects: new Map([[39, active]]),
    activeGroups: new Set([100_001]),
    display: {
      buttonState: (group, pressed) => (group === 100_001 ? (pressed ? pressedId : hoveredId) : -1),
    },
  });
  const readHit = () => player.command({path: [65, 2, 2, -1, 39, 123], args: [], named: []});
  assert.equal(await readHit(), 0);
  hoveredId = 39;
  assert.equal(await readHit(), 1);
  pressedId = 39;
  assert.equal(await readHit(), 2);
  active.disabled = true;
  assert.equal(await readHit(), 0);
  active.disabled = false;
  player.activeGroups.clear();
  assert.equal(await readHit(), 0);
  assert.equal(player.systemObjectsDirty, undefined);
});

test('Siglus story font overrides leave system-menu text on the configured font', async () => {
  const displayed = [];
  const player = Object.assign(Object.create(SiglusPlayer.prototype), {
    display: {setMessageFont: (...values) => displayed.push(values)},
    messageFont: {name: 'Default', bold: true, shadow: 2},
    objects: [new Map(), new Map()],
    systemObjects: new Map(),
  });
  const call = (path, ...args) => player.command({path, args, named: []});
  await call([64, 87], 'Game font');
  await call([64, 90], 0);
  await call([64, 93], 1);
  assert.deepEqual(displayed.at(-1), ['Game font', false, 1]);
  assert.equal(await call([64, 88]), 'Game font');
  await call([38, 2, -1, 0, 39], 'Story text');
  await call([65, 1, 2, -1, 0, 39], 'Menu text');
  assert.equal(player.objects[0].get(0).text.font, 'Game font');
  assert.equal(player.systemObjects.get(0).text.font, 'Default');
  await call([64, 89]);
  await call([64, 91]);
  await call([64, 94]);
  assert.deepEqual(displayed.at(-1), ['Default', true, 2]);
});

test('Siglus excall.script font overrides (65.13.87-95) match 1.1.141.3 jump table 0x54d42c', async () => {
  const player = Object.assign(Object.create(SiglusPlayer.prototype), {
    messageFont: {name: 'Default', bold: true, shadow: 2},
    excallAllocated: true,
    systemObjects: new Map(),
  });
  const call = (path, ...args) => player.command({path, args, named: []});
  await call([65, 13, 87], 'MenuFont');
  assert.equal(await call([65, 13, 88]), 'MenuFont');
  await call([65, 13, 90], 0);
  assert.equal(await call([65, 13, 92]), 0);
  await call([65, 13, 93], 1);
  assert.equal(await call([65, 13, 95]), 1);
  await call([65, 1, 2, -1, 0, 39], 'Header');
  assert.equal(player.systemObjects.get(0).text.font, 'MenuFont');
  assert.equal(player.systemObjects.get(0).text.bold, false);
  assert.equal(player.systemObjects.get(0).text.shadow, 1);
  await call([65, 13, 89]);
  await call([65, 13, 91]);
  await call([65, 13, 94]);
  assert.equal(await call([65, 13, 88]), '');
  assert.equal(await call([65, 13, 92]), -1);
  assert.equal(await call([65, 13, 95]), -1);
});

test('Siglus 1.1.141.3 EXCALL joypad fallback, MWND button count, return_sel, cursor_no, unified save copy/swap, and intEvent tracking', async () => {
  // 1. EXCALL joypad mode falls back to JOYPAD.ALLOW_JOYPAD_MODE when override is -1 (0x62f510)
  const joypad = Object.assign(new SiglusJoypad(), {active: true});
  const config = new Map([
    ['JOYPAD.ALLOW_JOYPAD_MODE', '1'],
    ['SAVE.CNT', '10'],
    ['QUICK_SAVE.CNT', '5'],
    ['MWND.000.WAKU_NO', '0'],
    ['WAKU.000.BTN.000.TYPE', '"save"'],
    ['WAKU.000.BTN.001.TYPE', '"load"'],
    ['WAKU.000.BTN.002.TYPE', '"return_sel"'],
  ]);
  const display = Object.assign(Object.create(SiglusDisplay.prototype), {
    config,
    frameActionsByWaku: new Map(),
    buttonState: () => -1,
  });
  const saves = new Map([[1, {version: 1, title: 'S1'}]]);
  const quickSaves = new Map([[2, {version: 1, title: 'Q2'}]]);
  const player = Object.assign(Object.create(SiglusPlayer.prototype), {
    game: {config},
    display,
    joypad,
    systemCallDepth: 1,
    excallJoypadModeOverride: -1,
    joypadModeOverride: -1,
    historyOpen: false,
    mwndBtnTouchEnabled: true,
    hideMwndEnabled: true,
    disabledMessageButtons: new Set(),
    selectionReturnFlags: [true, true],
    selectionSaves: [],
    mouseCursorNo: 0,
    saves,
    quickSaves,
    endSaves: new Map(),
    objects: [new Map([[0, {name: '', frames: [], x: 0, y: 0, visible: true, pattern: 0, transparency: 255}]]), new Map()],
    systemObjects: new Map([[0, {name: '', frames: [], x: 0, y: 0, visible: true, pattern: 0, transparency: 255}]]),
    excallAllocated: true,
    activeGroups: new Set(),
    writeSlot: async (map, idx, data) => { map.set(idx, data); },
    updateSlots: async (map, entries) => {
      for (const [idx, data] of entries) {
        if (data === undefined) map.delete(idx);
        else map.set(idx, data);
      }
    },
  });
  const call = (path, ...args) => player.command({path, args, named: []});

  assert.equal(await call([63, 333]), 1);
  await call([65, 13, 98], 0);
  assert.equal(await call([63, 333]), 0);
  await call([65, 13, 99]);
  assert.equal(await call([63, 333]), 1);

  // 2. MWND button count (38.3.-1.0.32.3 -> 0x555122 -> 0x559315)
  assert.equal(await call([38, 3, -1, 0, 32, 3]), 3);

  // 3. frameActionState for return_sel, hideMwndEnabled, and mwndBtnTouchEnabled
  assert.equal(player.frameActionState({id: 2, type: 'return_sel'}, false), 'disabled');
  player.selectionSaves.push({version: 1});
  assert.equal(player.frameActionState({id: 2, type: 'return_sel'}, false), 'enabled');
  player.hideMwndEnabled = false;
  assert.equal(player.frameActionState({id: 14, type: 'close_mwnd'}, false), 'disabled');
  player.mwndBtnTouchEnabled = false;
  assert.equal(player.frameActionState({id: 2, type: 'return_sel'}, false), 'disabled');

  // 4. script.set_mouse_cursor_no / get_mouse_cursor_no (64.52 / 64.53)
  await call([64, 52], 3);
  assert.equal(await call([64, 53]), 3);

  // 5. Unified save copy (63.67) and cross-category swap (63.22)
  assert.equal(await call([63, 67], 12, 3), 1); // quick slot 2 (abs 12) -> normal slot 3
  assert.equal(saves.get(3)?.title, 'Q2');
  assert.equal(await call([63, 67], 3, 3), 0); // same slot returns 0 (0x66255b)
  assert.equal(await call([63, 22], 1, 12), 1); // swap normal slot 1 <-> quick slot 2
  assert.equal(saves.get(1)?.title, 'Q2');
  assert.equal(quickSaves.get(2)?.title, 'S1');

  // 6. Object x_eve.set_real (51.7), EXCALL x_eve.check (51.5), tr_eve.check/end (72.5 / 72.3)
  await call([38, 2, -1, 0, 51, 7], 200, 500, 0, 0);
  assert.ok(player.objects[0].get(0).positionEvents?.x);
  assert.equal(await call([38, 2, -1, 0, 51, 5]), 1);
  await call([38, 2, -1, 0, 51, 3]);
  assert.equal(player.objects[0].get(0).positionEvents?.x, undefined);
  assert.equal(await call([38, 2, -1, 0, 51, 5]), 0);

  await call([65, 1, 2, -1, 0, 51, 0], 150, 500, 0, 0);
  assert.equal(await call([65, 1, 2, -1, 0, 51, 5]), 1);
  await call([65, 1, 2, -1, 0, 72, 0], 0, 500, 0, 0);
  assert.equal(await call([65, 1, 2, -1, 0, 72, 5]), 1);
  await call([65, 1, 2, -1, 0, 72, 3]);
  assert.equal(player.systemObjects.get(0).opacity, undefined);
  assert.equal(await call([65, 1, 2, -1, 0, 72, 5]), 0);

  // 7. excall[0] routes counter[] (6) and f[] (7) to story state (0x54d0cc/0x54d102)
  assert.deepEqual(player.stagePath([65, -1, 0, 6, -1, 2, 1]), [40, -1, 2, 1]);
  assert.deepEqual(player.stagePath([65, -1, 0, 7, -1, 5]), [29, -1, 5]);
});

test('the fixed Siglus viewport clips overflow without becoming a scroll container', () => {
  const display = fs.readFileSync(path.join(SIGLUS_DIR, 'display.ts'), 'utf8');
  assert.match(display, /this\.stage\.style\.cssText\s*=\s*'[^']*\boverflow:clip;/);
});

test('destination clips stay in stage space around translated and scaled objects', () => {
  const createElement = () => ({style: {}, dataset: {}, children: [], append(child) { this.children.push(child); }});
  const display = Object.assign(Object.create(SiglusDisplay.prototype), {
    width: 1920,
    height: 1080,
    stage: {ownerDocument: {createElement}},
  });
  const object = {x: -640, y: -108, scale: [1500, 1500], clip: [1, 0, 225, 1920, 855]};
  const {viewport, content} = display.destinationClipLayer(object, [0, 0]);
  assert.equal(content, viewport);
  assert.equal(viewport.style.clipPath, 'inset(225px 0px 225px 0px)');
  assert.match(viewport.style.cssText, /left:0px;top:0px;width:1920px;height:1080px/);

  const nested = display.destinationClipLayer(object, [110, 22]);
  assert.equal(nested.viewport.style.clipPath, viewport.style.clipPath);
  assert.match(nested.viewport.style.cssText, /left:-110px;top:-22px/);
  assert.match(nested.content.style.cssText, /left:110px;top:22px/);
  assert.deepEqual(nested.viewport.children, [nested.content]);
});

test('native message text draws a speaker above the window without moving the dialogue', () => {
  const element = () => ({style: {}, dataset: {}});
  const runs = [];
  const context = {clearRect() {}, measureText: () => ({width: 40}), fillText: (...args) => runs.push(args)};
  const display = Object.assign(Object.create(SiglusDisplay.prototype), {
    config: new Map([
      ['MWND.000.WINDOW_POS', '0,840'],
      ['MWND.000.WINDOW_SIZE', '1920,310'],
      ['MWND.000.NAME_MESSAGE_POS', '375,-36'],
      ['MWND.000.MESSAGE_POS', '375,30'],
      ['MWND.000.MESSAGE_MARGIN', '0,0,0,0'],
    ]),
    message: element(),
    text: element(),
    speaker: element(),
    nativeText: {...element(), getContext: () => context},
    currentName: '名前',
    currentText: [{text: '文'}],
    messageTextSize: 39,
    messageShadow: 0,
    applyMessageFrame() {},
    positionMessageButtons() {},
    setTextSize() {},
    updateSlide: () => 0,
  });
  display.selectMessageWindow(0);
  display.drawNativeMessage(display.nativeText);
  assert.equal(display.nativeText.style.top, '-36px');
  assert.equal(display.nativeText.height, 346);
  assert.deepEqual(runs, [['名前', 375, 0], ['文', 375, 66]]);
});

test('message portraits survive continuation waits and expire at the end of a page', async () => {
  const player = Object.assign(Object.create(SiglusPlayer.prototype), {
    stagePath: (path) => path,
    display: {messageWindow: 0, objectGraphic: async (name) => ({name}), finishMessageSlide() {}},
    root: {dataset: {}},
    messageFaces: new Map(),
    pageReadFlags: [],
    pageVoices: [],
    pages: 0,
    pendingText: true,
    scriptHistoryRecordingDisabled: true,
    systemOption: () => true,
    tracePage() {},
    waitAtPage() {
      assert.equal(this.messageFaces.get(0).get(0).name, 'speaker-face');
    },
  });
  await player.command({path: [41], args: [0, 'speaker-face']});
  await player.pageInput(true);
  assert.equal(player.messageFaces.get(0).get(0).name, 'speaker-face');
  await player.pageInput();
  assert.equal(player.messageFaces.has(0), false);
});

test('a message window opens with animations disabled', () => {
  const display = Object.assign(Object.create(SiglusDisplay.prototype), {
    message: {hidden: true, style: {display: 'none'}},
  });
  display.openMessage({type: 0, time: 0});
  assert.equal(display.message.hidden, false);
  assert.equal(display.message.style.display, '');
});

test('a dismissed choice cannot reappear after its graphic has loaded', async (t) => {
  const previous = Object.getOwnPropertyDescriptor(globalThis, 'document');
  Object.defineProperty(globalThis, 'document', {
    configurable: true,
    value: {createElement: () => ({dataset: {}, style: {}})},
  });
  t.after(() => {
    if (previous) Object.defineProperty(globalThis, 'document', previous);
    else delete globalThis.document;
  });
  let finishLoad;
  const asset = new Promise((resolve) => { finishLoad = resolve; });
  const mounted = [];
  const display = Object.assign(Object.create(SiglusDisplay.prototype), {
    config: new Map([['SELBTN.000.BASE_FILE', '"choice"']]),
    tableColor: () => undefined,
    objectGraphic: () => asset,
    stage: {append: (layer) => mounted.push(layer)},
  });
  const open = display.showSelectionButtons({templateNo: 0, items: []}, () => {}, undefined, false);
  await display.finishSelectionButtons(-1, false);
  finishLoad(undefined);
  await open;
  assert.deepEqual(mounted, []);
});

test('message position is restored from the checkpoint and defaults to zero for older saves', async () => {
  const display = Object.assign(Object.create(SiglusDisplay.prototype), {
    message: {style: {}},
    currentText: [],
    messageTextColors: new Map(),
    clearText() {},
    setMessageSlide() {},
    selectMessageWindow() {},
    setTextSize() {},
    name() {},
    finishMessageSlide() {},
  });
  display.repPosition(30, -20);
  const saved = display.saveMessage();
  display.repPosition(0, 0);
  await display.loadMessage(saved);
  assert.equal(display.message.style.translate, '30px -20px');
  await display.loadMessage({...saved, position: undefined});
  assert.equal(display.message.style.translate, '0px 0px');
});

test('replacing a focused script control preserves held input until focus leaves the stage', async () => {
  const stage = {
    ownerDocument: {activeElement: null, hasFocus: () => true},
    contains: (element) => element === stage,
  };
  const cleared = [];
  const display = {stage, clearInput: (reset) => cleared.push(reset)};
  const skip = (active) => cleared.push(active);
  const focusOut = () => SiglusDisplay.prototype.handleStageFocusOut.call(display, {relatedTarget: null}, skip);

  focusOut();
  stage.ownerDocument.activeElement = stage;
  await Promise.resolve();
  assert.deepEqual(cleared, []);

  stage.ownerDocument.activeElement = null;
  focusOut();
  await Promise.resolve();
  assert.deepEqual(cleared, [false, true]);
});

test('display frames sample held input for nonmodal script controls without duplicating input.next', async () => {
  const calls = [];
  const player = {
    stagePath: (path) => path,
    tickFrameActions: async () => calls.push('actions'),
    renderObjects: async () => calls.push('draw'),
    nextInput: async () => calls.push('yield'),
    sampleInputNow: () => calls.push('sample'),
    activeGroups: new Set([0]),
    systemCallActive: false,
    inputSampled: false,
  };
  const draw = () => SiglusPlayer.prototype.command.call(player, {path: [6], args: [], named: []});

  await draw();
  assert.deepEqual(calls.splice(0), ['actions', 'draw', 'yield', 'sample']);
  player.inputSampled = true;
  await draw();
  assert.deepEqual(calls, ['actions', 'draw']);
  assert.equal(player.inputSampled, false);
});

test('page waits run exported frame callbacks in their declaring scene and wake on stage decisions', async () => {
  const calls = [];
  const player = Object.assign(Object.create(SiglusPlayer.prototype), {
    game: {pack: {commandNames: ['$$open'], commandScenes: [0, 44], sceneNames: ['_export']}},
    vm: {callScene: async (...args) => calls.push(args)},
    display: {pageControls() {}},
    frameActions: new Map(),
    frameActionCounters: new Map(),
    pendingFrameWatchers: new Set(),
    pendingButtonCalls: [],
    decisions: new Map(),
    pruneDeadButtonGroups() {},
    renderObjects: async () => {},
    delay: async () => 1,
  });
  const channel = [53, -1, 3];
  player.startFrameAction(channel, '_caller', -1, '$$Open', [], false);
  await player.waitAtPage();
  assert.deepEqual(calls, [['_export', '$$open', [channel]]]);

  player.waitingForPage = true;
  player.wait = (result) => calls.push(result);
  player.choose({id: 253, group: 9});
  assert.equal(player.decisions.get(9), 253);
  assert.equal(calls.at(-1), 6);
});

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
  Object.assign(player, {
    systemCallActive: true,
    decisions: new Map(),
    activeGroups: new Set(),
    pendingButtonCalls: [],
  });
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
      messageWindow: 0,
      finishMessageSlide() {},
      saveMessage: () => ({name: '', text: [{text: 'sample'}]}),
    },
    historyPoints: new WeakMap(),
    messageFaces: new Map(),
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

test('backlog load queues its sound only for a selected checkpoint with se_flag set', async () => {
  const target = {};
  const restored = [];
  const player = Object.assign(Object.create(SiglusPlayer.prototype), {
    saveSlot: () => undefined,
    quickSaves: new Map(),
    pendingLoadSound: false,
    loadSave: (save) => restored.push(save),
  });
  const load = (sound) => player.command({path: [63, 310], args: [0, sound, 1], named: []});
  assert.equal(await load(1), 0);
  assert.equal(player.pendingLoadSound, false);
  player.historyTarget = target;
  assert.equal(await load(1), 1);
  assert.equal(player.pendingLoadSound, true);
  assert.equal(await load(0), 1);
  assert.equal(player.pendingLoadSound, false);
  assert.deepEqual(restored, [target, target]);
});

test('VM input sampling reports the destination scene after a script jump', async () => {
  const word = (value) => [value & 255, (value >>> 8) & 255, (value >>> 16) & 255, value >>> 24];
  const push = (form, value) => [2, ...word(form), ...word(value)];
  const command = (...forms) => [48, ...word(0), ...word(forms.length), ...forms.flatMap(word), ...word(0), ...word(0)];
  const scenes = {
    start: {strings: ['destination'], code: [8, ...push(10, 4), ...push(20, 0), ...command(20)]},
    destination: {strings: [], code: [1, ...word(73), 8, ...push(10, 86), ...push(10, 3), ...command(), 22]},
  };
  const pack = {
    commandNames: [],
    scene: (name) => ({...scenes[name], name, entries: [0], code: Uint8Array.from(scenes[name].code)}),
  };
  const samples = [];
  const vm = new SiglusVm(pack, {
    command: () => { samples.push(vm.currentPosition()); return 0; },
    property: () => undefined,
    message() {},
    trace() {},
  }, new AbortController().signal);
  await vm.run('start');
  assert.deepEqual(samples, [{scene: 'destination', line: 73}]);
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
  const player = Object.assign(Object.create(SiglusPlayer.prototype), {
    sceneCounters: new Map(),
    systemCounters: new Map(),
  });
  const command = (member) => player.command({path: [65, -1, 1, 6, -1, 0, member], args: [], named: []});
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
    frameActionCounters: new Map(),
    pendingButtonCalls: [],
    game: {pack: {commandNames: ['update'], commandScenes: [0, 0], sceneNames: ['_animation']}},
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

test('nested stage objects retain child state through object copy and save restoration', async () => {
  const player = Object.assign(Object.create(SiglusPlayer.prototype), {
    objects: [new Map(), new Map()],
    systemCallDepth: 0,
    frameActions: new Map(),
    frameActionCounters: new Map(),
    cgTable: new Map(),
    display: {objectGraphic: async (name, pattern) => ({name, pattern})},
  });
  const stage = [49, -1, 0, 2, -1, 42];
  const child = [...stage, 93, -1, 5];
  const grandchild = [...child, 93, -1, 2];
  const invoke = (target, operation, ...args) =>
    player.command({path: [...target, ...operation], args, named: []});

  await invoke(stage, [93, 4], 6);
  await invoke(child, [93, 4], 3);
  await invoke(child, [63, 2], 1);
  await invoke(child, [160], 1, 312, 142, 1606, 835);
  await invoke(child, [112, -1, 0, 0], 16, 300, 0, 2);
  await invoke(grandchild, [38], 'indicator', 1, 1200, 0);
  await invoke(grandchild, [42], 11, 9, 3, 0);
  await invoke(grandchild, [97]);
  await invoke(grandchild, [72, 0], 0, 2000, 3000, 2);

  const original = player.objects[1].get(42);
  const leaf = original.children.get(5).children.get(2);
  assert.ok(Number.isFinite(leaf.opacityStarted));
  leaf.opacityStarted = 1000;
  const now = leaf.opacityStarted + 500;
  const saved = JSON.parse(JSON.stringify(serializeDrawObject(original, now)));
  assert.equal(saved.childCount, 6);
  const [[childId, savedChild]] = saved.children;
  assert.equal(childId, 5);
  assert.equal(savedChild.childCount, 3);
  assert.deepEqual(savedChild.clip, [1, 312, 142, 1606, 835]);
  assert.deepEqual(savedChild.positionOffsets.x, [16]);
  const [[grandchildId, savedGrandchild]] = savedChild.children;
  assert.equal(grandchildId, 2);
  assert.deepEqual(savedGrandchild.button, {id: 11, group: 9, actionNo: 3, seNo: 0});
  assert.equal(savedGrandchild.buttonState, 'disable');
  assert.deepEqual(savedGrandchild.opacity, {values: [0, 2000, 3000, 2, 255], elapsed: 500});

  const copied = player.copyObject(original);
  const restored = await player.deserializeDrawObject(saved);
  assert.deepEqual(JSON.parse(JSON.stringify(serializeDrawObject(copied, now))), saved);
  assert.deepEqual(JSON.parse(JSON.stringify(serializeDrawObject(restored, now))), saved);
  assert.deepEqual(restored.children.get(5).children.get(2).frames, [{name: 'indicator', pattern: 0}]);
  const animation = {};
  const restoredLeaf = restored.children.get(5).children.get(2);
  SiglusDisplay.prototype.applyObjectOpacity.call({}, {
    style: {setProperty() {}},
    animate: () => animation,
  }, restoredLeaf, false, 'opacity');
  assert.ok(Math.abs(animation.currentTime - 500) < 0.001);
  assert.equal(restoredLeaf.opacityElapsed, undefined);
  assert.equal(serializeDrawObject(original, now + 5000).children[0][1].children[0][1].opacity, undefined);
  copied.children.get(5).clip[1] = 0;
  copied.children.get(5).children.get(2).button.id = 0;
  assert.equal(original.children.get(5).clip[1], 312);
  assert.equal(original.children.get(5).children.get(2).button.id, 11);
});

test('indexed EXCALL stage and front paths address main-stage children', async () => {
  const player = Object.assign(Object.create(SiglusPlayer.prototype), {
    objects: [new Map(), new Map()],
    systemCallDepth: 0,
    cgTable: new Map(),
    renderObjects: async () => {},
    delay: async () => 0,
    display: {
      numberGraphic: async (name, {value}) => ({name, value}),
      objectGraphic: async (name) => ({name}),
    },
  });
  const invoke = (path, ...args) => player.command({path, args, named: []});
  const back = [65, -1, 0, 0, -1, 0, 2, -1, 36, 93];
  await invoke([...back, 4], 12);
  await invoke([...back, -1, 11, 132], 'digits', 1, 45, 99);
  await invoke([...back, -1, 11, 134], 2, 1, 0, 0, 0, 1);
  await invoke([...back, -1, 11, 133], 19);
  const number = player.objects[1].get(36).children.get(11);
  assert.deepEqual(number.frames, [{name: 'digits', value: 19}]);
  assert.equal(number.number.ketaMax, 2);

  const front = [65, -1, 0, 1, 2, -1, 36, 93];
  await invoke([...front, 4], 2);
  await invoke([...front, -1, 1, 38], 'control', 1);
  await invoke([...front, -1, 1, 42], 98, 10, 20, 0);
  const control = player.objects[0].get(36).children.get(1);
  assert.equal(control.button.group, 10);
  assert.equal(control.button.id, 98);
  await invoke([...front, -1, 1, 68, 0], 600, 0, 0, 2);
  assert.equal(await invoke([...front, -1, 1, 68, 4]), 0);
  assert.deepEqual(control.scale, [1000, 600]);
  const frontParent = [38, 2, -1, 36];
  assert.equal(await invoke([...frontParent, 67, 5]), 0);
  await invoke([...frontParent, 67, 0], 500, 1000, 0, 2);
  assert.equal(await invoke([...frontParent, 67, 5]), 1);
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
    // Serialized as a relative phase inside the opacity checkpoint.
    'opacityStarted',
    'opacityElapsed',
    'horizontalMotion',
    'movement',
    'movementStarted',
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
    'opacity',
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
  // 3. Native 0x62f0a0: skip_trigger (64.48) arms input trigger without clobbering Ctrl/ReadSkip or auto-skipping
  assert.match(playerSrc, /if \(!this\.skipAllowed\) return false;\s*if \(this\.skip \|\| this\.readSkipEnabled\) return true;\s*return !this\.systemSkipDisabled && this\.skipTriggerFired;/);
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
  assert.match(
    playerSrc,
    /if \(action\.path\[0\] === 65\) \{\s*this\.frameActions\.delete\(key\);\s*this\.frameActionCounters\.delete\(key\);\s*\}/,
  );
  // 4. Native 0x6321f0 -> 0x5bb740: restoreSave and return_to_menu (63.235) reinit EXCALL & modal state
  assert.match(playerSrc, /private async restoreSave\(save: PlayerSave\)[\s\S]*?this\.releaseSystemObjects\(\);/);
  assert.match(playerSrc, /if \(member === 235\)[\s\S]*?this\.releaseSystemObjects\(\);/);
  // 5. Native 0x56aba0 / 0x6a7e50 / 0x6a7ff0: wipe_end (33) and mask_wipe_all (50) handled
  assert.match(playerSrc, /case 33:[\s\S]*?this\.display\.finishWipe\(\);/);
  assert.match(playerSrc, /case 50:[\s\S]*?case 51:/);
  // 6. Native 1.1.141.3 0x54d24e (0x54d42c): excall.script font overrides (0x57..0x5f = 87..95)
  assert.match(playerSrc, /case 88:\s*return font\.name \?\? '';\s*case 89:\s*font\.name = undefined;\s*return 0;/);
  assert.match(playerSrc, /case 92:\s*return font\.bold \?\? -1;/);
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

test('G00 Type 2 skips 24-byte outer atlas crop table (0x6de310/0x6de430)', () => {
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

  // Verify object.text outlines honor their configured shadow mode.
  const displaySrc = fs.readFileSync(path.join(SIGLUS_DIR, 'display.ts'), 'utf8');
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
  const buttonOffsets = new Map();
  const restoredStage = [];
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
      repPosition: () => {},
      setMessageSlide: () => {},
      clearMessageFilterFiles: () => {},
      clearMessageFrameFiles: () => {},
      restoreMessageTextColors: () => {},
      finishWipe: () => {},
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
      show: async (objects) => restoredStage.push([...objects].map(({name}) => name)),
      offsetMessageButton: (window, id, axis, value) => buttonOffsets.set(`${window}.${id}.${axis}`, value),
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
    messageFrameFiles: new Map(),
    messageButtonOffsets: new Map(),
    messageFaces: new Map(),
    frameActions: new Map(),
    frameActionCounters: new Map(),
    pendingButtonCalls: [],
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
    backButtonGroups: new Map(),
  });

  // 1. syscom get_save_message / get_quick_save_message strip embedded newlines
  assert.equal(await player.command({path: [63, 129], args: [0], named: []}), '一行目二行目三行目');
  assert.equal(await player.command({path: [63, 130], args: [0], named: []}), 'クイックテキスト');

  // 2. captureSave / restoreSave preserves the pointer callback and current portrait state.
  player.messageFaces.set(0, new Map([[0, {name: 'portrait', visible: true}]]));
  player.objects[0].set(1, {name: 'saved stage', visible: true});
  player.messageButtonOffsets.set('0.1.54', [15, 5]);
  await player.command({path: [37, 6, -1, 3, 2], args: [], named: []});
  assert.equal(player.activeGroups.has(3), false);
  const captured = player.captureSave(false);
  assert.deepEqual(captured.controls.backButtonGroups, [[3, false]]);
  assert.equal(captured.messageFaces[0][1][0][1].name, 'portrait');
  assert.deepEqual(captured.messagePointerAction, {
    channel: 0,
    scene: '_04mwbtn_hide',
    command: 't_mwnd_btn_check',
  });
  player.messagePointerAction = undefined;
  player.messageFaces.clear();
  await player.restoreSave({...captured, background: undefined});
  assert.deepEqual(player.messagePointerAction, captured.messagePointerAction);
  assert.equal(player.messageFaces.get(0).get(0).name, 'portrait');
  assert.equal(buttonOffsets.get('0.1.x'), 20);
  assert.deepEqual(restoredStage.at(-1), ['saved stage']);
  await player.restoreSave({
    ...captured,
    messageFaces: undefined,
    messagePointerAction: undefined,
    messageButtonOffsets: undefined,
    stageObjects: undefined,
    background: undefined,
  });
  assert.equal(player.messageFaces.size, 0);
  assert.equal(player.messagePointerAction, undefined);
  assert.equal(buttonOffsets.get('0.1.x'), 0);
  assert.deepEqual(restoredStage.at(-1), []);

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

test('nested Select.ini installation markers ignore AppleDouble dotfiles and recognize parent exe layouts', async () => {
  const probeSource = (bytes) => new BlobSource(new Blob([bytes]));
  const nestedFiles = [
    {path: '._SiglusEngine.exe', source: probeSource(Uint8Array.of(0, 5, 22, 7))},
    {path: 'SiglusEngine.exe', source: probeSource(Uint8Array.of(0x4d, 0x5a))},
    {path: '1st_beat/._Scene.pck', source: probeSource(Uint8Array.of(0, 5, 22, 7))},
    {path: '1st_beat/Scene.pck', source: probeSource(Uint8Array.of(92, 0, 0, 0))},
    {path: '1st_beat/gameexe.dat', source: probeSource(Uint8Array.of(0))},
  ];
  assert.equal(siglusDirectory(nestedFiles), '1st_beat/');
  assert.equal(await isSiglusInstallation(nestedFiles), true);
  assert.equal(
    await isSiglusInstallation([
      {path: 'SiglusEngine.exe', source: probeSource(Uint8Array.of(0x4d, 0x5a))},
      {path: '1st_beat/Scene.pck', source: probeSource(Uint8Array.of(0, 0, 0, 0))},
      {path: '1st_beat/gameexe.dat', source: probeSource(Uint8Array.of(0))},
    ]),
    false,
  );
});

test('parseCgTable decodes CGTABLE2 with packedFlag=0 XOR+LZSS payloads and CGTABLE v1', () => {
  const literalLz = (raw) => {
    const body = [];
    for (let i = 0; i < raw.length; i += 8) {
      body.push(0xff);
      for (let j = 0; j < 8 && i + j < raw.length; j++) body.push(raw[i + j]);
    }
    const stream = new Uint8Array(8 + body.length);
    const dv = new DataView(stream.buffer);
    dv.setUint32(0, stream.length, true);
    dv.setUint32(4, raw.length, true);
    stream.set(body, 8);
    return stream;
  };

  const entry = new Uint8Array(60);
  entry.set(Buffer.from('EVAK_01A', 'ascii'), 0);
  const edv = new DataView(entry.buffer);
  edv.setInt32(32, 0, true);
  edv.setInt32(36, 1, true);
  edv.setInt32(40, 77, true);
  const payload = literalLz(entry);
  xorCycle(payload, cgmXor);
  const cgm = new Uint8Array(32 + payload.length);
  cgm.set(Buffer.from('CGTABLE2', 'ascii'), 0);
  const hdv = new DataView(cgm.buffer);
  hdv.setInt32(16, 1, true);
  hdv.setInt32(20, 0, true); // Angel Beats sets header[20..23]=0 on an XOR+LZSS CGTABLE2 payload
  cgm.set(payload, 32);

  const parsedV2 = parseCgTable(cgm);
  assert.equal(parsedV2.version, 2);
  assert.equal(parsedV2.byName.get('evak_01a'), 0);
  assert.deepEqual(parsedV2.entries[0].codes, [77]);

  const v1 = new Uint8Array(32 + 36);
  v1.set(Buffer.from('CGTABLE', 'ascii'), 0);
  const v1dv = new DataView(v1.buffer);
  v1dv.setInt32(16, 1, true);
  v1.set(Buffer.from('BG_00', 'ascii'), 32);
  v1dv.setInt32(64, 5, true);
  const parsedV1 = parseCgTable(v1);
  assert.equal(parsedV1.version, 1);
  assert.equal(parsedV1.byName.get('bg_00'), 5);
});

test('SiglusDbs supports hasRow, checkColumn, and typed linear-scan cell reads', () => {
  // Build a minimal UTF-16LE DBS table (2 rows, 2 cols: col 10='S', col 20='V')
  const rowCount = 2;
  const colCount = 2;
  const rowHeaderOffset = 28;
  const colHeaderOffset = rowHeaderOffset + rowCount * 4;
  const dataOffset = colHeaderOffset + colCount * 8;
  const stringTable = Buffer.from('Alpha\0Beta\0', 'utf16le');
  const stringOffset = dataOffset + rowCount * colCount * 4;
  const paddedLen = Math.ceil((stringOffset + stringTable.length) / 4) * 4;
  const plain = new Uint8Array(paddedLen);
  const pdv = new DataView(plain.buffer);
  pdv.setUint32(4, rowCount, true);
  pdv.setUint32(8, colCount, true);
  pdv.setUint32(12, rowHeaderOffset, true);
  pdv.setUint32(16, colHeaderOffset, true);
  pdv.setUint32(20, dataOffset, true);
  pdv.setUint32(24, stringOffset, true);
  pdv.setInt32(rowHeaderOffset, 100, true);
  pdv.setInt32(rowHeaderOffset + 4, 200, true);
  pdv.setInt32(colHeaderOffset, 10, true);
  pdv.setUint32(colHeaderOffset + 4, 'S'.charCodeAt(0), true);
  pdv.setInt32(colHeaderOffset + 8, 20, true);
  pdv.setUint32(colHeaderOffset + 12, 'V'.charCodeAt(0), true);
  pdv.setUint32(dataOffset, 0, true);
  pdv.setInt32(dataOffset + 4, 42, true);
  pdv.setUint32(dataOffset + 8, 12, true);
  pdv.setInt32(dataOffset + 12, 99, true);
  plain.set(stringTable, stringOffset);
  for (let i = 0; i < paddedLen / 4; i++) {
    const key = dbsMask[(Math.floor(i / 16) % 5) * 5 + ((i % 16) % 5)] >= 0x80 ? 0x7190c70e : 0x499bf135;
    pdv.setUint32(i * 4, (pdv.getUint32(i * 4, true) ^ key) >>> 0, true);
  }
  const lzBody = [];
  for (let i = 0; i < plain.length; i += 8) {
    lzBody.push(0xff);
    for (let j = 0; j < 8 && i + j < plain.length; j++) lzBody.push(plain[i + j]);
  }
  const raw = new Uint8Array(4 + 8 + lzBody.length);
  const rdv = new DataView(raw.buffer);
  rdv.setUint32(0, 1, true);
  rdv.setUint32(4, 8 + lzBody.length, true);
  rdv.setUint32(8, plain.length, true);
  raw.set(lzBody, 12);
  for (let i = 4; i + 4 <= raw.length; i += 4) {
    rdv.setUint32(i, (rdv.getUint32(i, true) ^ 0x89f4622d) >>> 0, true);
  }

  const dbs = new SiglusDbs(raw);
  assert.equal(dbs.hasRow(100), true);
  assert.equal(dbs.hasRow(200), true);
  assert.equal(dbs.hasRow(300), false);
  assert.equal(dbs.checkColumn(10), 1);
  assert.equal(dbs.checkColumn(20), 2);
  assert.equal(dbs.checkColumn(30), 0);
  assert.equal(dbs.getStr(200, 10), 'Beta');
  assert.equal(dbs.getNum(200, 20), 99);
});

test('SiglusVm dynamic list resize/clear/sets/init, checkpoints, and commandArity behave per native 1.1.80.8', async () => {
  const i32 = (v) => [v & 0xff, (v >>> 8) & 0xff, (v >>> 16) & 0xff, v >>> 24];
  const push = (form, value) => [0x02, ...i32(form), ...i32(value)];
  const pushInt = (value) => push(10, value);
  const pushStr = (index) => push(20, index);
  const elm = (...segments) => [0x08, ...segments.flatMap(pushInt)];
  const encodeArgs = (forms) => [
    ...i32(forms.length),
    ...forms.toReversed().flatMap((f) => (Array.isArray(f) ? [...i32(-1), ...encodeArgs(f)] : i32(f))),
  ];
  const cmd = (forms, retForm = 0) => [0x30, ...i32(0), ...encodeArgs(forms), ...i32(0), ...i32(retForm)];
  const assign = (lhsForm, rhsForm) => [0x20, ...i32(lhsForm), ...i32(rhsForm), ...i32(0)];
  const dec = (form, size) => [0x07, ...i32(form), ...i32(size)];

  const globalIntList = 0x7f000000;
  const globalStrList = 0x7f000001;
  const localIntList = 0x7d000000;
  const localIntRef = 0x7d000001;
  const localStrRef = 0x7d000002;
  const hostCalls = [];

  // Test scene: declared global intlist[2] and strlist[1], plus local intlist[3], sets/resize/clear/init
  const code = [
    ...pushInt(3), ...dec(11, 0), // L[0]: intlist size 3
    ...dec(10, 0), // L[1]: scratch int
    ...dec(20, 0), // L[2]: scratch str
    // globalIntList.sets(0, 10, 20, 30) & resize(4)
    ...elm(globalIntList, 1), ...pushInt(0), ...pushInt(10), ...pushInt(20), ...pushInt(30), ...cmd([10, 10, 10, 10]),
    ...elm(globalIntList, 2), ...pushInt(4), ...cmd([10]),
    // globalIntList.clear(1, 99, 7) (clamps end to size-1 = 3)
    ...elm(globalIntList, 8), ...pushInt(1), ...pushInt(99), ...pushInt(7), ...cmd([10, 10, 10]),
    // 2-arg clear fills with 0; reversed range (3, 1) is no-op
    ...elm(globalIntList, 8), ...pushInt(2), ...pushInt(2), ...cmd([10, 10]),
    ...elm(globalIntList, 8), ...pushInt(3), ...pushInt(1), ...pushInt(55), ...cmd([10, 10, 10]),
    // local intlist resize(2), sets(0, 5, 6), 2-arg clear(1, 1)
    ...elm(0x7c000000 - 0x7c000000 + 83), // placeholder replaced below via proper localRoot=83
  ];
  // Build clean bytecode cleanly with explicit localRoot = 83:
  const mainCode = Uint8Array.from([
    ...pushInt(3), ...dec(11, 0),
    // globalIntList.resize(4) & sets(0, 11, 22, 33, 44) & 3-arg clear(1, 99, 7) & 2-arg clear(2, 2) & no-op clear(3, 1, 99)
    ...elm(globalIntList, 2), ...pushInt(4), ...cmd([10]),
    ...elm(globalIntList, 1), ...pushInt(0), ...pushInt(11), ...pushInt(22), ...pushInt(33), ...pushInt(44), ...cmd([10, 10, 10, 10, 10]),
    ...elm(globalIntList, 8), ...pushInt(1), ...pushInt(99), ...pushInt(7), ...cmd([10, 10, 10]),
    ...elm(globalIntList, 8), ...pushInt(2), ...pushInt(2), ...cmd([10, 10]),
    ...elm(globalIntList, 8), ...pushInt(3), ...pushInt(1), ...pushInt(99), ...cmd([10, 10, 10]),
    // localIntList.resize(2) & clear(0, 1, 88) & clear(1, 1)
    ...elm(83, localIntList, 2), ...pushInt(2), ...cmd([10]),
    ...elm(83, localIntList, 8), ...pushInt(0), ...pushInt(1), ...pushInt(88), ...cmd([10, 10, 10]),
    ...elm(83, localIntList, 8), ...pushInt(1), ...pushInt(1), ...cmd([10, 10]),
    // globalStrList.resize(2), sets(0, 'A', 'B'), host report (command 999)
    ...elm(globalStrList, 2), ...pushInt(2), ...cmd([10]),
    ...elm(globalStrList, 1), ...pushInt(0), ...pushStr(0), ...pushStr(1), ...cmd([10, 20, 20]),
    // report sizes and elements via host cmd 999:
    ...elm(999),
    ...elm(globalIntList, 9), ...cmd([], 10),
    ...elm(globalIntList, -1, 0), [0x05],
    ...elm(globalIntList, -1, 1), [0x05],
    ...elm(globalIntList, -1, 2), [0x05],
    ...elm(globalIntList, -1, 3), [0x05],
    ...elm(83, localIntList, 9), ...cmd([], 10),
    ...elm(83, localIntList, -1, 0), [0x05],
    ...elm(83, localIntList, -1, 1), [0x05],
    ...elm(globalStrList, 4), ...cmd([], 10),
    ...elm(globalStrList, -1, 1), [0x05],
    ...cmd([10, 10, 10, 10, 10, 10, 10, 10, 10, 20]),
    // init globalStrList (3) and globalIntList (10) -> check reset sizes (2, 1)
    ...elm(globalIntList, 10), ...cmd([]),
    ...elm(globalStrList, 3), ...cmd([]),
    ...elm(998), ...elm(globalIntList, 9), ...cmd([], 10), ...elm(globalStrList, 4), ...cmd([], 10), ...cmd([10, 10]),
    0x15, ...i32(0), ...encodeArgs([]),
  ]);
  void code; void assign; void localIntRef; void localStrRef;

  const subCode = Uint8Array.from([
    0x01, ...i32(10),
    ...dec(10, 0),
    ...dec(20, 0),
    0x09,
    0x15, ...i32(0), ...encodeArgs([]),
  ]);
  const pack = {
    sceneNames: ['main'],
    properties: [11, 2, 21, 1],
    propertyNames: ['g_ints', 'g_strs'],
    commands: [],
    commandNames: [],
    commandScenes: [],
    scene: () => ({
      name: 'main',
      code: mainCode,
      strings: ['Alpha', 'Beta'],
      labels: [0, subCode],
      entries: [0],
      properties: [],
      commands: [mainCode.length],
      commandNames: ['local_two_args'],
    }),
  };
  // Put subCode cleanly at an offset inside combined code buffer for commandArity test
  const combined = Uint8Array.from([...mainCode, ...subCode]);
  pack.scene = () => ({
    name: 'main',
    code: combined,
    strings: ['Alpha', 'Beta'],
    labels: [0],
    entries: [0],
    properties: [],
    commands: [mainCode.length],
    commandNames: ['local_two_args'],
  });

  let savedCheckpoint;
  const vm = new SiglusVm(
    pack,
    {
      command: async (c) => {
        if (c.path[0] === 999) {
          savedCheckpoint = vm.checkpoint(0);
          hostCalls.push({cmd: 999, args: c.args});
        } else if (c.path[0] === 998) {
          hostCalls.push({cmd: 998, args: c.args});
        }
        return 0;
      },
      property: () => undefined,
      message: () => {},
      trace: () => {},
    },
    new AbortController().signal,
  );
  assert.equal(vm.commandArity('main', 'local_two_args'), 2);
  await vm.run('main', 0);
  assert.deepEqual(hostCalls[0], {cmd: 999, args: [4, 11, 7, 0, 7, 2, 88, 0, 2, 'Beta']});
  assert.deepEqual(hostCalls[1], {cmd: 998, args: [2, 1]});
  assert.deepEqual(savedCheckpoint.declaredListSizes, [['2130706432', 4], ['2130706433', 2]]);
  assert.deepEqual(savedCheckpoint.frames[0].localListSizes, [[0, 2]]);
});

test('parseSiglusCompositeSpec and layoutSiglusCompositeLayers match 1.1.80.8 whitespace and center alignment', () => {
  const parsed = parseSiglusCompositeSpec(
    ' bs_base ( +4 , -2 , 1 , blend = 2 ) | bs_face(10, 20) ',
  );
  assert.equal(parsed.explicitDim, undefined);
  assert.equal(parsed.layers.length, 2);
  assert.deepEqual(parsed.layers[0], {
    part: 'bs_base ( +4 , -2 , 1 , blend = 2 )',
    name: 'bs_base',
    dx: 4,
    dy: -2,
    pattern: 1,
    blend: '2',
  });
  assert.deepEqual(parsed.layers[1], {
    part: 'bs_face(10, 20)',
    name: 'bs_face',
    dx: 10,
    dy: 20,
    pattern: 0,
    blend: undefined,
  });

  const layout = layoutSiglusCompositeLayers([
    {frame: {width: 400, height: 600, x: 0, y: 0, centerX: 200, centerY: 100}, dx: 4, dy: -2},
    {frame: {width: 100, height: 80, x: 5, y: 3, centerX: 50, centerY: 40}, dx: 10, dy: 20},
  ]);
  assert.equal(layout.baseCenterX, 200);
  assert.equal(layout.baseCenterY, 100);
  assert.deepEqual(layout.placements, [
    {drawX: 4, drawY: -2},
    {drawX: 165, drawY: 83}, // dx(10) + baseCenterX(200) + x(5) - centerX(50)
  ]);

  const explicit = parseSiglusCompositeSpec('( 800 , 600 ) | part ( -10 , +5 )');
  assert.deepEqual(explicit.explicitDim, {width: 800, height: 600});
  const explicitLayout = layoutSiglusCompositeLayers(
    [{frame: {width: 100, height: 50, x: 2, y: 4, centerX: 30, centerY: 10}, dx: -10, dy: 5}],
    explicit.explicitDim,
  );
  assert.deepEqual([explicitLayout.width, explicitLayout.height], [800, 600]);
  assert.deepEqual(explicitLayout.placements, [{drawX: -38, drawY: -1}]);
});

test('SiglusConfiguration falls back to built-in Japanese dialogs 115 and 124 when PE resources are encrypted or missing', async () => {
  const garbageExe = new BlobSource(new Blob([Uint8Array.from({length: 512}, (_, i) => i & 0xff)]));
  const cfg = new SiglusConfiguration({}, garbageExe, new AbortController().signal);
  const autoTmpl = await cfg.template(115);
  const movieTmpl = await cfg.template(124);
  assert.ok(autoTmpl.items.some((item) => item.id === 1177) && autoTmpl.items.some((item) => item.id === 1176));
  assert.ok(movieTmpl.items.some((item) => item.id === 1164) && movieTmpl.items.some((item) => item.id === 1165));
});

test('SiglusPlayer commits wait=0 wipe synchronously before async display, supports audio wait commands, and tolerates missing child parents', async () => {
  const childObj = {
    type: 2,
    name: 'bs2_yr0101_01',
    frames: [],
    x: 0,
    y: 0,
    visible: true,
    layer: 0,
    order: 0,
    transparency: 255,
    pattern: 0,
  };
  const backParent = {
    type: 0,
    name: '',
    frames: [],
    x: 0,
    y: 0,
    visible: true,
    layer: 0,
    order: 0,
    transparency: 255,
    pattern: 0,
    wipeCopy: true,
    button: {id: 1, group: 3},
    children: new Map([[0, childObj]]),
  };
  let releaseShow;
  let finishedWipe = false;
  let renderedGroups;
  const audioLog = [];
  const unhandledProperties = new Map();
  const display = {
    finishWipe() {
      finishedWipe = true;
    },
    closeMessage() {},
    syncObjectButtonGroups: (groups) => (renderedGroups = [...groups]),
    show: () => new Promise((resolve) => { releaseShow = resolve; }),
  };
  const player = Object.assign(Object.create(SiglusPlayer.prototype), {
    controller: new AbortController(),
    objects: [new Map(), new Map([[12, backParent]])],
    usesWipeCopy: true,
    activeGroups: new Set(),
    cancelGroups: new Set(),
    backButtonGroups: new Map(),
    decisions: new Map(),
    frameActions: new Map(),
    frameActionCounters: new Map(),
    pendingButtonCalls: [],
    currentCast: [],
    currentCastCostumes: [],
    pageVoices: [],
    unhandledProperties,
    unhandledCommands: new Map(),
    display,
    systemOption: () => false,
    releaseUnusedObjectMovies: () => {},
    audio: {
      bgmStart: (...args) => audioLog.push(['bgmStart', ...args]),
      resumeBgm: (...args) => audioLog.push(['resumeBgm', ...args]),
      pcmStart: (...args) => audioLog.push(['pcmStart', ...args]),
      resumePcm: (...args) => audioLog.push(['resumePcm', ...args]),
    },
    waitAudio: async (...args) => { audioLog.push(['waitAudio', ...args]); return 0; },
    recordBgmListened: () => {},
  });

  // 1. wait=0 wipe (named=[8], args=[0, 250, 0]) commits front objects[0][12] and clears back immediately
  await player.command({path: [37, 6, -1, 3, 2], args: [], named: []});
  await player.command({path: [37, 2, -1, 12, 115, 1], args: [5], named: []});
  assert.equal(player.activeGroups.has(3), false);
  await player.command({path: [7], args: [0, 250, 0], named: [8], scene: 't', line: 1, pc: 0, name: ''});
  assert.ok(finishedWipe);
  assert.deepEqual(renderedGroups, [3]);
  assert.equal(player.backButtonGroups.size, 0);
  assert.equal(await player.command({path: [38, 2, -1, 12, 115, 2], args: [], named: []}), 5);
  assert.equal(serializeDrawObject(player.objects[0].get(12)).frameActionChannelCount, 5);
  assert.equal(player.objects[1].size, 0);
  assert.equal(await player.objectCommand({path: [38, 2, -1, 12, 93, -1, 0, 62], args: [], named: []}), 'bs2_yr0101_01');
  // Calling wipe_end or resolving previous show does not clobber front[12]
  releaseShow();
  await player.pendingWipe;
  assert.equal(player.objects[0].get(12).children.get(0).name, 'bs2_yr0101_01');

  // 2. Missing parent .child traversal returns "" / 0 and write returns value without allocating or recording unhandledProperties
  assert.equal(await player.objectCommand({path: [38, 2, -1, 99, 93, -1, 0, 62], args: [], named: []}), '');
  assert.equal(player.property([38, 2, -1, 99, 93, -1, 0, 27]), 0);
  assert.equal(player.property([38, 2, -1, 99, 93, -1, 0, 27], 128), 128);
  assert.equal(player.property([38, 2, -1, 99, 93, -1, 0, 27]), 0);
  assert.equal(player.objects[0].has(99), false);
  assert.equal(unhandledProperties.size, 0);

  // 3. Native 1.1.80.8 audio wait commands (42.2, 42.12, 44.-1.*.1, 44.-1.*.17)
  await player.command({path: [42, 2], args: ['bgm01', 100, 50], named: [], scene: 't', line: 2, pc: 0, name: ''});
  await player.command({path: [42, 12], args: [120], named: [], scene: 't', line: 3, pc: 0, name: ''});
  await player.command({path: [44, -1, 3, 1], args: ['se01', 40], named: [], scene: 't', line: 4, pc: 0, name: ''});
  await player.command({path: [44, -1, 3, 17], args: [60], named: [], scene: 't', line: 5, pc: 0, name: ''});
  assert.deepEqual(audioLog, [
    ['bgmStart', 'bgm01', false, 100, 50],
    ['waitAudio', 'bgm', false],
    ['resumeBgm', 120],
    ['waitAudio', 'bgm', false],
    ['pcmStart', 3, {loop: false, resource: 'se01'}, false, 40],
    ['waitAudio', 'pcm3', false],
    ['resumePcm', 3, 60],
    ['waitAudio', 'pcm3', false],
  ]);
});

test('Native 1.1.141.3 dialogue wait (64.48/64.51/64.21/64.22), skip/auto flags (64.0..86), and hover-sound deduplication', async () => {
  const {SiglusPlayer} = await import('../dist/engines/siglus/player.js');
  const {SiglusDisplay} = await import('../dist/engines/siglus/display.js');

  // 1. 64.51 (async_msg_mode_once) + 64.48 (set_skip_trigger) before dialogue MUST NOT skip waitAtPage()
  let waitCount = 0;
  const player = Object.assign(Object.create(SiglusPlayer.prototype), {
    controller: new AbortController(),
    root: {dataset: {}},
    game: {config: new Map()},
    display: {
      messageWindow: 0,
      finishMessageSlide: () => {},
      saveMessage: () => ({index: 0, name: '麦', text: [{text: '「よし」'}], voices: []}),
    },
    audio: {stop: () => {}, channelState: () => 0},
    readFlags: new Map(),
    pageReadFlags: [],
    pageVoices: [],
    backlog: [],
    historyPoints: new Map(),
    messageFaces: new Map(),
    unhandledCommands: new Map(),
    objectsDirty: false,
    pendingText: true,
    pages: 0,
    saveEnabled: false,
    loadEnabled: false,
    skip: false,
    readSkipEnabled: false,
    skipAllowed: true,
    systemSkipDisabled: false,
    skipTriggerArmed: false,
    skipTriggerFired: false,
    msgAsyncMode: false,
    msgAsyncModeOnce: false,
    keyWaitDisabled: false,
    autoEnabled: true,
    scriptAutoMode: false,
    scriptAutoModeMojiWait: -1,
    scriptAutoModeMinWait: -1,
    scriptMwndOpenAnimeForce: false,
    scriptFlag10: false,
    endMsgByKeyDisabled: false,
    autoModeMojiCnt: 0,
    systemOption: () => false,
    tracePage: () => {},
    addHistory: () => {},
    waitAtPage: async () => {
      waitCount++;
    },
  });

  await player.command({path: [64, 51], args: [], named: [], scene: '010', line: 126, pc: 0, name: ''});
  await player.command({path: [64, 48], args: [], named: [], scene: '010', line: 126, pc: 0, name: ''});
  assert.equal(player.msgAsyncMode, true);
  assert.equal(player.msgAsyncModeOnce, true);
  assert.equal(player.skipTriggerArmed, true);
  assert.equal(player.skipTriggerFired, false);
  assert.equal(player.skipping, false, '64.48 alone must NEVER enable fast-forward skip mode');
  await player.pageInput(false);
  assert.equal(waitCount, 1, '64.51 + 64.48 must still stop at waitAtPage() for user input');
  assert.equal(player.skipTriggerArmed, false, 'entering key-wait disarms 64.48 (+0x378)');
  assert.equal(player.msgAsyncMode, false, 'one-shot async_msg_mode clears on page end');
  assert.equal(player.msgAsyncModeOnce, false);

  // 2. Persistent async_msg_mode (64.21/64.22) survives page end until 64.22
  await player.command({path: [64, 21], args: [], named: [], scene: '010', line: 127, pc: 0, name: ''});
  await player.pageInput(false);
  assert.equal(waitCount, 2);
  assert.equal(player.msgAsyncMode, true);
  await player.command({path: [64, 22], args: [], named: [], scene: '010', line: 128, pc: 0, name: ''});
  assert.equal(player.msgAsyncMode, false);

  // 3. 64.0/64.1 script auto mode does not clobber user autoEnabled; 64.60..65 manage script timings
  await player.command({path: [64, 0], args: [], named: [], scene: '010', line: 130, pc: 0, name: ''});
  assert.equal(player.scriptAutoMode, true);
  assert.equal(player.autoEnabled, true);
  await player.command({path: [64, 1], args: [], named: [], scene: '010', line: 131, pc: 0, name: ''});
  assert.equal(player.scriptAutoMode, false);
  assert.equal(player.autoEnabled, true, '64.1 must preserve user autoEnabled');
  await player.command({path: [64, 60], args: [45], named: [], scene: '010', line: 132, pc: 0, name: ''});
  await player.command({path: [64, 61], args: [800], named: [], scene: '010', line: 133, pc: 0, name: ''});
  assert.equal(await player.command({path: [64, 64], args: [], named: [], scene: '010', line: 134, pc: 0, name: ''}), 45);
  assert.equal(await player.command({path: [64, 65], args: [], named: [], scene: '010', line: 135, pc: 0, name: ''}), 800);
  await player.command({path: [64, 62], args: [], named: [], scene: '010', line: 136, pc: 0, name: ''});
  await player.command({path: [64, 63], args: [], named: [], scene: '010', line: 137, pc: 0, name: ''});
  assert.equal(await player.command({path: [64, 64], args: [], named: [], scene: '010', line: 138, pc: 0, name: ''}), -1);
  assert.equal(await player.command({path: [64, 65], args: [], named: [], scene: '010', line: 139, pc: 0, name: ''}), -1);

  // 4. Native 0x62f0a0 / 0x62f000: skip_disable (64.2/5/83/85) blocks only skipTriggerFired, ctrl_disable (64.6/7/84/86) blocks all
  player.skipTriggerFired = true;
  assert.equal(player.skipping, true);
  assert.equal(await player.command({path: [64, 18], args: [], named: [], scene: '010', line: 140, pc: 0, name: ''}), 1);
  await player.command({path: [64, 2], args: [], named: [], scene: '010', line: 141, pc: 0, name: ''});
  assert.equal(await player.command({path: [64, 83], args: [], named: [], scene: '010', line: 142, pc: 0, name: ''}), 1);
  assert.equal(player.skipping, false, '64.2 blocks skipTriggerFired');
  player.skip = true;
  assert.equal(player.skipping, true, '64.2 does not block physical Ctrl skip');
  await player.command({path: [64, 6], args: [], named: [], scene: '010', line: 143, pc: 0, name: ''});
  assert.equal(await player.command({path: [64, 84], args: [], named: [], scene: '010', line: 144, pc: 0, name: ''}), 1);
  assert.equal(player.skipping, false, '64.6 blocks Ctrl skip as well');
  await player.command({path: [64, 4], args: [1], named: [], scene: '010', line: 145, pc: 0, name: ''});
  assert.equal(await player.command({path: [64, 16], args: [], named: [], scene: '010', line: 146, pc: 0, name: ''}), 1);
  await player.command({path: [64, 10], args: [1], named: [], scene: '010', line: 147, pc: 0, name: ''});
  assert.equal(await player.command({path: [64, 24], args: [], named: [], scene: '010', line: 148, pc: 0, name: ''}), 1);
  await player.command({path: [64, 49], args: [], named: [], scene: '010', line: 149, pc: 0, name: ''});
  await player.pageInput(false);
  assert.equal(waitCount, 2, '64.49 (+0x499) suppresses key-wait until 64.50 clears it');
  await player.command({path: [64, 50], args: [], named: [], scene: '010', line: 150, pc: 0, name: ''});
  assert.equal(player.unhandledCommands.size, 0);

  // 5. SiglusDisplay hover-sound deduplication across DOM layer rebuilds
  const sounds = [];
  const display = Object.assign(Object.create(SiglusDisplay.prototype), {
    hoveredControlKey: undefined,
    onButtonSound: (seNo, kind) => sounds.push([seNo, kind]),
  });
  const inertBtn = {isConnected: true, closest: (sel) => (sel === '[inert]' ? {} : null)};
  const detachedBtn = {isConnected: false, closest: () => null};
  const liveBtn = {isConnected: true, closest: () => null};
  // Initial hover plays once
  display.enterButtonHover('obj:stage:0:1', 0);
  // Layer rebuild marks old node inert and detaches it, then new node fires synthetic pointerenter
  display.leaveButtonHover('obj:stage:0:1', inertBtn);
  display.leaveButtonHover('obj:stage:0:1', detachedBtn);
  display.enterButtonHover('obj:stage:0:1', 0);
  display.enterButtonHover('obj:stage:0:1', 0);
  assert.deepEqual(sounds, [[0, 'hit']], 'Stationary hover across DOM rebuilds must play hit sound once');
  // Genuine pointerleave on live node clears key; re-entering plays hit sound once again
  display.leaveButtonHover('obj:stage:0:1', liveBtn);
  display.enterButtonHover('obj:stage:0:1', 0);
  // Moving directly to another button plays its hit sound once
  display.enterButtonHover('obj:stage:0:2', 1);
  assert.deepEqual(sounds, [
    [0, 'hit'],
    [0, 'hit'],
    [1, 'hit'],
  ]);
});

test('Transition smoothness: evalObjectIntEvent, non-blocking wipe preservation, back-stage re-anchoring, and copyObject cloning', async () => {
  const {SiglusDisplay, evalObjectIntEvent} = await import('../dist/engines/siglus/display.js');
  const {SiglusPlayer} = await import('../dist/engines/siglus/player.js');

  // 1. evalObjectIntEvent: one-shot linear/ease-in/ease-out, delay, loop, and turn (ping-pong)
  const oneShot = {mode: 0, from: 0, target: 100, duration: 200, delay: 50, easing: 0, started: 1000, endAt: 1250};
  assert.equal(evalObjectIntEvent(oneShot, 1020), 0);
  assert.equal(evalObjectIntEvent(oneShot, 1150), 50);
  assert.equal(evalObjectIntEvent(oneShot, 1250), undefined);
  const easeIn = {...oneShot, easing: 1};
  assert.equal(evalObjectIntEvent(easeIn, 1150), 25);
  const easeOut = {...oneShot, easing: 2};
  assert.equal(evalObjectIntEvent(easeOut, 1150), 75);
  const loopEv = {mode: 1, from: 10, target: 110, duration: 100, delay: 0, easing: 0, started: 0, endAt: Infinity};
  assert.equal(evalObjectIntEvent(loopEv, 150), 60);
  const turnEv = {mode: 2, from: 0, target: 100, duration: 100, delay: 0, easing: 0, started: 0, endAt: Infinity};
  assert.equal(evalObjectIntEvent(turnEv, 50), 50);
  assert.equal(evalObjectIntEvent(turnEv, 125), 75);
  assert.equal(evalObjectIntEvent(turnEv, 175), 25);

  // 2. refreshObjects() updates activeWipeLayer in place without aborting a running wait=0 wipe
  let finishedWipe = false;
  let replacedInPlace = null;
  let syncedHover = false;
  const oldChild = {inert: false};
  const wipingLayer = {
    isConnected: true,
    children: [oldChild],
    replaceChildren: (...nodes) => {
      replacedInPlace = nodes;
    },
  };
  const display = Object.assign(Object.create(SiglusDisplay.prototype), {
    wipe: {playState: 'running', finish: () => (finishedWipe = true)},
    activeWipeLayer: wipingLayer,
    objectLayer: undefined,
    stageGeneration: 7,
    refreshGeneration: 0,
    drawObjects: async () => ({children: ['updated-node']}),
    preserveStageFocus: (fn) => fn(),
    syncHoverAfterDomUpdate: () => (syncedHover = true),
    replaceLayer: async () => {
      throw new Error('refreshObjects must not call replaceLayer/finishWipe during an active wipe');
    },
  });
  await display.refreshObjects([], () => {});
  assert.equal(finishedWipe, false);
  assert.equal(display.stageGeneration, 7, 'in-place wipe refresh must not invalidate show() stageGeneration');
  assert.equal(oldChild.inert, true);
  assert.deepEqual(replacedInPlace, ['updated-node']);
  assert.equal(display.objectLayer, wipingLayer);
  assert.equal(syncedHover, true);

  // 3. copyObject deep-clones animation event objects & reanchorObjectEvents re-anchors back-stage timestamps
  const player = Object.create(SiglusPlayer.prototype);
  const srcObj = {
    name: 'sprite',
    frames: [],
    x: 10,
    y: 20,
    visible: true,
    pattern: 0,
    opacityStarted: 100,
    movement: [50, 200, 0, 2, 0],
    movementStarted: 100,
    horizontalMotion: {from: 0, duration: 200, delay: 0, easing: 0, started: 100},
    positionEvents: {x: {from: 0, started: 100, time: {duration: 200, delay: 0}}},
    scaleEvents: {y: {from: 500, started: 100, time: {duration: 300, delay: 0}}},
    intEvents: new Map([['ch:75', {mode: 0, from: 0, target: 255, duration: 200, delay: 50, easing: 0, started: 100, endAt: 350}]]),
  };
  const cloned = player.copyObject(srcObj);
  player.reanchorObjectEvents(cloned, 500);
  assert.equal(cloned.opacityStarted, 500);
  assert.equal(cloned.movementStarted, 500);
  assert.equal(cloned.horizontalMotion.started, 500);
  assert.equal(cloned.positionEvents.x.started, 500);
  assert.equal(cloned.scaleEvents.y.started, 500);
  assert.equal(cloned.intEvents.get('ch:75').started, 500);
  assert.equal(cloned.intEvents.get('ch:75').endAt, 750);
  assert.equal(srcObj.positionEvents.x.started, 100, 're-anchoring clone must not mutate source object');
  assert.equal(srcObj.scaleEvents.y.started, 100);
  assert.equal(srcObj.horizontalMotion.started, 100);
});

test('Multi-subsystem audit regressions: audio Firefox/fade/duck, VM post-jump/lists/GOSUBSTR, CGTABLE CP932, Gameexe BOM, screen dialog 127, and player/display fixes', async () => {
  const {SiglusAudio} = await import('../dist/engines/siglus/audio.js');
  const {SiglusDisplay} = await import('../dist/engines/siglus/display.js');
  const {SiglusPlayer} = await import('../dist/engines/siglus/player.js');
  const {SiglusVm} = await import('../dist/engines/siglus/vm.js');
  const {parseCgTable} = await import('../dist/formats/siglus/cgtable.js');
  const {SiglusConfiguration} = await import('../dist/engines/siglus/configuration.js');
  const {SiglusScenePack} = await import('../dist/formats/siglus/scene-pack.js');
  const {encodeCp932} = await import('../dist/text/cp932.js');

  // 1. CGTABLE: NUL-terminated magic (ignoring garbage after NUL) + CP932 Japanese CG name decoding
  const cgm = new Uint8Array(32 + 36);
  cgm.set(Buffer.from('CGTABLE\0JUNKDATA'), 0);
  const cgmView = new DataView(cgm.buffer);
  cgmView.setInt32(16, 1, true); // count = 1
  cgmView.setInt32(20, 0, true); // unpacked
  const jpNameBytes = encodeCp932('イベント01');
  cgm.set(jpNameBytes, 32);
  cgmView.setInt32(32 + 32, 7, true);
  const parsedCgm = parseCgTable(cgm);
  assert.equal(parsedCgm.version, 1);
  assert.equal(parsedCgm.entries[0].name, 'イベント01');
  assert.equal(parsedCgm.byName.get('イベント01'), 7);

  // 2. SiglusAudio: Firefox fallback (no cancelAndHoldAtTime), anchored stopActiveChannel fade,
  //    hard stop cancelling fading sources, and volumeType applying character voice mute/level.
  const ops = [];
  const fakeParam = {
    value: 0.75,
    cancelScheduledValues(t) {
      ops.push(['cancelScheduled', t]);
    },
    setValueAtTime(v, t) {
      ops.push(['set', v, t]);
    },
    linearRampToValueAtTime(v, t) {
      ops.push(['ramp', v, t]);
    },
  };
  let stoppedAt = [];
  const fakeSource = {
    stop(t) {
      stoppedAt.push(t);
    },
  };
  const audio = Object.assign(Object.create(SiglusAudio.prototype), {
    context: {currentTime: 10},
    playing: new Map([
      [
        'bgm',
        {
          source: fakeSource,
          gain: {gain: fakeParam},
          kind: 'BGM',
          startsAt: 1,
          duration: 100,
          loop: true,
        },
      ],
    ]),
    fading: new Map(),
    fadeEnds: new Map(),
    channelLevels: new Map(),
    levels: new Map(),
    soundLevels: new Map(),
    disabled: new Set(),
    characterLevels: new Map([[3, 128]]),
    mutedCharacters: new Set([4]),
    config: new Map(),
    voiceDuck: 1,
    voiceDuckingActive: false,
  });
  audio.setChannelLevel('bgm', 128, 500);
  assert.equal(ops[0][0], 'cancelScheduled', 'Firefox fallback must not require cancelAndHoldAtTime');
  assert.equal(ops[1][0], 'set');
  assert.equal(ops[2][0], 'ramp');
  ops.length = 0;
  audio.stopActiveChannel('bgm', 1000);
  assert.equal(ops[0][0], 'cancelScheduled', 'fade-out must anchor at currentTime before ramping to 0');
  assert.equal(ops[1][0], 'set');
  assert.deepEqual(ops[2], ['ramp', 0, 11]);
  assert.equal(audio.fading.get('bgm')?.size, 1);
  // Hard stop(0) immediately stops fading-out source and clears fadeEnds
  audio.stopActiveChannel('bgm', 0);
  assert.equal(stoppedAt.at(-1), 10);
  assert.equal(audio.fadeEnds.has('bgm'), false);
  // Character mute/level applies even when volumeType !== 1
  const volMuted = audio.playbackVolume('pcm0', 'PCM', 4, 2, false);
  const volHalf = audio.playbackVolume('pcm0', 'PCM', 3, 2, false);
  const volFull = audio.playbackVolume('pcm0', 'PCM', 5, 2, false);
  assert.equal(volMuted, 0);
  assert.ok(volHalf > 0 && volHalf < volFull);

  // 3. SiglusDisplay: virtualKeyState(vk, 5) consumes vkReleased (not vkDown), editBox missing-id returns safe defaults,
  //    and setScreenEffect uses SVG color matrix instead of effectTint.
  let filterApplied = '';
  const display = Object.assign(Object.create(SiglusDisplay.prototype), {
    vkDown: new Set([38]),
    vkPressed: new Set(),
    vkReleased: new Set([40]),
    edits: new Map(),
    effectTint: {style: {display: ''}},
    sceneLayers: {
      style: {
        get filter() {
          return filterApplied;
        },
        set filter(v) {
          filterApplied = v;
        },
      },
    },
    colorFilterUrl: (m) => `url(#cm:${m.slice(0, 8)})`,
    appendColorMatrix: () => {},
  });
  assert.equal(display.virtualKeyState(38, 5), 0, 'held key without release must return 0 for command 5');
  assert.equal(display.virtualKeyState(40, 5), 1, 'released key must return 1 once for command 5');
  assert.equal(display.virtualKeyState(40, 5), 0);
  assert.equal(display.editBox(99, 3, () => 0, () => ''), '');
  assert.equal(display.editBox(99, 4, () => 0, () => ''), 0);
  assert.equal(display.editBox(99, 5, () => 0, () => ''), 0);
  display.setScreenEffect({mono: 0, reverse: 0, bright: 0, dark: 0, colorR: 0, colorG: 0, colorB: 0, colorRate: 0, addR: 40, addG: 20, addB: 0});
  assert.equal(display.effectTint.style.display, 'none', 'setScreenEffect must not use isolated effectTint overlay');
  assert.ok(filterApplied.startsWith('url(#cm:'), 'setScreenEffect must use SVG color matrix filter');

  // 4. SiglusConfiguration: fallback screen dialog template (127) resolves without SiglusEngine.exe
  const configUi = new SiglusConfiguration({}, undefined, new AbortController().signal);
  const screenTpl = await configUi.template(127);
  assert.ok(screenTpl.items.some((item) => item.id === 1166));
  assert.ok(screenTpl.items.some((item) => item.id === 1036));

  // 5. SiglusPlayer: counter.set preserves stopped state, cgtable counts unique flagNo,
  //    get_save_new_no(start) works with 1 arg, and runSelbtn returns -1 when all items are disabled.
  const player = Object.assign(Object.create(SiglusPlayer.prototype), {
    sceneCounters: new Map(),
    cgTable: new Map([
      ['cg_01a', 1],
      ['cg_01b', 1],
      ['cg_02a', 2],
    ]),
    cgFlags: new Set([1, 2]),
    saves: new Map([
      [5, {timestamp: 100}],
      [12, {timestamp: 200}],
    ]),
    quickSaves: new Map(),
    namaeAliases: new Map(),
    namaeIds: new Map(),
    namaeValues: new Map(),
    renderObjects: async () => {},
    controller: new AbortController(),
    system: new Map([[0, 1]]),
    game: {saveKey: 'test-siglus', config: new Map()},
  });
  player.counter(player.sceneCounters, 0, 0, [500]);
  assert.equal(player.counter(player.sceneCounters, 0, 14, []), 0, 'counter.set on unstarted counter must stay stopped');
  assert.equal(player.counter(player.sceneCounters, 0, 1, []), 500);
  assert.equal(player.newestSlot(player.saves, 5, Infinity), 12);
  const selResult = await player.runSelbtn(
    {
      scene: 'test',
      offset: 0,
      line: 1,
      path: [76],
      args: [
        ['Only disabled', 2, -1],
        ['Hidden spacer', 3, -1],
      ],
      named: [],
    },
    false,
  );
  assert.equal(selResult, -1, 'non-cancelable selbtn with zero enabled items must return -1 instead of softlocking');

  // 6. SiglusVm: activeFrame() resolves post-jump frame for assign/readIntList/writeIntList
  const preJump = {scene: {name: 'boot', properties: []}, locals: new Map(), references: new Map(), declarations: new Map()};
  const postJump = {scene: {name: 'story', properties: []}, locals: new Map(), references: new Map(), declarations: new Map()};
  const vm = Object.assign(Object.create(SiglusVm.prototype), {
    frames: [preJump],
    sceneJumps: new WeakMap([[preJump, postJump]]),
    globals: new Map(),
    pack: {properties: []},
    services: {property: () => undefined},
  });
  vm.assign([83, 0, -1, 2], 42);
  assert.equal(postJump.locals.get('83.0.-1.2'), 42);
  assert.equal(preJump.locals.get('83.0.-1.2'), undefined);
  vm.writeIntList([83, 0], 5, [11, 22]);
  assert.deepEqual(vm.readIntList([83, 0], 5, 2), [11, 22]);
});
