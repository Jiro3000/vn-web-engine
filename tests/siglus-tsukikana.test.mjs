import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import {
  parseButtonActionStates,
  parseButtonSe,
  parseMwndAnimation,
  parseMwndColors,
} from '../dist/engines/siglus/mwnd.js';
import {SiglusScenePack} from '../dist/formats/siglus/scene-pack.js';
import {
  auditGameexeCoverage,
  auditScenePackBytecode,
  auditSiglusAssets,
  auditWmaParity,
  verifyPinnedDigests,
} from './helpers/siglus-game-suite.mjs';

const REPO_ROOT = path.resolve(import.meta.dirname, '..');
const SIGLUS_DIR = path.join(REPO_ROOT, 'src/engines/siglus');
const TK_DIR = '/Volumes/Transcend/Torrents/1GAMES/Tsuki no Kanata de Aimashou';
const HAS_TK =
  fs.existsSync(`${TK_DIR}/SiglusEngine.exe`) &&
  fs.existsSync(`${TK_DIR}/Gameexe.dat`) &&
  fs.existsSync(`${TK_DIR}/Scene.pck`);

test('Tsukikana engine fixes: global 115, cgtable 78.*, pcmevent 52.* oneshot/loop/wait/check, VK_SPACE 0x623b80, backlog MSG_DOWN_BTN z-order, and unhandled telemetry', () => {
  const playerSrc = fs.readFileSync(path.join(SIGLUS_DIR, 'player.ts'), 'utf8');
  const displaySrc = fs.readFileSync(path.join(SIGLUS_DIR, 'display.ts'), 'utf8');

  // 1. Native 0x54f140 / 0x650bd0: global 115 (0x73) triggers pageInput(true)
  assert.match(playerSrc, /case 115:[\s\S]{0,200}await this\.pageInput\(true\)/);

  // 2. Native 0x559a80: cgtable root 78 full command surface (1, 2, 3, 4, 5, 6, 7, 8, 9)
  assert.match(playerSrc, /if \(root === 78\)/);
  assert.match(playerSrc, /if \(member === 1\)/);
  assert.match(playerSrc, /if \(member === 3\)/);
  assert.match(playerSrc, /if \(member === 4\) return new Set\(this\.cgTable\.values\(\)\)\.size;/);
  assert.match(playerSrc, /if \(member === 9\)/);

  // 3. Native 0x55fe50: pcmevent[slot] modes 0 (oneshot), 1 (loop), 4/6 (wait), 5 (check)
  assert.match(playerSrc, /private startPcmEventSequence\(/);
  assert.match(playerSrc, /this\.startPcmEventSequence\(slot, pcmchNo, entries, opts, op === 1\)/);
  assert.match(playerSrc, /if \(op === 5\)/);

  // 4. Native 0x623b80: VK_SPACE (0x20) toggles hide_mwnd without advancing dialogue
  assert.match(displaySrc, /toggleHideMessage\?: \(\) => boolean/);
  assert.match(displaySrc, /event\.key === ' ' &&[\s\S]{0,180}toggleHideMessage\?\.\(\)/);
  assert.match(playerSrc, /0x623b80[\s\S]{0,600}this\.setUserMessageHidden\(true\)/);

  // 5. Backlog slider track must be appended BEFORE MSG_UP_BTN / MSG_DOWN_BTN so down arrow is hit-testable
  const trackIdx = displaySrc.indexOf('overlay.append(track);');
  const upIdx = displaySrc.indexOf("makeButton('MSG_UP_BTN'");
  const downIdx = displaySrc.indexOf("makeButton('MSG_DOWN_BTN'");
  assert.ok(trackIdx > 0 && upIdx > 0 && downIdx > 0);
  assert.ok(
    trackIdx < upIdx && trackIdx < downIdx,
    'Backlog slider track must be appended before MSG_UP_BTN and MSG_DOWN_BTN',
  );

  // 6. Runtime unhandled command/property telemetry exposed on debugSnapshot()
  assert.match(playerSrc, /unhandledCommands: \[\.\.\.this\.unhandledCommands\]/);
  assert.match(playerSrc, /unhandledProperties: \[\.\.\.this\.unhandledProperties\]/);
});

test(
  'Tsuki no Kanata de Aimashou pinned SHA-256 digests and 100% bytecode coverage across all 326 scenes',
  {skip: !HAS_TK},
  () => {
    verifyPinnedDigests(TK_DIR, {
      'SiglusEngine.exe': '2fd87b8186d768492a840987427c1db299854587fa47f00095b140128dcd70fd',
      'Gameexe.dat': '1c6d74be00c53b7a9784c93582ed6f1805fd20166f03b66d9a21ea1e93275c32',
      'Scene.pck': '64de8f467707b48b3765629fedbdc4f19b6433e6073506dbbdeabc0e93b97f97',
      'dat/BGM_LIST.dbs': 'ebffbc1bbe5d2c894665a919ec74d5df6da26bdee80550b0dba6d654557d56b2',
      'dat/CALENDAR.dbs': '72d03b6ec75dc134bbfd220894f2c21a3e92ac4b8b7af809fa41fc0149119ab4',
      'dat/G00list.dbs': '9db4844c3a30f3f68c0fde568fb321e9a3d8b0fe23c37b96920e83c56adf6d23',
      'dat/tcdata.tcr': 'd996af9c7d3569f46ad8e1f06535271e8f0eb07451d662ed8fd3c9850f2bedb2',
      'dat/font01.ttf': '403bedfa178cbda07d751d2f9316a191591f0921e3c936f68f22c0d06e69f984',
      'dat/font02.ttf': '9b12932d3be5e9b3937029acbe8feaa2e11575a4d216d267dce8148fcc040732',
      'mov/logo.wmv': '9d2432edac7db1e0814417a82e3eb101bde8c7c6d4f66853256f4854f7dd5ff9',
      'mov/OP.wmv': 'ddc14584ef8b0f8f3ebaf6260da7c635be291afc56f3069793ba3354aeef2558',
    });

    const pack = new SiglusScenePack(new Uint8Array(fs.readFileSync(path.join(TK_DIR, 'Scene.pck'))));
    auditScenePackBytecode(pack, {
      expectedSceneCount: 326,
      exactInstructions: 3_188_290,
    });
  },
);

test(
  'Tsuki no Kanata de Aimashou Gameexe.dat 100% schema coverage & 1920x1080 static geometry invariants',
  {skip: !HAS_TK},
  () => {
    const pack = new SiglusScenePack(new Uint8Array(fs.readFileSync(path.join(TK_DIR, 'Scene.pck'))));
    const cfg = pack.configuration(new Uint8Array(fs.readFileSync(path.join(TK_DIR, 'Gameexe.dat'))));

    assert.deepEqual(parseMwndColors(cfg, 0), {mojiColor: 0, shadowColor: 1, fuchiColor: 1});
    assert.deepEqual(parseButtonSe(cfg, 7), {hit: 13, push: -1, decide: 14});
    assert.equal(parseButtonActionStates(cfg, 1).select.cutOffset, 3);
    assert.deepEqual(parseMwndAnimation(cfg, 0, 'open'), {type: 1, time: 200});

    auditGameexeCoverage(cfg, TK_DIR, {
      expectedScreenSize: '1920, 1080',
      expectedMwndCount: 6,
      expectedSpaceHide: [47, 58, 79, 120, 121],
    });
  },
);

test(
  'Tsuki no Kanata de Aimashou dat/*.dbs, gan/*.gan, mov/*.omv, bgm/*.owp, wav/*.nwa, and koe/*.ovk parse cleanly',
  {skip: !HAS_TK},
  async () => {
    await auditSiglusAssets(TK_DIR, {
      dbs: [
        {file: 'dat/BGM_LIST.dbs', rows: 54, cols: 5},
        {file: 'dat/CALENDAR.dbs', rows: 66, cols: 32},
        {file: 'dat/G00list.dbs', rows: 3001, cols: 1},
      ],
      ganCount: 5,
      omvCount: 28,
      endingOmvPrefix: 'SR_',
      endingOmvCount: 7,
      endingOmvSize: [1920, 1080],
      bgmCount: 49,
      nwaCount: 363,
      ovkCount: 271,
    });
  },
);

test(
  'Tsuki no Kanata de Aimashou mov/logo.wmv and mov/OP.wmv decode identically across JS and WASM WMA v2',
  {skip: !HAS_TK},
  () => {
    auditWmaParity(path.join(TK_DIR, 'mov/logo.wmv'), {expectedCodec: 0x161, expectedRate: 44100});
    auditWmaParity(path.join(TK_DIR, 'mov/OP.wmv'), {expectedCodec: 0x161, expectedRate: 48000});
  },
);
