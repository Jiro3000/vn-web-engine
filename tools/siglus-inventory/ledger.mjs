#!/usr/bin/env node
/**
 * Phase 3: Persistent Multi-Layer Coverage Ledger, TypeScript Link Map,
 * Corpus Command/Property/Gameexe Accounting, and Automatic Staleness Invalidation.
 *
 * Strictly separates all 8 coverage layers:
 *   discovered, cross_version_matched, understood, implemented,
 *   statically_verified, unit_tested, interaction_tested, browser_verified
 *
 * Usage:
 *   node tools/siglus-inventory/ledger.mjs build
 *   node tools/siglus-inventory/ledger.mjs check [--strict-stale]
 *   node tools/siglus-inventory/ledger.mjs report
 */

import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import {SiglusScenePack} from '../../dist/formats/siglus/scene-pack.js';
import {
  DEFAULT_GAMEEXE_ALLOWLIST,
  READ_FLAG_GLOBAL_ROOTS,
  READ_FLAG_MWND_MEMBERS,
  normalizeCommandPath,
} from '../../tests/helpers/siglus-game-suite.mjs';
import {LEDGER_SCHEMA, VERIFICATION_METRIC_KEYS, validateVerificationLedger} from './schema.mjs';

const REPO_ROOT = path.resolve(import.meta.dirname, '../..');
const CORPUS_PATH = path.join(import.meta.dirname, 'corpus.json');
const MATCH_PATH = path.join(REPO_ROOT, 'targetgame/siglus-inventory/checkpoints/match-8rev.json');
const EXPORTS_DIR = path.join(REPO_ROOT, 'targetgame/siglus-inventory/exports');
const EVIDENCE_PATH = path.join(REPO_ROOT, 'docs/siglus/verified-evidence.json');
const LEDGER_OUT_PATH = path.join(REPO_ROOT, 'docs/siglus/verification-ledger.json');
const REPORT_OUT_PATH = path.join(REPO_ROOT, 'docs/siglus/COVERAGE.md');
const MUTATION_REPORT_PATH = path.join(REPO_ROOT, 'docs/siglus/mutation-report.json');

const SIGLUS_ENGINE_DIR = path.join(REPO_ROOT, 'src/engines/siglus');
const SIGLUS_FORMAT_DIR = path.join(REPO_ROOT, 'src/formats/siglus');
const TESTS_DIR = path.join(REPO_ROOT, 'tests');

function sha256File(absPath) {
  return crypto.createHash('sha256').update(fs.readFileSync(absPath)).digest('hex');
}

function findCI(dir, lower) {
  if (!fs.existsSync(dir)) return null;
  const hit = fs.readdirSync(dir).find((n) => !n.startsWith('._') && n.toLowerCase() === lower);
  return hit ? path.join(dir, hit) : null;
}

function resolveDataDir(dir) {
  if (findCI(dir, 'scene.pck') && findCI(dir, 'gameexe.dat')) return dir;
  const nested = path.join(dir, 'StartData', 'GameData');
  if (findCI(nested, 'scene.pck') && findCI(nested, 'gameexe.dat')) return nested;
  const sel = findCI(dir, 'select.ini');
  if (sel) {
    const first = fs
      .readFileSync(sel, 'utf8')
      .split(/\r?\n/)
      .find((l) => l.trim());
    const sub = first?.split('\t')[0]?.trim();
    if (sub && findCI(path.join(dir, sub), 'scene.pck')) return path.join(dir, sub);
  }
  for (const e of fs.readdirSync(dir, {withFileTypes: true})) {
    if (!e.isDirectory() || e.name.startsWith('.')) continue;
    const cand = path.join(dir, e.name);
    if (findCI(cand, 'scene.pck') && findCI(cand, 'gameexe.dat')) return cand;
  }
  throw new Error(`Missing Scene.pck/Gameexe.dat in ${dir}`);
}

function hasTrailingReadFlag(p) {
  if (p.length === 1) return READ_FLAG_GLOBAL_ROOTS.has(p[0]);
  if (p.length >= 4) {
    const m = p.at(-1);
    if (
      READ_FLAG_MWND_MEMBERS.has(m) &&
      p[p.length - 4] === 3 &&
      p[p.length - 3] === -1 &&
      (p[0] === 37 || p[0] === 38 || p[0] === 49 || p[0] === 65)
    ) {
      return true;
    }
  }
  return false;
}

/**
 * Scan Scene.pck across a game for BOTH commands (op 48) AND property reads/writes (op 5 / op 32).
 */
export function scanScenePackPaths(pack) {
  const commandPaths = new Map();
  const propertyPaths = new Map();
  const bump = (map, norm) => map.set(norm, (map.get(norm) ?? 0) + 1);

  for (const sceneName of pack.sceneNames) {
    const sc = pack.scene(sceneName);
    const code = sc.code;
    const view = new DataView(code.buffer, code.byteOffset, code.byteLength);
    let pc = 0;
    const stack = [];
    const points = [];
    const readWord = () => {
      const v = view.getInt32(pc, true);
      pc += 4;
      return v;
    };
    const countArgs = () => {
      const n = readWord();
      let total = 0;
      for (let i = 0; i < n; i++) {
        const f = readWord();
        total += f === -1 ? countArgs() : 1;
      }
      return total;
    };

    while (pc < code.length) {
      const op = code[pc++];
      if (op === 0 || op === 9 || op === 22 || op === 50) continue;
      if (op === 1 || op === 49) {
        readWord();
      } else if (op === 2) {
        readWord();
        stack.push(readWord());
      } else if (op === 3) {
        if (readWord() !== 0) stack.pop();
      } else if (op === 4) {
        readWord();
        stack.push(stack.at(-1));
      } else if (op === 5) {
        const p = points.pop();
        const el = p !== undefined ? stack.splice(p) : [];
        if (el.length > 0 && el[0] >= 0 && el[0] < 0x10000) {
          bump(propertyPaths, normalizeCommandPath(el));
        }
        stack.push(0);
      } else if (op === 6) {
        const s = points.at(-1) ?? 0;
        points.push(stack.length);
        stack.push(...stack.slice(s));
      } else if (op === 7) {
        const f = readWord();
        readWord();
        if (f === 11 || f === 21) stack.pop();
      } else if (op === 8) {
        points.push(stack.length);
      } else if (op === 16 || op === 17 || op === 18) {
        readWord();
        if (op !== 16) stack.pop();
      } else if (op === 19 || op === 20) {
        readWord();
        countArgs();
        stack.push(0);
      } else if (op === 21) {
        countArgs();
      } else if (op === 32) {
        readWord();
        readWord();
        readWord();
        stack.pop();
        const p = points.pop();
        const el = p !== undefined ? stack.splice(p) : [];
        if (el.length > 0 && el[0] >= 0 && el[0] < 0x10000) {
          bump(propertyPaths, normalizeCommandPath(el));
        }
      } else if (op === 33) {
        readWord();
        pc++;
      } else if (op === 34) {
        readWord();
        readWord();
        pc++;
        stack.pop();
      } else if (op === 48) {
        readWord();
        const nArgs = countArgs();
        const nc = readWord();
        for (let i = 0; i < nc; i++) readWord();
        const ret = readWord();
        const p = points.pop();
        const el = p !== undefined ? stack.splice(p) : [];
        const cmdPath = el.slice(0, Math.max(1, el.length - nArgs));
        if (hasTrailingReadFlag(cmdPath)) readWord();
        if (cmdPath.length > 0 && cmdPath[0] >= 0 && cmdPath[0] < 0x10000) {
          bump(commandPaths, normalizeCommandPath(cmdPath));
        }
        if (ret !== 0) stack.push(0);
      }
    }
  }
  return {commandPaths, propertyPaths};
}

