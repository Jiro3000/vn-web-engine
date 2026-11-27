#!/usr/bin/env node
/**
 * Phase 4: Fast, deterministic, resumable targeted mutation testing runner for SiglusEngine.
 *
 * - Mutates copies inside an isolated temporary directory; NEVER mutates the working tree.
 * - Transpiles & validates each mutant strictly; compilation/syntax errors are classified
 *   as `invalid` (NEVER counted as `killed`).
 * - Runs all fast Node Siglus unit, invariant, and stateful interaction test suites
 *   (never headless Brave per mutant).
 * - Classifies every mutant strictly into:
 *     killed | surviving | equivalent | invalid | timed_out
 *
 * Usage:
 *   node tools/siglus-mutate.mjs [--ids id1,id2] [--force] [--timeout-ms 20000]
 */

import {spawnSync} from 'node:child_process';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import ts from 'typescript';

const REPO_ROOT = path.resolve(import.meta.dirname, '..');
const CHECKPOINT_PATH = path.join(REPO_ROOT, 'targetgame/siglus-inventory/checkpoints/mutation-checkpoint.json');
const REPORT_OUT_PATH = path.join(REPO_ROOT, 'docs/siglus/mutation-report.json');

export const FAST_SIGLUS_TESTS = [
  'tests/siglus-audit-invariants.test.mjs',
  'tests/siglus-stateful-interactions.test.mjs',
  'tests/siglus-audio-checkpoint.test.mjs',
  'tests/siglus-g00.test.mjs',
  'tests/siglus-graphics.test.mjs',
  'tests/siglus-label-call.test.mjs',
  'tests/siglus-mwnd-layout.test.mjs',
  'tests/siglus-nwa.test.mjs',
  'tests/siglus-omv.test.mjs',
  'tests/siglus-timetable.test.mjs',
];

/**
 * Curated catalog of high-leverage semantic mutations across SiglusEngine runtime & formats.
 * Each entry targets a unique exact substring in `file` (must match exactly once).
 */
