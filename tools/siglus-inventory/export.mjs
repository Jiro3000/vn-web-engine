#!/usr/bin/env node
/**
 * Phase 1: Resumable headless Ghidra whole-binary native inventory runner.
 *
 * Strictly static analysis: never executes or emulates any target binary.
 * Reuses existing read-only Ghidra projects when executableSha256 matches;
 * imports new binaries into ignored targetgame/siglus-inventory/ghidra/.
 *
 * Usage:
 *   node tools/siglus-inventory/export.mjs --ids anemoi,hoshiori-rikka
 *   node tools/siglus-inventory/export.mjs --all
 *   node tools/siglus-inventory/export.mjs --exe /path/to/SiglusEngine.exe --id new-game
 *   node tools/siglus-inventory/export.mjs --validate-only
 */

import {spawnSync} from 'node:child_process';
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import {validateInventory} from './schema.mjs';

const REPO_ROOT = path.resolve(import.meta.dirname, '../..');
const CORPUS_PATH = path.join(import.meta.dirname, 'corpus.json');
const SCRIPT_DIR = path.join(import.meta.dirname, 'ghidra');
const INVENTORY_ROOT = path.join(REPO_ROOT, 'targetgame/siglus-inventory');
const EXPORTS_DIR = path.join(INVENTORY_ROOT, 'exports');
const GHIDRA_DIR = path.join(INVENTORY_ROOT, 'ghidra');
const EXTRACTED_DIR = path.join(INVENTORY_ROOT, 'extracted');
const CHECKPOINTS_DIR = path.join(INVENTORY_ROOT, 'checkpoints');
const GHIDRA_INSTALL = process.env.GHIDRA_INSTALL ?? '/opt/homebrew/opt/ghidra/libexec';
const JDK_BIN = process.env.JDK_BIN ?? '/opt/homebrew/opt/openjdk@21/bin';

function sha256Buffer(buf) {
  return crypto.createHash('sha256').update(buf).digest('hex');
}

export function inspectPeStatic(filePath) {
  const buf = fs.readFileSync(filePath);
  const outerSha256 = sha256Buffer(buf);
  const size = buf.length;
  if (size < 0x40 || buf[0] !== 0x4d || buf[1] !== 0x5a) {
    throw new Error(`Not a valid PE/MZ file: ${filePath}`);
  }
  const view = new DataView(buf.buffer, buf.byteOffset, buf.byteLength);
  const eLfanew = view.getUint32(0x3c, true);
  if (eLfanew + 24 >= size || buf.toString('ascii', eLfanew, eLfanew + 4) !== 'PE\0\0') {
    throw new Error(`Missing PE signature in ${filePath}`);
  }
  const numSections = view.getUint16(eLfanew + 6, true);
  const optSize = view.getUint16(eLfanew + 20, true);
  const optOff = eLfanew + 24;
  const magic = view.getUint16(optOff, true);
  const isPe64 = magic === 0x20b;
  const imageBase = isPe64
    ? Number(view.getBigUint64(optOff + 24, true))
    : view.getUint32(optOff + 28, true);

  let maxRawEnd = 0;
  const sectionNames = [];
  const secOff = optOff + optSize;
  for (let i = 0; i < numSections; i++) {
    const off = secOff + i * 40;
    const rawName = buf.subarray(off, off + 8).toString('latin1').replace(/\0+$/, '');
    const rawSize = view.getUint32(off + 16, true);
    const rawPtr = view.getUint32(off + 20, true);
    sectionNames.push(rawName);
    if (rawPtr + rawSize > maxRawEnd) maxRawEnd = rawPtr + rawSize;
  }

  // Extract VS_FIXEDFILEINFO (0xFEEF04BD) statically from resources
  let fileVersion = null;
  const sig = Buffer.from([0xbd, 0x04, 0xef, 0xfe]);
  const vIdx = buf.indexOf(sig);
  if (vIdx >= 0 && vIdx + 24 <= size) {
    const ms = view.getUint32(vIdx + 8, true);
    const ls = view.getUint32(vIdx + 12, true);
    fileVersion = `${ms >>> 16}.${ms & 0xffff}.${ls >>> 16}.${ls & 0xffff}`;
  }

  // Detect SdWrap embedded PE32 payload (static slice, never executed)
  let containerKind = 'direct-pe';
  let embeddedPeOffset = null;
  let analyzedSha256 = outerSha256;
  const overlayBytes = size - maxRawEnd;
  if (overlayBytes > 0x100000) {
    // Scan aligned 0x1000 boundaries in overlay for an embedded MZ+PE32 Siglus image
    for (let off = Math.ceil(maxRawEnd / 0x1000) * 0x1000; off + 0x1000 < size; off += 0x1000) {
      if (buf[off] === 0x4d && buf[off + 1] === 0x5a) {
        const innerLfanew = view.getUint32(off + 0x3c, true);
        if (
          innerLfanew > 0 &&
          innerLfanew < 0x1000 &&
          off + innerLfanew + 4 < size &&
          buf.toString('ascii', off + innerLfanew, off + innerLfanew + 4) === 'PE\0\0'
        ) {
          containerKind = 'sdwrap-embedded-pe';
          embeddedPeOffset = '0x' + off.toString(16);
          analyzedSha256 = sha256Buffer(buf.subarray(off));
          // Also check inner PE FileVersion
          const innerVIdx = buf.indexOf(sig, off);
          if (innerVIdx >= off && innerVIdx + 24 <= size) {
            const ms = view.getUint32(innerVIdx + 8, true);
            const ls = view.getUint32(innerVIdx + 12, true);
            fileVersion = `${ms >>> 16}.${ms & 0xffff}.${ls >>> 16}.${ls & 0xffff}`;
          }
          break;
        }
      }
    }
  } else if (!sectionNames.includes('.text')) {
    containerKind = 'packed-pe';
  }

  return {
    size,
    sha256: outerSha256,
    analyzedSha256,
    fileVersion,
    imageBase: '0x' + imageBase.toString(16),
    containerKind,
    embeddedPeOffset,
    sectionNames,
  };
}