/**
 * Map Siglus command/property root IDs to their corresponding structural anchor & TS implementation surface.
 */
const ROOT_DISPATCH_MAP = {
  3: {anchor: 'dispatcher.global', name: 'return', ts: ['src/engines/siglus/player.ts']},
  4: {anchor: 'dispatcher.global', name: 'jump', ts: ['src/engines/siglus/player.ts']},
  5: {anchor: 'dispatcher.global', name: 'farcall', ts: ['src/engines/siglus/player.ts']},
  6: {anchor: 'dispatcher.global', name: 'disp', ts: ['src/engines/siglus/player.ts']},
  10: {anchor: 'dispatcher.global', name: 'wait', ts: ['src/engines/siglus/player.ts']},
  13: {anchor: 'dispatcher.global', name: 'nl', ts: ['src/engines/siglus/player.ts']},
  14: {anchor: 'dispatcher.global', name: 'r', ts: ['src/engines/siglus/player.ts']},
  17: {anchor: 'dispatcher.global', name: 'color', ts: ['src/engines/siglus/player.ts', 'src/engines/siglus/display.ts']},
  18: {anchor: 'dispatcher.global', name: 'p', ts: ['src/engines/siglus/player.ts']},
  20: {anchor: 'dispatcher.mov', name: 'mov', ts: ['src/engines/siglus/player.ts', 'src/engines/siglus/display.ts']},
  24: {anchor: 'dispatcher.keylist', name: 'key', ts: ['src/engines/siglus/player.ts', 'src/engines/siglus/display.ts']},
  29: {anchor: 'dispatcher.global', name: 'F', ts: ['src/engines/siglus/player.ts']},
  30: {anchor: 'dispatcher.global', name: 'G', ts: ['src/engines/siglus/player.ts']},
  31: {anchor: 'dispatcher.global', name: 'Z', ts: ['src/engines/siglus/player.ts']},
  32: {anchor: 'dispatcher.global', name: 'S', ts: ['src/engines/siglus/player.ts']},
  33: {anchor: 'dispatcher.global', name: 'M', ts: ['src/engines/siglus/player.ts']},
  35: {anchor: 'dispatcher.global', name: 'timewait', ts: ['src/engines/siglus/player.ts']},
  36: {anchor: 'dispatcher.global', name: 'wipe', ts: ['src/engines/siglus/player.ts', 'src/engines/siglus/wipe.ts']},
  37: {anchor: 'dispatcher.stage', name: 'back', ts: ['src/engines/siglus/player.ts', 'src/engines/siglus/display.ts']},
  38: {anchor: 'dispatcher.stage', name: 'front', ts: ['src/engines/siglus/player.ts', 'src/engines/siglus/display.ts']},
  39: {anchor: 'dispatcher.math', name: 'math', ts: ['src/engines/siglus/player.ts', 'src/engines/siglus/math.ts']},
  40: {anchor: 'dispatcher.counter', name: 'counter', ts: ['src/engines/siglus/player.ts']},
  41: {anchor: 'dispatcher.mwnd', name: 'face', ts: ['src/engines/siglus/player.ts', 'src/engines/siglus/display.ts']},
  42: {anchor: 'dispatcher.bgm', name: 'bgm', ts: ['src/engines/siglus/player.ts', 'src/engines/siglus/audio.ts']},
  43: {anchor: 'dispatcher.pcm', name: 'pcm', ts: ['src/engines/siglus/player.ts', 'src/engines/siglus/audio.ts']},
  44: {anchor: 'dispatcher.pcmch', name: 'pcmch', ts: ['src/engines/siglus/player.ts', 'src/engines/siglus/audio.ts']},
  45: {anchor: 'dispatcher.se', name: 'se', ts: ['src/engines/siglus/player.ts', 'src/engines/siglus/audio.ts']},
  46: {anchor: 'dispatcher.mouse', name: 'mouse', ts: ['src/engines/siglus/player.ts', 'src/engines/siglus/display.ts']},
  47: {anchor: 'dispatcher.mwnd', name: 'mwnd_47', ts: ['src/engines/siglus/player.ts', 'src/engines/siglus/display.ts']},
  48: {anchor: 'dispatcher.koe', name: 'koe', ts: ['src/engines/siglus/player.ts', 'src/engines/siglus/audio.ts']},
  49: {anchor: 'dispatcher.stage', name: 'next', ts: ['src/engines/siglus/player.ts', 'src/engines/siglus/display.ts']},
  50: {anchor: 'dispatcher.global', name: 'mask_wipe_all', ts: ['src/engines/siglus/player.ts', 'src/engines/siglus/wipe.ts']},
  52: {anchor: 'dispatcher.pcmevent', name: 'pcmevent', ts: ['src/engines/siglus/player.ts', 'src/engines/siglus/audio.ts']},
  53: {anchor: 'runtime.frame_action', name: 'frame_action_ch', ts: ['src/engines/siglus/player.ts']},
  54: {anchor: 'runtime.frame_action', name: 'frame_action', ts: ['src/engines/siglus/player.ts']},
  55: {anchor: 'dispatcher.mwnd', name: 'koekoe', ts: ['src/engines/siglus/player.ts', 'src/engines/siglus/audio.ts']},
  57: {anchor: 'dispatcher.mwnd', name: 'close', ts: ['src/engines/siglus/player.ts', 'src/engines/siglus/display.ts']},
  62: {anchor: 'dispatcher.mwnd', name: 'namae', ts: ['src/engines/siglus/player.ts']},
  63: {anchor: 'dispatcher.syscom', name: 'syscom', ts: ['src/engines/siglus/player.ts', 'src/engines/siglus/configuration.ts']},
  64: {anchor: 'dispatcher.script', name: 'script', ts: ['src/engines/siglus/player.ts']},
  65: {anchor: 'dispatcher.excall', name: 'excall', ts: ['src/engines/siglus/player.ts', 'src/engines/siglus/display.ts']},
  70: {anchor: 'dispatcher.screen', name: 'screen', ts: ['src/engines/siglus/player.ts', 'src/engines/siglus/display.ts']},
  73: {anchor: 'dispatcher.stage', name: 'stage_73', ts: ['src/engines/siglus/player.ts', 'src/engines/siglus/display.ts']},
  78: {anchor: 'dispatcher.cgtable', name: 'cgtable', ts: ['src/engines/siglus/player.ts', 'src/formats/siglus/cgtable.ts']},
  79: {anchor: 'dispatcher.mask', name: 'mask', ts: ['src/engines/siglus/player.ts', 'src/engines/siglus/display.ts']},
  83: {anchor: 'dispatcher.call', name: 'cur_call', ts: ['src/engines/siglus/vm.ts']},
  84: {anchor: 'dispatcher.global', name: 'sel_or_text', ts: ['src/engines/siglus/player.ts', 'src/engines/siglus/selbtn.ts']},
  86: {anchor: 'dispatcher.input', name: 'input', ts: ['src/engines/siglus/player.ts', 'src/engines/siglus/display.ts']},
  92: {anchor: 'dispatcher.system', name: 'system', ts: ['src/engines/siglus/player.ts']},
  105: {anchor: 'dispatcher.database', name: 'database', ts: ['src/engines/siglus/player.ts', 'src/formats/siglus/dbs.ts']},
  123: {anchor: 'dispatcher.bgmtable', name: 'bgmtable', ts: ['src/engines/siglus/player.ts']},
  138: {anchor: 'dispatcher.global', name: 'del_call_stack', ts: ['src/engines/siglus/player.ts', 'src/engines/siglus/vm.ts']},
  139: {anchor: 'dispatcher.global', name: 'get_call_stack_cnt', ts: ['src/engines/siglus/player.ts', 'src/engines/siglus/vm.ts']},
  140: {anchor: 'dispatcher.global', name: 'set_call_stack_cnt', ts: ['src/engines/siglus/player.ts', 'src/engines/siglus/vm.ts']},
  141: {anchor: 'dispatcher.global', name: 'clear_call_stack', ts: ['src/engines/siglus/player.ts', 'src/engines/siglus/vm.ts']},
  145: {anchor: 'dispatcher.msgbk', name: 'msgbk', ts: ['src/engines/siglus/player.ts']},
};

