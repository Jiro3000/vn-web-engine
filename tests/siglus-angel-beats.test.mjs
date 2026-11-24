import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import {BlobSource} from '../dist/core/source.js';
import {parseMwndLayout} from '../dist/engines/siglus/mwnd.js';
import {
  isSiglusInstallation,
  siglusDirectory,
} from '../dist/engines/siglus/installation-markers.js';
import {readSfntFontData} from '../dist/formats/sfnt.js';
import {parseCgTable} from '../dist/formats/siglus/cgtable.js';
import {SiglusDbs} from '../dist/formats/siglus/dbs.js';
import {SiglusScenePack} from '../dist/formats/siglus/scene-pack.js';
import {readSiglusToneCurves} from '../dist/formats/siglus/tonecurve.js';
import {
  auditGameexeCoverage,
  auditScenePackBytecode,
  auditScenePackStack,
  auditSiglusAssets,
  auditToneCurveFile,
  auditWmaParity,
  verifyPinnedDigests,
} from './helpers/siglus-game-suite.mjs';

const GAME_DIR = '/Volumes/Transcend/Torrents/1GAMES/Angel Beats! -1st beat-';
const DATA_DIR = path.join(GAME_DIR, '1st_beat');
const digests = {
  'SiglusEngine.exe': 'c39fb9f8e9486d4fddf3085ee7934287abbff745be4033ef85662c7596c313e0',
  'Select.ini': 'd912b0499c384fbfafb92ad64d2aef271c52230c751ecb79716913e84c6d14dc',
  '1st_beat/Scene.pck': 'a224598a00db2607353ac03c45df56960856e84f6cdac09fc6c891a657156d19',
  '1st_beat/gameexe.dat': 'ad2af92715819d35fdd262c6f9a6a761859ff91622fe1ea6c30db0c8237b99a9',
  '1st_beat/dat/ab1stcg.dbs': 'bfcbca2af26905c29e6e9e770c3b3e4ed47970be3cd0f94b589f92c123f8815b',
  '1st_beat/dat/mode.cgm': 'e3a93678cbb6ca92e36bb9e2c7276a0c566c5fb2df3ddbd99c955645d3f66706',
  '1st_beat/dat/tcdata.tcr': '42e679d3c750dd665046256d807806459398e175ca782d749d2c49f590ac9f18',
  '1st_beat/dat/font01.ttf': '403bedfa178cbda07d751d2f9316a191591f0921e3c936f68f22c0d06e69f984',
  '1st_beat/dat/font02.ttf': '9b12932d3be5e9b3937029acbe8feaa2e11575a4d216d267dce8148fcc040732',
  '1st_beat/mov/OP00.wmv': '25e33f4e52e2d7b1b76c868e3c7dbf1e73747a0d1246cdd159b3742bd4885463',
};
const installed = fs.existsSync(path.join(DATA_DIR, 'Scene.pck'));

function read(rel) {
  return new Uint8Array(fs.readFileSync(path.join(GAME_DIR, rel)));
}

test('Angel Beats -1st beat- nested Select.ini recognition and Scene.pck bytecode', {skip: !installed}, async () => {
  verifyPinnedDigests(GAME_DIR, digests);
  const sceneHeader = fs.readFileSync(path.join(DATA_DIR, 'Scene.pck')).subarray(0, 64);
  const probe = [
    {path: '._SiglusEngine.exe', source: new BlobSource(new Blob([Uint8Array.of(0, 5, 22, 7)]))},
    {path: 'SiglusEngine.exe', source: new BlobSource(new Blob([Uint8Array.of(0x4d, 0x5a)]))},
    {path: 'Select.ini', source: new BlobSource(new Blob([read('Select.ini')]))},
    {path: '1st_beat/._Scene.pck', source: new BlobSource(new Blob([Uint8Array.of(0, 5, 22, 7)]))},
    {path: '1st_beat/Scene.pck', source: new BlobSource(new Blob([sceneHeader]))},
    {path: '1st_beat/gameexe.dat', source: new BlobSource(new Blob([Uint8Array.of(0)]))},
  ];
  assert.equal(siglusDirectory(probe), '1st_beat/');
  assert.equal(await isSiglusInstallation(probe), true);

  const pack = new SiglusScenePack(read('1st_beat/Scene.pck'));
  const coverage = auditScenePackBytecode(pack, {
    expectedSceneCount: 183,
    exactInstructions: 7_126_051,
  });
  assert.equal(coverage.commandPaths.size, 615);
  assert.equal(auditScenePackStack(pack), 7_123_652);
});

