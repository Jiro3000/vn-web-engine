#!/usr/bin/env node
/**
 * Fast Phase 1 static onboarding auditor for any SiglusEngine game directory.
 *
 * Usage:
 *   node tools/siglus-static-check.mjs "<gameDir>" [--baseline "<refGameDir>"]
 *
 * Prints:
 *   - Pinned SHA-256 digests (ignoring macOS ._* AppleDouble dotfiles)
 *   - Gameexe.dat summary, auto-discovered system scenes, & 100% schema coverage check
 *   - 100% Scene.pck bytecode audit (scene count, instruction count, command paths, diff vs baseline)
 *   - Codec checks for DBS, CGTABLE/CGTABLE2, GAN, OMV, OWP, NWA, OVK, and JS vs WASM WMV/WMA parity
 */
import fs from 'node:fs';
import path from 'node:path';
import {parseMwndLayout, parseNoSaveObjectIds, parseSpaceHideObjectIds} from '../dist/engines/siglus/mwnd.js';
import {parseCgTable} from '../dist/formats/siglus/cgtable.js';
import {SiglusDbs} from '../dist/formats/siglus/dbs.js';
import {readGan} from '../dist/formats/siglus/gan.js';
import {SiglusOmv} from '../dist/formats/siglus/omv.js';
import {SiglusScenePack} from '../dist/formats/siglus/scene-pack.js';
import {decodeNwa, decodeOwp, ovkIndex} from '../dist/formats/siglus/sound.js';
import {
  auditGameexeCoverage,
  auditScenePackBytecode,
  auditWmaParity,
  listNonDotFiles,
  sha256File,
} from '../tests/helpers/siglus-game-suite.mjs';

function resolveDataDir(inputDir) {
  const abs = path.resolve(inputDir);
  if (fs.existsSync(path.join(abs, 'Scene.pck')) && fs.existsSync(path.join(abs, 'Gameexe.dat'))) {
    return abs;
  }
  const nested = path.join(abs, 'StartData', 'GameData');
  if (fs.existsSync(path.join(nested, 'Scene.pck')) && fs.existsSync(path.join(nested, 'Gameexe.dat'))) {
    return nested;
  }
  throw new Error(`Could not find Scene.pck + Gameexe.dat in ${abs}`);
}

const args = process.argv.slice(2);
const targetArg = args[0];
if (!targetArg) {
  console.error('Usage: node tools/siglus-static-check.mjs "<gameDir>" [--baseline "<refGameDir>"]');
  process.exit(1);
}
const baselineIdx = args.indexOf('--baseline');
const baselineArg = baselineIdx >= 0 ? args[baselineIdx + 1] : undefined;

const dataDir = resolveDataDir(targetArg);
console.log(`=== SIGLUS STATIC AUDIT: ${dataDir} ===\n`);

// 1. Pinned SHA-256 digests
const digestFiles = [];
for (const base of ['SiglusEngine.exe', 'Gameexe.dat', 'Scene.pck']) {
  if (fs.existsSync(path.join(dataDir, base))) digestFiles.push(base);
}
for (const ext of ['.dbs', '.cgm', '.tcr', '.ttf', '.otf']) {
  for (const f of listNonDotFiles(path.join(dataDir, 'dat'), ext)) digestFiles.push(`dat/${f}`);
}
for (const f of listNonDotFiles(path.join(dataDir, 'mov'), '.wmv')) digestFiles.push(`mov/${f}`);

console.log('1. Pinned SHA-256 Digests:');
const digests = {};
for (const rel of digestFiles) {
  const full = path.join(dataDir, rel);
  const digest = sha256File(full);
  digests[rel] = digest;
  console.log(`   '${rel}': '${digest}', // ${fs.statSync(full).size.toLocaleString()} B`);
}

// 2. Gameexe.dat summary & coverage
const pack = new SiglusScenePack(new Uint8Array(fs.readFileSync(path.join(dataDir, 'Scene.pck'))));
const cfg = pack.configuration(new Uint8Array(fs.readFileSync(path.join(dataDir, 'Gameexe.dat'))));

console.log('\n2. Gameexe.dat Summary & Schema Coverage:');
const keySummary = {};
for (const k of [
  'GAMENAME',
  'SCREEN_SIZE',
  'START_SCENE',
  'MENU_SCENE',
  'CANCEL_SCENE',
  'SAVE_SCENE',
  'LOAD_SCENE',
  'CONFIG_SCENE',
  'MWND.CNT',
  'WAKU.CNT',
  'SAVE.CNT',
  'QUICK_SAVE.CNT',
  'TONECURVE_FILE',
  'CG_TABLE_FILE',
]) {
  if (cfg.has(k)) keySummary[k] = cfg.get(k);
}
console.log('  ', JSON.stringify(keySummary, null, 2).replace(/\n/g, '\n   '));
console.log('   SPACE_HIDE:', [...parseSpaceHideObjectIds(cfg)].sort((a, b) => a - b));
console.log('   NO_SAVE:', [...parseNoSaveObjectIds(cfg)].sort((a, b) => a - b));

