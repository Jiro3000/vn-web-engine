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

const GAME_DIR = '/Volumes/Transcend/Torrents/1GAMES/Hoshi Ori Yume Mirai - Rikka to Anata';
const digests = {
  'SiglusEngine.exe': '251c57cecde9613a5da9f3e9a99c23e1a47019f9efacbbf83e215dad829fa2f9',
  'Gameexe.dat': '054d2d1aee9688d81fa0ee3aecc066e13a76af3766dc384b7d7c3d45be5fc55d',
  'Scene.pck': '7db33188e47ac6ecbff808d06c38632946391575af88e1e0444ae491495ee283',
  'dat/BGM_LIST.dbs': '5af6b7c9a34d6fe477693cab70020d55b10a93f11aff65510d1059ac5f4907bd',
  'dat/CALENDAR.dbs': 'e428ba48501040ec069290d68dcc7f9441a50e7a9f22a097fe7f099b8544bb9d',
  'dat/name_chg.dbs': '45e0b0401f9766634dc53c809fb83b46d39921830b4ea5594ff967294bcd3e19',
  'dat/tcdata.tcr': 'ab741787cc8324f7fa57be29d329ef8fbf76f3b25ba98c454472f5ead5fcc7ca',
  'mov/logo.wmv': 'b63703ec2a2aa7f16f3e1a7f260ce6cf4c9e7b27e029120f86a30834980977fb',
};
const installed = fs.existsSync(path.join(GAME_DIR, 'Scene.pck'));

function read(name) {
  return new Uint8Array(fs.readFileSync(path.join(GAME_DIR, name)));
}

test('Hoshi Ori Rikka release identity and complete Scene.pck bytecode', {skip: !installed}, () => {
  verifyPinnedDigests(GAME_DIR, digests);
  const pack = new SiglusScenePack(read('Scene.pck'));
  const coverage = auditScenePackBytecode(pack, {
    expectedSceneCount: 53,
    exactInstructions: 216_751,
  });
  assert.equal(coverage.commandPaths.size, 544);
  assert.equal(auditScenePackStack(pack), 213_351);
});

test('Hoshi Ori Rikka Gameexe schema, message windows and buttons', {skip: !installed}, () => {
  const config = new SiglusScenePack(read('Scene.pck')).configuration(read('Gameexe.dat'));
  auditGameexeCoverage(config, GAME_DIR, {
    expectedScreenSize: '1280, 720',
    expectedMwndCount: 4,
    expectedSpaceHide: [58, 79, 120],
  });
  assert.equal(config.get('SAVE.CNT'), '111');
  assert.equal(config.get('QUICK_SAVE.CNT'), '11');
  assert.equal(config.nameEntries.length, 16);
  assert.match(config.nameEntries[0], /"？？？／涼介"\s*,\s*"？？？"/);
  assert.match(config.nameEntries[15], /"美砂／回想"\s*,\s*"美砂"/);
  for (const index of [0, 1, 2, 3]) {
    const layout = parseMwndLayout(config, index);
    assert.deepEqual(layout.windowPos, [0, index < 2 ? 560 : 687]);
    assert.deepEqual(layout.windowSize, [1280, 207]);
    assert.equal(layout.nameExtendType, 0);
  }
  assert.equal(parseButtonActionStates(config, 1).select.cutOffset, 3);
  assert.deepEqual(parseButtonSe(config, 7), {hit: 13, push: -1, decide: 14});
});

test('Hoshi Ori Rikka packaged assets and exact JS/WASM WMA parity', {skip: !installed}, async () => {
  assert.deepEqual(auditToneCurveFile(path.join(GAME_DIR, 'dat/tcdata.tcr')), [1, 2, 3, 30]);
  const curves = readSiglusToneCurves(read('dat/tcdata.tcr'));
  assert.equal(curves.get(1).monochrome, 0);
  assert.equal(curves.get(2).monochrome, 100 / 255);
  assert.equal(curves.get(3).monochrome, 131 / 255);
  assert.equal(curves.get(30).monochrome, 1);
  await auditSiglusAssets(GAME_DIR, {
    dbs: [
      {file: 'dat/BGM_LIST.dbs', rows: 43, cols: 4},
      {file: 'dat/CALENDAR.dbs', rows: 72, cols: 21},
      {file: 'dat/name_chg.dbs', rows: 3, cols: 2},
    ],
    ganCount: 2,
    omvCount: 10,
    bgmOggCount: 11,
    nwaCount: 34,
    oggCount: 3,
    ovkCount: 0,
    g00Count: 264,
    g00CutCount: 1_042,
    sampleLimit: Infinity,
  });
  auditWmaParity(path.join(GAME_DIR, 'mov', 'logo.wmv'), {
    expectedCodec: 0x161,
    expectedRate: 44100,
    maxPackets: Infinity,
  });
});

test('Hoshi Ori Rikka NWA sample seeks decode only the requested block range', {skip: !installed}, async () => {
  const bytes = read('wav/SE0111.nwa');
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
  assert.ok(reads.reduce((total, {length}) => total + length, 0) < bytes.length / 50);
  await assert.rejects(source.read(source.frames, 1), /Invalid range/);
});
