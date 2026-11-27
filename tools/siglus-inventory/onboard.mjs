#!/usr/bin/env node
/**
 * One-command onboarding CLI for adding any new (e.g. 9th) SiglusEngine.exe revision:
 *   1. Statically inspects PE metadata & SHA-256 (detects direct PE, SdWrap embedded PE, or packed PE)
 *   2. Exports 100% of Ghidra-discovered functions into ignored targetgame/siglus-inventory/
 *   3. Runs cross-version matching against existing corpus
 *   4. Refreshes the multi-layer verification ledger and coverage report
 *
 * Usage:
 *   node tools/siglus-inventory/onboard.mjs --exe "/path/to/SiglusEngine.exe" --id my-game [--title "My Game"] [--game-dir "/path/to/game"] [--register]
 */

import fs from 'node:fs';
import path from 'node:path';
import {exportBinary, inspectPeStatic} from './export.mjs';
import {buildCrossVersionMap} from './match.mjs';
import {buildLedger, renderCoverageMarkdown} from './ledger.mjs';

const REPO_ROOT = path.resolve(import.meta.dirname, '../..');
const CORPUS_PATH = path.join(import.meta.dirname, 'corpus.json');
const CHECKPOINTS_DIR = path.join(REPO_ROOT, 'targetgame/siglus-inventory/checkpoints');

function parseCli(argv) {
  const opts = {exe: null, id: null, title: null, gameDir: null, register: false, force: false};
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--exe') opts.exe = path.resolve(argv[++i]);
    else if (a === '--id') opts.id = argv[++i];
    else if (a === '--title') opts.title = argv[++i];
    else if (a === '--game-dir') opts.gameDir = path.resolve(argv[++i]);
    else if (a === '--register') opts.register = true;
    else if (a === '--force') opts.force = true;
    else throw new Error(`Unknown argument: ${a}`);
  }
  if (!opts.exe) throw new Error('--exe <path/to/SiglusEngine.exe> is required');
  if (!opts.id) {
    opts.id = path.basename(path.dirname(opts.exe)).toLowerCase().replace(/[^a-z0-9]+/g, '-');
  }
  if (!opts.title) opts.title = opts.id;
  if (!opts.gameDir) opts.gameDir = path.dirname(opts.exe);
  return opts;
}

const opts = parseCli(process.argv.slice(2));
const pe = inspectPeStatic(opts.exe);
console.log(`[onboard] Static PE inspection for ${opts.id}:`, JSON.stringify(pe));

const entry = {
  id: opts.id,
  title: opts.title,
  fileVersion: pe.fileVersion,
  exePath: opts.exe,
  gameDir: opts.gameDir,
  size: pe.size,
  sha256: pe.sha256,
  containerKind: pe.containerKind,
  ...(pe.embeddedPeOffset ? {embeddedPeOffset: pe.embeddedPeOffset} : {}),
  analyzedSha256: pe.analyzedSha256,
};

exportBinary(entry, {force: opts.force});

const corpus = JSON.parse(fs.readFileSync(CORPUS_PATH, 'utf8'));
const ids = [...new Set([...corpus.binaries.map((b) => b.id), opts.id])];
if (opts.register && !corpus.binaries.some((b) => b.id === opts.id)) {
  corpus.binaries.push(entry);
  fs.writeFileSync(CORPUS_PATH, JSON.stringify(corpus, null, 2) + '\n');
  console.log(`[onboard] Registered ${opts.id} in tools/siglus-inventory/corpus.json`);
}

const availableIds = ids.filter((id) =>
  fs.existsSync(path.join(REPO_ROOT, 'targetgame/siglus-inventory/exports', `${id}.inventory.json`)),
);
if (availableIds.length >= 2) {
  const matchMap = buildCrossVersionMap(availableIds, {compact: false});
  const outPath = path.join(CHECKPOINTS_DIR, `match-${opts.id}.json`);
  fs.writeFileSync(outPath, JSON.stringify(matchMap, null, 2) + '\n');
  console.log(`[onboard] Cross-version match complete (${availableIds.length} revisions) -> ${path.relative(REPO_ROOT, outPath)}`);
}

if (opts.register) {
  const ledger = buildLedger();
  fs.writeFileSync(path.join(REPO_ROOT, 'docs/siglus/verification-ledger.json'), JSON.stringify(ledger, null, 2) + '\n');
  fs.writeFileSync(path.join(REPO_ROOT, 'docs/siglus/COVERAGE.md'), renderCoverageMarkdown(ledger));
  console.log('[onboard] Refreshed docs/siglus/verification-ledger.json and docs/siglus/COVERAGE.md');
}
console.log(`[onboard] Done for ${opts.id}.`);