export const MUTATION_CATALOG = [
  // --- vm.ts ---
  {
    id: 'vm.div-by-zero-guard',
    file: 'src/engines/siglus/vm.ts',
    area: 'vm',
    description: 'Drop division-by-zero guard in binary op 4 (returns Infinity/0 bug)',
    target: 'return divisor === 0 ? 0 : Math.trunc((Number(a) | 0) / divisor) | 0;',
    replacement: 'return divisor === 0 ? 1 : Math.trunc((Number(a) | 0) / divisor) | 0;',
  },
  {
    id: 'vm.mod-by-zero-guard',
    file: 'src/engines/siglus/vm.ts',
    area: 'vm',
    description: 'Corrupt modulo-by-zero guard in binary op 5',
    target: 'return divisor === 0 ? 0 : ((Number(a) | 0) % divisor) | 0;',
    replacement: 'return divisor === 0 ? 1 : ((Number(a) | 0) % divisor) | 0;',
  },
  {
    id: 'vm.imul-32bit-wrap',
    file: 'src/engines/siglus/vm.ts',
    area: 'vm',
    description: 'Replace signed 32-bit Math.imul with JS float multiply',
    target: 'return Math.imul(Number(a), Number(b));',
    replacement: 'return Number(a) * Number(b);',
  },
  {
    id: 'vm.read-args-reverse',
    file: 'src/engines/siglus/vm.ts',
    area: 'vm',
    description: 'Omit stack-argument reversal in Frame.readArguments',
    target: 'return args.reverse();',
    replacement: 'return args;',
  },
  {
    id: 'vm.checkpoint-active-frame',
    file: 'src/engines/siglus/vm.ts',
    area: 'vm',
    description: 'Ignore sceneJumps activeFrame mapping in SiglusVm.checkpoint',
    target: 'const activeFrames = this.frames.map((original) => this.sceneJumps.get(original) ?? original);',
    replacement: 'const activeFrames = this.frames.map((original) => original);',
  },
  {
    id: 'vm.trailing-read-flag-global',
    file: 'src/engines/siglus/vm.ts',
    area: 'vm',
    description: 'Always return false for single-element global readFlag check',
    target: 'if (path.length === 1) return readFlagGlobalRoots.has(path[0]!);',
    replacement: 'if (path.length === 1) return false;',
  },

  // --- player.ts ---
  {
    id: 'player.dirty-guard-visible',
    file: 'src/engines/siglus/player.ts',
    area: 'player',
    description: 'Remove no-op write guard on object.visible (causes spurious DOM dirtying)',
    target: 'if (value !== undefined && object.visible !== Boolean(value)) {',
    replacement: 'if (value !== undefined) {',
  },
  {
    id: 'player.counter-pause-retain',
    file: 'src/engines/siglus/player.ts',
    area: 'player',
    description: 'Skip setting pausedAt on counter.pause (member 4)',
    target: 'if (counter) counter.pausedAt ??= now;',
    replacement: 'if (counter) { /* dropped pause */ }',
  },
  {
    id: 'player.counter-resume-offset',
    file: 'src/engines/siglus/player.ts',
    area: 'player',
    description: 'Fail to clear pausedAt on counter.resume (member 5)',
    target: 'counter.start += now - counter.pausedAt;\n          delete counter.pausedAt;',
    replacement: 'counter.start += now - counter.pausedAt;',
  },
  {
    id: 'player.counter-check-active-paused',
    file: 'src/engines/siglus/player.ts',
    area: 'player',
    description: 'Ignore pausedAt === undefined in counter.check_active (member 14)',
    target: 'Boolean(counter && counter.pausedAt === undefined &&',
    replacement: 'Boolean(counter &&',
  },
  {
    id: 'player.excall-release-frameactions-scope',
    file: 'src/engines/siglus/player.ts',
    area: 'player',
    description: 'Delete story frameActions too on EXCALL releaseSystemObjects',
    target: 'if (action.path[0] === 65) {\n        this.frameActions.delete(key);',
    replacement: 'if (action.path[0] !== -1) {\n        this.frameActions.delete(key);',
  },
  {
    id: 'player.excall-release-groups-scope',
    file: 'src/engines/siglus/player.ts',
    area: 'player',
    description: 'Clear story button groups (< 100000) during EXCALL releaseSystemObjects',
    target: 'if (group >= 100_000) {\n        this.activeGroups.delete(group);',
    replacement: 'if (group >= 0) {\n        this.activeGroups.delete(group);',
  },
  {
    id: 'player.excall-joypad-fallback',
    file: 'src/engines/siglus/player.ts',
    area: 'player',
    description: 'Drop defaultMode fallback in EXCALL joypadModeActive',
    target: '? excallMode === 1 || (excallMode !== 0 && defaultMode !== 0)',
    replacement: '? excallMode === 1',
  },
  {
    id: 'player.object-hit-state-disabled',
    file: 'src/engines/siglus/player.ts',
    area: 'player',
    description: 'Ignore disabled flag in object.get_button_hit_state (123)',
    target: '        btn.group < 0 ||\n        existing.disabled ||\n        !this.activeGroups.has(btn.group)',
    replacement: '        btn.group < 0 ||\n        !this.activeGroups.has(btn.group)',
  },

  // --- display.ts ---
  {
    id: 'display.wheel-sign',
    file: 'src/engines/siglus/display.ts',
    area: 'display',
    description: 'Invert mouse.wheel delta sign (+Math.sign -> -Math.sign)',
    target: 'this.wheelDelta += Math.sign(event.deltaY);',
    replacement: 'this.wheelDelta -= Math.sign(event.deltaY);',
  },
  {
    id: 'display.hover-se-dedup',
    file: 'src/engines/siglus/display.ts',
    area: 'display',
    description: 'Drop hover SE deduplication guard in enterButtonHover',
    target: 'if (this.hoveredControlKey === key) return;',
    replacement: 'if (false && this.hoveredControlKey === key) return;',
  },
  {
    id: 'display.leave-hover-inert-guard',
    file: 'src/engines/siglus/display.ts',
    area: 'display',
    description: 'Drop detached/inert node guard in leaveButtonHover',
    target: 'if (!element.isConnected || element.closest(\'[inert]\')) return;',
    replacement: 'if (false && !element.isConnected) return;',
  },
  {
    id: 'display.button-hit-path-empty-bounds',
    file: 'src/engines/siglus/display.ts',
    area: 'display',
    description: 'Corrupt empty-bounds hit path in buttonHitPath',
    target: 'if (right <= left || bottom <= top) return \'inset(100%)\';',
    replacement: 'if (right <= left || bottom <= top) return \'inset(0px)\';',
  },
  {
    id: 'display.number-cache-cap',
    file: 'src/engines/siglus/display.ts',
    area: 'display',
    description: 'Disable LRU eviction cap (> 256) in numberGraphicCache',
    target: 'if (this.numberGraphicCache.size > 256)',
    replacement: 'if (this.numberGraphicCache.size > 1_000_000)',
  },
  {
    id: 'display.serialize-opacity-elapsed',
    file: 'src/engines/siglus/display.ts',
    area: 'display',
    description: 'Always drop active opacity event in serializeDrawObject',
    target: 'opacity: object.opacity && opacityElapsed < object.opacity[1] + object.opacity[2]',
    replacement: 'opacity: false && object.opacity && opacityElapsed < object.opacity[1] + object.opacity[2]',
  },
  {
    id: 'display.serialize-offset-event-expiry',
    file: 'src/engines/siglus/display.ts',
    area: 'display',
    description: 'Invert offsetEvent expiry check (>= -> <) in serializeDrawObject',
    target: 'if (elapsed >= Number(event.time.duration ?? 0) + Number(event.time.delay ?? 0)) continue;',
    replacement: 'if (elapsed < Number(event.time.duration ?? 0) + Number(event.time.delay ?? 0)) continue;',
  },

  // --- mwnd.ts ---
  {
    id: 'mwnd.vertical-mode-flag',
    file: 'src/engines/siglus/mwnd.ts',
    area: 'mwnd',
    description: 'Break vertical text mode detection (TATEYOKO_MODE === 1 -> === 2)',
    target: 'const vertical = Number(config.get(\'TATEYOKO_MODE\') ?? 0) === 1;',
    replacement: 'const vertical = Number(config.get(\'TATEYOKO_MODE\') ?? 0) === 2;',
  },
  {
    id: 'mwnd.name-align-right-sign',
    file: 'src/engines/siglus/mwnd.ts',
    area: 'mwnd',
    description: 'Add instead of subtract nameMsgX for NAME_WINDOW_ALIGN == 2',
    target: 'nameAlign === 0 ? originX + nameMsgX : nameAlign === 2 ? originX - nameMsgX : originX;',
    replacement: 'nameAlign === 0 ? originX + nameMsgX : nameAlign === 2 ? originX + nameMsgX : originX;',
  },

  // --- wipe.ts ---
  {
    id: 'wipe.softness-upper-clamp',
    file: 'src/engines/siglus/wipe.ts',
    area: 'wipe',
    description: 'Return 0 instead of 1 when wipe softness option exceeds table length',
    target: 'if (option >= wipeSoftnessTable.length) return 1;',
    replacement: 'if (option >= wipeSoftnessTable.length) return 0;',
  },
  {
    id: 'wipe.g00-mask-reverse',
    file: 'src/engines/siglus/wipe.ts',
    area: 'wipe',
    description: 'Drop reverse polarity inversion in g00MaskValues',
    target: 'values[i] = reverse ? 255 - lum : lum;',
    replacement: 'values[i] = lum;',
  },
  {
    id: 'wipe.pcm-event-2x-weight',
    file: 'src/engines/siglus/wipe.ts',
    area: 'wipe',
    description: 'Weight non-previous PCM event entries 1x instead of native 2x',
    target: 'total += i === previousIndex ? p : p * 2;',
    replacement: 'total += p;',
  },

  // --- audio.ts ---
  {
    id: 'audio.dsound-volume-curve-scale',
    file: 'src/engines/siglus/audio.ts',
    area: 'audio',
    description: 'Corrupt DirectSound log-dB scale factor (5000 -> 2000)',
    target: 'Math.min(0, Math.trunc((Math.log(normalized) / Math.fround(Math.LN10)) * 5000)),',
    replacement: 'Math.min(0, Math.trunc((Math.log(normalized) / Math.fround(Math.LN10)) * 2000)),',
  },

  // --- formats/siglus/* ---
  {
    id: 'g00.type1-palette-bounds',
    file: 'src/formats/siglus/g00.ts',
    area: 'formats/g00',
    description: 'Drop invalid palette index bounds check in G00 Type 1 decoder',
    target: 'if (color >= paletteSize) throw new Error(\'Invalid G00 palette index\');',
    replacement: 'if (color > 9999) throw new Error(\'Invalid G00 palette index\');',
  },
  {
    id: 'g00.type2-negative-dedup-length',
    file: 'src/formats/siglus/g00.ts',
    area: 'formats/g00',
    description: 'Drop Math.abs on deduplicated negative Type 2 cut length',
    target: 'const length = Math.abs(view.getInt32(8 + index * 8, true));',
    replacement: 'const length = view.getInt32(8 + index * 8, true);',
  },
  {
    id: 'dbs.getnum-type-guard',
    file: 'src/formats/siglus/dbs.ts',
    area: 'formats/dbs',
    description: 'Drop type === "V" guard in SiglusDbs.getNum',
    target: 'if (rIdx < 0 || cIdx < 0 || this.columns[cIdx]!.type !== \'V\') return 0;',
    replacement: 'if (rIdx < 0 || cIdx < 0) return 0;',
  },
  {
    id: 'dbs.checkcolumn-code',
    file: 'src/formats/siglus/dbs.ts',
    area: 'formats/dbs',
    description: 'Swap int/string return codes (2 : 1 -> 1 : 2) in SiglusDbs.checkColumn',
    target: 'return col.type === \'V\' ? 2 : 1;',
    replacement: 'return col.type === \'V\' ? 1 : 2;',
  },
  {
    id: 'dbs.findstr-case-sensitivity',
    file: 'src/formats/siglus/dbs.ts',
    area: 'formats/dbs',
    description: 'Always fold case in SiglusDbs.findStr (breaks find_str_real 105.-1.*.7)',
    target: 'const target = caseSensitive ? value : value.toLowerCase();',
    replacement: 'const target = value.toLowerCase();',
  },
  {
    id: 'player.database-check-item-member',
    file: 'src/engines/siglus/player.ts',
    area: 'player/database',
    description: 'Reintroduce off-by-one member ID (3 -> 2) for database.check_item_no',
    target: 'if (path[3] === 3) return db ? Number(db.hasRow(n(0))) : 0;',
    replacement: 'if (path[3] === 2) return db ? Number(db.hasRow(n(0))) : 0;',
  },
  {
    id: 'player.cgtable-disable-gate',
    file: 'src/engines/siglus/player.ts',
    area: 'player/cgtable',
    description: 'Drop cgTableDisabled guard in recordCgSeen (breaks cgtable.set_disable 78.7)',
    target: 'if (this.cgTableDisabled || !name || !this.cgTable.size) return;',
    replacement: 'if (!name || !this.cgTable.size) return;',
  },
  {
    id: 'player.math-sqrt-negative-clamp',
    file: 'src/engines/siglus/player.ts',
    area: 'player/math',
    description: 'Drop negative-to-0 clamp in math.sqrt (39.14)',
    target: 'return v <= 0 ? 0 : Math.trunc(Math.sqrt(v)) | 0;',
    replacement: 'return Math.trunc(Math.sqrt(v)) | 0;',
  },
  {
    id: 'cgtable.v2-stride',
    file: 'src/formats/siglus/cgtable.ts',
    area: 'formats/cgtable',
    description: 'Use v1 stride (36) instead of v2 stride (60) for CGTABLE2',
    target: 'version = 2;\n    stride = 60;',
    replacement: 'version = 2;\n    stride = 36;',
  },
  {
    id: 'compression.lzss-backref-count',
    file: 'src/formats/siglus/compression.ts',
    area: 'formats/compression',
    description: 'Corrupt LZSS back-reference minimum match length (+ 2 -> + 3)',
    target: 'let count = (word & 15) + 2;',
    replacement: 'let count = (word & 15) + 3;',
  },
  {
    id: 'compression.xor-unaligned-prefix',
    file: 'src/formats/siglus/compression.ts',
    area: 'formats/compression',
    description: 'Skip unaligned prefix bytes in xorByteInPlace',
    target: 'for (; i < prefix; i++) bytes[i] = bytes[i]! ^ k;',
    replacement: 'i = prefix;',
  },
  {
    id: 'scene-pack.string-table-xor-key',
    file: 'src/formats/siglus/scene-pack.ts',
    area: 'formats/scene-pack',
    description: 'Corrupt Scene.pck UTF-16 string table XOR key mask',
    target: 'const key = (i * multiplier) & 0xffff;',
    replacement: 'const key = ((i + 1) * multiplier) & 0xffff;',
  },
];

