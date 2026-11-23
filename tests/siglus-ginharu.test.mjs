import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import {
  parseButtonActionStates,
  parseButtonSe,
  parseMwndLayout,
} from '../dist/engines/siglus/mwnd.js';
import {SiglusScenePack} from '../dist/formats/siglus/scene-pack.js';
import {readSfntFontData} from '../dist/formats/sfnt.js';
import {readSiglusToneCurves} from '../dist/formats/siglus/tonecurve.js';
import {decodeNwa, openNwa} from '../dist/formats/siglus/sound.js';
import {
  auditGameexeCoverage,
  auditScenePackBytecode,
  auditScenePackStack,
  auditSiglusAssets,
  auditToneCurveFile,
  auditWmaParity,
  verifyPinnedDigests,
} from './helpers/siglus-game-suite.mjs';

const GAME_DIR = '/Volumes/Transcend/Torrents/1GAMES/GinHaru';
const digests = {
  'SiglusEngine.exe': 'da87e1ac7e7138de6ad92bad1b69036a8363ebd4974784ede7eff65a1dabd7d5',
  'Gameexe.dat': '027bede1229f944b50256551c0b590c6b87128afaf380d0bbcac44f395409e95',
  'Scene.pck': 'a61fe33f7d144a667709fa30f58181ebe5d70da2f51ead34430fcc664622c354',
  'dat/BGM_LIST.dbs': 'ebffbc1bbe5d2c894665a919ec74d5df6da26bdee80550b0dba6d654557d56b2',
  'dat/CALENDAR.dbs': '72d03b6ec75dc134bbfd220894f2c21a3e92ac4b8b7af809fa41fc0149119ab4',
  'dat/name_chg.dbs': '45e0b0401f9766634dc53c809fb83b46d39921830b4ea5594ff967294bcd3e19',
  'dat/tcdata.tcr': '2df769768bf295605efdc05929923a86938797d458f8cca1f079a4f15713646a',
  'dat/font01.ttf': '403bedfa178cbda07d751d2f9316a191591f0921e3c936f68f22c0d06e69f984',
  'dat/font02.ttf': '9b12932d3be5e9b3937029acbe8feaa2e11575a4d216d267dce8148fcc040732',
  'mov/logo.wmv': '2f6fbfb236fbf10b2c0e30dde1b44d778cf822540092c8cd84da932d6338e11d',
  'mov/opmv.wmv': 'ad5334f3566f17be7819fd81e6039ef0f1b8450901cb39983647106bec6dff34',
};
const installed = fs.existsSync(path.join(GAME_DIR, 'Scene.pck'));

function read(name) {
  return new Uint8Array(fs.readFileSync(path.join(GAME_DIR, name)));
}

test('GinHaru release identity and complete Scene.pck bytecode', {skip: !installed}, () => {
  verifyPinnedDigests(GAME_DIR, digests);
  const pack = new SiglusScenePack(read('Scene.pck'));
  const coverage = auditScenePackBytecode(pack, {
    expectedSceneCount: 442,
    exactInstructions: 4_322_551,
  });
  assert.equal(coverage.commandPaths.size, 722);
  assert.equal(auditScenePackStack(pack), 4_317_137);
});

test('GinHaru Gameexe schema, message windows and buttons', {skip: !installed}, () => {
  const config = new SiglusScenePack(read('Scene.pck')).configuration(read('Gameexe.dat'));
  auditGameexeCoverage(config, GAME_DIR, {
    expectedScreenSize: '1280, 720',
    expectedMwndCount: 4,
    expectedSpaceHide: [58, 79, 120],
  });
  assert.equal(config.get('SAVE.CNT'), '171');
  assert.equal(config.get('QUICK_SAVE.CNT'), '11');
  assert.equal(config.nameEntries.length, 11);
  assert.match(config.nameEntries[0], /"？？？／ベスリー"\s*,\s*"？？？"/);
  assert.match(config.nameEntries[10], /"Ｈ＿結羽"\s*,\s*"％Ｅ"/);
  assert.equal(config.get('NAMAE'), config.nameEntries[10]);
  for (const index of [0, 1, 2, 3]) {
    const layout = parseMwndLayout(config, index);
    assert.deepEqual(layout.windowPos, [0, index < 2 ? 560 : 700]);
    assert.deepEqual(layout.windowSize, [1280, index < 2 ? 207 : 0]);
    assert.equal(layout.nameExtendType, 0);
  }
  assert.equal(parseButtonActionStates(config, 1).select.cutOffset, 3);
  assert.deepEqual(parseButtonSe(config, 7), {hit: 13, push: -1, decide: 14});
});

test('GinHaru packaged assets and exact JS/WASM WMA parity', {skip: !installed}, async () => {
  assert.deepEqual(auditToneCurveFile(path.join(GAME_DIR, 'dat/tcdata.tcr')), [1, 2, 3, 4, 30]);
  const curves = readSiglusToneCurves(read('dat/tcdata.tcr'));
  assert.equal(curves.get(1).monochrome, 0);
  assert.equal(curves.get(2).monochrome, 100 / 255);
  assert.equal(curves.get(30).monochrome, 1);
  assert.deepEqual(curves.get(1).channels.map((channel) => [...channel.subarray(0, 6)]), [
    [0, 1, 2, 4, 5, 7], [0, 1, 2, 3, 5, 6], [0, 0, 1, 2, 3, 4],
  ]);
  for (const file of ['dat/font01.ttf', 'dat/font02.ttf']) {
    const faces = readSfntFontData(read(file));
    assert.equal(faces.length, 1, file);
    assert.ok(faces[0].unitsPerEm > 0 && faces[0].names.length > 0, file);
  }
  await auditSiglusAssets(GAME_DIR, {
    dbs: [
      {file: 'dat/BGM_LIST.dbs', rows: 54, cols: 5},
      {file: 'dat/CALENDAR.dbs', rows: 66, cols: 32},
      {file: 'dat/name_chg.dbs', rows: 3, cols: 2},
    ],
    ganCount: 2,
    omvCount: 51,
    endingOmvPrefix: 'sr_',
    endingOmvCount: 5,
    endingOmvSize: [1280, 720],
    bgmNwaCount: 65,
    nwaCount: 763,
    oggCount: 3,
    ovkCount: 390,
    g00Count: 3359,
    g00CutCount: 146_519,
    sampleLimit: Infinity,
  });
  for (const name of ['logo.wmv', 'opmv.wmv']) {
    auditWmaParity(path.join(GAME_DIR, 'mov', name), {
      expectedCodec: 0x161,
      expectedRate: 44100,
      maxPackets: Infinity,
    });
  }
});

test('GinHaru NWA sample seeks decode only the requested block range', {skip: !installed}, async () => {
  const bytes = read('bgm/BGM101.nwa');
  const full = decodeNwa(bytes);
  const reads = [];
  const source = await openNwa({
    size: bytes.length,
    read: async (offset, length) => {
      reads.push({offset, length});
      return bytes.subarray(offset, offset + length);
    },
  });
  assert.equal(source.rate, full.rate);
  assert.equal(source.channels, full.channels);
  assert.equal(source.frames * source.channels, full.pcm.length);
  for (const start of [0, 253, Math.floor(source.frames / 2), source.frames - 1027]) {
    const count = 1027;
    assert.deepEqual(await source.read(start, count), full.pcm.subarray(start * 2, (start + count) * 2));
  }
  assert.equal(reads.length, 6);
  assert.ok(reads.reduce((total, {length}) => total + length, 0) < bytes.length / 100);
  await assert.rejects(source.read(source.frames, 1), /Invalid range/);
});