function ensureDirs() {
  for (const d of [EXPORTS_DIR, GHIDRA_DIR, EXTRACTED_DIR, CHECKPOINTS_DIR]) {
    fs.mkdirSync(d, {recursive: true});
  }
}

function runAnalyzeHeadless(args, logFile) {
  const ghidraSettings = path.join(GHIDRA_DIR, '_ghidra-settings');
  const ghidraHome = path.join(GHIDRA_DIR, '_ghidra-home');
  const ghidraTemp = path.join(GHIDRA_DIR, '_ghidra-temp');
  for (const d of [ghidraSettings, ghidraHome, ghidraTemp]) {
    fs.mkdirSync(d, {recursive: true});
  }
  const env = {
    ...process.env,
    PATH: `${JDK_BIN}:${process.env.PATH ?? ''}`,
    JAVA_TOOL_OPTIONS: [
      `-Dapplication.settingsdir=${ghidraSettings}`,
      `-Duser.home=${ghidraHome}`,
      `-Djava.io.tmpdir=${ghidraTemp}`,
    ].join(' '),
  };
  const headless = path.join(GHIDRA_INSTALL, 'support/analyzeHeadless');
  const res = spawnSync(headless, args, {
    env,
    encoding: 'utf8',
    maxBuffer: 64 * 1024 * 1024,
  });
  fs.writeFileSync(logFile, (res.stdout ?? '') + '\n--- STDERR ---\n' + (res.stderr ?? ''));
  return res;
}