function resolveAnchorForPath(pathStr) {
  const parts = pathStr.split('.').map((s) => (s === '*' ? -1 : Number(s)));
  const root = parts[0];
  // Nested stage/excall object or mwnd paths
  if ((root === 37 || root === 38 || root === 49) && parts[1] === 2) {
    return {
      anchor: 'dispatcher.object',
      name: 'stage.object',
      ts: ['src/engines/siglus/player.ts', 'src/engines/siglus/display.ts'],
    };
  }
  if ((root === 37 || root === 38 || root === 49) && parts[1] === 3) {
    return {
      anchor: 'dispatcher.mwnd',
      name: 'stage.mwnd',
      ts: ['src/engines/siglus/player.ts', 'src/engines/siglus/mwnd.ts', 'src/engines/siglus/display.ts'],
    };
  }
  if ((root === 37 || root === 38 || root === 49) && parts[1] === 6) {
    return {
      anchor: 'dispatcher.group',
      name: 'stage.objbtngroup',
      ts: ['src/engines/siglus/player.ts', 'src/engines/siglus/display.ts'],
    };
  }
  if (root === 65 && parts.includes(2) && parts.length >= 5) {
    return {
      anchor: 'dispatcher.object',
      name: 'excall.stage.object',
      ts: ['src/engines/siglus/player.ts', 'src/engines/siglus/display.ts'],
    };
  }
  if (root === 65 && parts[1] === 13) {
    return {
      anchor: 'dispatcher.script',
      name: 'excall.script',
      ts: ['src/engines/siglus/player.ts'],
    };
  }
  return ROOT_DISPATCH_MAP[root] ?? {
    anchor: 'dispatcher.global',
    name: `root_${root}`,
    ts: ['src/engines/siglus/player.ts'],
  };
}

/**
 * Scan all Siglus TS source files & test files for source hashes, RVA comments, and test links.
 */
function scanSiglusWorkspace() {
  const sourcePins = {};
  const sourceText = {};
  const commentHints = []; // {file, line, va, versionHint, text}

  const collectDir = (absDir, relPrefix) => {
    for (const name of fs.readdirSync(absDir).sort()) {
      if (name.startsWith('._') || !name.endsWith('.ts')) continue;
      const abs = path.join(absDir, name);
      const rel = `${relPrefix}/${name}`;
      sourcePins[rel] = sha256File(abs);
      const text = fs.readFileSync(abs, 'utf8');
      sourceText[rel] = text;
      const lines = text.split('\n');
      for (let i = 0; i < lines.length; i++) {
        const line = lines[i];
        if (!line.includes('//') && !line.includes('*')) continue;
        const vas = [...line.matchAll(/\b0x([4-9a-f][0-9a-f]{5})\b/gi)].map((m) => '0x' + m[1].toLowerCase());
        if (vas.length === 0) continue;
        const verMatch = line.match(/\b(1\.1\.\d+\.\d+)\b/);
        for (const va of vas) {
          commentHints.push({
            file: rel,
            line: i + 1,
            va,
            versionHint: verMatch ? verMatch[1] : null,
            text: line.trim().slice(0, 140),
          });
        }
      }
    }
  };
  collectDir(SIGLUS_ENGINE_DIR, 'src/engines/siglus');
  collectDir(SIGLUS_FORMAT_DIR, 'src/formats/siglus');

  const testFiles = fs
    .readdirSync(TESTS_DIR)
    .filter((n) => n.startsWith('siglus-') && n.endsWith('.test.mjs'))
    .sort()
    .map((n) => `tests/${n}`);
  const testContents = Object.fromEntries(
    testFiles.map((rel) => [rel, fs.readFileSync(path.join(REPO_ROOT, rel), 'utf8')]),
  );

  return {sourcePins, sourceText, commentHints, testFiles, testContents};
}

/**
 * Hash a delimited slice of source text between startMarker and endMarker
 * (inclusive) so region-scoped staleness checks only invalidate entries whose
 * actual handler region changed.
 */
export function hashSourceRegion(text, startMarker, endMarker) {
  const start = text.indexOf(startMarker);
  if (start < 0) return null;
  const endIdx = endMarker ? text.indexOf(endMarker, start + startMarker.length) : text.length;
  if (endIdx < 0) return null;
  const slice = text.slice(start, endMarker ? endIdx + endMarker.length : endIdx);
  return crypto.createHash('sha256').update(slice).digest('hex');
}

/**
 * Check whether an entry's verified snapshot is stale relative to current TS source hashes,
 * region-scoped source slices, dependency hashes, or native binary identities.
 */