test('Angel Beats -1st beat- Gameexe schema, fonts, CGTABLE2, and DBS tables', {skip: !installed}, () => {
  const pack = new SiglusScenePack(read('1st_beat/Scene.pck'));
  const config = pack.configuration(read('1st_beat/gameexe.dat'));
  auditGameexeCoverage(config, DATA_DIR, {
    expectedScreenSize: '1280, 720',
    expectedMwndCount: 6,
  });
  assert.equal(config.get('SAVE.CNT'), '1010');
  assert.equal(config.get('QUICK_SAVE.CNT'), '10');
  assert.equal(config.get('END_SAVE.CNT'), '1');
  assert.equal(config.get('EDITBOX.CNT'), '12');
  assert.equal(config.get('FONT_FILE.CNT'), '2');
  assert.equal(config.get('MSGBK.LOAD_CALL'), '"_sys_com_sys", "$msgbk_btn_load"');
  assert.equal(config.get('CONFIG.FONT.NAME'), '"モトヤLシータ゛3等幅"');
  for (const index of [0, 1, 2, 3, 4, 5]) {
    const layout = parseMwndLayout(config, index);
    assert.deepEqual(layout.windowSize.length, 2);
  }

  const cg = parseCgTable(read('1st_beat/dat/mode.cgm'));
  assert.equal(cg.version, 2);
  assert.equal(cg.entries.length, 304);
  assert.equal(cg.byName.get('evak_01a'), 0);

  const dbs = new SiglusDbs(read('1st_beat/dat/ab1stcg.dbs'));
  assert.equal(dbs.rowCount, 264);
  assert.deepEqual(
    dbs.columns.map((col) => col.type),
    ['S', 'S', 'V', 'V', 'V', 'V', 'S'],
  );
  assert.equal(dbs.hasRow(dbs.rowIds[0]), true);
  assert.equal(dbs.hasRow(999_999), false);
  assert.equal(dbs.checkColumn(0), 1);
  assert.equal(dbs.checkColumn(2), 2);
  assert.equal(dbs.checkColumn(999), 0);

  const [maru] = readSfntFontData(read('1st_beat/dat/font01.ttf'));
  const [cedar] = readSfntFontData(read('1st_beat/dat/font02.ttf'));
  assert.ok(maru.names.some((n) => n.unicode === 'MotoyaLMaru'));
  assert.ok(cedar.names.some((n) => n.unicode === 'MotoyaLCedar'));
});

test('Angel Beats -1st beat- packaged assets and exact JS/WASM WMA parity', {skip: !installed}, async () => {
  assert.deepEqual(auditToneCurveFile(path.join(DATA_DIR, 'dat/tcdata.tcr')), [0, 1, 2, 3, 4, 5, 6, 7, 8, 9]);
  const curves = readSiglusToneCurves(read('1st_beat/dat/tcdata.tcr'));
  assert.equal(curves.size, 10);

  await auditSiglusAssets(DATA_DIR, {
    dbs: [{file: 'dat/ab1stcg.dbs', rows: 264, cols: 7}],
    ganCount: 1,
    omvCount: 97,
    bgmOggCount: 89,
    nwaCount: 0,
    oggCount: 309,
    ovkCount: 55,
    g00Count: 2621,
    g00CutCount: 8814,
    sampleLimit: Infinity,
  });

  const wma = auditWmaParity(path.join(DATA_DIR, 'mov', 'OP00.wmv'), {
    expectedCodec: 0x161,
    expectedRate: 48000,
    maxPackets: Infinity,
  });
  assert.equal(wma.frames, 1044);
  assert.equal(wma.maxDiff, 0);
});
