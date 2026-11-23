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
import {readSelbtnTemplate} from '../dist/engines/siglus/selbtn.js';
import {orderedObjects, serializeDrawObject} from '../dist/engines/siglus/display.js';
import {unpackSiglusLz, xorByteInPlace} from '../dist/formats/siglus/compression.js';
import {G00Image} from '../dist/formats/siglus/g00.js';
import {decodeOwp} from '../dist/formats/siglus/sound.js';
import {AsfDemuxer, readAsfLayout} from '../dist/formats/asf/demux.js';
import {SiglusScenePack} from '../dist/formats/siglus/scene-pack.js';
import {WindowsMediaDecoder} from '../dist/video/windows-media.js';

const REPO_ROOT = path.resolve(import.meta.dirname, '..');
const SIGLUS_DIR = path.join(REPO_ROOT, 'src/engines/siglus');
const SSR_DIR = '/Users/paul/Torrents/Games/tsuki no kanata fan disk';
const HAS_SSR = fs.existsSync(`${SSR_DIR}/Gameexe.dat`) && fs.existsSync(`${SSR_DIR}/Scene.pck`);

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

test('Full-route crawl regressions: frame_action owner ref, mask intevents, skipTriggerPending, compositeGraphic, input.next, and 0-size drawImage guards', () => {
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
  // 4. Base-driven pipe compositeGraphic syntax without leading (W,H)
  assert.match(displaySrc, /if \(name\.includes\('\|'\)/);
  // 5. input.next yields a frame even outside system scenes & keys record outside systemInput
  assert.match(playerSrc, /await this\.nextInput\(true\)/);
  assert.match(displaySrc, /const pushKey = \(index: number, down: boolean\): void =>/);
  // 6. Zero-dimension drawImage guards
  assert.match(displaySrc, /if \(graphic\.width > 0 && graphic\.height > 0\)/);
  // 7. Native 0x6a7cd0 EXCALL wipe isolation: wiping while excallAllocated only updates systemLayer
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
  assert.match(displaySrc, /appendChildren\([\s\S]{0,600}if \(object\.clip\?\.\[0\]\) \{[\s\S]{0,500}clipBox\.style\.clipPath/);
  assert.match(displaySrc, /const screenX = parentOrigin\[0\] \+ x;/);
  assert.match(displaySrc, /shadowMode === 2 \|\|\s*\(shadowMode === undefined && outlineColor !== undefined && outlineColor >= 0\)/);
});

test('Native 0x650980/0x650bd0 pageInput waits without pendingText (smartphone LIME) and 0x661af0/cf0/c20/e70 play save/load SE', () => {
  const playerSrc = fs.readFileSync(path.join(SIGLUS_DIR, 'player.ts'), 'utf8');
  // 1. pageInput must NOT early-return on !this.pendingText, must flush objectsDirty, and honor autoModeMojiCnt
  assert.doesNotMatch(playerSrc, /private async pageInput\([^)]*\): Promise<void> \{\s*if \(!this\.pendingText\) return;/);
  assert.match(playerSrc, /private async pageInput\([\s\S]{0,350}if \(this\.objectsDirty\) await this\.renderObjects\(\);/);
  assert.match(playerSrc, /const autoChars = this\.autoModeMojiCnt \|\| this\.pageCharacters;/);
  // 2. syscom.save/quick_save play SE.004 when args[2] != 0; syscom.load/quick_load play SE.005 after resetPlayback
  assert.match(playerSrc, /if \(member === 249 \|\| member === 18\)[\s\S]{0,600}if \(n\(2\)\) await this\.playSystemSound\(4\);/);
  assert.match(playerSrc, /if \(member === 256 \|\| member === 20\)[\s\S]{0,600}this\.pendingLoadSound = Boolean\(n\(2\)\);/);
  assert.match(playerSrc, /this\.audio\.resetPlayback\(\);\s*if \(this\.pendingLoadSound\)/);
});
