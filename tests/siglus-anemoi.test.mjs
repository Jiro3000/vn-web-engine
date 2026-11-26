import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import {readPeVersionStrings} from '../dist/formats/pe/version-info.js';
import {readSfntFontData} from '../dist/formats/sfnt.js';
import {parseCgTable} from '../dist/formats/siglus/cgtable.js';
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

const GAME_DIR = '/Volumes/Transcend/Torrents/1GAMES/anemoi';
const installed = fs.existsSync(path.join(GAME_DIR, 'Scene.pck'));

const digests = {
  'SiglusEngine.exe': '778e27f4e629ce8b35498d4788aaa825b0635c344d4ed49af13e851509406d28',
  'Gameexe.dat': 'f614d7edc77ecec80c896e8c9b899601308db89fbe8c4f89f2c325c779453d84',
  'Scene.pck': '18a8573d9b8c550b74334858f320bdfad57ad04343327ce35928880eb0130e77',
  'Version.json': '5e3dcd77493944c9e68eabd2d81e955495533adac40eab53630d9bdcc151d2db',
  'dat/mode.cgm': '07564a4e4db969b67f4e4fd9f60c04511fd848c4fbf4befca71e9ef92d42932b',
  'dat/tcdata.tcr': '79c7b047051e98d03fa60b351d66f7b0f850e6aea12aeb1395a9286400473712',
  'dat/NotoSansCJKjp-DemiLight.otf': '53f8a6290445e414efaf7feac2b4c6d321d371037a772cc04750b7c56bca0267',
  'dat/mplus-1mn-medium.ttf': '1d60ea367b25467830c33f8247dfc36ae2e18882bc5b0edaa4ed9bee50614d0f',
  'dat/ZenMaruGothic-Black.ttf': '80e8bf5787a5b66bd3cef2f54d1d1f00033c2560fab4a55749709bc4709eb573',
  'dat/NotoSansJP-Black.ttf': '290a8fbc5ab2a5dda285c300127dd7b0af73baae1484cf3883b210c1e281fd6a',
  'dat/urace_hunter.dbs': '3ee30b6c3cd53c225a6da987f49419f276b65e256fb3190ab24e9160ae3ee763',
  'dat/urace_item.dbs': '7ba4f355da55a1051e770a23dc8a095018a5fe47b0b16bf3d9abd103a95fa403',
  'dat/urace_npc_uma.dbs': '96c6f830a764e2345c60aa2491146e209e86b4dcc7ae973dd7fe42c7eaa10323',
  'dat/urace_owner.dbs': 'e16da3b840828eaea067d1517932ede0390f9cad89c4f5f04d54bbec2fdf1a72',
  'dat/urace_race.dbs': 'ac8c944181f6b7def33e373d163883ef3a74ec632c7ac138438da6fbb9d6cac8',
  'dat/urace_skill.dbs': '6d123a63ac307d6978056f4c5cf4c5d7b40f907c59a8ee632b5dddad8a1be4d3',
  'dat/urace_trap.dbs': 'a14e8e89054a06ad1c9201cbbbe33efbeaadff043ea484cbaf47a7ad1a93bfbd',
  'dat/urace_uma.dbs': '00ae139957f26bd6d6889fe10be320f6a60d38e23233f41f7f4779aa67d5fa12',
  'mov/anemoi_op.wmv': '7912947b467d2bb981bfa9b38826af39b86e06b9e1e2159025f8e112ec5f6b50',
};

function read(file) {
  return fs.readFileSync(path.join(GAME_DIR, file));
}

test('anemoi release identity and complete Scene.pck bytecode', {skip: !installed}, () => {
  verifyPinnedDigests(GAME_DIR, digests);
  const executable = read('SiglusEngine.exe');
  const gameexe = read('Gameexe.dat');
  const scenePack = read('Scene.pck');
  const version = read('Version.json');
  assert.equal(executable.length, 8_694_784);
  assert.equal(executable.readUInt16LE(executable.readUInt32LE(0x3c) + 4), 0x14c);
  assert.deepEqual(readPeVersionStrings(executable).map(({values}) => values.FileVersion), ['1.1.141.3']);
  assert.equal(gameexe.length, 16_120);
  assert.equal(scenePack.length, 26_654_556);
  assert.equal(version.length, 23);
  assert.deepEqual(JSON.parse(version.toString('utf8')), {version: 11});

  const pack = new SiglusScenePack(scenePack);
  const coverage = auditScenePackBytecode(pack, {
    expectedSceneCount: 538,
    exactInstructions: 8_837_083,
  });
  assert.equal(coverage.commandPaths.size, 773);
  assert.equal(auditScenePackStack(pack), 8_826_483);
});