function sha256(bufOrStr) {
  return crypto.createHash('sha256').update(bufOrStr).digest('hex');
}

function copyDirRecursive(src, dst) {
  fs.mkdirSync(dst, {recursive: true});
  for (const entry of fs.readdirSync(src, {withFileTypes: true})) {
    const s = path.join(src, entry.name);
    const d = path.join(dst, entry.name);
    if (entry.isDirectory()) copyDirRecursive(s, d);
    else fs.copyFileSync(s, d);
  }
}

/**
 * Compile a mutated TS source string in isolation and verify zero syntax/transpile diagnostics.
 */
function compileMutatedTs(mutatedTsSource, relTsPath) {
  const res = ts.transpileModule(mutatedTsSource, {
    fileName: relTsPath,
    reportDiagnostics: true,
    compilerOptions: {
      target: ts.ScriptTarget.ES2022,
      module: ts.ModuleKind.ESNext,
      moduleResolution: ts.ModuleResolutionKind.Bundler,
      isolatedModules: true,
    },
  });
  const errors = (res.diagnostics ?? []).filter((d) => d.category === ts.DiagnosticCategory.Error);
  if (errors.length > 0) {
    return {
      ok: false,
      error: errors.map((d) => ts.flattenDiagnosticMessageText(d.messageText, '\n')).join('; '),
    };
  }
  return {ok: true, outputText: res.outputText};
}

