import assert from 'node:assert/strict';
import test from 'node:test';
import {SiglusAudio, siglusVolumeGain} from '../dist/engines/siglus/audio.js';
import {SiglusDisplay, serializeDrawObject} from '../dist/engines/siglus/display.js';
import {parseMwndLayout, computeWakuButtonOrigin} from '../dist/engines/siglus/mwnd.js';
import {SiglusPlayer} from '../dist/engines/siglus/player.js';
import {SiglusVm} from '../dist/engines/siglus/vm.js';
import {g00MaskValues, proceduralWipeMask, selectPcmEventIndex, wipeSoftness} from '../dist/engines/siglus/wipe.js';
import {parseCgTable} from '../dist/formats/siglus/cgtable.js';
import {unpackSiglusLz, xorByteInPlace, xorCycle} from '../dist/formats/siglus/compression.js';
import {SiglusDbs} from '../dist/formats/siglus/dbs.js';
import {G00Image} from '../dist/formats/siglus/g00.js';
import {cgmXor, dbsMask} from '../dist/formats/siglus/tables.js';

function mulberry32(seed) {
  let a = seed >>> 0;
  return () => {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function makeBaseObject(overrides = {}) {
  return {
    name: 'sprite_a',
    frames: [],
    x: 0,
    y: 0,
    visible: true,
    pattern: 0,
    transparency: 255,
    ...overrides,
  };
}

function makeMockPlayer(overrides = {}) {
  const config = new Map([
    ['SCREEN_SIZE', '1920, 1080'],
    ['OBJECT.CNT', '64'],
    ['MWND.CNT', '2'],
    ['MWND.000.WAKU_NO', '0'],
    ['WAKU.000.BTN.000.TYPE', '"save"'],
    ['WAKU.000.BTN.001.TYPE', '"load"'],
    ['SAVE.CNT', '10'],
    ['QUICK_SAVE.CNT', '5'],
    ['JOYPAD.ALLOW_JOYPAD_MODE', '1'],
  ]);
  const display = Object.assign(Object.create(SiglusDisplay.prototype), {
    config,
    width: 1920,
    height: 1080,
    windowIndex: 0,
    messageTextColors: new Map(),
    messageButtonStates: new Map(),
    currentText: [],
    activeFrameActions: [],
    frameActionsByWaku: new Map(),
    message: {hidden: false, style: {}},
    buttonState: () => -1,
    objectGraphic: async (name, pat = 0) => ({name, width: 64, height: 48, pattern: pat}),
    graphicCutCount: async () => 4,
    setMessageFont() {},
    finishMessageSlide() {},
    clearText() {},
    setMessageSlide() {},
    selectMessageWindow() {},
    setTextSize() {},
    name() {},
    pageControls() {},
    clearSystemObjects() {},
    syncObjectButtonGroups() {},
  });
  return Object.assign(Object.create(SiglusPlayer.prototype), {
    game: {config, pack: {commandNames: [], commandScenes: [], sceneNames: ['main']}},
    display,
    objects: [new Map(), new Map()],
    systemObjects: new Map(),
    systemBackObjects: new Map(),
    excallAllocated: false,
    systemCallDepth: 0,
    excallJoypadModeOverride: -1,
    joypadModeOverride: -1,
    messageFont: {name: 'Default', bold: false, shadow: 0},
    activeGroups: new Set(),
    cancelGroups: new Set(),
    groupProps: new Map(),
    excallFlags: new Map(),
    sceneCounters: new Map(),
    systemCounters: new Map(),
    frameActions: new Map(),
    frameActionCounters: new Map(),
    pendingFrameWatchers: new Set(),
    pendingButtonCalls: [],
    decisions: new Map(),
    messageFaces: new Map(),
    namaeIds: new Map(),
    namaeValues: new Map(),
    namaeAliases: new Map(),
    saves: new Map(),
    quickSaves: new Map(),
    endSaves: new Map(),
    innerSaves: new Map(),
    selectionSaves: [],
    selectionReturnFlags: [true, true],
    disabledMessageButtons: new Set(),
    mwndBtnTouchEnabled: true,
    hideMwndEnabled: true,
    historyOpen: false,
    renderObjects: async () => {},
    delay: async () => 0,
    pruneDeadButtonGroups() {},
    releaseUnusedObjectMovies() {},
    ...overrides,
  });
}

test('Stateful interaction: seeded object + intEvent + wipe + save/load round-trip preserves mid-animation state', async () => {
  const rng = mulberry32(0x51610501);
  const player = makeMockPlayer();
  const call = (path, ...args) => player.command({path, args, named: []});

  for (let seedStep = 0; seedStep < 25; seedStep++) {
    const objId = Math.floor(rng() * 8);
    const x = Math.floor(rng() * 1200) - 200;
    const y = Math.floor(rng() * 800) - 100;
    const tr = Math.floor(rng() * 256);
    const duration = 200 + Math.floor(rng() * 800);

    // Mutate story front object (38.2.-1.<objId>.*)
    const obj = makeBaseObject({x, y, transparency: tr, sourceClipBounds: [0, 0, 64, 48]});
    player.objects[0].set(objId, obj);

    // Start x_eve (51.0) and tr_eve (72.0) and sourceClip bottom event (157.0)
    const targetX = x + 120;
    const targetTr = Math.max(0, Math.min(255, 255 - tr));
    await call([38, 2, -1, objId, 51, 0], targetX, duration, 0, 0);
    await call([38, 2, -1, objId, 72, 0], targetTr, duration, 0, 0);
    await call([38, 2, -1, objId, 157, 0], 32, duration, 0, 0);

    assert.equal(await call([38, 2, -1, objId, 51, 5]), 1, `step ${seedStep}: x_eve must be active`);
    assert.equal(await call([38, 2, -1, objId, 72, 5]), 1, `step ${seedStep}: tr_eve must be active`);

    // Interleave procedural wipe mask generation across supported wipe families
    const wipeTypes = [10, 11, 60, 70, 80, 100, 101, 102, 110, 120, 150];
    const wipeType = wipeTypes[seedStep % wipeTypes.length];
    const mask = proceduralWipeMask(wipeType, 16, 12, [seedStep % 9, 1, seedStep & 1]);
    assert.ok(mask && mask.values.length === 16 * 12, `wipe type ${wipeType} mask shape`);

    // Capture serialized object mid-animation (at +50ms) and restore via deserializeDrawObject
    const startedAt = obj.opacityStarted ?? performance.now();
    obj.offsetEvents = {
      x: new Map([[0, {from: x, started: startedAt, time: {duration, delay: 0, easing: 'linear'}}]]),
    };
    obj.offsetEventCounts = {x: 1};
    obj.positionOffsets = {x: [targetX]};
    const midNow = startedAt + 50;
    const saved = serializeDrawObject(obj, midNow);
    assert.ok(saved.opacity, 'serialized tr_eve (opacity) preserved mid-animation');
    assert.ok(saved.offsetEvents?.x?.length === 1, 'serialized x offsetEvent preserved mid-animation');

    const restored = await player.deserializeDrawObject(saved);
    assert.equal(restored.x, targetX);
    assert.equal(restored.transparency, targetTr);
    assert.deepEqual(restored.opacity, obj.opacity);
    assert.equal(restored.offsetEvents?.x?.get(0)?.from, x);

    // Ending events clears active status cleanly
    player.objects[0].set(objId, restored);
    await call([38, 2, -1, objId, 72, 3]);
    assert.equal(await call([38, 2, -1, objId, 72, 5]), 0);
  }
});

test('Stateful interaction: EXCALL entry/exit isolates systemObjects, fonts, button groups, and frame_actions from story state', async () => {
  const rng = mulberry32(0x51610502);
  const player = makeMockPlayer();
  const call = (path, ...args) => player.command({path, args, named: []});

  for (let round = 0; round < 12; round++) {
    // Establish story objects, story font override, story button group, and story frame_action
    player.objects[0].set(round, makeBaseObject({x: 100 + round, y: 200, button: {id: round, group: 5}}));
    player.activeGroups.add(5);
    await call([64, 87], `StoryFont_${round}`);
    player.startFrameAction([53, -1, 0], 'story_scene', 0, '$$story_tick', [], false);

    // Enter EXCALL modal scope
    player.excallAllocated = true;
    player.systemCallDepth = 1;
    player.systemObjects.set(0, makeBaseObject({x: 500 + Math.floor(rng() * 100), y: 50, button: {id: 1, group: 100001}}));
    player.activeGroups.add(100001);
    await call([65, 13, 87], `ExcallFont_${round}`);
    await call([65, 13, 98], 0); // excall joypad override = 0
    player.startFrameAction([65, 1, 53, -1, 0], 'excall_scene', 1, '$$excall_tick', [], false);

    // Verify EXCALL font & objects do NOT pollute story state
    assert.equal(await call([64, 88]), `StoryFont_${round}`);
    assert.equal(await call([65, 13, 88]), `ExcallFont_${round}`);
    assert.equal(player.objects[0].get(round)?.x, 100 + round);

    // Exit EXCALL via releaseSystemObjects()
    player.releaseSystemObjects();
    player.systemCallDepth = 0;

    assert.equal(player.excallAllocated, false);
    assert.equal(player.systemObjects, undefined);
    // Story object, story font, story button group (<100000), and story frame_action MUST survive EXCALL exit intact!
    assert.equal(player.objects[0].get(round)?.x, 100 + round);
    assert.equal(player.activeGroups.has(5), true, `round ${round}: story button group 5 must survive EXCALL exit`);
    assert.equal(player.activeGroups.has(100001), false, `round ${round}: EXCALL button group 100001 must be cleared`);
    assert.equal(await call([64, 88]), `StoryFont_${round}`);
    assert.ok(
      [...player.frameActions.values()].some((a) => a.command === '$$story_tick'),
      `round ${round}: story frame_action must survive EXCALL exit`,
    );
    assert.equal(
      [...player.frameActions.values()].some((a) => a.command === '$$excall_tick'),
      false,
      `round ${round}: EXCALL frame_action must be cleaned up on release`,
    );
    // Re-allocate systemObjects Map for next EXCALL round
    player.systemObjects = new Map();
    player.systemBackObjects = new Map();
  }
});

test('Stateful interaction: counter start/pause/resume/stop and save/copy/swap invariants across seeded interleavings', async () => {
  const rng = mulberry32(0x51610503);
  const player = makeMockPlayer({
    writeSlot: async (map, idx, data) => {
      map.set(idx, data);
    },
    updateSlots: async (map, entries) => {
      for (const [idx, data] of entries) {
        if (data === undefined) map.delete(idx);
        else map.set(idx, data);
      }
    },
  });
  const call = (path, ...args) => player.command({path, args, named: []});

  // Counter lifecycle: set(0), get(1), reset(2), start(3), pause(4), resume(5), check_active(14)
  for (let i = 0; i < 10; i++) {
    const id = i % 4;
    await call([40, -1, id, 3]); // start
    assert.equal(await call([40, -1, id, 14]), 1, `counter ${id} active after start`);
    await call([40, -1, id, 4]); // pause
    assert.equal(await call([40, -1, id, 14]), 0, `counter ${id} inactive while paused`);
    await call([40, -1, id, 5]); // resume
    assert.equal(await call([40, -1, id, 14]), 1, `counter ${id} active after resume`);
    await call([40, -1, id, 2]); // reset
    assert.equal(await call([40, -1, id, 14]), 0, `counter ${id} inactive after reset`);
  }

  // Unified save copy (63.67) and swap (63.22) preserve exact slot bijection
  player.saves.set(0, {version: 1, title: 'S0'});
  player.saves.set(1, {version: 1, title: 'S1'});
  player.quickSaves.set(0, {version: 1, title: 'Q0'});
  for (let step = 0; step < 15; step++) {
    const a = Math.floor(rng() * 3);
    const b = 10 + Math.floor(rng() * 2); // quick slot 0 or 1
    const beforeA = player.saves.get(a)?.title;
    const beforeB = player.quickSaves.get(b - 10)?.title;
    if (step % 2 === 0) {
      await call([63, 22], a, b);
      assert.equal(player.saves.get(a)?.title, beforeB);
      assert.equal(player.quickSaves.get(b - 10)?.title, beforeA);
    } else if (beforeA !== undefined) {
      assert.equal(await call([63, 67], a, b), 1);
      assert.equal(player.quickSaves.get(b - 10)?.title, beforeA);
    }
  }
});

test('Stateful interaction: read-only queries and no-op writes NEVER trigger objectsDirty or systemObjectsDirty', async () => {
  const rng = mulberry32(0x51610504);
  const obj = makeBaseObject({
    x: 320,
    y: 180,
    pattern: 2,
    transparency: 200,
    visible: true,
    button: {id: 7, group: 100001},
    frames: [
      {width: 100, height: 50},
      {width: 120, height: 60},
      {width: 140, height: 70},
    ],
  });
  const player = makeMockPlayer({
    excallAllocated: true,
    objects: [new Map([[3, obj]]), new Map()],
    systemObjects: new Map([[3, {...obj, frames: obj.frames}]]),
    systemBackObjects: new Map([[3, {...obj, frames: obj.frames}]]),
    objectsDirty: false,
    systemObjectsDirty: false,
  });
  const call = (path, ...args) => player.command({path, args, named: []});

  for (let i = 0; i < 40; i++) {
    const pick = Math.floor(rng() * 8);
    if (pick === 0) await call([38, 2, -1, 3, 24]); // get_size_x
    else if (pick === 1) await call([38, 2, -1, 3, 25]); // get_size_y
    else if (pick === 2) await call([38, 2, -1, 3, 123]); // get_button_hit_state
    else if (pick === 3) await call([38, 2, -1, 3, 188]); // get_button_no
    else if (pick === 4) await call([38, 2, -1, 3, 51, 5]); // x_eve.check
    else if (pick === 5) await call([65, 1, 2, -1, 3, 72, 5]); // excall tr_eve.check
    else if (pick === 6) await call([38, 2, 3]); // stage.object.cnt
    else {
      // Property reads on x(3), y(4), pattern(1), transparency(27)
      assert.equal(player.property([38, 2, -1, 3, 3]), 320);
      assert.equal(player.property([38, 2, -1, 3, 4]), 180);
      assert.equal(player.property([38, 2, -1, 3, 1]), 2);
      assert.equal(player.property([38, 2, -1, 3, 27]), 200);
      // No-op writes (identical values) MUST NOT dirty stage
      player.property([38, 2, -1, 3, 0], 1); // visible already true
      player.property([38, 2, -1, 3, 3], 320);
      player.property([38, 2, -1, 3, 4], 180);
      player.property([38, 2, -1, 3, 1], 2);
      player.property([38, 2, -1, 3, 27], 200);
    }
    assert.equal(player.objectsDirty, false, `iter ${i} pick ${pick}: read-only query dirtied objectsDirty`);
    assert.equal(player.systemObjectsDirty, false, `iter ${i} pick ${pick}: read-only query dirtied systemObjectsDirty`);
  }

  // Real write MUST dirty objectsDirty
  player.property([38, 2, -1, 3, 3], 400);
  assert.equal(player.objectsDirty, true);
});

test('Stateful interaction: mwnd text color, vertical layout, wipe/audio curves, and format edge invariants', () => {
  // 1. DirectSound volume curve (audio.ts)
  assert.equal(siglusVolumeGain(0), 0);
  assert.equal(siglusVolumeGain(-0.5), 0);
  assert.equal(siglusVolumeGain(Number.NaN), 0);
  assert.equal(siglusVolumeGain(1), 1);
  assert.equal(siglusVolumeGain(1.5), 1);
  const gHalf = siglusVolumeGain(0.5);
  const gQuarter = siglusVolumeGain(0.25);
  assert.ok(gQuarter > 0 && gQuarter < gHalf && gHalf < 1, `monotonic curve: ${gQuarter} < ${gHalf} < 1`);
  // 0.5^2.5 ≈ 0.1768
  assert.ok(Math.abs(gHalf - Math.pow(0.5, 2.5)) < 0.01);

  // 2. Wipe softness table & PCM event 1x/2x weighted selector
  assert.equal(wipeSoftness(-1), 0);
  assert.equal(wipeSoftness(0), 0);
  assert.equal(wipeSoftness(1), 0.5);
  assert.equal(wipeSoftness(2), 0.75);
  assert.equal(wipeSoftness(99), 1);
  // With probs [10, 10] and previousIndex=0, weights are [10, 20] (total=30): r=0.33->0, r=0.34->1
  assert.equal(selectPcmEventIndex([10, 10], 0, () => 0.30), 0);
  assert.equal(selectPcmEventIndex([10, 10], 0, () => 0.35), 1);
  assert.equal(selectPcmEventIndex([], -1), -1);

  // 3. g00MaskValues reverse polarity
  const bgra = Uint8Array.of(0, 0, 255, 255, 255, 255, 255, 255); // red (lum=76), white (lum=255)
  const fwd = g00MaskValues(bgra, 2, 1, false);
  const rev = g00MaskValues(bgra, 2, 1, true);
  assert.equal(fwd[0], 76);
  assert.equal(fwd[1], 255);
  assert.equal(rev[0], 255 - 76);
  assert.equal(rev[1], 0);

  // 4. MWND layout & WAKU button anchor modes 0..3
  const cfg = new Map([
    ['SCREEN_SIZE', '1280, 720'],
    ['MWND.000.WINDOW_POS', '100, 500'],
    ['MWND.000.WINDOW_SIZE', '1080, 200'],
    ['MWND.000.NAME_EXTEND_TYPE', '0'],
    ['MWND.000.NAME_WINDOW_ALIGN', '2'],
    ['MWND.000.NAME_WINDOW_POS', '40, -30'],
    ['MWND.000.NAME_MESSAGE_POS', '12, 8'],
  ]);
  const layout = parseMwndLayout(cfg, 0);
  assert.equal(layout.nameAnchorX, 28); // 40 - 12 (align 2 subtracts NAME_MESSAGE_POS.x)
  assert.equal(layout.nameAnchorY, -22); // -30 + 8
  const sp = {x: 0, y: 0, centerX: 0, centerY: 0};
  assert.deepEqual(computeWakuButtonOrigin(0, [100, 500], [1080, 200], 10, 20, sp), {left: 110, top: 520});
  assert.deepEqual(computeWakuButtonOrigin(1, [100, 500], [1080, 200], 10, 20, sp), {left: 1170, top: 520});
  assert.deepEqual(computeWakuButtonOrigin(2, [100, 500], [1080, 200], 10, 20, sp), {left: 110, top: 680});
  assert.deepEqual(computeWakuButtonOrigin(3, [100, 500], [1080, 200], 10, 20, sp), {left: 1170, top: 680});

  // 5. Compression: xorByteInPlace (aligned + unaligned) & unpackSiglusLz overlapping RLE distance=1
  const buf = new Uint8Array([1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11]);
  const sub = buf.subarray(1, 10); // unaligned byteOffset=1, length=9
  xorByteInPlace(sub, 0x39);
  assert.deepEqual([...sub], [2, 3, 4, 5, 6, 7, 8, 9, 10].map((v) => v ^ 0x39));
  xorByteInPlace(sub, 0x39);
  assert.deepEqual([...sub], [2, 3, 4, 5, 6, 7, 8, 9, 10]);

  // LZSS: literal 0x41 ('A'), then back-ref distance=1 count=5 (word = (1 << 4) | (5 - 2) = 0x13)
  const lz = new Uint8Array(8 + 1 + 1 + 2);
  const lzv = new DataView(lz.buffer);
  lzv.setUint32(0, lz.length, true);
  lzv.setUint32(4, 6, true);
  lz[8] = 0x01; // bit0=literal, bit1=backref
  lz[9] = 0x41;
  lz[10] = 0x13;
  lz[11] = 0x00;
  assert.deepEqual([...unpackSiglusLz(lz)], [0x41, 0x41, 0x41, 0x41, 0x41, 0x41]);

  // 6. CGTABLE v2 synthetic raw + XOR-packed round-trip
  const cg = new Uint8Array(32 + 60);
  cg.set(Buffer.from('CGTABLE2'), 0);
  const cgv = new DataView(cg.buffer);
  cgv.setInt32(16, 1, true);
  cgv.setInt32(20, 0, true);
  cg.set(Buffer.from('CG_TEST_01'), 32);
  cgv.setInt32(32 + 32, 42, true);
  cgv.setInt32(32 + 36, 2, true);
  cgv.setInt32(32 + 40, 101, true);
  cgv.setInt32(32 + 44, 202, true);
  const parsedCg = parseCgTable(cg);
  assert.equal(parsedCg.version, 2);
  assert.equal(parsedCg.byName.get('cg_test_01'), 42);
  assert.deepEqual(parsedCg.entries[0].codes, [101, 202]);

  // 7. SiglusDbs synthetic round-trip with duplicate rowId first-match semantics & non-zero string offset
  // Build raw unpacked DBS buffer: 28-byte header + 2 rows + 2 cols ('V','S') + 4 cells + padding + UTF-16LE string at rel=4
  const strBytes = Buffer.from('\0\0hello\0', 'utf16le');
  const rawDbsLen = Math.ceil((28 + 8 + 16 + 16 + strBytes.length) / 4) * 4;
  const dbsRaw = new Uint8Array(rawDbsLen);
  const dv = new DataView(dbsRaw.buffer);
  dv.setUint32(0, rawDbsLen, true);
  dv.setUint32(4, 2, true); // rowCount=2
  dv.setUint32(8, 2, true); // colCount=2
  dv.setUint32(12, 28, true); // rowHeaderOffset
  dv.setUint32(16, 36, true); // colHeaderOffset
  dv.setUint32(20, 52, true); // dataOffset
  dv.setUint32(24, 68, true); // stringOffset
  dv.setInt32(28, 10, true); // row 0 id=10
  dv.setInt32(32, 10, true); // row 1 id=10 (duplicate!)
  dv.setInt32(36, 1, true);
  dv.setUint32(40, 'V'.charCodeAt(0), true);
  dv.setInt32(44, 2, true);
  dv.setUint32(48, 'S'.charCodeAt(0), true);
  dv.setInt32(52, 777, true); // row0 col0
  dv.setUint32(56, 4, true); // row0 col1 -> non-zero rel offset 4 -> "hello"
  dv.setInt32(60, 999, true); // row1 col0 (must NOT shadow row0!)
  dv.setUint32(64, 4, true);
  dbsRaw.set(strBytes, 68);
  // Apply inner dbsMask XOR
  for (let i = 0; i < rawDbsLen / 4; i++) {
    const r = Math.floor(i / 16);
    const c = i % 16;
    const k = dbsMask[(r % 5) * 5 + (c % 5)] >= 0x80 ? 0x7190c70e : 0x499bf135;
    dv.setUint32(i * 4, (dv.getUint32(i * 4, true) ^ k) >>> 0, true);
  }
  // Pack as all-literal Siglus LZSS
  const chunks = [];
  for (let p = 0; p < dbsRaw.length; p += 8) {
    chunks.push(0xff);
    for (let j = 0; j < 8 && p + j < dbsRaw.length; j++) chunks.push(dbsRaw[p + j]);
  }
  const packed = new Uint8Array(8 + chunks.length);
  const pv = new DataView(packed.buffer);
  pv.setUint32(0, packed.length, true);
  pv.setUint32(4, dbsRaw.length, true);
  packed.set(chunks, 8);
  // Apply outer XOR 0x89f4622d
  for (let i = 0; i + 4 <= packed.length; i += 4) {
    pv.setUint32(i, (pv.getUint32(i, true) ^ 0x89f4622d) >>> 0, true);
  }
  const fileBuf = new Uint8Array(4 + packed.length);
  new DataView(fileBuf.buffer).setUint32(0, 1, true); // encodingType=1 (UTF-16LE)
  fileBuf.set(packed, 4);
  const dbs = new SiglusDbs(fileBuf);
  assert.equal(dbs.hasRow(10), true);
  assert.equal(dbs.hasRow(11), false);
  assert.equal(dbs.checkColumn(1), 2);
  assert.equal(dbs.checkColumn(2), 1);
  assert.equal(dbs.checkColumn(99), 0);
  assert.equal(dbs.getNum(10, 1), 777); // first-match wins over 999!
  assert.equal(dbs.getNum(10, 2), 0); // type guard 'V' rejects 'S'
  assert.equal(dbs.getStr(10, 2), 'hello');
  assert.equal(dbs.getStr(10, 1), ''); // type guard 'S' rejects 'V'
});

test('Stateful interaction: SiglusVm signed 32-bit math, div-by-zero, GOSUB/RETURN, and checkpoint restore', async () => {
  // Build minimal synthetic bytecode:
  // push 10, push 0, div -> 0; push -7, push 3, mod -> -1; push 100000, push 100000, imul -> 1410065408 (32-bit wrap);
  // gosub label 1 -> returns 42; call host cmd [60, 0] with result
  const code = [];
  const pushU8 = (v) => code.push(v & 0xff);
  const pushI32 = (v) => {
    const b = new ArrayBuffer(4);
    new DataView(b).setInt32(0, v, true);
    for (const x of new Uint8Array(b)) code.push(x);
  };
  const pushInt = (v) => {
    pushU8(2);
    pushI32(10);
    pushI32(v);
  };
  const emitBin = (op) => {
    pushU8(34);
    pushI32(10);
    pushI32(10);
    pushU8(op);
  };
  const emitCmd = (root, nArgs) => {
    pushU8(48);
    pushI32(0); // overload
    pushI32(nArgs);
    for (let i = 0; i < nArgs; i++) pushI32(10);
    pushI32(0); // named count
    pushI32(0); // retForm void
  };

  // Element path [60] (math) with 5 int args: divByZero, modByZero, negMod, imulWrap, gosubVal
  pushU8(8); // mark element
  pushInt(60);
  pushInt(10);
  pushInt(0);
  emitBin(4); // 10 / 0 == 0
  pushInt(10);
  pushInt(0);
  emitBin(5); // 10 % 0 == 0
  pushInt(-7);
  pushInt(3);
  emitBin(5); // -7 % 3 == -1
  pushInt(100000);
  pushInt(100000);
  emitBin(3); // Math.imul(100000, 100000) == 1410065408
  // GOSUB label 1 (op 19: label=1, 0 args) -> pushes return value
  pushU8(19);
  pushI32(1);
  pushI32(0);
  emitCmd(60, 5);
  pushU8(0); // EOF

  const label1Offset = code.length;
  pushInt(42);
  pushU8(21); // RETURN with 1 int arg
  pushI32(1);
  pushI32(10);

  const scene = {
    name: 'synth',
    code: new Uint8Array(code),
    strings: [],
    labels: [0, label1Offset],
    entries: [0],
    properties: [],
    commands: [],
    commandNames: [],
  };
  const jumpedScene = {
    name: 'target_scene',
    code: new Uint8Array([0]),
    strings: [],
    labels: [0],
    entries: [0],
    properties: [],
    commands: [],
    commandNames: [],
  };
  const pack = {
    sceneNames: ['synth', 'target_scene'],
    commandNames: [],
    commandScenes: [],
    propertyNames: [],
    properties: [],
    scene: (name) => (name === 'target_scene' ? jumpedScene : scene),
  };
  const observed = [];
  let checkpointAfterJump = null;
  const vm = new SiglusVm(
    pack,
    {
      async command(cmd) {
        observed.push(cmd);
        // Simulate a post-jump frame mapping and verify vm.checkpoint() captures the jumped activeFrame!
        const origFrame = vm.frames[0];
        const fakeJumped = {
          scene: jumpedScene,
          pc: 0,
          line: 99,
          stack: [],
          points: [],
          locals: new Map(),
          declarations: new Map(),
          localListSizes: new Map(),
          localListInitialSizes: new Map(),
          references: new Map(),
          pendingRetForm: 0,
        };
        vm.sceneJumps.set(origFrame, fakeJumped);
        checkpointAfterJump = vm.checkpoint();
        vm.sceneJumps.delete(origFrame);
        return 0;
      },
      property: () => 0,
      message() {},
      trace() {},
    },
    new AbortController().signal,
  );
  await vm.run('synth', 0);
  assert.equal(observed.length, 1);
  assert.deepEqual(observed[0].path, [60]);
  assert.deepEqual(observed[0].args, [0, 0, -1, Math.imul(100000, 100000), 42]);
  assert.equal(checkpointAfterJump.frames[0].scene, 'target_scene');
  assert.equal(checkpointAfterJump.frames[0].line, 99);
});

test('Stateful interaction: display buttonHitPath empty bounds, numberGraphicCache LRU cap, G00 Type 2 negative dedup length, and Scene.pck string XOR key', async (t) => {
  // 1. display.buttonHitPath empty/degenerate contentBounds -> inset(100%)
  const display = Object.assign(Object.create(SiglusDisplay.prototype), {
    hitPaths: new WeakMap(),
    numberGraphicCache: new Map(),
    objectGraphic: async () => ({
      image: {},
      width: 10,
      height: 16,
      x: 0,
      y: 0,
      centerX: 0,
      centerY: 0,
    }),
  });
  const emptyFrame = {width: 64, height: 64, contentBounds: [20, 20, 20, 20]};
  assert.equal(display.buttonHitPath(emptyFrame, null, {}), 'inset(100%)');

  // 2. display.numberGraphicCache LRU eviction cap <= 256
  const prevDoc = Object.getOwnPropertyDescriptor(globalThis, 'document');
  Object.defineProperty(globalThis, 'document', {
    configurable: true,
    value: {
      createElement: () => ({
        width: 0,
        height: 0,
        getContext: () => ({drawImage() {}}),
      }),
    },
  });
  t.after(() => {
    if (prevDoc) Object.defineProperty(globalThis, 'document', prevDoc);
    else delete globalThis.document;
  });
  for (let v = 0; v < 265; v++) {
    await display.numberGraphic('digits', {
      value: v,
      ketaMax: 3,
      dispZero: false,
      dispSign: false,
      tumeruSign: false,
      spaceMod: 0,
      space: 0,
    });
  }
  assert.ok(display.numberGraphicCache.size <= 256, `numberGraphicCache exceeded 256: ${display.numberGraphicCache.size}`);

  // 3. G00 Type 2 deduplicated cut with negative signed length (-N)
  // Construct minimal Type 2 resource directly via G00Resource (cut 0 at offset 12, length = -212)
  const chipBytes = 4; // 1x1 BGRA pixel
  const cutLen = 116 + 92 + chipBytes; // 212 bytes
  const g00Data = new Uint8Array(12 + cutLen);
  const gv = new DataView(g00Data.buffer);
  gv.setUint32(0, 1, true); // cut count
  gv.setUint32(4, 12, true); // cut 0 offset
  gv.setInt32(8, -cutLen, true); // NEGATIVE signed length (deduplicated Type 2 cut!)
  gv.setUint16(12 + 2, 1, true); // 1 chip
  gv.setInt32(12 + 28, 1, true); // cut width = 1
  gv.setInt32(12 + 32, 1, true); // cut height = 1
  gv.setUint16(12 + 116 + 0, 0, true); // chip left
  gv.setUint16(12 + 116 + 2, 0, true); // chip top
  gv.setUint16(12 + 116 + 6, 1, true); // chip width
  gv.setUint16(12 + 116 + 8, 1, true); // chip height
  g00Data.set([11, 22, 33, 255], 12 + 116 + 92);
  const g00Img = new G00Image({type: 2, width: 1, height: 1, count: 1, data: g00Data});
  const frame0 = g00Img.frame(0);
  assert.deepEqual([...frame0.bgra], [11, 22, 33, 255]);

  // 4. Scene.pck stringTable XOR key (index >= 1 uses (i * 0x7087) & 0xffff)
  const {SiglusScenePack} = await import('../dist/formats/siglus/scene-pack.js');
  const {sceneXor} = await import('../dist/formats/siglus/tables.js');
  // Build a minimal uncompressed scene payload (132-byte header + 1-byte code + 2-entry string table)
  const s0 = Buffer.from('A', 'utf16le');
  const s1 = Buffer.from('BC', 'utf16le');
  // XOR s1 with (1 * 0x7087) & 0xffff
  const s1Enc = Buffer.from(s1);
  for (let p = 0; p < s1Enc.length; p += 2) {
    s1Enc.writeUInt16LE(s1Enc.readUInt16LE(p) ^ 0x7087, p);
  }
  const codeOff = 132;
  const strIdxOff = 136;
  const strDataOff = strIdxOff + 16;
  const sceneBuf = new Uint8Array(strDataOff + s0.length + s1Enc.length);
  const sv = new DataView(sceneBuf.buffer);
  sv.setUint32(0, 132, true);
  sv.setUint32(4, codeOff, true);
  sv.setUint32(8, 1, true);
  sv.setUint32(12, strIdxOff, true);
  sv.setUint32(16, 2, true);
  sv.setUint32(20, strDataOff, true);
  sv.setUint32(strIdxOff + 0, 0, true);
  sv.setUint32(strIdxOff + 4, 1, true);
  sv.setUint32(strIdxOff + 8, 1, true);
  sv.setUint32(strIdxOff + 12, 2, true);
  sceneBuf.set(s0, strDataOff);
  sceneBuf.set(s1Enc, strDataOff + s0.length);
  // LZSS-wrap sceneBuf as all literals and XOR with sceneXor
  const lzBody = [];
  for (let p = 0; p < sceneBuf.length; p += 8) {
    lzBody.push(0xff);
    for (let j = 0; j < 8 && p + j < sceneBuf.length; j++) lzBody.push(sceneBuf[p + j]);
  }
  const packedScene = new Uint8Array(8 + lzBody.length);
  new DataView(packedScene.buffer).setUint32(0, packedScene.length, true);
  new DataView(packedScene.buffer).setUint32(4, sceneBuf.length, true);
  packedScene.set(lzBody, 8);
  xorCycle(packedScene, sceneXor);
  // Build minimal 92-byte Scene.pck header + 1 scene name "s0" + 1 entry
  const nameBuf = Buffer.from('s0', 'utf16le');
  const nameIdxOff = 92;
  const nameDataOff = 100;
  const entryOff = 104;
  const sceneBase = 112;
  const pck = new Uint8Array(sceneBase + packedScene.length);
  const pv = new DataView(pck.buffer);
  pv.setUint32(0, 92, true);
  pv.setUint32(52, nameIdxOff, true);
  pv.setUint32(56, 1, true);
  pv.setUint32(60, nameDataOff, true);
  pv.setUint32(68, entryOff, true);
  pv.setUint32(72, 1, true);
  pv.setUint32(76, sceneBase, true);
  pv.setUint32(nameIdxOff, 0, true);
  pv.setUint32(nameIdxOff + 4, 2, true);
  pck.set(nameBuf, nameDataOff);
  pv.setUint32(entryOff, 0, true);
  pv.setUint32(entryOff + 4, packedScene.length, true);
  pck.set(packedScene, sceneBase);
  const parsedPack = new SiglusScenePack(pck);
  assert.deepEqual(parsedPack.scene('s0').strings, ['A', 'BC']);
});

test('Phase 5 Ghidra fix: database root 105 dispatch (0x55fb30) supports check_item_no=3, check_column_no=4, find_num=5, find_str=6, find_str_real=7', async () => {
  // Build a synthetic UTF-16LE DBS table with 2 rows (rowId 10, 20) and 2 columns (col 1='V', col 2='S')
  const str0 = Buffer.from('Alpha\0', 'utf16le');
  const str1 = Buffer.from('Beta\0', 'utf16le');
  const rowIdsOff = 28;
  const colHdrOff = rowIdsOff + 8;
  const dataOff = colHdrOff + 16;
  const strOff = dataOff + 16;
  const rawBodyLen = strOff + str0.length + str1.length;
  const bodyLen = Math.ceil(rawBodyLen / 4) * 4;
  const body = new Uint8Array(bodyLen);
  const bv = new DataView(body.buffer);
  bv.setUint32(4, 2, true); // rowCount
  bv.setUint32(8, 2, true); // colCount
  bv.setUint32(12, rowIdsOff, true);
  bv.setUint32(16, colHdrOff, true);
  bv.setUint32(20, dataOff, true);
  bv.setUint32(24, strOff, true);
  bv.setInt32(rowIdsOff + 0, 10, true);
  bv.setInt32(rowIdsOff + 4, 20, true);
  bv.setInt32(colHdrOff + 0, 1, true);
  bv.setUint32(colHdrOff + 4, 'V'.charCodeAt(0), true);
  bv.setInt32(colHdrOff + 8, 2, true);
  bv.setUint32(colHdrOff + 12, 'S'.charCodeAt(0), true);
  bv.setInt32(dataOff + 0, 111, true);
  bv.setUint32(dataOff + 4, 0, true);
  bv.setInt32(dataOff + 8, 222, true);
  bv.setUint32(dataOff + 12, str0.length, true);
  body.set(str0, strOff);
  body.set(str1, strOff + str0.length);
  for (let i = 0; i < bodyLen / 4; i++) {
    const r = Math.floor(i / 16);
    const c = i % 16;
    const key = dbsMask[(r % 5) * 5 + (c % 5)] >= 0x80 ? 0x7190c70e : 0x499bf135;
    bv.setUint32(i * 4, (bv.getUint32(i * 4, true) ^ key) >>> 0, true);
  }
  const lzBody = [];
  for (let p = 0; p < body.length; p += 8) {
    lzBody.push(0xff);
    for (let j = 0; j < 8 && p + j < body.length; j++) lzBody.push(body[p + j]);
  }
  const outer = new Uint8Array(8 + lzBody.length);
  const ov = new DataView(outer.buffer);
  ov.setUint32(0, outer.length, true);
  ov.setUint32(4, body.length, true);
  outer.set(lzBody, 8);
  for (let i = 0; i + 4 <= outer.length; i += 4) {
    ov.setUint32(i, (ov.getUint32(i, true) ^ 0x89f4622d) >>> 0, true);
  }
  const fileBuf = new Uint8Array(4 + outer.length);
  new DataView(fileBuf.buffer).setUint32(0, 1, true); // UTF-16LE
  fileBuf.set(outer, 4);
  const db = new SiglusDbs(fileBuf);

  const player = makeMockPlayer({
    loadDatabase: async () => db,
  });
  const call = (path, ...args) => player.command({path, args, named: []});

  assert.equal(await call([105, -1, 0, 0], 10, 1), 111);
  assert.equal(await call([105, -1, 0, 1], 20, 2), 'Beta');
  assert.equal(await call([105, -1, 0, 3], 10), 1); // check_item_no
  assert.equal(await call([105, -1, 0, 3], 99), 0);
  assert.equal(await call([105, -1, 0, 4], 1), 2); // check_column_no ('V' -> 2)
  assert.equal(await call([105, -1, 0, 4], 2), 1); // check_column_no ('S' -> 1)
  assert.equal(await call([105, -1, 0, 4], 9), 0); // check_column_no (missing -> 0)
  assert.equal(await call([105, -1, 0, 5], 1, 222), 20); // find_num
  assert.equal(await call([105, -1, 0, 5], 1, 999), -1);
  assert.equal(await call([105, -1, 0, 5], 2, 111), -1); // wrong column type
  assert.equal(await call([105, -1, 0, 6], 2, 'ALPHA'), 10); // find_str case-insensitive
  assert.equal(await call([105, -1, 0, 6], 2, 'beta'), 20);
  assert.equal(await call([105, -1, 0, 6], 2, 'gamma'), -1);
  assert.equal(await call([105, -1, 0, 7], 2, 'ALPHA'), -1); // find_str_real case-sensitive
  assert.equal(await call([105, -1, 0, 7], 2, 'Alpha'), 10);
});

test('Phase 5 Ghidra fix: cgtable root 78 (0x55f780) supports set_disable=7, set_enable=8, and get_name_by_flag_no=10', async () => {
  const saved = new Map();
  const prevStorage = globalThis.localStorage;
  globalThis.localStorage = {
    getItem: (k) => saved.get(k) ?? null,
    setItem: (k, v) => saved.set(k, String(v)),
    removeItem: (k) => saved.delete(k),
  };
  try {
    const player = makeMockPlayer({
      game: {saveKey: 'test-cgtable', config: new Map(), files: new Map()},
      cgTableLoaded: true,
      cgTable: new Map([
        ['ev01_a', 10],
        ['ev02_b', 20],
      ]),
      cgNameByFlag: new Map([
        [10, 'EV01_A'],
        [20, 'EV02_B'],
      ]),
      cgFlags: new Set(),
      cgTableDisabled: false,
    });
    const call = (path, ...args) => player.command({path, args, named: []});

    // get_name_by_flag_no (member 10)
    assert.equal(await call([78, 10], 10), 'EV01_A');
    assert.equal(await call([78, 10], 20), 'EV02_B');
    assert.equal(await call([78, 10], 99), '');

    // set_disable (member 7) suppresses automatic recordCgSeen
    await call([78, 7]);
    player.recordCgSeen('EV01_A');
    assert.equal(await call([78, 2], 'EV01_A'), 0);

    // set_enable (member 8) re-enables automatic recordCgSeen
    await call([78, 8]);
    player.recordCgSeen('EV01_A');
    assert.equal(await call([78, 2], 'EV01_A'), 1);
  } finally {
    if (prevStorage === undefined) delete globalThis.localStorage;
    else globalThis.localStorage = prevStorage;
  }
});

test('Phase 5 Ghidra fix: counter root 40 (0x560090) supports start_frame=10, start_frame_loop=12, and check_value=7', async () => {
  const player = makeMockPlayer();
  const call = (path, ...args) => player.command({path, args, named: []});

  // Normal counter check_value(target): returns 1 iff current value >= target
  await call([40, -1, 0, 0], 50); // set 50 (paused)
  assert.equal(await call([40, -1, 0, 7], 40), 1);
  assert.equal(await call([40, -1, 0, 7], 50), 1);
  assert.equal(await call([40, -1, 0, 7], 51), 0);

  // start_frame (member 10)
  await call([40, -1, 1, 10], 10, 100, 5000);
  assert.equal(await call([40, -1, 1, 14]), 1);
  assert.equal(await call([40, -1, 1, 7], 10), 1);
  assert.equal(await call([40, -1, 1, 7], 200), 0);

  // start_frame_loop (member 12)
  await call([40, -1, 2, 12], 0, 60, 1000);
  assert.equal(await call([40, -1, 2, 14]), 1);
  assert.equal(await call([40, -1, 2, 7], 0), 1);
  assert.equal(await call([40, -1, 2, 7], 100), 0);
});

test('Phase 5 Ghidra fix: math root 39 (0x55eed0) supports tostr(val,width), tan=8, tostr_zen_zero=13, and sqrt=14', async () => {
  const player = makeMockPlayer();
  const call = (path, ...args) => player.command({path, args, named: []});

  // math.tostr(val, width) (member 1, 2 args)
  assert.equal(await call([39, 1], 7, 4), '   7');
  assert.equal(await call([39, 1], 0, 3), '  0');
  assert.equal(await call([39, 1], -5, 4), '-  5');
  assert.equal(await call([39, 1], 1234, 2), '1234');

  // math.tan(deg10, scale) (member 8)
  assert.equal(await call([39, 8], 0, 1000), 0);
  assert.equal(await call([39, 8], 450, 1000), 1000);

  // math.tostr_zen_zero(val, width) (member 13)
  assert.equal(await call([39, 13], 7, 4), '０００７');
  assert.equal(await call([39, 13], 0, 3), '０００');
  assert.equal(await call([39, 13], -5, 4), '－００５');

  // math.sqrt(x) (member 14)
  assert.equal(await call([39, 14], -9), 0);
  assert.equal(await call([39, 14], 0), 0);
  assert.equal(await call([39, 14], 15), 3);
  assert.equal(await call([39, 14], 16), 4);
});

test('Phase 5 Batch 2 Ghidra fix: pcmevent.start_random (52.-1.*.2, 0x5652f0) parses [file, prob, minTime, maxTime] and stop(stopSound) respects arg0', async () => {
  const stopped = [];
  const player = makeMockPlayer({
    controller: new AbortController(),
    pcmEvents: new Map(),
    audio: {
      pcm: async () => {},
      effect: async () => {},
      effectDurationMs: async () => 50,
      stop: (ch, fade) => stopped.push([ch, fade]),
    },
  });
  const call = (path, ...args) => player.command({path, args, named: []});
  try {
    // Native 0x5652f0 lines 1288-1320:
    // 1 arg: [file] -> prob=1, min=0, max=0
    // 2 args: [file, prob] -> prob=arg1, min=0, max=0
    // 3 args: [file, prob, time] -> prob=arg1, min=arg2, max=arg2
    // 4 args: [file, prob, min, max] -> prob=arg1, min=arg2, max=arg3
    await call([52, -1, 0, 2], 3, ['a'], ['b', 40], ['c', 60, 500], ['d', 80, 1000, 2000]);
    const cfg = player.pcmEvents.get(0)?.config;
    assert.ok(cfg, 'pcmevent slot 0 should be registered');
    assert.equal(cfg.mode, 'random');
    assert.equal(cfg.pcmchNo, 3);
    assert.deepEqual(cfg.entries, [
      {file: 'a', probability: 1, minTime: 0, maxTime: 0},
      {file: 'b', probability: 40, minTime: 0, maxTime: 0},
      {file: 'c', probability: 60, minTime: 500, maxTime: 500},
      {file: 'd', probability: 80, minTime: 1000, maxTime: 2000},
    ]);

    // stop(0) cancels schedule without cutting off playing sound; stop(1) fades channel out with 100ms
    await call([52, -1, 0, 3], 0);
    assert.equal(player.pcmEvents.has(0), false);
    assert.deepEqual(stopped, []);

    await call([52, -1, 0, 2], 3, ['a', 50]);
    await call([52, -1, 0, 3], 1);
    assert.equal(player.pcmEvents.has(0), false);
    assert.deepEqual(stopped, [['pcm3', 100]]);
  } finally {
    player.controller.abort();
    for (const ev of player.pcmEvents.values()) ev.cancel(false);
  }
});

test('Phase 5 Batch 2 Ghidra fix: global 138/139/140/141 (0x54fc20 -> 0x5c71f0) manipulate VM call stack without wiping backlog', async () => {
  // Build a minimal 3-scene pack: s0 -> farcall s1 -> farcall s2
  const makeCode = (bytes) => new Uint8Array(bytes);
  const w32 = (n) => [n & 0xff, (n >> 8) & 0xff, (n >> 16) & 0xff, (n >> 24) & 0xff];
  // Encode a scene that executes command(cmdId, args...) then RETURN(0)
  const buildScene = (name, strings, codeBytes) => ({
    name,
    code: makeCode(codeBytes),
    view: new DataView(makeCode(codeBytes).buffer),
    labels: [0],
    entries: [0],
    strings,
    properties: [],
    commands: [],
  });
  // Helper: CD_PUSH(10, val), CD_PUSH(20, strIdx), CD_ELM_POINT(8), CD_PUSH(10, root), CD_COMMAND(48)
  const pushInt = (v) => [2, ...w32(10), ...w32(v)];
  const pushStr = (idx) => [2, ...w32(20), ...w32(idx)];
  const callCmd = (root, argSpecs, retForm = 0) => [
    8, // CD_ELM_POINT
    ...pushInt(root),
    ...argSpecs.flatMap((a) => (a.str !== undefined ? pushStr(a.str) : pushInt(a.int))),
    48, // CD_COMMAND
    ...w32(0), // overload
    ...w32(argSpecs.length),
    ...argSpecs.flatMap((a) => w32(a.str !== undefined ? 20 : 10)),
    ...w32(0), // named count
    ...w32(retForm),
  ];
  const retVoid = [21, ...w32(0)]; // CD_RETURN(0 args)

  // s0: farcall("s1", 0), then callCmd(900) [marker: s0 resumed]
  const s0 = buildScene('s0', ['s1'], [
    ...callCmd(5, [{str: 0}, {int: 0}]),
    ...callCmd(900, []),
    ...retVoid,
  ]);
  // s1: farcall("s2", 0), then callCmd(901) [marker: s1 resumed]
  const s1 = buildScene('s1', ['s2'], [
    ...callCmd(5, [{str: 0}, {int: 0}]),
    ...callCmd(901, []),
    ...retVoid,
  ]);
  // s2: callCmd(902) [hook inside deepest frame], then RETURN
  const s2 = buildScene('s2', [], [...callCmd(902, []), ...retVoid]);

  const scenes = new Map([['s0', s0], ['s1', s1], ['s2', s2]]);
  const pack = {
    sceneNames: ['s0', 's1', 's2'],
    commandNames: [],
    commandScenes: [],
    properties: [],
    scene: (n) => scenes.get(n),
  };

  const log = [];
  const controller = new AbortController();
  let player;
  const vm = new SiglusVm(
    pack,
    {
      trace() {},
      property() { return undefined; },
      async command(cmd) {
        if (cmd.path[0] === 900 || cmd.path[0] === 901) {
          log.push(`resumed:${cmd.path[0]}`);
          return 0;
        }
        if (cmd.path[0] === 902) {
          // Inside s2: stack is [s0, s1, s2] => depth 3
          const depthBefore = await player.command({path: [139], args: [], named: []});
          log.push(`depthBefore:${depthBefore}`);
          // del_call_stack(1) removes s1 (immediate caller), leaving [s0, s2] => depth 2!
          await player.command({path: [138], args: [1], named: []});
          const depthAfterDel = await player.command({path: [139], args: [], named: []});
          log.push(`depthAfterDel:${depthAfterDel}`);
          return 0;
        }
        return player.command(cmd);
      },
    },
    controller.signal,
  );
  player = makeMockPlayer({
    vm,
    backlog: [{name: 'Hero', text: [{text: 'Line 1'}], voices: []}, {name: 'Hero', text: [{text: 'Line 2'}], voices: []}],
    historyPoints: new WeakMap(),
  });

  await vm.run('s0', 0);
  assert.deepEqual(log, ['depthBefore:3', 'depthAfterDel:2', 'resumed:900']);
  // Dialogue backlog MUST be completely untouched by del_call_stack (138)!
  assert.equal(player.backlog.length, 2);

  // Also test clear_call_stack (141) does not wipe backlog
  await player.command({path: [141], args: [], named: []});
  assert.equal(player.backlog.length, 2);
});

test('Phase 5 Batch 2 Ghidra fix: msgbk.clear (145.6, 0x555b20) clears backlog and database.cnt (105.1, 0x54fc20) returns database count', async () => {
  const player = makeMockPlayer({
    backlog: [{name: 'A', text: [{text: 'hi'}], voices: []}],
    historyPoints: new WeakMap(),
  });
  player.game.config.set('DATABASE.000', '"db0"');
  player.game.config.set('DATABASE.001', '"db1"');
  player.game.config.set('DATABASE.002', '"db2"');
  const call = (path, ...args) => player.command({path, args, named: []});

  assert.equal(await call([145, 6]), 0);
  assert.equal(player.backlog.length, 0);
  assert.equal(await call([105, 1]), 3);
});

test('Phase 5 Batch 4 Ghidra fixes: object 1-arg disp defaults, color clamping [0..255], get_pixel_color default pat=0, init_param, getters, and intlist/rep ops (0x5593a0)', async () => {
  const pixelCalls = [];
  const player = makeMockPlayer({
    display: {
      objectGraphic: async (name, pat) => ({
        image: {},
        width: 32,
        height: 32,
        x: 0,
        y: 0,
        centerX: 0,
        centerY: 0,
        tag: `${name}#${pat}`,
      }),
      numberGraphic: async (name, spec) => ({
        image: {},
        width: 16,
        height: 16,
        x: 0,
        y: 0,
        centerX: 0,
        centerY: 0,
      }),
      graphicCutCount: () => 10,
      graphicPixelChannel: (frame, x, y, ch) => {
        pixelCalls.push({tag: frame.tag, x, y, ch});
        return frame.tag.endsWith('#0') ? 100 + ch : 200 + ch;
      },
      savedThumbnail: async () => ({image: {}, width: 64, height: 36, x: 0, y: 0, centerX: 0, centerY: 0}),
    },
    saves: new Map([[0, {thumbnail: new Uint8Array([1])}]]),
    cgTable: new Map(),
    cgFlags: new Set(),
    resolveFont: () => ({name: 'sans-serif', bold: false, shadow: 0}),
    storyFont: () => ({name: 'sans-serif', bold: false, shadow: 0}),
  });
  const cmd = (id, tail, args = [], named = []) =>
    player.objectCommand({path: [37, 2, -1, id, ...tail], args, named, scene: 's0'});
  const prop = (id, tail, val) => player.property([37, 2, -1, id, ...tail], val);

  // 1. disc-009: 1-arg create_string (39), create_number (132), create_weather (129), create_save_thumb (116)
  // Native FUN_005f5010(1) -> FUN_005f5730(0) resets disp=0; overload 0 leaves disp=0!
  await cmd(1, [39], ['hello']);
  assert.equal(prop(1, [0]), 0, '1-arg create_string must default disp=0');
  assert.equal(await cmd(1, [135]), 'hello', 'get_string (135) returns text value');
  await cmd(2, [39], ['shown', 1]);
  assert.equal(prop(2, [0]), 1, '2-arg create_string with disp=1 sets disp=1');

  await cmd(3, [132], ['num_g00']);
  assert.equal(prop(3, [0]), 0, '1-arg create_number must default disp=0');
  await cmd(3, [133], [42]);
  assert.equal(await cmd(3, [136]), 42, 'get_number (136) returns current number value');
  assert.equal(await cmd(3, [169]), 10, 'get_pat_cnt (169) supports type=5 number objects');

  await cmd(4, [129], ['snow']);
  assert.equal(prop(4, [0]), 0, '1-arg create_weather must default disp=0');

  await cmd(5, [116], [0]);
  assert.equal(prop(5, [0]), 0, '1-arg create_save_thumb must default disp=0');

  // 2. disc-010: get_pixel_color_a/r/g/b (100..103) with 2 args MUST query pattern 0, NOT object.pattern!
  await cmd(6, [38], ['spr', 1, 0, 0, 2]); // pattern = 2
  assert.equal(prop(6, [1]), 2);
  assert.equal(await cmd(6, [101], [5, 6]), 100, 'get_pixel_color_r 2-arg must query pattern 0');
  assert.equal(await cmd(6, [100], [5, 6, 2]), 203, 'get_pixel_color_a 3-arg queries explicit pattern 2');

  // 3. disc-011: All 12 color/tr properties clamp strictly to [0, 255] (FUN_00558ad0..FUN_00558ce0)
  for (const p of [27, 28, 29, 30, 31, 32, 33, 34, 23, 57, 58, 59]) {
    prop(6, [p], -50);
    assert.equal(prop(6, [p]), 0, `property ${p} must clamp negative to 0`);
    prop(6, [p], 999);
    assert.equal(prop(6, [p]), 255, `property ${p} must clamp >255 to 255`);
    prop(6, [p], 128);
    assert.equal(prop(6, [p]), 128);
  }

  // 4. disc-012: init_param (37) resets transform/color/visibility/button WITHOUT freeing graphic/name/type
  prop(6, [3], 123);
  prop(6, [4], 456);
  prop(6, [5], 789);
  prop(6, [44], 3);
  prop(6, [92], 1);
  prop(6, [139], 1);
  await cmd(6, [50], [10, 20, 30]); // set_rotate(rx, ry, rz)
  assert.deepEqual([prop(6, [15]), prop(6, [16]), prop(6, [17])], [10, 20, 30]);
  await cmd(6, [42], [7, 2, 4, 9]); // set_button(id, group, actionNo, seNo)
  await cmd(6, [26], ['on_btn']); // set_button_call
  await cmd(6, [98], [1]); // set_button_push_keep
  await cmd(6, [175], [1]); // set_button_alpha_test
  assert.equal(await cmd(6, [188]), 7);
  assert.equal(await cmd(6, [189]), 2);
  assert.equal(await cmd(6, [190]), 4);
  assert.equal(await cmd(6, [191]), 9);
  assert.equal(await cmd(6, [119]), 1);
  assert.equal(await cmd(6, [176]), 1);
  await cmd(6, [60]); // clear_button_call
  assert.equal(player.objects[1].get(6).buttonCall, undefined);

  await cmd(6, [37]); // init_param!
  assert.equal(await cmd(6, [62]), 'spr', 'init_param preserves file name');
  assert.equal(await cmd(6, [174]), 1, 'init_param preserves object type');
  assert.equal(prop(6, [0]), 0, 'init_param resets disp=0');
  assert.equal(prop(6, [3]), 0, 'init_param resets x=0');
  assert.equal(prop(6, [5]), 0, 'init_param resets z=0');
  assert.equal(prop(6, [12]), 1000, 'init_param resets scale_x=1000');
  assert.equal(prop(6, [14]), 1000, 'init_param resets scale_z=1000');
  assert.equal(prop(6, [27]), 255, 'init_param resets tr=255');
  assert.equal(prop(6, [44]), -1, 'init_param resets world=-1');
  assert.equal(prop(6, [139]), 0, 'init_param resets click_disable=0');
  assert.equal(prop(6, [92]), 1, 'init_param preserves wipe_erase (+0x1b4, only reset by init 35)');
  assert.equal(await cmd(6, [189]), -1, 'init_param clears button -> group_no=-1');
  assert.equal(await cmd(6, [190]), -1, 'init_param clears button -> action_no=-1');
  assert.equal(await cmd(6, [191]), -1, 'init_param clears button -> se_no=-1');

  // 5. disc-013: object.f (111) sets/clear/init & bit views + z_rep (110) / x_rep clear (8) + z_eve (65)
  await cmd(6, [111, 2], [4]); // resize(4)
  await cmd(6, [111, 1], [1, 10, 20, 30]); // sets(1, 10, 20, 30)
  assert.deepEqual([prop(6, [111, -1, 0]), prop(6, [111, -1, 1]), prop(6, [111, -1, 2]), prop(6, [111, -1, 3])], [0, 10, 20, 30]);
  await cmd(6, [111, 8], [1, 2, 77]); // clear(1, 2, 77)
  assert.deepEqual([prop(6, [111, -1, 1]), prop(6, [111, -1, 2]), prop(6, [111, -1, 3])], [77, 77, 30]);
  prop(6, [111, 3, -1, 0], 1); // bit[0] = 1
  assert.equal(prop(6, [111, 3, -1, 0]), 1);
  assert.equal(prop(6, [111, -1, 0]), 1);
  await cmd(6, [111, 10]); // init
  assert.deepEqual([prop(6, [111, -1, 0]), prop(6, [111, -1, 1])], [0, 0]);

  await cmd(6, [54, 2], [3]); // x_rep.resize(3)
  await cmd(6, [54, 8], [0, 2, 55]); // x_rep.clear(0, 2, 55)
  assert.deepEqual([prop(6, [54, -1, 0]), prop(6, [54, -1, 1]), prop(6, [54, -1, 2])], [55, 55, 55]);
  await cmd(6, [65, 0], [300, 0, 0, 0]); // z_eve.set
  assert.equal(prop(6, [5]), 300);
});

test('Phase 5 Batch 5 Ghidra fixes: syscom (0x569f60) message_speed [0..100], auto_min_wait [0..5000], koe_mode clamp, get_quick_save_value (184), sound_onoff (280..282), font/extra/msg_back getters', async () => {
  const written = [];
  const audio = Object.assign(Object.create(SiglusAudio.prototype), {
    levels: new Map(),
    disabled: new Set(),
    soundLevels: new Map(),
    soundDisabled: new Set(),
    updateGains() {},
  });
  const player = makeMockPlayer({
    audio,
    playback: {messageSpeed: 50, autoCharacterWait: 100, autoMinimumWait: 1000, voiceDuckLevel: 128, messageNowait: false, voiceDuckEnabled: true},
    playbackDefaults: {messageSpeed: 50, autoCharacterWait: 100, autoMinimumWait: 1000, voiceDuckLevel: 128, messageNowait: false, voiceDuckEnabled: true},
    messageFont: {name: 'CustomFont', bold: false, shadow: 0},
    defaultMessageFont: {name: 'DefaultFont', bold: false, shadow: 1},
    applyMessageFont() {},
    persistOptions() {},
    quickSaves: new Map([[0, {customValues: [11, 22, 33]}]]),
    localExtraSwitches: new Map(),
    backlog: [{name: 'Alice', text: [{text: 'Hello'}, {text: ' world'}], voices: [{id: 500}]}],
    historyPoints: new WeakMap(),
    vm: {
      readIntList: () => [],
      writeIntList: (_ref, _ofs, out) => written.push(...out),
    },
  });
  const call = (member, ...args) => player.command({path: [63, member], args, named: []});

  // 1. disc-014: messageSpeed clamps to [0, 100] (0x56cb52) and autoMinimumWait clamps to [0, 5000] (0x56cc3f)
  await call(46, 200);
  assert.equal(await call(48), 100, 'syscom.set_message_speed (46) must clamp to 100');
  await call(54, 9999);
  assert.equal(await call(56), 5000, 'syscom.set_auto_mode_min_wait (54) must clamp to 5000');

  // 2. disc-015: set_koe_mode (148, 0x56c7fd) resets invalid values outside {0,1,2} to 0
  await call(148, 2);
  assert.equal(await call(150), 2);
  await call(148, 99);
  assert.equal(await call(150), 0, 'syscom.set_koe_mode (148) must clamp invalid values to 0');

  // 3. disc-016: get_quick_save_value (184, 0x56bba5) reads quick-save customValues into VM intlist
  await call(184, 0, [30], 0, 3);
  assert.deepEqual(written, [11, 22, 33], 'syscom.get_quick_save_value (184) must populate intlist');

  // 4. disc-017: sound_onoff (280/281/282), font bold/shadow/reset (296/297/307/308/326), local extra switch/mode (189..191, 164..166), msg_back (336..339)
  assert.equal(await call(282, 5), 1);
  await call(280, 5, 0);
  assert.equal(await call(282, 5), 0);
  await call(281, 5);
  assert.equal(await call(282, 5), 1);
  assert.equal(await call(282, 99), 1, 'OOB sound_onoff returns 1');

  await call(296, 1);
  assert.equal(await call(307), 1);
  await call(297, 2);
  assert.equal(await call(308), 2);
  await call(326);
  assert.equal(await call(284), 'DefaultFont');

  await call(189, 2, 1);
  assert.equal(await call(191, 2), 1);
  await call(190, 2);
  assert.equal(await call(191, 2), 0);

  await call(164, 1, 3);
  assert.equal(await call(166, 1), 3);
  await call(165, 1);
  assert.equal(await call(166, 1), 0);

  assert.equal(await call(336, 0), 'Alice');
  assert.equal(await call(337, 0), 'Hello world');
  assert.equal(await call(338, 0), 1);
  assert.equal(await call(339, 0), 0);
});

test('Phase 5 Batch 6+7 Ghidra fixes (disc-018..023): CONFIG.*.ONOFF dot keys, syscom 330/331/164..166/189..191/311..319 defaults, effect clamps+intevent 14..16, pcmch/bgm fades+pause+wait, vm include prune+str.mid/search_last', async () => {
  // 1. disc-018, disc-019, disc-020: CONFIG.*.ONOFF dot lookup, syscom 330/331, Gameexe defaults for 164..166, 189..191, 311..313, 317..319
  const stoppedAudio = [];
  const pausedPcm = [];
  const startedPcm = [];
  const startedBgm = [];
  let waitedBgm = 0;
  const player = makeMockPlayer({
    options: new Map(),
    localExtraSwitches: new Map(),
    stageEffects: new Map(),
    bgmListened: new Set(),
    recordBgmListened() {},
    persistOptions() {},
    applyScreenEffects() {},
    waitAudio: async (ch, canSkip) => {
      if (ch === 'bgm') waitedBgm++;
      return 0;
    },
    audio: {
      stop: (ch, fade) => stoppedAudio.push([ch, fade]),
      pausePcm: (ch, fade) => pausedPcm.push([ch, fade]),
      pcmStart: (ch, src, ready, fade) => startedPcm.push({ch, src, ready, fade}),
      bgmStart: (name, loop, fadeIn, fadeOut, delay, start) =>
        startedBgm.push({name, loop, fadeIn, fadeOut, delay, start}),
      bgmName: () => 'bgm01',
    },
  });
  // Native Gameexe keys use dots before ONOFF (0x699d00)
  player.game.config.set('CONFIG.WHEEL_NEXT_MESSAGE.ONOFF', '1');
  player.game.config.set('CONFIG.SKIP_WIPE_ANIME.ONOFF', '1');
  player.game.config.set('SYSTEM.EXTRA_INT_VALUE.CNT', '2');
  player.game.config.set('SYSTEM.EXTRA_INT_VALUE.000', '42');
  player.game.config.set('SYSTEM.EXTRA_INT_VALUE.001', '-7');
  player.game.config.set('SYSTEM.EXTRA_STR_VALUE.CNT', '2');
  player.game.config.set('SYSTEM.EXTRA_STR_VALUE.000', '"BG"');
  player.game.config.set('SYSTEM.EXTRA_STR_VALUE.001', '"TK"');
  player.game.config.set('SYSTEM.EXTRA_STR_VALUE.002', '"OOB"');
  player.game.config.set('CONFIG.GLOBAL_EXTRA_MODE.001.MODE', '4');
  player.game.config.set('CONFIG.OBJECT_DISP.002.ONOFF', '1');
  player.game.config.set('CONFIG.MOUSE_CURSOR_HIDE_ONOFF', '1');
  player.game.config.set('CONFIG.MOUSE_CURSOR_HIDE_TIME', '5000');
  player.game.config.set('SE.007', '"sys_click"');

  const sys = (member, ...args) => player.command({path: [63, member], args, named: []});

  // disc-018: CONFIG.WHEEL_NEXT_MESSAGE.ONOFF and CONFIG.SKIP_WIPE_ANIME.ONOFF read dot-form keys
  assert.equal(await sys(121), 1, 'WHEEL_NEXT_MESSAGE_ONOFF must read CONFIG.WHEEL_NEXT_MESSAGE.ONOFF');
  assert.equal(await sys(118), 1, 'SKIP_WIPE_ANIME_ONOFF must read CONFIG.SKIP_WIPE_ANIME.ONOFF');
  await sys(119, 0);
  assert.equal(await sys(121), 0);
  await sys(120); // reset to Gameexe default
  assert.equal(await sys(121), 1);

  // disc-019: syscom 330 (get_system_extra_int_value) & 331 (get_system_extra_str_value)
  assert.equal(await sys(330, 0), 42);
  assert.equal(await sys(330, 1), -7);
  assert.equal(await sys(330, 2), 0, 'OOB extra_int returns 0');
  assert.equal(await sys(330, -1), 0);
  assert.equal(await sys(331, 0), 'BG');
  assert.equal(await sys(331, 1), 'TK');
  assert.equal(await sys(331, 2), '', 'OOB extra_str returns empty string');
  assert.equal(await sys(331, -1), '');

  // disc-020: Gameexe defaults + reset for 164..166 (global_extra_mode), 189..191 (object_disp), 311..313 & 317..319 (mouse_cursor_hide)
  assert.equal(await sys(166, 1), 4, 'global_extra_mode[1] defaults to CONFIG.GLOBAL_EXTRA_MODE.001.MODE');
  await sys(164, 1, 9);
  assert.equal(await sys(166, 1), 9);
  await sys(165, 1);
  assert.equal(await sys(166, 1), 4, 'global_extra_mode reset restores Gameexe default');

  assert.equal(await sys(191, 2), 1, 'object_disp[2] defaults to CONFIG.OBJECT_DISP.002.ONOFF');
  await sys(189, 2, 0);
  assert.equal(await sys(191, 2), 0);
  await sys(190, 2);
  assert.equal(await sys(191, 2), 1, 'object_disp reset restores Gameexe default');
  // local_extra_switch (300/301) remains completely independent from object_disp (189..191)
  await sys(300, 2, 0);
  assert.equal(await sys(301, 2), 0);
  assert.equal(await sys(191, 2), 1, 'syscom 300 must not overwrite object_disp 191');

  assert.equal(await sys(313), 1, 'mouse_cursor_hide_onoff defaults to CONFIG.MOUSE_CURSOR_HIDE_ONOFF');
  await sys(311, 0);
  assert.equal(await sys(313), 0);
  await sys(312);
  assert.equal(await sys(313), 1);

  assert.equal(await sys(319), 5000, 'mouse_cursor_hide_time defaults to CONFIG.MOUSE_CURSOR_HIDE_TIME');
  await sys(317, 1500);
  assert.equal(await sys(319), 1500);
  await sys(318);
  assert.equal(await sys(319), 5000);

  // 2. disc-021: effect property clamps [0..255] (props 3..13), bool 31/32, intevent channels 14..16 (x/y/z)
  player.property([70, 31, -1, 0, 3], -20);
  assert.equal(player.property([70, 31, -1, 0, 3]), 0, 'effect mono (prop 3) clamps <0 to 0');
  player.property([70, 31, -1, 0, 10], 400);
  assert.equal(player.property([70, 31, -1, 0, 10]), 255, 'effect color_rate (prop 10) clamps >255 to 255');
  player.property([70, 31, -1, 0, 31], 5);
  assert.equal(player.property([70, 31, -1, 0, 31]), 1, 'effect prop 31 normalizes to boolean 0|1');
  await player.command({path: [70, 31, -1, 0, 14, 0], args: [120, 0, 0], named: []});
  assert.equal(player.property([70, 31, -1, 0, 0]), 120, 'effect x_eve (channel 14) writes prop 0 (x)');
  await player.command({path: [70, 31, -1, 0, 16, 0], args: [-45, 0, 0], named: []});
  assert.equal(player.property([70, 31, -1, 0, 2]), -45, 'effect z_eve (channel 16) writes prop 2 (z)');

  // 3. disc-022: pcmch.stop (5) 100ms 0-arg default, pcmch.pause (10), pcmch.play named(9) se_no + volumeType clamp, bgm.play named(2) wait_flag
  await player.command({path: [44, -1, 2, 5], args: [], named: []});
  assert.deepEqual(stoppedAudio, [['pcm2', 100]], 'pcmch.stop() with 0 args defaults fade to 100ms');
  await player.command({path: [44, -1, 2, 10], args: [], named: []});
  assert.deepEqual(pausedPcm, [[2, 100]], 'pcmch.pause() with 0 args defaults fade to 100ms');
  await player.command({path: [44, -1, 2, 10], args: [250], named: []});
  assert.deepEqual(pausedPcm[1], [2, 250], 'pcmch.pause(250) passes explicit fade');
  await player.command({path: [44, -1, 1, 0], args: [7, 99], named: [9, 3]});
  assert.equal(startedPcm.length, 1);
  assert.equal(startedPcm[0].src.resource, 'sys_click', 'pcmch.play named(9) resolves SE.007');
  assert.equal(startedPcm[0].src.volumeType, 2, 'pcmch.play clamps OOB volumeType >31 to 2');

  await player.command({path: [42, 0], args: ['bgm01', 1], named: [2]});
  assert.equal(waitedBgm, 1, 'bgm.play with named(2)=1 waits for bgm');

  // 4. disc-023: vm.ts user command (include >= 0) pruned-frame unwinding + str.mid negative start + str.search_last("") === -1
  const w32 = (v) => [v & 0xff, (v >> 8) & 0xff, (v >> 16) & 0xff, (v >> 24) & 0xff];
  const pushInt = (v) => [2, ...w32(10), ...w32(v)];
  const callCmd = (root, argSpecs, retForm = 0) => [
    8,
    ...pushInt(root),
    ...argSpecs.flatMap((a) => pushInt(a)),
    48,
    ...w32(0),
    ...w32(argSpecs.length),
    ...argSpecs.map(() => w32(10)).flat(),
    ...w32(0),
    ...w32(retForm),
  ];
  const retVoid = [21, ...w32(0)];
  const makeScene = (name, codeBytes, entries = [0], commands = []) => {
    const code = new Uint8Array(codeBytes);
    return {name, code, view: new DataView(code.buffer), labels: entries, entries, strings: [], properties: [], commands};
  };
  // User command ID = (0x7e << 24) | idx -> globalCommand include index -> scene u1/u2 entry 0
  const USER_CMD_0 = (0x7e << 24) | 0;
  const USER_CMD_1 = (0x7e << 24) | 1;
  const u0 = makeScene('u0', [...callCmd(USER_CMD_0, []), ...callCmd(910, []), ...retVoid]);
  const u1 = makeScene('u1', [...callCmd(USER_CMD_1, []), ...callCmd(911, []), ...retVoid]);
  const u2 = makeScene('u2', [...callCmd(912, []), ...retVoid]);
  const scenes = new Map([['u0', u0], ['u1', u1], ['u2', u2]]);
  const pack = {
    sceneNames: ['u0', 'u1', 'u2'],
    commandNames: ['cmd0', 'cmd1'],
    commandScenes: [1, 0, 2, 0],
    properties: [],
    scene: (name) => scenes.get(name),
  };
  const log = [];
  const ctrl = new AbortController();
  const vm = new SiglusVm(
    pack,
    {
      trace() {},
      property() { return undefined; },
      async command(c) {
        if (c.path[0] === 910 || c.path[0] === 911) {
          log.push(`resumed:${c.path[0]}`);
          return 0;
        }
        if (c.path[0] === 912) {
          // Prune caller u1 (depth 1 below u2)
          vm.delCallStack(1);
          return 0;
        }
        return undefined;
      },
    },
    ctrl.signal,
  );
  await vm.run('u0', 0);
  assert.deepEqual(log, ['resumed:910'], 'pruned intermediate user-command frame u1 must NOT resume');

  // str.mid negative start + str.search_last("") === -1
  assert.equal(vm.stringCommand('abcdef', 3, [-2, 4]), 'ab', 'str.mid(-2, 4) matches native end=rawStart+len=2');
  assert.equal(vm.stringCommand('abcdef', 3, [-5, 2]), '', 'str.mid(-5, 2) returns empty');
  assert.equal(vm.stringCommand('abcdef', 11, ['']), -1, 'str.search_last("") returns -1 in native');
  assert.equal(vm.stringCommand('ababa', 11, ['ba']), 3);
});