export function exportBinary(entry, {force = false} = {}) {
  ensureDirs();
  const outPath = path.join(EXPORTS_DIR, `${entry.id}.inventory.json`);
  const ckptPath = path.join(CHECKPOINTS_DIR, `${entry.id}.export.checkpoint.json`);

  // Step 1: Verify on-disk binary statically
  if (!fs.existsSync(entry.exePath)) {
    throw new Error(`Executable not found: ${entry.exePath}`);
  }
  const pe = inspectPeStatic(entry.exePath);
  if (entry.sha256 && entry.sha256 !== pe.sha256) {
    throw new Error(`SHA-256 mismatch for ${entry.id}: corpus=${entry.sha256} actual=${pe.sha256}`);
  }
  if (entry.analyzedSha256 && entry.analyzedSha256 !== pe.analyzedSha256) {
    throw new Error(
      `analyzedSha256 mismatch for ${entry.id}: corpus=${entry.analyzedSha256} actual=${pe.analyzedSha256}`,
    );
  }

  // Step 2: Check resumable checkpoint
  if (!force && fs.existsSync(outPath) && fs.existsSync(ckptPath)) {
    const ckpt = JSON.parse(fs.readFileSync(ckptPath, 'utf8'));
    if (ckpt.status === 'complete' && ckpt.analyzedSha256 === pe.analyzedSha256) {
      const inv = JSON.parse(fs.readFileSync(outPath, 'utf8'));
      const v = validateInventory(inv);
      if (v.valid) {
        console.log(
          `[skip/resume] ${entry.id} (${pe.fileVersion ?? 'unknown'}): ${inv.summary.discoveredFunctionCount} functions already exported & valid.`,
        );
        return {entry, pe, outPath, summary: inv.summary, resumed: true};
      }
    }
  }

  // Step 3: Prepare input binary (extract static inner PE if SdWrap)
  let targetBinaryPath = entry.exePath;
  if (pe.containerKind === 'sdwrap-embedded-pe' && pe.embeddedPeOffset) {
    const offset = parseInt(pe.embeddedPeOffset, 16);
    const extractedPath = path.join(EXTRACTED_DIR, `${entry.id}-inner-${pe.analyzedSha256.slice(0, 12)}.exe`);
    if (!fs.existsSync(extractedPath)) {
      const full = fs.readFileSync(entry.exePath);
      fs.writeFileSync(extractedPath, full.subarray(offset));
    }
    targetBinaryPath = extractedPath;
  }

  const scriptArgs = [
    outPath,
    entry.id,
    pe.analyzedSha256,
    pe.sha256,
    pe.fileVersion ?? 'null',
    pe.containerKind,
    pe.embeddedPeOffset ?? 'null',
    String(pe.size),
  ];

  // Step 4: Try existing read-only Ghidra project first (only if SHA-256 verified inside script!)
  let exported = false;
  const logFile = path.join(CHECKPOINTS_DIR, `${entry.id}.ghidra.log`);
  if (entry.existingGhidraProject) {
    const projDir = path.resolve(REPO_ROOT, entry.existingGhidraProject.dir);
    const gpr = path.join(projDir, `${entry.existingGhidraProject.name}.gpr`);
    if (fs.existsSync(gpr)) {
      console.log(`[export] ${entry.id} (${pe.fileVersion}): using existing read-only Ghidra project ${entry.existingGhidraProject.name}...`);
      const res = runAnalyzeHeadless(
        [
          projDir,
          entry.existingGhidraProject.name,
          '-process',
          entry.existingGhidraProject.program,
          '-noanalysis',
          '-readOnly',
          '-scriptPath',
          SCRIPT_DIR,
          '-postScript',
          'SiglusWholeBinaryInventory.java',
          ...scriptArgs,
        ],
        logFile,
      );
      if (res.status === 0 && fs.existsSync(outPath)) {
        exported = true;
      } else {
        console.warn(`[warn] Existing project export failed for ${entry.id} (see ${logFile}); falling back to dedicated project.`);
      }
    }
  }

  // Step 5: Dedicated project in targetgame/siglus-inventory/ghidra/<id>
  if (!exported) {
    const projDir = path.join(GHIDRA_DIR, entry.id);
    const projName = `Siglus_${entry.id.replace(/[^a-zA-Z0-9_]/g, '_')}`;
    const gprPath = path.join(projDir, `${projName}.gpr`);
    fs.mkdirSync(projDir, {recursive: true});
    const programName = path.basename(targetBinaryPath);

    let res;
    if (fs.existsSync(gprPath)) {
      console.log(`[export] ${entry.id} (${pe.fileVersion}): reusing dedicated Ghidra project ${projName}...`);
      res = runAnalyzeHeadless(
        [
          projDir,
          projName,
          '-process',
          programName,
          '-noanalysis',
          '-readOnly',
          '-scriptPath',
          SCRIPT_DIR,
          '-postScript',
          'SiglusWholeBinaryInventory.java',
          ...scriptArgs,
        ],
        logFile,
      );
    } else {
      console.log(`[export] ${entry.id} (${pe.fileVersion}): importing & analyzing ${programName} into ${projDir}...`);
      res = runAnalyzeHeadless(
        [
          projDir,
          projName,
          '-import',
          targetBinaryPath,
          '-scriptPath',
          SCRIPT_DIR,
          '-postScript',
          'SiglusWholeBinaryInventory.java',
          ...scriptArgs,
        ],
        logFile,
      );
    }
    if (res.status !== 0 || !fs.existsSync(outPath)) {
      throw new Error(`Ghidra headless export failed for ${entry.id} (exit=${res.status}); inspect ${logFile}`);
    }
  }

  // Step 6: Validate output schema & write checkpoint
  const inv = JSON.parse(fs.readFileSync(outPath, 'utf8'));
  const validation = validateInventory(inv);
  if (!validation.valid) {
    throw new Error(`Schema validation failed for ${entry.id}:\n  ${validation.errors.join('\n  ')}`);
  }
  const outSha256 = sha256Buffer(fs.readFileSync(outPath));
  fs.writeFileSync(
    ckptPath,
    JSON.stringify(
      {
        status: 'complete',
        binaryId: entry.id,
        fileVersion: pe.fileVersion,
        containerKind: pe.containerKind,
        sha256: pe.sha256,
        analyzedSha256: pe.analyzedSha256,
        outputPath: path.relative(REPO_ROOT, outPath),
        outputSha256: outSha256,
        summary: inv.summary,
        completedAt: new Date().toISOString(),
      },
      null,
      2,
    ) + '\n',
  );
  console.log(
    `[ok] ${entry.id} (${pe.fileVersion}, ${pe.containerKind}): ${inv.summary.discoveredFunctionCount} functions, ` +
      `${inv.summary.totalSwitchTables} switches, ${inv.summary.totalIndirectCallSites} indirect sites`,
  );
  return {entry, pe, outPath, summary: inv.summary, resumed: false};
}