export function evaluateStaleness(entry, currentSourcePins, currentBinaries, currentSourceText = null) {
  const staleReasons = [];
  const snap = entry.verifiedSnapshot;
  if (!snap) return {stale: false, staleReasons: []};

  if (snap.sourceHashes) {
    for (const [relFile, pinnedSha] of Object.entries(snap.sourceHashes)) {
      const actual = currentSourcePins[relFile];
      if (!actual) {
        staleReasons.push(`missing-source:${relFile}`);
      } else if (actual !== pinnedSha) {
        staleReasons.push(`source-changed:${relFile} (pinned=${pinnedSha.slice(0, 12)} actual=${actual.slice(0, 12)})`);
      }
    }
  }
  if (Array.isArray(snap.sourceRegions)) {
    for (const reg of snap.sourceRegions) {
      const abs = path.join(REPO_ROOT, reg.file);
      const text = currentSourceText?.[reg.file] ?? (fs.existsSync(abs) ? fs.readFileSync(abs, 'utf8') : null);
      if (text === null) {
        staleReasons.push(`missing-region-file:${reg.file}`);
        continue;
      }
      const actual = hashSourceRegion(text, reg.startMarker, reg.endMarker);
      if (!actual) {
        staleReasons.push(`missing-region-marker:${reg.file}:${reg.startMarker.slice(0, 40)}`);
      } else if (actual !== reg.sha256) {
        staleReasons.push(`region-changed:${reg.file} (pinned=${reg.sha256.slice(0, 12)} actual=${actual.slice(0, 12)})`);
      }
    }
  }
  if (snap.dependencyHashes) {
    for (const [relFile, pinnedSha] of Object.entries(snap.dependencyHashes)) {
      const abs = path.join(REPO_ROOT, relFile);
      const actual = currentSourcePins[relFile] ?? (fs.existsSync(abs) ? sha256File(abs) : null);
      if (!actual) {
        staleReasons.push(`missing-dependency:${relFile}`);
      } else if (actual !== pinnedSha) {
        staleReasons.push(`dependency-changed:${relFile} (pinned=${pinnedSha.slice(0, 12)} actual=${actual.slice(0, 12)})`);
      }
    }
  }
  if (snap.binaryHashes) {
    for (const [binId, pinnedSha] of Object.entries(snap.binaryHashes)) {
      const actual = currentBinaries[binId]?.analyzedSha256;
      if (!actual) {
        staleReasons.push(`missing-binary:${binId}`);
      } else if (actual !== pinnedSha) {
        staleReasons.push(`binary-changed:${binId} (pinned=${pinnedSha.slice(0, 12)} actual=${actual.slice(0, 12)})`);
      }
    }
  }
  return {stale: staleReasons.length > 0, staleReasons};
}