/**
 * Create an isolated runnable workspace copy in tmpdir so the real repo is NEVER modified.
 */
function prepareIsolatedWorkspace() {
  const workDir = fs.mkdtempSync(path.join(os.tmpdir(), 'siglus-mutate-'));
  // Copy dist/ so we can safely overwrite one mutated .js file at a time
  copyDirRecursive(path.join(REPO_ROOT, 'dist'), path.join(workDir, 'dist'));
  // COPY test files and helpers (NEVER symlink tests/, otherwise Node ESM resolves
  // ../dist/* against the realpath in REPO_ROOT instead of workDir/dist!)
  fs.mkdirSync(path.join(workDir, 'tests'), {recursive: true});
  for (const relTest of FAST_SIGLUS_TESTS) {
    fs.copyFileSync(path.join(REPO_ROOT, relTest), path.join(workDir, relTest));
  }
  copyDirRecursive(path.join(REPO_ROOT, 'tests/helpers'), path.join(workDir, 'tests/helpers'));
  fs.symlinkSync(path.join(REPO_ROOT, 'tests/fixtures'), path.join(workDir, 'tests/fixtures'));
  fs.symlinkSync(path.join(REPO_ROOT, 'ui'), path.join(workDir, 'ui'));
  fs.symlinkSync(path.join(REPO_ROOT, 'node_modules'), path.join(workDir, 'node_modules'));
  fs.symlinkSync(path.join(REPO_ROOT, 'package.json'), path.join(workDir, 'package.json'));
  fs.symlinkSync(path.join(REPO_ROOT, 'src'), path.join(workDir, 'src'));
  return workDir;
}