test('anemoi Gameexe schema, backlog callback, and bundled fonts', {skip: !installed}, () => {
  const config = new SiglusScenePack(read('Scene.pck')).configuration(read('Gameexe.dat'));
  assert.equal(config.size, 816);
  assert.equal(config.get('SAVE.CNT'), '1010');
  assert.equal(config.get('QUICK_SAVE.CNT'), '10');
  assert.equal(config.get('EDITBOX.CNT'), '1');
  assert.equal(config.get('END_SAVE.CNT'), '1');
  assert.equal(config.get('SAVE_HISTORY.CNT'), '32');
  assert.equal(config.get('TATEYOKO_MODE'), '0');
  assert.equal(config.get('MSGBTN.CNT'), '0');
  assert.equal(config.get('SEL_SAVE.CNT'), '1');
  assert.equal(config.get('X_MENU_SCENE'), '"__sys_quick_menu", 00');
  assert.equal(config.get('MSGBK.LOAD_CALL'), '"__sys_dialog", "$$call_backlog_jump_dialog"');
  assert.equal(config.get('CONFIG.FONT.NAME'), '"Noto Sans CJK JP DemiLight"');
  assert.equal(config.get('FONT_FILE.CNT'), '4');

  for (const [index, [file, family, signature]] of [
    ['NotoSansCJKjp-DemiLight.otf', 'Noto Sans CJK JP DemiLight', 0x4f54544f],
    ['mplus-1mn-medium.ttf', 'M+ 1mn medium', 0x00010000],
    ['ZenMaruGothic-Black.ttf', 'Zen Maru Gothic Black', 0x00010000],
    ['NotoSansJP-Black.ttf', 'Noto Sans JP Black', 0x00010000],
  ].entries()) {
    assert.equal(config.get(`FONT_FILE.${String(index).padStart(3, '0')}.NAME`), `"${file}"`);
    const bytes = read(`dat/${file}`);
    assert.equal(bytes.readUInt32BE(0), signature, file);
    if (signature === 0x4f54544f) assert.equal(bytes.length, 16_445_132);
    const faces = readSfntFontData(bytes);
    assert.equal(faces.length, 1, file);
    assert.ok(faces[0].names.some(({unicode}) => unicode === family), file);
  }

  const coverage = auditGameexeCoverage(config, GAME_DIR, {
    expectedScreenSize: '1920, 1080',
    expectedMwndCount: 4,
    // The inline text-button style lookup rejects every index at count zero (0x5edb9a).
    extraAllowlist: [/^MSGBTN\.CNT$/],
  });
  assert.deepEqual(coverage.unclassified, []);
});

test('anemoi packaged assets and exact JS/WASM WMA Pro parity', {skip: !installed}, async () => {
  const cgm = parseCgTable(read('dat/mode.cgm'));
  assert.equal(cgm.version, 2);
  assert.equal(cgm.entries.length, 545);
  assert.equal(cgm.entries[0].name, 'CG_AI01_0101');
  assert.deepEqual(auditToneCurveFile(path.join(GAME_DIR, 'dat/tcdata.tcr')), [0, 1, 3]);
  await auditSiglusAssets(GAME_DIR, {
    dbs: [
      {file: 'dat/urace_hunter.dbs', rows: 23, cols: 11},
      {file: 'dat/urace_item.dbs', rows: 14, cols: 4},
      {file: 'dat/urace_npc_uma.dbs', rows: 259, cols: 6},
      {file: 'dat/urace_owner.dbs', rows: 56, cols: 16},
      {file: 'dat/urace_race.dbs', rows: 17, cols: 13},
      {file: 'dat/urace_skill.dbs', rows: 33, cols: 20},
      {file: 'dat/urace_trap.dbs', rows: 15, cols: 5},
      {file: 'dat/urace_uma.dbs', rows: 33, cols: 12},
    ],
    g00Count: 3_489,
    g00CutCount: 10_857,
    ganCount: 5,
    omvCount: 83,
    endingOmvPrefix: 'anemoi_ed',
    endingOmvCount: 3,
    bgmCount: 71,
    oggCount: 2_517,
    ovkCount: 449,
    sampleLimit: Infinity,
  });
  const movie = path.join(GAME_DIR, 'mov/anemoi_op.wmv');
  assert.equal(fs.statSync(movie).size, 103_755_212);
  const parity = auditWmaParity(movie, {expectedCodec: 0x162, expectedRate: 44_100, maxPackets: Infinity});
  assert.equal(parity.maxDiff, 0);
});