export function buildLedger({
  corpusPath = CORPUS_PATH,
  matchPath = MATCH_PATH,
  evidencePath = EVIDENCE_PATH,
} = {}) {
  const corpus = JSON.parse(fs.readFileSync(corpusPath, 'utf8'));
  const matchMap = fs.existsSync(matchPath) ? JSON.parse(fs.readFileSync(matchPath, 'utf8')) : null;
  const evidenceDoc = fs.existsSync(evidencePath)
    ? JSON.parse(fs.readFileSync(evidencePath, 'utf8'))
    : {records: [], knownDiscrepancies: []};
  const evidenceById = new Map((evidenceDoc.records ?? []).map((r) => [r.entryId, r]));

  const {sourcePins, sourceText, commentHints, testFiles, testContents} = scanSiglusWorkspace();
  const combinedEngineSource = Object.entries(sourceText)
    .filter(([k]) => k.startsWith('src/engines/siglus/'))
    .map(([, v]) => v)
    .join('\n');

  const binaries = {};
  for (const b of corpus.binaries) {
    const rev = matchMap?.revisions?.find((r) => r.id === b.id);
    binaries[b.id] = {
      id: b.id,
      title: b.title,
      fileVersion: rev?.fileVersion ?? b.fileVersion,
      containerKind: rev?.containerKind ?? b.containerKind,
      sha256: b.sha256,
      analyzedSha256: b.analyzedSha256,
      discoveredFunctionCount: rev?.discoveredFunctionCount ?? 0,
    };
  }

  // Build helper to get cross-version status for any structural anchor ID
  const anchorCrossStatus = (anchorId) => {
    const perRev = {};
    let anchoredCount = 0;
    let modifiedTransitions = 0;
    let modifiedInLatest = false;
    if (matchMap) {
      for (const rev of matchMap.revisions) {
        const a = matchMap.anchors?.[rev.id]?.[anchorId];
        if (a?.va) {
          perRev[rev.id] = {va: a.va, rva: a.rva, rawBytesSha256: a.rawBytesSha256, normalizedInsnSha256: a.normalizedInsnSha256, inlinedInto: a.inlinedInto ?? null};
          anchoredCount++;
        } else if (a) {
          perRev[rev.id] = {va: null, status: a.status};
        }
      }
      for (const p of matchMap.pairs ?? []) {
        const m = p.matches.find((x) => x.anchorId === anchorId);
        if (m && (m.changeClass === 'modified' || m.changeClass === 'merged' || m.changeClass === 'split')) {
          modifiedTransitions++;
          if (p.toId === 'anemoi') modifiedInLatest = true;
        }
      }
    }
    return {perRev, matched: anchoredCount >= 2, anchoredCount, modifiedTransitions, modifiedInLatest};
  };

  const hasInteractionSuite = testFiles.includes('tests/siglus-stateful-interactions.test.mjs');
  const interactionText = hasInteractionSuite ? testContents['tests/siglus-stateful-interactions.test.mjs'] : '';

  // Load killed mutants from mutation-report.json so mutation_tested reflects real killed mutants only
  const killedMutantsByArea = new Map();
  const killedMutantsByFile = new Map();
  const killedMutantIds = new Set();
  if (fs.existsSync(MUTATION_REPORT_PATH)) {
    const mutDoc = JSON.parse(fs.readFileSync(MUTATION_REPORT_PATH, 'utf8'));
    for (const m of mutDoc.results ?? []) {
      if (m.status !== 'killed') continue;
      killedMutantIds.add(m.id);
      if (m.area) {
        const arr = killedMutantsByArea.get(m.area) ?? [];
        arr.push(m.id);
        killedMutantsByArea.set(m.area, arr);
      }
      if (m.file) {
        const arr = killedMutantsByFile.get(m.file) ?? [];
        arr.push(m.id);
        killedMutantsByFile.set(m.file, arr);
      }
    }
  }
  const hasKilledMutantForSurface = (kind, surface, tsFiles) => {
    if (surface && killedMutantsByArea.has(surface)) return true;
    const base = surface?.split('.').at(-1);
    if (
      base &&
      (killedMutantsByArea.has(base) ||
        killedMutantsByArea.has(`player/${base}`) ||
        killedMutantsByArea.has(`formats/${base}`) ||
        killedMutantsByArea.has(`vm/${base}`))
    ) {
      return true;
    }
    if (kind === 'asset_decoder') {
      return (tsFiles ?? []).some((f) => killedMutantsByFile.has(f));
    }
    return false;
  };

  const findTestsForSurface = (keywords, pathStr = null) => {
    const hits = [];
    for (const tf of testFiles) {
      const body = testContents[tf];
      if (pathStr && body.includes(`[${pathStr.replace(/\./g, ', ')}]`)) {
        hits.push(tf);
        continue;
      }
      if (keywords.some((kw) => kw && body.includes(kw))) {
        hits.push(tf);
      }
    }
    return [...new Set(hits)];
  };

  const applyVerifiedEvidence = (entry) => {
    entry.verificationDepth = 'unverified';
    entry.classification = 'engine_semantic';
    if (entry.status.mutation_tested === undefined) {
      entry.status.mutation_tested = hasKilledMutantForSurface(
        entry.kind,
        entry.surface,
        (entry.tsLinks ?? []).map((l) => l.file),
      );
    }
    const ev = evidenceById.get(entry.id);
    if (!ev) return entry;
    entry.nativeEvidence = ev.nativeEvidence ?? [];
    entry.verifiedSnapshot = ev.verifiedSnapshot ?? null;
    if (ev.notes) entry.notes = ev.notes;
    if (ev.classification) entry.classification = ev.classification;
    if (ev.extraTestLinks?.length) {
      entry.testLinks = [...new Set([...entry.testLinks, ...ev.extraTestLinks])];
    }
    if (Array.isArray(ev.mutants) && ev.mutants.some((id) => killedMutantIds.has(id))) {
      entry.status.mutation_tested = true;
    }
    const {stale, staleReasons} = evaluateStaleness(entry, sourcePins, binaries, sourceText);
    entry.stale = stale;
    entry.staleReasons = staleReasons;
    if (!stale && entry.nativeEvidence.length > 0) {
      entry.status.understood = true;
      entry.status.statically_verified = true;
      entry.verificationDepth =
        ev.verificationDepth ??
        (entry.classification === 'platform_boundary' ? 'platform_boundary' : 'leaf_verified');
    } else if (stale) {
      entry.status.statically_verified = false;
      entry.verificationDepth = 'unverified';
    }
    if (ev.unitTested) entry.status.unit_tested = true;
    if (ev.interactionTested) entry.status.interaction_tested = true;
    if (ev.browserVerified) entry.status.browser_verified = true;
    return entry;
  };

  const entries = [];

  // 1. Add all Phase 2 structural anchors (dispatchers, parsers, asset decoders, runtime loops)
  if (matchMap) {
    const anchorIds = Object.keys(matchMap.anchors[matchMap.revisions.find((r) => r.containerKind !== 'packed-pe')?.id] ?? {});
    for (const anchorId of anchorIds.sort()) {
      const cross = anchorCrossStatus(anchorId);
      const isDecoder = anchorId.startsWith('decoder.');
      const kind = isDecoder ? 'asset_decoder' : 'native_function';
      const defaultTs =
        anchorId === 'decoder.g00' || anchorId === 'decoder.g00_loader'
          ? ['src/formats/siglus/g00.ts']
          : anchorId === 'decoder.dbs'
            ? ['src/formats/siglus/dbs.ts']
            : anchorId === 'decoder.omv'
              ? ['src/formats/siglus/omv.ts']
              : anchorId === 'decoder.cgtable'
                ? ['src/formats/siglus/cgtable.ts']
                : anchorId === 'decoder.ovk' || anchorId === 'decoder.owp'
                  ? ['src/formats/siglus/sound.ts']
                  : anchorId === 'loader.scene_pck'
                    ? ['src/formats/siglus/scene-pack.ts']
                    : anchorId.startsWith('parser.gameexe')
                      ? ['src/engines/siglus/mwnd.ts', 'src/engines/siglus/player.ts']
                      : ['src/engines/siglus/player.ts'];

      // Find any RVA comment hints mentioning one of this anchor's VAs
      const anchorVas = new Set(Object.values(cross.perRev).map((r) => r.va).filter(Boolean));
      const hints = commentHints.filter((h) => anchorVas.has(h.va));
      const testLinks = findTestsForSurface([anchorId.split('.').at(-1)]);

      const entry = {
        id: `anchor:${anchorId}`,
        kind,
        surface: anchorId,
        revisions: cross.perRev,
        crossVersion: {
          anchoredRevisions: cross.anchoredCount,
          modifiedTransitions: cross.modifiedTransitions,
          modifiedInLatest: cross.modifiedInLatest,
        },
        tsLinks: defaultTs.map((file) => ({file})),
        dependencyFiles: [],
        testLinks,
        commentHints: hints.slice(0, 8),
        nativeEvidence: [],
        verifiedSnapshot: null,
        stale: false,
        staleReasons: [],
        status: {
          discovered: cross.anchoredCount > 0,
          cross_version_matched: cross.matched,
          understood: false,
          implemented: true,
          statically_verified: false,
          unit_tested: testLinks.length > 0,
          interaction_tested: hasInteractionSuite && interactionText.includes(anchorId.split('.').at(-1)),
          browser_verified: true,
        },
      };
      entries.push(applyVerifiedEvidence(entry));
    }
  }

  // 2. Scan all 8 games' Scene.pck & Gameexe.dat corpora
  const cmdCorpus = new Map();
  const propCorpus = new Map();
  const gameexeCorpus = new Map();
  const corpusStats = {};

  for (const b of corpus.binaries) {
    const dataDir = resolveDataDir(b.gameDir);
    const pack = new SiglusScenePack(new Uint8Array(fs.readFileSync(findCI(dataDir, 'scene.pck'))));
    const cfg = pack.configuration(new Uint8Array(fs.readFileSync(findCI(dataDir, 'gameexe.dat'))));
    const {commandPaths, propertyPaths} = scanScenePackPaths(pack);

    corpusStats[b.id] = {
      scenes: pack.sceneNames.length,
      uniqueCommands: commandPaths.size,
      uniqueProperties: propertyPaths.size,
      gameexeKeys: cfg.size,
    };

    for (const [p, cnt] of commandPaths) {
      const rec = cmdCorpus.get(p) ?? {totalCalls: 0, games: {}};
      rec.totalCalls += cnt;
      rec.games[b.id] = cnt;
      cmdCorpus.set(p, rec);
    }
    for (const [p, cnt] of propertyPaths) {
      const rec = propCorpus.get(p) ?? {totalCalls: 0, games: {}};
      rec.totalCalls += cnt;
      rec.games[b.id] = cnt;
      propCorpus.set(p, rec);
    }
    for (const k of cfg.keys()) {
      const schema = k.replace(/\.\d+(?=\.|$)/g, '.NNN');
      const set = gameexeCorpus.get(schema) ?? new Set();
      set.add(b.id);
      gameexeCorpus.set(schema, set);
    }
  }

  // 3. Emit 100% of observed Scene.pck commands
  for (const [pathStr, usage] of [...cmdCorpus.entries()].sort((a, b) => b[1].totalCalls - a[1].totalCalls)) {
    const route = resolveAnchorForPath(pathStr);
    const cross = anchorCrossStatus(route.anchor);
    const parts = pathStr.split('.');
    const leaf = parts.at(-1);
    const playerHasCase =
      sourceText['src/engines/siglus/player.ts'].includes(`case ${leaf}:`) ||
      sourceText['src/engines/siglus/player.ts'].includes(`case ${parts[0]}:`);
    const testLinks = findTestsForSurface([], pathStr);
    const interactionHit = hasInteractionSuite && interactionText.includes(pathStr);

    const entry = {
      id: `cmd:${pathStr}`,
      kind: 'command',
      path: pathStr,
      surface: route.name,
      anchorId: route.anchor,
      corpusUsage: {
        totalCalls: usage.totalCalls,
        gameCount: Object.keys(usage.games).length,
        games: usage.games,
      },
      crossVersion: {
        anchoredRevisions: cross.anchoredCount,
        modifiedTransitions: cross.modifiedTransitions,
        modifiedInLatest: cross.modifiedInLatest,
      },
      tsLinks: route.ts.map((file) => ({file})),
      dependencyFiles: ['src/engines/siglus/vm.ts'],
      testLinks,
      nativeEvidence: [],
      verifiedSnapshot: null,
      stale: false,
      staleReasons: [],
      status: {
        discovered: true,
        cross_version_matched: cross.matched,
        understood: false,
        implemented: playerHasCase,
        statically_verified: false,
        unit_tested: testLinks.length > 0,
        interaction_tested: interactionHit,
        browser_verified: usage.totalCalls >= 50 && Object.keys(usage.games).length >= 2,
      },
    };
    entries.push(applyVerifiedEvidence(entry));
  }

  // 4. Emit 100% of observed Scene.pck properties
  for (const [pathStr, usage] of [...propCorpus.entries()].sort((a, b) => b[1].totalCalls - a[1].totalCalls)) {
    const route = resolveAnchorForPath(pathStr);
    const cross = anchorCrossStatus(route.anchor);
    const parts = pathStr.split('.');
    const leaf = parts.at(-1);
    const playerHasCase =
      sourceText['src/engines/siglus/player.ts'].includes(`case ${leaf}:`) ||
      sourceText['src/engines/siglus/player.ts'].includes(`case ${parts[0]}:`);
    const testLinks = findTestsForSurface([], pathStr);
    const interactionHit = hasInteractionSuite && interactionText.includes(pathStr);

    const entry = {
      id: `prop:${pathStr}`,
      kind: 'property',
      path: pathStr,
      surface: route.name,
      anchorId: route.anchor,
      corpusUsage: {
        totalCalls: usage.totalCalls,
        gameCount: Object.keys(usage.games).length,
        games: usage.games,
      },
      crossVersion: {
        anchoredRevisions: cross.anchoredCount,
        modifiedTransitions: cross.modifiedTransitions,
        modifiedInLatest: cross.modifiedInLatest,
      },
      tsLinks: route.ts.map((file) => ({file})),
      dependencyFiles: ['src/engines/siglus/vm.ts'],
      testLinks,
      nativeEvidence: [],
      verifiedSnapshot: null,
      stale: false,
      staleReasons: [],
      status: {
        discovered: true,
        cross_version_matched: cross.matched,
        understood: false,
        implemented: playerHasCase,
        statically_verified: false,
        unit_tested: testLinks.length > 0,
        interaction_tested: interactionHit,
        browser_verified: usage.totalCalls >= 50 && Object.keys(usage.games).length >= 2,
      },
    };
    entries.push(applyVerifiedEvidence(entry));
  }

  // 5. Emit 100% of observed Gameexe.dat key schemas
  const gxCross = anchorCrossStatus('parser.gameexe.core');
  for (const [schema, gameSet] of [...gameexeCorpus.entries()].sort((a, b) => a[0].localeCompare(b[0]))) {
    const tokens = schema.split('.').filter((t) => t !== 'NNN');
    const last = tokens.at(-1);
    const first = tokens[0];
    const inSource =
      combinedEngineSource.includes(schema) ||
      (tokens.length >= 2 && combinedEngineSource.includes(tokens.slice(-2).join('.'))) ||
      (first && (combinedEngineSource.includes(`${first}.`) || combinedEngineSource.includes(`${first}\\.`))) ||
      (last && last.length > 4 && combinedEngineSource.includes(last));
    const allowlisted = DEFAULT_GAMEEXE_ALLOWLIST.some((re) => re.test(schema));
    const testLinks = findTestsForSurface([schema, first]);

    const entry = {
      id: `gameexe:${schema}`,
      kind: 'gameexe_key',
      keySchema: schema,
      anchorId: 'parser.gameexe.core',
      corpusUsage: {
        gameCount: gameSet.size,
        games: [...gameSet].sort(),
      },
      crossVersion: {
        anchoredRevisions: gxCross.anchoredCount,
        modifiedTransitions: gxCross.modifiedTransitions,
        modifiedInLatest: gxCross.modifiedInLatest,
      },
      tsLinks: [{file: 'src/engines/siglus/mwnd.ts'}, {file: 'src/engines/siglus/player.ts'}],
      dependencyFiles: [],
      testLinks,
      allowlistedNonRuntime: !inSource && allowlisted,
      nativeEvidence: [],
      verifiedSnapshot: null,
      stale: false,
      staleReasons: [],
      status: {
        discovered: true,
        cross_version_matched: gxCross.matched,
        understood: false,
        implemented: Boolean(inSource || allowlisted),
        statically_verified: false,
        unit_tested: testLinks.length > 0,
        interaction_tested: false,
        browser_verified: Boolean(inSource),
      },
    };
    entries.push(applyVerifiedEvidence(entry));
  }

  // 6. Populate explicit unresolvedGaps (packed binaries + indirect-call frontiers + cross-version unresolved)
  const unresolvedGaps = [];
  if (matchMap) {
    for (const rev of matchMap.revisions) {
      if (rev.containerKind === 'packed-pe') {
        unresolvedGaps.push({
          kind: 'packed_binary_blocker',
          binaryId: rev.id,
          fileVersion: rev.fileVersion,
          sha256: rev.sha256,
          description: 'On-disk executable is statically packed; static analysis cannot expose unpacked engine dispatchers without execution (prohibited).',
        });
      }
      const reach = matchMap.reachability?.[rev.id];
      if (reach && !reach.packedBlocker) {
        unresolvedGaps.push({
          kind: 'indirect_call_frontier',
          binaryId: rev.id,
          fileVersion: rev.fileVersion,
          reachableLowerBound: reach.reachableCount,
          frontierFunctionCount: reach.indirectCallFrontierCount,
          indirectSiteCount: reach.indirectCallSiteCount,
          topFrontierFunctions: (reach.indirectCallFrontierTop ?? []).slice(0, 10),
        });
      }
    }
    for (const p of matchMap.pairs ?? []) {
      if (p.summary?.unresolved > 0) {
        unresolvedGaps.push({
          kind: 'cross_version_unresolved_functions',
          fromId: p.fromId,
          toId: p.toId,
          fromVersion: p.fromVersion,
          toVersion: p.toVersion,
          unresolvedCount: p.summary.unresolved,
          blockedByPackedBinary: Boolean(p.blockedByPackedBinary),
        });
      }
    }
  }

  // Compute separate 9-layer coverage totals + verificationDepth breakdown (overall & by kind)
  const metrics = {
    overall: {leaf_verified: 0, wrapper_dispatch: 0, platform_boundary: 0},
    byKind: {},
  };
  for (const k of VERIFICATION_METRIC_KEYS) metrics.overall[k] = 0;
  metrics.overall.total = entries.length;
  metrics.overall.stale = 0;

  for (const e of entries) {
    if (!metrics.byKind[e.kind]) {
      metrics.byKind[e.kind] = {total: 0, stale: 0, leaf_verified: 0, wrapper_dispatch: 0, platform_boundary: 0};
      for (const k of VERIFICATION_METRIC_KEYS) metrics.byKind[e.kind][k] = 0;
    }
    metrics.byKind[e.kind].total++;
    if (e.stale) {
      metrics.overall.stale++;
      metrics.byKind[e.kind].stale++;
    }
    if (e.verificationDepth === 'leaf_verified' || e.verificationDepth === 'wrapper_dispatch' || e.verificationDepth === 'platform_boundary') {
      metrics.overall[e.verificationDepth]++;
      metrics.byKind[e.kind][e.verificationDepth]++;
    }
    for (const k of VERIFICATION_METRIC_KEYS) {
      if (e.status[k]) {
        metrics.overall[k]++;
        metrics.byKind[e.kind][k]++;
      }
    }
  }

  // Priority burn-down queue: unverified, wrapper_dispatch, or stale (excluding verified platform_boundary)
  const burnDownQueue = entries
    .filter((e) => !e.status.statically_verified || e.verificationDepth === 'wrapper_dispatch' || e.stale)
    .filter((e) => !(e.classification === 'platform_boundary' && e.status.statically_verified))
    .filter((e) => e.kind === 'command' || e.kind === 'property' || e.kind === 'native_function' || e.kind === 'gameexe_key')
    .map((e) => {
      const freq = e.corpusUsage?.totalCalls ?? 0;
      const games = e.corpusUsage?.gameCount ?? 0;
      const modBoost = e.crossVersion?.modifiedInLatest ? 2.0 : e.crossVersion?.modifiedTransitions > 0 ? 1.3 : 1.0;
      const staleBoost = e.stale ? 3.0 : 1.0;
      const depthBoost = e.verificationDepth === 'wrapper_dispatch' ? 0.65 : 1.0;
      const score = Math.round(((Math.log10(freq + 10) * 100 + games * 25 + (e.kind === 'native_function' ? 120 : 0)) * modBoost * staleBoost * depthBoost));
      return {
        id: e.id,
        kind: e.kind,
        surface: e.surface ?? e.keySchema,
        anchorId: e.anchorId ?? e.surface,
        verificationDepth: e.verificationDepth,
        stale: e.stale,
        modifiedInLatest: Boolean(e.crossVersion?.modifiedInLatest),
        totalCalls: freq,
        gameCount: games,
        priorityScore: score,
      };
    })
    .sort((a, b) => b.priorityScore - a.priorityScore)
    .slice(0, 40);

  const ledger = {
    schema: LEDGER_SCHEMA,
    generatedAt: new Date().toISOString(),
    binaries,
    sourcePins,
    corpusStats,
    metrics,
    burnDownQueue,
    entries,
    unresolvedGaps,
    knownDiscrepancies: evidenceDoc.knownDiscrepancies ?? [],
  };

  const validation = validateVerificationLedger(ledger);
  if (!validation.valid) {
    throw new Error(`Ledger schema validation failed:\n  ${validation.errors.join('\n  ')}`);
  }
  return ledger;
}

