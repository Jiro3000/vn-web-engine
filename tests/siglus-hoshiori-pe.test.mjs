import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import {readPeVersionStrings} from '../dist/formats/pe/version-info.js';
import {readSfntFontData} from '../dist/formats/sfnt.js';
import {SiglusScenePack} from '../dist/formats/siglus/scene-pack.js';
import {
  auditGameexeCoverage,
  auditScenePackBytecode,
  auditScenePackStack,
  auditSiglusAssets,
  auditToneCurveFile,
  auditWmaParity,
  verifyPinnedDigests,
} from './helpers/siglus-game-suite.mjs';

const GAME_DIR = '/Volumes/Transcend/Torrents/1GAMES/Hoshi Ori Yume Mirai - Perfect Edition';
const installed = fs.existsSync(path.join(GAME_DIR, 'Scene.pck'));
const digests = {
  'SiglusEngine.exe': 'e34f5b020a85e2108b1b4dc6e253eebdd4148734326f4eeb5ce7f63bbf1d99dd',
  'Gameexe.dat': 'd4ad0dd8da164e8b1180387aaa71560678eee8e89765506efd50473dbea9a9f0',
  'Scene.pck': '234741eb59f73bd78becf4367dcbd3b2e481e639654c4a03a17787579dab5c71',
  'dat/BGM_LIST.dbs': 'ebffbc1bbe5d2c894665a919ec74d5df6da26bdee80550b0dba6d654557d56b2',
  'dat/CALENDAR.dbs': 'e428ba48501040ec069290d68dcc7f9441a50e7a9f22a097fe7f099b8544bb9d',
  'dat/name_chg.dbs': '45e0b0401f9766634dc53c809fb83b46d39921830b4ea5594ff967294bcd3e19',
  'dat/tcdata.tcr': 'ab741787cc8324f7fa57be29d329ef8fbf76f3b25ba98c454472f5ead5fcc7ca',
  'dat/font01.ttf': '403bedfa178cbda07d751d2f9316a191591f0921e3c936f68f22c0d06e69f984',
  'dat/font02.ttf': '9b12932d3be5e9b3937029acbe8feaa2e11575a4d216d267dce8148fcc040732',
  'mov/logo.wmv': 'b63703ec2a2aa7f16f3e1a7f260ce6cf4c9e7b27e029120f86a30834980977fb',
  'mov/OPMV.wmv': '928ced30a128deb765acc00bf16d15254e092746416ddc625c9e11f205883547',
};

const additionalCommandPaths = [
  // At _00grp:0xa82f the flattened inventory records the preceding literal.
  // CD_PROPERTY dereferences the form-1310 local before this child-list resize.
  '35.0.93.4',
  '37.2.-1.*.93.-1.*.160',
  '37.2.-1.*.93.-1.*.63.2',
  '37.2.-1.*.93.-1.*.93.-1.*.38',
  '37.2.-1.*.93.-1.*.93.-1.*.97',
  '38.2.-1.*.67.5',
  '49.-1.*.2.-1.*.93.-1.*.112.-1.*.0',
  '49.-1.*.2.-1.*.93.-1.*.160',
  '49.-1.*.2.-1.*.93.-1.*.63.2',
  '65.-1.*.0.-1.*.2.-1.*.93.-1.*.132',
  '65.-1.*.0.-1.*.2.-1.*.93.-1.*.133',
  '65.-1.*.0.-1.*.2.-1.*.93.-1.*.134',
  '65.-1.*.1.2.-1.*.93.-1.*.42',
  '65.-1.*.1.2.-1.*.93.-1.*.68.4',
  '83.2097152008.3',
  '83.2097152009.6',
  '83.2097152010.2',
];

function read(file) {
  return fs.readFileSync(path.join(GAME_DIR, file));
}

test('Hoshi Ori Perfect Edition release identity and complete Scene.pck bytecode', {skip: !installed}, () => {
  verifyPinnedDigests(GAME_DIR, digests);
  const executable = read('SiglusEngine.exe');
  const gameexe = read('Gameexe.dat');
  const scenePack = read('Scene.pck');
  assert.equal(executable.length, 9_604_608);
  assert.equal(gameexe.length, 18_368);
  assert.equal(scenePack.length, 20_138_386);
  assert.deepEqual(readPeVersionStrings(executable).map(({values}) => values.FileVersion), ['1.1.137.0']);

  const pack = new SiglusScenePack(scenePack);
  const coverage = auditScenePackBytecode(pack, {
    expectedSceneCount: 510,
    exactInstructions: 3_550_750,
  });
  assert.equal(coverage.commandPaths.size, 688);
  for (const command of additionalCommandPaths) {
    assert.ok(coverage.commandPaths.has(command), `Missing command path ${command}`);
  }
  assert.equal(auditScenePackStack(pack), 3_544_996);
});

test('Hoshi Ori Perfect Edition Gameexe schema, backlog callback, and bundled fonts', {skip: !installed}, () => {
  const config = new SiglusScenePack(read('Scene.pck')).configuration(read('Gameexe.dat'));
  const coverage = auditGameexeCoverage(config, GAME_DIR, {
    expectedScreenSize: '1920, 1080',
    expectedMwndCount: 4,
    expectedSpaceHide: [58, 79, 120],
  });
  assert.deepEqual(coverage.unclassified, []);
  assert.equal(config.size, 1_003);
  assert.equal(config.get('SAVE.CNT'), '111');
  assert.equal(config.get('QUICK_SAVE.CNT'), '11');
  assert.equal(config.get('MSGBK.LOAD_CALL'), '"_00com", "$msgbk_btn_load"');
  assert.equal(config.get('CONFIG.FONT.NAME'), '"モトヤLシータ゛3等幅"');
  assert.equal(config.get('FONT_FILE.CNT'), '2');
  for (const [index, file, family] of [
    ['000', 'font02.ttf', 'MotoyaLCedar'],
    ['001', 'font01.ttf', 'MotoyaLMaru'],
  ]) {
    assert.equal(config.get(`FONT_FILE.${index}.NAME`), `"${file}"`);
    const faces = readSfntFontData(read(`dat/${file}`));
    assert.equal(faces.length, 1);
    assert.ok(faces[0].names.some(({unicode}) => unicode === family), file);
  }
});

test('Hoshi Ori Perfect Edition packaged assets and exact JS/WASM WMA parity', {skip: !installed}, async () => {
  assert.deepEqual(auditToneCurveFile(path.join(GAME_DIR, 'dat/tcdata.tcr')), [1, 2, 3, 30]);
  await auditSiglusAssets(GAME_DIR, {
    dbs: [
      {file: 'dat/BGM_LIST.dbs', rows: 54, cols: 5},
      {file: 'dat/CALENDAR.dbs', rows: 72, cols: 21},
      {file: 'dat/name_chg.dbs', rows: 3, cols: 2},
    ],
    ganCount: 2,
    omvCount: 40,
    endingOmvPrefix: 'ed_',
    endingOmvCount: 7,
    bgmNwaCount: 55,
    nwaCount: 582,
    oggCount: 3,
    ovkCount: 594,
    g00Count: 3_895,
    g00CutCount: 141_067,
    sampleLimit: Infinity,
  });
  for (const [file, expectedRate] of [['logo.wmv', 44_100], ['OPMV.wmv', 48_000]]) {
    const parity = auditWmaParity(path.join(GAME_DIR, 'mov', file), {
      expectedCodec: 0x161,
      expectedRate,
      maxPackets: Infinity,
    });
    assert.equal(parity.maxDiff, 0, file);
  }
});