export function runSingleMutant(mutant, workDir, {timeoutMs = 20000} = {}) {
  const absTs = path.join(REPO_ROOT, mutant.file);
  if (!fs.existsSync(absTs)) {
    return {id: mutant.id, status: 'invalid', reason: `Missing source file ${mutant.file}`};
  }
  const origTs = fs.readFileSync(absTs, 'utf8');
  const firstIdx = origTs.indexOf(mutant.target);
  if (firstIdx < 0) {
    return {id: mutant.id, status: 'invalid', reason: 'Mutation target substring not found'};
  }
  if (origTs.indexOf(mutant.target, firstIdx + 1) >= 0) {
    return {id: mutant.id, status: 'invalid', reason: 'Mutation target matched multiple locations (ambiguous)'};
  }

  const mutatedTs = origTs.slice(0, firstIdx) + mutant.replacement + origTs.slice(firstIdx + mutant.target.length);
  const compiled = compileMutatedTs(mutatedTs, mutant.file);
  if (!compiled.ok) {
    // STRICT: compilation failure is `invalid`, NEVER `killed`!
    return {id: mutant.id, status: 'invalid', reason: `Compilation error: ${compiled.error}`};
  }

  const relJs = mutant.file.replace(/^src\//, 'dist/').replace(/\.ts$/, '.js');
  const isoJs = path.join(workDir, relJs);
  const origJs = fs.readFileSync(isoJs, 'utf8');

  // Verify JS syntax validity using node --check before running tests
  fs.writeFileSync(isoJs, compiled.outputText);
  try {
    const syntax = spawnSync(process.execPath, ['--check', isoJs], {encoding: 'utf8', timeout: 5000});
    if (syntax.status !== 0) {
      return {
        id: mutant.id,
        status: 'invalid',
        reason: `Emitted JS syntax error: ${(syntax.stderr ?? '').trim().slice(0, 200)}`,
      };
    }

    const t0 = Date.now();
    const testRun = spawnSync(process.execPath, ['--test', ...FAST_SIGLUS_TESTS], {
      cwd: workDir,
      encoding: 'utf8',
      timeout: timeoutMs,
      maxBuffer: 16 * 1024 * 1024,
    });
    const durationMs = Date.now() - t0;

    if (testRun.error?.code === 'ETIMEDOUT' || testRun.signal === 'SIGTERM' || testRun.signal === 'SIGKILL') {
      return {id: mutant.id, status: 'timed_out', durationMs};
    }
    if (testRun.status !== 0) {
      const output = (testRun.stdout ?? '') + '\n' + (testRun.stderr ?? '');
      // Extract first failing test name
      const failLine = output
        .split('\n')
        .find((l) => l.includes('✖ ') && !l.includes('failing tests:'));
      return {
        id: mutant.id,
        status: 'killed',
        durationMs,
        killedBy: failLine ? failLine.trim().slice(0, 140) : `exit=${testRun.status}`,
      };
    }
    if (mutant.equivalentReason) {
      return {
        id: mutant.id,
        status: 'equivalent',
        durationMs,
        justification: mutant.equivalentReason,
      };
    }
    return {id: mutant.id, status: 'surviving', durationMs};
  } finally {
    fs.writeFileSync(isoJs, origJs);
  }
}

export function runMutationSuite({ids = null, force = false, timeoutMs = 20000} = {}) {
  // Compute suite + source fingerprint for resumable caching
  const testFingerprint = sha256(
    FAST_SIGLUS_TESTS.map((f) => `${f}:${sha256(fs.readFileSync(path.join(REPO_ROOT, f)))}`).join('\n'),
  );
  let checkpoint = {testFingerprint, results: {}};
  if (!force && fs.existsSync(CHECKPOINT_PATH)) {
    try {
      const prev = JSON.parse(fs.readFileSync(CHECKPOINT_PATH, 'utf8'));
      if (prev.testFingerprint === testFingerprint) checkpoint = prev;
    } catch {
      // Ignore corrupt checkpoint
    }
  }

  const selected = ids ? MUTATION_CATALOG.filter((m) => ids.includes(m.id)) : MUTATION_CATALOG;
  const workDir = prepareIsolatedWorkspace();
  const results = [];

  try {
    // Baseline sanity check: unmutated isolated workspace MUST pass 100% of fast tests!
    const base = spawnSync(process.execPath, ['--test', ...FAST_SIGLUS_TESTS], {
      cwd: workDir,
      encoding: 'utf8',
      timeout: timeoutMs * 2,
    });
    if (base.status !== 0) {
      throw new Error(`Unmutated baseline test suite failed in isolated workspace:\n${base.stdout}\n${base.stderr}`);
    }

    for (const m of selected) {
      const srcHash = sha256(fs.readFileSync(path.join(REPO_ROOT, m.file)));
      const cacheKey = `${m.id}:${srcHash}:${sha256(m.target + '->' + m.replacement)}`;
      let res = checkpoint.results[cacheKey];
      if (res) {
        console.log(`  [cached] ${m.id.padEnd(38)} -> ${res.status}`);
      } else {
        res = runSingleMutant(m, workDir, {timeoutMs});
        checkpoint.results[cacheKey] = res;
        fs.mkdirSync(path.dirname(CHECKPOINT_PATH), {recursive: true});
        fs.writeFileSync(CHECKPOINT_PATH, JSON.stringify(checkpoint, null, 2) + '\n');
        console.log(
          `  [${res.status.padEnd(9)}] ${m.id.padEnd(38)} (${res.durationMs ?? 0}ms)` +
            (res.killedBy ? ` ${res.killedBy.slice(0, 70)}` : res.reason ? ` ${res.reason.slice(0, 70)}` : ''),
        );
      }
      results.push({
        id: m.id,
        file: m.file,
        area: m.area,
        description: m.description,
        ...res,
      });
    }
  } finally {
    fs.rmSync(workDir, {recursive: true, force: true});
  }

  const counts = {total: results.length, killed: 0, surviving: 0, equivalent: 0, invalid: 0, timed_out: 0};
  for (const r of results) counts[r.status] = (counts[r.status] ?? 0) + 1;
  const denom = counts.killed + counts.surviving + counts.timed_out;
  counts.killRatePct = denom > 0 ? Number(((counts.killed / denom) * 100).toFixed(1)) : 0;

  const report = {
    schema: 'siglus-mutation-report/v1',
    generatedAt: new Date().toISOString(),
    testSuites: FAST_SIGLUS_TESTS,
    summary: counts,
    results,
  };
  fs.mkdirSync(path.dirname(REPORT_OUT_PATH), {recursive: true});
  fs.writeFileSync(REPORT_OUT_PATH, JSON.stringify(report, null, 2) + '\n');
  console.log('\nMutation Summary:', JSON.stringify(counts));
  return report;
}

if (import.meta.url === `file://${process.argv[1]}`) {
  let ids = null;
  let force = false;
  let timeoutMs = 20000;
  for (let i = 2; i < process.argv.length; i++) {
    const a = process.argv[i];
    if (a === '--ids') ids = process.argv[++i].split(',').map((s) => s.trim()).filter(Boolean);
    else if (a === '--force') force = true;
    else if (a === '--timeout-ms') timeoutMs = Number(process.argv[++i]);
  }
  runMutationSuite({ids, force, timeoutMs});
}