/**
 * Validate an existing ledger on disk: schema, dangling TS/test links, and staleness detection.
 */
export function checkLedger(ledgerPath = LEDGER_OUT_PATH, {strictStale = false} = {}) {
  const ledger = JSON.parse(fs.readFileSync(ledgerPath, 'utf8'));
  const schemaRes = validateVerificationLedger(ledger);
  const errors = [...schemaRes.errors];
  const staleEntries = [];

  // Recompute current source hashes on disk
  const currentPins = {};
  for (const rel of Object.keys(ledger.sourcePins ?? {})) {
    const abs = path.join(REPO_ROOT, rel);
    if (!fs.existsSync(abs)) {
      errors.push(`Dangling pinned source file: ${rel}`);
    } else {
      currentPins[rel] = sha256File(abs);
    }
  }

  for (const e of ledger.entries ?? []) {
    for (const link of e.tsLinks ?? []) {
      const abs = path.join(REPO_ROOT, link.file);
      if (!fs.existsSync(abs)) {
        errors.push(`Dangling tsLink in ${e.id}: ${link.file}`);
      } else if (link.line !== undefined) {
        const lineCount = fs.readFileSync(abs, 'utf8').split('\n').length;
        if (link.line < 1 || link.line > lineCount) {
          errors.push(`Out-of-range tsLink line in ${e.id}: ${link.file}:${link.line} (max ${lineCount})`);
        }
      }
    }
    for (const tf of e.testLinks ?? []) {
      if (!fs.existsSync(path.join(REPO_ROOT, tf))) {
        errors.push(`Dangling testLink in ${e.id}: ${tf}`);
      }
    }
    const st = evaluateStaleness(e, currentPins, ledger.binaries ?? {});
    if (st.stale) {
      staleEntries.push({id: e.id, reasons: st.staleReasons});
      if (e.status?.statically_verified && !e.stale) {
        errors.push(`Stale verified entry ${e.id} has not been invalidated: ${st.staleReasons.join('; ')}`);
      }
    }
  }

  if (strictStale && staleEntries.length > 0) {
    errors.push(`Found ${staleEntries.length} stale ledger entries under --strict-stale`);
  }

  return {
    valid: errors.length === 0,
    errors,
    staleCount: staleEntries.length,
    staleEntries,
    metrics: ledger.metrics,
  };
}