function parseCli(argv) {
  const opts = {ids: null, all: false, force: false, validateOnly: false, exe: null, id: null};
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--all') opts.all = true;
    else if (a === '--force') opts.force = true;
    else if (a === '--validate-only') opts.validateOnly = true;
    else if (a === '--ids') opts.ids = argv[++i].split(',').map((s) => s.trim()).filter(Boolean);
    else if (a === '--exe') opts.exe = path.resolve(argv[++i]);
    else if (a === '--id') opts.id = argv[++i];
    else throw new Error(`Unknown argument: ${a}`);
  }
  return opts;
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const opts = parseCli(process.argv.slice(2));
  const corpus = JSON.parse(fs.readFileSync(CORPUS_PATH, 'utf8'));

  if (opts.validateOnly) {
    let ok = 0;
    for (const b of corpus.binaries) {
      const p = path.join(EXPORTS_DIR, `${b.id}.inventory.json`);
      if (!fs.existsSync(p)) {
        console.log(`[missing] ${b.id}: ${p}`);
        continue;
      }
      const inv = JSON.parse(fs.readFileSync(p, 'utf8'));
      const v = validateInventory(inv);
      if (!v.valid) {
        console.error(`[FAIL] ${b.id}:`, v.errors);
        process.exit(1);
      }
      console.log(`[valid] ${b.id} (${inv.binary.fileVersion}): ${inv.summary.discoveredFunctionCount} functions`);
      ok++;
    }
    console.log(`Validated ${ok} exported inventories.`);
    process.exit(0);
  }

  let targets = [];
  if (opts.exe) {
    const id = opts.id ?? path.basename(path.dirname(opts.exe)).toLowerCase().replace(/[^a-z0-9]+/g, '-');
    targets = [{id, title: id, exePath: opts.exe}];
  } else if (opts.ids) {
    targets = opts.ids.map((id) => {
      const found = corpus.binaries.find((b) => b.id === id);
      if (!found) throw new Error(`Unknown corpus binary id: ${id}`);
      return found;
    });
  } else if (opts.all) {
    targets = corpus.binaries;
  } else {
    console.error('Usage: node tools/siglus-inventory/export.mjs [--ids a,b | --all | --exe <path> --id <id> | --validate-only] [--force]');
    process.exit(1);
  }

  for (const t of targets) {
    exportBinary(t, {force: opts.force});
  }
}