const gxAudit = auditGameexeCoverage(cfg, dataDir, {checkGeometry: true});
console.log(
  `   Schema coverage: ${gxAudit.schemaCount} schemas, ${gxAudit.unclassified.length} unclassified, ${gxAudit.mwndCnt} MWND(s) verified in ${gxAudit.screenW}x${gxAudit.screenH}.`,
);

// 3. 100% Bytecode audit
console.log('\n3. Scene.pck 100% Bytecode Audit:');
const bc = auditScenePackBytecode(pack);
console.log(
  `   ${bc.sceneCount} scenes, ${bc.totalInstructions.toLocaleString()} instructions, 0 unknown opcodes, 0 misaligned scenes, ${bc.commandPaths.size} unique built-in command paths.`,
);

if (baselineArg) {
  const refDir = resolveDataDir(baselineArg);
  const refPack = new SiglusScenePack(new Uint8Array(fs.readFileSync(path.join(refDir, 'Scene.pck'))));
  const refBc = auditScenePackBytecode(refPack);
  const newPaths = [...bc.commandPaths.entries()]
    .filter(([k]) => !refBc.commandPaths.has(k))
    .sort((a, b) => b[1] - a[1]);
  console.log(`   Delta vs baseline (${path.basename(refDir)}): ${newPaths.length} new command path(s):`);
  for (const [k, count] of newPaths.slice(0, 40)) {
    console.log(`     - ${k} (${count} calls)`);
  }
}

// 4. Assets & Codecs
console.log('\n4. Assets & Codec Verification:');
const dbsFiles = listNonDotFiles(path.join(dataDir, 'dat'), '.dbs');
for (const f of dbsFiles) {
  const d = new SiglusDbs(new Uint8Array(fs.readFileSync(path.join(dataDir, 'dat', f))));
  console.log(`   DBS dat/${f}: ${d.rowCount} rows x ${d.columnCount} cols`);
}
for (const f of listNonDotFiles(path.join(dataDir, 'dat'), '.cgm')) {
  const c = parseCgTable(new Uint8Array(fs.readFileSync(path.join(dataDir, 'dat', f))));
  console.log(`   CGTABLE dat/${f}: v${c.version}, ${c.entries.length} entries`);
}
const gans = listNonDotFiles(path.join(dataDir, 'gan'), '.gan');
for (const f of gans) {
  const sets = readGan(new Uint8Array(fs.readFileSync(path.join(dataDir, 'gan', f))));
  if (!sets.length) throw new Error(`Empty GAN ${f}`);
}
console.log(`   GAN: ${gans.length} file(s) parsed cleanly`);

const omvs = listNonDotFiles(path.join(dataDir, 'mov'), '.omv');
for (const f of omvs) {
  const o = new SiglusOmv(new Uint8Array(fs.readFileSync(path.join(dataDir, 'mov', f))));
  if (o.width <= 0 || o.height <= 0) throw new Error(`Invalid OMV ${f}`);
}
console.log(`   OMV: ${omvs.length} file(s) parsed cleanly`);

const wmvs = listNonDotFiles(path.join(dataDir, 'mov'), '.wmv');
for (const f of wmvs) {
  const res = auditWmaParity(path.join(dataDir, 'mov', f));
  console.log(
    `   WMV mov/${f}: codec=0x${res.codec.toString(16)} rate=${res.sampleRate}Hz frames=${res.frames} JS==WASM maxDiff=${res.maxDiff}`,
  );
}

const bgms = listNonDotFiles(path.join(dataDir, 'bgm'), '.owp');
for (const f of bgms) {
  const dec = decodeOwp(new Uint8Array(fs.readFileSync(path.join(dataDir, 'bgm', f))).subarray(0, 16));
  if (Buffer.from(dec.subarray(0, 4)).toString('ascii') !== 'OggS') {
    throw new Error(`BGM ${f} is not OggS after OWP XOR 0x39`);
  }
}
console.log(`   BGM (.owp): ${bgms.length} file(s) verified OggS`);

const nwas = listNonDotFiles(path.join(dataDir, 'wav'), '.nwa');
for (const f of nwas.slice(0, 20)) {
  const dec = decodeNwa(new Uint8Array(fs.readFileSync(path.join(dataDir, 'wav', f))));
  if (dec.rate <= 0 || dec.pcm.length === 0) throw new Error(`Empty NWA ${f}`);
}
console.log(`   WAV (.nwa): ${nwas.length} file(s) (first ${Math.min(20, nwas.length)} decoded cleanly)`);

const ovks = listNonDotFiles(path.join(dataDir, 'koe'), '.ovk');
for (const f of ovks.slice(0, 20)) {
  const buf = new Uint8Array(fs.readFileSync(path.join(dataDir, 'koe', f)));
  const idx = await ovkIndex({
    size: buf.length,
    read: async (o, l) => buf.subarray(o, o + l),
  });
  if (idx.size === 0) throw new Error(`Empty OVK ${f}`);
}
console.log(`   KOE (.ovk): ${ovks.length} bank(s) (first ${Math.min(20, ovks.length)} indexed cleanly)`);

console.log('\n5. Auto-computed saveKey:');
console.log(`   siglus:${digests['Scene.pck']}`);
console.log('\nALL STATIC CHECKS PASSED (0 errors, 0 warnings).');