export function renderCoverageMarkdown(ledger) {
  const lines = [];
  lines.push('# SiglusEngine Multi-Layer Verification Coverage');
  lines.push('');
  lines.push(`Generated: \`${ledger.generatedAt}\``);
  lines.push('');
  lines.push('> Coverage layers are strictly separate. Matching hashes, CFG shape, or passing browser smoke tests never count as `statically_verified` without pinned Ghidra evidence.');
  lines.push('');

  lines.push('## Binary Corpus (8 Revisions)');
  lines.push('');
  lines.push('| ID | Title | FileVersion | Container | Discovered Functions | Analyzed SHA-256 (prefix) |');
  lines.push('| --- | --- | --- | --- | ---: | --- |');
  for (const b of Object.values(ledger.binaries)) {
    lines.push(
      `| \`${b.id}\` | ${b.title} | \`${b.fileVersion ?? 'unknown'}\` | \`${b.containerKind}\` | ${b.discoveredFunctionCount.toLocaleString()} | \`${b.analyzedSha256.slice(0, 16)}\` |`,
    );
  }
  lines.push('');

  lines.push('## Multi-Layer Coverage Summary');
  lines.push('');
  const cols = ['total', ...VERIFICATION_METRIC_KEYS, 'leaf_verified', 'wrapper_dispatch', 'platform_boundary', 'stale'];
  lines.push(`| Layer / Kind | ${cols.join(' | ')} |`);
  lines.push(`| --- | ${cols.map(() => '---:').join(' | ')} |`);
  const fmtRow = (label, obj) => `| ${label} | ${cols.map((c) => (obj[c] ?? 0).toLocaleString()).join(' | ')} |`;
  lines.push(fmtRow('**Overall**', ledger.metrics.overall));
  for (const [kind, obj] of Object.entries(ledger.metrics.byKind)) {
    lines.push(fmtRow(`\`${kind}\``, obj));
  }
  lines.push('');

  if (fs.existsSync(MUTATION_REPORT_PATH)) {
    const mut = JSON.parse(fs.readFileSync(MUTATION_REPORT_PATH, 'utf8'));
    lines.push('## Targeted Mutation Testing Summary');
    lines.push('');
    lines.push(`- Generated: \`${mut.generatedAt}\``);
    lines.push(`- Total Mutants: **${mut.summary.total}** | Killed: **${mut.summary.killed}** | Surviving: **${mut.summary.surviving}** | Equivalent: **${mut.summary.equivalent}** | Invalid: **${mut.summary.invalid}** | Timed Out: **${mut.summary.timed_out}**`);
    lines.push(`- Effective Kill Rate (killed / (killed + surviving + timed_out)): **${mut.summary.killRatePct}%**`);
    lines.push('');
  }

  lines.push('## Top Priority Burn-Down Queue (Unverified / Stale / Modified in 1.1.141.3)');
  lines.push('');
  lines.push('| Priority | Entry ID | Kind | Surface | Calls (8 games) | Games | Modified in 1.1.141.3 | Stale |');
  lines.push('| ---: | --- | --- | --- | ---: | ---: | --- | --- |');
  for (const item of ledger.burnDownQueue.slice(0, 25)) {
    lines.push(
      `| ${item.priorityScore} | \`${item.id}\` | \`${item.kind}\` | \`${item.surface}\` | ${item.totalCalls.toLocaleString()} | ${item.gameCount} | ${item.modifiedInLatest ? 'yes' : 'no'} | ${item.stale ? 'STALE' : 'no'} |`,
    );
  }
  lines.push('');

  lines.push('## Unresolved Coverage Gaps & Indirect-Call Frontiers');
  lines.push('');
  for (const gap of ledger.unresolvedGaps) {
    if (gap.kind === 'packed_binary_blocker') {
      lines.push(`- **Packed binary blocker** (\`${gap.binaryId}\` \`${gap.fileVersion}\`): ${gap.description}`);
    } else if (gap.kind === 'indirect_call_frontier') {
      lines.push(
        `- **Indirect-call frontier** (\`${gap.binaryId}\` \`${gap.fileVersion}\`): reachable lower bound \`>= ${gap.reachableLowerBound}\` functions; **${gap.frontierFunctionCount}** reachable functions contain **${gap.indirectSiteCount}** unresolved indirect-call / vtable / function-pointer sites.`,
      );
    } else if (gap.kind === 'cross_version_unresolved_functions') {
      lines.push(
        `- **Cross-version unresolved** (\`${gap.fromId}\` → \`${gap.toId}\`): **${gap.unresolvedCount}** functions left explicitly unresolved${gap.blockedByPackedBinary ? ' (packed binary blocker)' : ''}.`,
      );
    }
  }
  lines.push('');

  if (ledger.knownDiscrepancies.length > 0) {
    lines.push('## Confirmed & Resolved Discrepancies');
    lines.push('');
    for (const d of ledger.knownDiscrepancies) {
      lines.push(`- \`${d.id}\` [${d.status}]: ${d.summary}`);
    }
    lines.push('');
  }

  return lines.join('\n');
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const cmd = process.argv[2] ?? 'build';
  if (cmd === 'build' || cmd === 'refresh') {
    const ledger = buildLedger();
    fs.mkdirSync(path.dirname(LEDGER_OUT_PATH), {recursive: true});
    fs.writeFileSync(LEDGER_OUT_PATH, JSON.stringify(ledger, null, 2) + '\n');
    fs.writeFileSync(REPORT_OUT_PATH, renderCoverageMarkdown(ledger));
    console.log(`[ok] Wrote ledger (${ledger.entries.length} entries) to ${path.relative(REPO_ROOT, LEDGER_OUT_PATH)}`);
    console.log(`[ok] Wrote report to ${path.relative(REPO_ROOT, REPORT_OUT_PATH)}`);
    console.log('Metrics:', JSON.stringify(ledger.metrics.overall));
  } else if (cmd === 'check') {
    const strictStale = process.argv.includes('--strict-stale');
    const res = checkLedger(LEDGER_OUT_PATH, {strictStale});
    if (!res.valid) {
      console.error('[FAIL] Ledger validation failed:');
      for (const e of res.errors) console.error('  -', e);
      process.exit(1);
    }
    console.log(`[ok] Ledger valid. Entries=${res.metrics.overall.total}, Stale=${res.staleCount}`);
  } else if (cmd === 'report') {
    const ledger = JSON.parse(fs.readFileSync(LEDGER_OUT_PATH, 'utf8'));
    fs.writeFileSync(REPORT_OUT_PATH, renderCoverageMarkdown(ledger));
    console.log(`[ok] Regenerated ${path.relative(REPO_ROOT, REPORT_OUT_PATH)}`);
  } else {
    console.error('Usage: node tools/siglus-inventory/ledger.mjs <build|check|report> [--strict-stale]');
    process.exit(1);
  }
}
