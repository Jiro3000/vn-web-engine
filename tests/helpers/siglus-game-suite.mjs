import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import {
  computeSpriteOffset,
  computeWakuButtonOrigin,
  parseMwndLayout,
  parseSpaceHideObjectIds,
  parseWakuConfig,
} from '../../dist/engines/siglus/mwnd.js';
import {AsfDemuxer, readAsfLayout} from '../../dist/formats/asf/demux.js';
import {isOggPageStart, oggPageChecksumValid, readOggPage} from '../../dist/formats/ogg/page.js';
import {SiglusDbs} from '../../dist/formats/siglus/dbs.js';
import {G00Image} from '../../dist/formats/siglus/g00.js';
import {readGan} from '../../dist/formats/siglus/gan.js';
import {SiglusOmv} from '../../dist/formats/siglus/omv.js';
import {decodeNwa, decodeOwp, ovkIndex} from '../../dist/formats/siglus/sound.js';
import {readSiglusToneCurves} from '../../dist/formats/siglus/tonecurve.js';
import {WindowsMediaDecoder} from '../../dist/video/windows-media.js';

const REPO_ROOT = path.resolve(import.meta.dirname, '../..');
const SIGLUS_DIR = path.join(REPO_ROOT, 'src/engines/siglus');

export const READ_FLAG_GLOBAL_ROOTS = new Set([
  0x0c, 0x12, 0x13, 0x4c, 0x4d, 0x5a, 0x5b, 0x64, 0x65, 0x66, 0x7f,
]);
export const READ_FLAG_MWND_MEMBERS = new Set([4, 5, 9, 0x1a, 0x1b, 0x32, 0x33, 0x34]);

export const DEFAULT_GAMEEXE_ALLOWLIST = [
  /^DIALOG(?:_EXIST|_TAB_EXIST|_STYLE)?\./,
  /^(?:SAVEINFO|LOADINFO|WARNINGINFO|SAVELOAD_DIALOG)\./,
  /^SYSCOMMENU\./,
  /^TWITTER\./,
  /^(?:DISCMARK|DUMMY_CHECK.*|GAMEVERSION|MANUAL_PATH|MOUSE_CURSOR\.(?:DEFAULT|CNT)|SAVE\.NO_DATA_STR)$/,
  // Native resource declarations parsed at 0x6626a0 and 0x665670 in Siglus 1.1.102.1.
  /^MOUSE_CURSOR\.NNN\.FILE$/,
  /^TONECURVE_FILE$/,
  /^NAMAE(?:\.NNN)?$/, // Repeated declarations are consumed through the parsed name-entry list.
  /^(?:FLAG|GLOBAL_FLAG|CALL_FLAG|COUNTER|OBJBTNGROUP|MSGBTN|FRAME_ACTION_CH|PCMCH|PCMEVENT|MASK|CHRKOE|BGM|FONT_FILE|SELBTN|WORLD|WAKU|MWND|OBJECT|EFFECT|QUAKE|MOVIE|KOE|SE|DATABASE|EDITBOX|END_SAVE)\.CNT$/,
  /^FONT_FILE\.NNN\.NAME$/,
  /^CHRKOE\.NOT_LOOK_NAME_STR$/,
  /^CONFIG\.GLOBAL_EXTRA_MODE\./,
  /^EMOJI\./,
  /^SHAKE\./,
  /^SYSTEM\.EXTRA_STR_VALUE\./,
  /^LOAD\.WIPE$/,
  /^(?:EXCALL|MSGBK|MWND)\.ORDER$/,
  /^MWND\.(?:FACE|FILTER|FUCHI|MOJI|SHADOW|WAKU)_LAYER_REP$/,
  /^MWND\.DEFAULT_SEL_MWND_NO$/,
  /^MWND\.NNN\.(?:MSG_BACK_INSERT_NL|NAME_WINDOW_SIZE|NOVEL_MODE|OVERFLOW_CHECK_SIZE|TALK_MARGIN)$/,
  /^MSGBK\.(?:ACTIVE_MOJI_(?:FUCHI|SHADOW)_COLOR|DEBUG_MOJI_.*|FILTER_MARGIN|MOJI_SHADOW_COLOR)$/,
  /^MESSAGE_BACK_SAVE\.INTERVAL$/,
  /^WAKU\.NNN\.FILTER_MARGIN$/,
  /^CONFIG_WINDOW\./,
  /^SAVE_THUMB\./,
  /^SHORTCUT\./,
];

export function sha256File(filePath) {
  return crypto.createHash('sha256').update(fs.readFileSync(filePath)).digest('hex');
}

export function listNonDotFiles(dir, ext) {
  if (!fs.existsSync(dir)) return [];
  const lowerExt = ext?.toLowerCase();
  return fs
    .readdirSync(dir)
    .filter(
      (name) =>
        !name.startsWith('._') &&
        name !== '.DS_Store' &&
        (!lowerExt || name.toLowerCase().endsWith(lowerExt)),
    )
    .sort();
}

export function verifyPinnedDigests(gameDir, expectedDigests) {
  for (const [rel, expected] of Object.entries(expectedDigests)) {
    assert.equal(sha256File(path.join(gameDir, rel)), expected, `SHA-256 mismatch for ${rel}`);
  }
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
    )
      return true;
  }
  return false;
}

export function normalizeCommandPath(pathArr) {
  const out = [];
  for (let i = 0; i < pathArr.length; i++) {
    out.push(i > 0 && pathArr[i - 1] === -1 ? '*' : String(pathArr[i]));
  }
  return out.join('.');
}

export function auditScenePackBytecode(
  pack,
  {expectedSceneCount, exactInstructions, minInstructions} = {},
) {
  if (expectedSceneCount !== undefined) {
    assert.equal(pack.sceneNames.length, expectedSceneCount);
  }
  const unaryOps = new Set();
  const binaryOps = new Set();
  const commandPaths = new Map();
  let totalInstructions = 0;

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
      totalInstructions++;
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
        if (p !== undefined) stack.splice(p);
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
        if (p !== undefined) stack.splice(p);
      } else if (op === 33) {
        readWord();
        unaryOps.add(code[pc++]);
      } else if (op === 34) {
        readWord();
        readWord();
        binaryOps.add(code[pc++]);
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
        if (cmdPath.length > 0 && cmdPath[0] < 0x10000) {
          const norm = normalizeCommandPath(cmdPath);
          commandPaths.set(norm, (commandPaths.get(norm) ?? 0) + 1);
        }
        if (ret !== 0) stack.push(0);
      } else {
        assert.fail(`Unknown Siglus opcode ${op} in ${sceneName} at pc=${pc - 1}`);
      }
    }
    assert.equal(pc, code.length, `Scene ${sceneName} bytecode ended misaligned`);
  }

  if (exactInstructions !== undefined) {
    assert.equal(totalInstructions, exactInstructions);
  }
  if (minInstructions !== undefined) {
    assert.ok(
      totalInstructions >= minInstructions,
      `Expected >=${minInstructions} instructions, got ${totalInstructions}`,
    );
  }
  for (const op of unaryOps) assert.ok([1, 2, 48].includes(op), `Unhandled unary op ${op}`);
  for (const op of binaryOps)
    assert.ok(
      [1, 2, 3, 4, 5, 16, 17, 18, 19, 20, 21, 32, 33, 49, 50, 51, 52, 53, 54].includes(op),
      `Unhandled binary op ${op}`,
    );

  return {
    sceneCount: pack.sceneNames.length,
    totalInstructions,
    unaryOps,
    binaryOps,
    commandPaths,
  };
}

export function auditScenePackStack(pack) {
  const exports = new Map();
  for (let i = 0; i < pack.commandScenes.length; i += 2) {
    const owner = pack.commandScenes[i];
    const entries = exports.get(owner) ?? [];
    entries.push(pack.commandScenes[i + 1]);
    exports.set(owner, entries);
  }
  let reachableInstructions = 0;
  for (const [sceneIndex, name] of pack.sceneNames.entries()) {
    const scene = pack.scene(name);
    const code = new DataView(scene.code.buffer, scene.code.byteOffset, scene.code.byteLength);
    const seen = new Map();
    const entries = new Set([...scene.entries, ...scene.commands, ...(exports.get(sceneIndex) ?? [])]);
    const work = [...entries].map((pc) => ({pc, stack: [], points: [], declarations: new Map()}));
    while (work.length) {
      let {pc, stack, points, declarations} = work.pop();
      while (pc < code.byteLength) {
        const address = pc;
        const location = () => `${name}@0x${address.toString(16)}`;
        const previous = seen.get(address);
        if (previous) {
          if (stack.length !== previous.stack.length || String(points) !== String(previous.points))
            assert.fail(`Inconsistent Siglus stack at ${location()}`);
          if (stack.every((value, i) => value === previous.stack[i] || previous.stack[i] === null))
            break;
          stack = stack.map((value, i) => (value === previous.stack[i] ? value : null));
        } else {
          reachableInstructions++;
        }
        seen.set(address, {stack: stack.slice(), points: points.slice()});

        const word = () => {
          const value = code.getInt32(pc, true);
          pc += 4;
          return value;
        };
        const pop = () => {
          if (stack.length === 0) assert.fail(`Siglus stack underflow at ${location()}`);
          return stack.pop();
        };
        const element = () => {
          const start = points.pop();
          if (start === undefined || start >= stack.length)
            assert.fail(`Missing Siglus element path at ${location()}`);
          return stack.splice(start);
        };
        const argumentsAt = () => {
          for (let count = word(); count > 0; count--) {
            const form = word();
            if (form === -1) argumentsAt();
            else if (form === 0 || form === 10 || form === 20 || form === 30) pop();
            else element();
          }
        };
        const branch = (label, call) => {
          const target = scene.labels[label];
          if (target === undefined) assert.fail(`Missing Siglus label ${label} at ${location()}`);
          work.push({
            pc: target,
            stack: call ? [] : stack.slice(),
            points: call ? [] : points.slice(),
            declarations: call ? new Map() : new Map(declarations),
          });
        };
        const op = code.getUint8(pc++);
        switch (op) {
          case 0:
          case 9:
            continue;
          case 1:
            word();
            continue;
          case 2: {
            const form = word();
            const value = word();
            stack.push(form === 20 ? null : value);
            continue;
          }
          case 3:
            if (word()) pop();
            continue;
          case 4: {
            word();
            const top = pop();
            stack.push(top, top);
            continue;
          }
          case 5: {
            const path = element();
            if (path.length === 2 && path[0] === 83 && path[1] >>> 24 === 125) {
              const form = [...declarations.values()][path[1] & 0xffff];
              if (form !== undefined && ![0, 10, 20, 30].includes(form)) points.push(stack.length);
            }
            stack.push(null);
            continue;
          }
          case 6: {
            const start = points.at(-1);
            if (start === undefined) assert.fail(`Missing Siglus element copy at ${location()}`);
            points.push(stack.length);
            stack.push(...stack.slice(start));
            continue;
          }
          case 7: {
            const form = word();
            declarations.set(word(), form);
            if (form === 11 || form === 21) pop();
            continue;
          }
          case 8:
            points.push(stack.length);
            continue;
          case 16:
          case 17:
          case 18: {
            const label = word();
            if (op !== 16) pop();
            branch(label, false);
            if (op !== 16) continue;
            break;
          }
          case 19:
          case 20: {
            const label = word();
            argumentsAt();
            branch(label, true);
            stack.push(null);
            continue;
          }
          case 21:
            argumentsAt();
            break;
          case 22:
            break;
          case 32:
            pc += 12;
            pop();
            element();
            continue;
          case 33:
            pc += 5;
            pop();
            stack.push(null);
            continue;
          case 34:
            pc += 9;
            pop();
            pop();
            stack.push(null);
            continue;
          case 48: {
            word();
            argumentsAt();
            for (let count = word(); count > 0; count--) word();
            const result = word();
            const path = element();
            if (hasTrailingReadFlag(path)) word();
            if (result === 23) points.push(stack.length);
            if (result) stack.push(null);
            if (path.length === 1 && (path[0] === 3 || path[0] === 4)) break;
            continue;
          }
          case 49:
            word();
            pop();
            continue;
          case 50:
            pop();
            continue;
          default:
            assert.fail(`Unknown Siglus opcode ${op} at ${location()}`);
        }
        break;
      }
    }
  }
  return reachableInstructions;
}

export function auditGameexeCoverage(
  cfg,
  gameDir,
  {
    expectedScreenSize,
    expectedMwndCount,
    expectedSpaceHide,
    extraAllowlist = [],
    checkGeometry = true,
  } = {},
) {
  const screenRaw = cfg.get('SCREEN_SIZE') ?? '1280, 720';
  if (expectedScreenSize !== undefined) {
    assert.equal(screenRaw, expectedScreenSize);
  }
  const [screenW, screenH] = screenRaw.split(',').map((n) => Number(n.trim()));

  if (expectedSpaceHide !== undefined) {
    assert.deepEqual([...parseSpaceHideObjectIds(cfg)].sort((a, b) => a - b), expectedSpaceHide);
  }

  const mwndCnt = Number(cfg.get('MWND.CNT') ?? 0);
  if (expectedMwndCount !== undefined) {
    assert.equal(mwndCnt, expectedMwndCount);
  }

  assert.ok(
    [screenW, screenH].every((n) => Number.isSafeInteger(n) && n > 0),
    `Invalid SCREEN_SIZE: ${screenRaw}`,
  );
  if (checkGeometry && mwndCnt > 0) {
    for (let i = 0; i < mwndCnt; i++) {
      const layout = parseMwndLayout(cfg, i);
      // Siglus 1.1.102.1 copies WINDOW_POS and WINDOW_SIZE verbatim from the
      // configuration into the live message-window object (0x669230, 0x5284d0).
      // The logical window also anchors WAKU children. Stage clipping is applied
      // to the drawn elements and does not change those anchor coordinates.
      assert.ok(
        layout.windowPos.every(Number.isSafeInteger) &&
          layout.windowSize.every((n) => Number.isSafeInteger(n) && n >= 0),
        `MWND.${i} invalid geometry: ${layout.windowPos}, ${layout.windowSize}`,
      );
      const waku = parseWakuConfig(cfg, layout.wakuNo);
      if (waku.wakuFile && gameDir) {
        const g00Path = path.join(gameDir, 'g00', `${waku.wakuFile}.g00`);
        if (fs.existsSync(g00Path)) {
          const g = new G00Image(new Uint8Array(fs.readFileSync(g00Path))).frame(0);
          const off = computeSpriteOffset(layout.windowPos[0], layout.windowPos[1], g);
          assert.ok(Number.isFinite(off.left) && Number.isFinite(off.top));
        }
      }
      const tag = String(layout.wakuNo).padStart(3, '0');
      for (const [k, v] of cfg) {
        const m = new RegExp(`^WAKU\\.${tag}\\.BTN\\.(\\d+)\\.POS$`).exec(k);
        if (!m) continue;
        const [mode, bx, by] = v.split(',').map(Number);
        const origin = computeWakuButtonOrigin(mode, layout.windowPos, layout.windowSize, bx, by, {
          x: 0,
          y: 0,
          centerX: 0,
          centerY: 0,
        });
        assert.ok(
          mode >= 0 &&
            mode <= 3 &&
            Number.isInteger(mode) &&
            Number.isSafeInteger(origin.left) &&
            Number.isSafeInteger(origin.top),
          `WAKU.${tag}.BTN.${m[1]} invalid origin: ${JSON.stringify(origin)}`,
        );
      }
    }
  }

  const engineCode = listNonDotFiles(SIGLUS_DIR, '.ts')
    .map((f) => fs.readFileSync(path.join(SIGLUS_DIR, f), 'utf8'))
    .join('\n');

  const allowlist = [...DEFAULT_GAMEEXE_ALLOWLIST, ...extraAllowlist];
  const schemas = new Set([...cfg.keys()].map((k) => k.replace(/\.\d+(?=\.|$)/g, '.NNN')));
  const unclassified = [];
  for (const schema of schemas) {
    if (allowlist.some((re) => re.test(schema))) continue;
    const tokens = schema.split('.').filter((t) => t !== 'NNN');
    const last = tokens.at(-1);
    const first = tokens[0];
    const matched =
      engineCode.includes(schema) ||
      (tokens.length >= 2 && engineCode.includes(tokens.slice(-2).join('.'))) ||
      (first && (engineCode.includes(first + '.') || engineCode.includes(first + '\\.'))) ||
      (last && last.length > 4 && engineCode.includes(last));
    if (!matched) unclassified.push(schema);
  }
  assert.deepEqual(unclassified, [], `Unclassified Gameexe.dat keys: ${unclassified.join(', ')}`);
  return {screenW, screenH, mwndCnt, schemaCount: schemas.size, unclassified};
}

export function auditWmaParity(
  filePath,
  {expectedCodec, expectedRate, maxPackets = 25, minFrames = 5} = {},
) {
  const buf = new Uint8Array(fs.readFileSync(filePath));
  const layout = readAsfLayout(buf);
  const audioStream = layout.streams.find((s) => s.kind === 'audio');
  assert.ok(audioStream && audioStream.kind === 'audio', `No audio stream in ${filePath}`);
  if (expectedCodec !== undefined) assert.equal(audioStream.codec, expectedCodec);
  if (expectedRate !== undefined) assert.equal(audioStream.sampleRate, expectedRate);

  const jsDec = new WindowsMediaDecoder(audioStream, {wasm: false});
  const wasmDec = new WindowsMediaDecoder(audioStream, {wasm: true});
  const demux = new AsfDemuxer(layout);
  let frames = 0;
  let maxAbs = 0;
  let maxDiff = 0;
  for (
    let off = layout.dataOffset, count = 0;
    off + layout.packetSize <= buf.length && count < Math.min(layout.packetCount, maxPackets);
    off += layout.packetSize, count++
  ) {
    for (const pkt of demux.packet(buf.subarray(off, off + layout.packetSize))) {
      if (pkt.stream !== audioStream.number) continue;
      const a = jsDec.decode(pkt.data, pkt.time, pkt.key);
      const b = wasmDec.decode(pkt.data, pkt.time, pkt.key);
      assert.equal(a.length, b.length);
      for (let i = 0; i < a.length; i++) {
        frames++;
        for (let ch = 0; ch < a[i].channels.length; ch++) {
          for (let j = 0; j < a[i].channels[ch].length; j++) {
            const va = a[i].channels[ch][j];
            const vb = b[i].channels[ch][j];
            assert.ok(Number.isFinite(va) && Number.isFinite(vb));
            if (Math.abs(va) > maxAbs) maxAbs = Math.abs(va);
            const d = Math.abs(va - vb);
            if (d > maxDiff) maxDiff = d;
          }
        }
      }
    }
  }
  assert.ok(frames >= minFrames, `${filePath}: expected >=${minFrames} WMA frames, got ${frames}`);
  assert.ok(maxAbs > 0.005 && maxAbs < 2.0, `${filePath}: unexpected PCM peak ${maxAbs}`);
  assert.equal(maxDiff, 0, `${filePath}: JS vs WASM WMA mismatch (maxDiff=${maxDiff})`);
  return {codec: audioStream.codec, sampleRate: audioStream.sampleRate, frames, maxAbs, maxDiff};
}

export function auditNwaFile(filePath) {
  const {channels, rate, pcm} = decodeNwa(new Uint8Array(fs.readFileSync(filePath)));
  assert.ok(rate > 0 && pcm.length > 0, `NWA ${filePath} decoded empty`);
  return {channels, rate, frames: pcm.length / channels};
}

export function auditOggFile(filePath) {
  const bytes = fs.readFileSync(filePath);
  assert.ok(bytes.length > 0, `Empty Ogg file ${filePath}`);
  for (let pos = 0; pos < bytes.length;) {
    const page = isOggPageStart(bytes, pos) && readOggPage(bytes, pos);
    assert.ok(page && oggPageChecksumValid(page), `Invalid Ogg page at ${pos} in ${filePath}`);
    pos += page.bytes.length;
  }
}

export async function auditOvkFile(filePath) {
  const file = await fs.promises.open(filePath, 'r');
  try {
    const {size} = await file.stat();
    const index = await ovkIndex({
      size,
      read: async (offset, length) => {
        const buffer = Buffer.alloc(length);
        const {bytesRead} = await file.read(buffer, 0, length, offset);
        assert.equal(bytesRead, length, `Truncated OVK at ${offset} in ${filePath}`);
        return buffer;
      },
    });
    assert.ok(index.size > 0, `OVK ${filePath} empty index`);
  } finally {
    await file.close();
  }
}

export function auditToneCurveFile(filePath) {
  return [...readSiglusToneCurves(fs.readFileSync(filePath)).keys()];
}

export async function auditSiglusAssets(
  gameDir,
  {
    dbs = [],
    ganCount,
    omvCount,
    endingOmvPrefix,
    endingOmvCount,
    endingOmvSize,
    bgmCount,
    bgmNwaCount,
    bgmOggCount,
    nwaCount,
    oggCount,
    ovkCount,
    g00Count,
    g00CutCount,
    sampleLimit = 20,
  } = {},
) {
  for (const spec of dbs) {
    const parsed = new SiglusDbs(new Uint8Array(fs.readFileSync(path.join(gameDir, spec.file))));
    if (spec.rows !== undefined) assert.equal(parsed.rowCount, spec.rows, `${spec.file} rows`);
    if (spec.cols !== undefined) assert.equal(parsed.columnCount, spec.cols, `${spec.file} cols`);
  }

  if (ganCount !== undefined) {
    const gans = listNonDotFiles(path.join(gameDir, 'gan'), '.gan');
    assert.equal(gans.length, ganCount);
    for (const f of gans) {
      const sets = readGan(new Uint8Array(fs.readFileSync(path.join(gameDir, 'gan', f))));
      assert.ok(Array.isArray(sets) && sets.length > 0, `GAN ${f} empty`);
    }
  }

  if (omvCount !== undefined) {
    const omvs = listNonDotFiles(path.join(gameDir, 'mov'), '.omv');
    assert.equal(omvs.length, omvCount);
    let endings = 0;
    for (const f of omvs) {
      const omv = new SiglusOmv(new Uint8Array(fs.readFileSync(path.join(gameDir, 'mov', f))));
      assert.ok(omv.width > 0 && omv.height > 0, `OMV ${f} invalid dims`);
      if (endingOmvPrefix && f.startsWith(endingOmvPrefix)) {
        endings++;
        if (endingOmvSize) {
          assert.equal(omv.width, endingOmvSize[0]);
          assert.equal(omv.height, endingOmvSize[1]);
        }
      }
    }
    if (endingOmvCount !== undefined) assert.equal(endings, endingOmvCount);
  }

  if (bgmCount !== undefined) {
    const bgms = listNonDotFiles(path.join(gameDir, 'bgm'), '.owp');
    assert.equal(bgms.length, bgmCount);
    for (const f of bgms) {
      const dec = decodeOwp(new Uint8Array(fs.readFileSync(path.join(gameDir, 'bgm', f))).subarray(0, 16));
      assert.equal(Buffer.from(dec.subarray(0, 4)).toString('ascii'), 'OggS', `BGM ${f} not OggS`);
    }
  }

  for (const [folder, expected] of [
    ['bgm', bgmNwaCount],
    ['wav', nwaCount],
  ]) {
    if (expected === undefined) continue;
    const dir = path.join(gameDir, folder);
    const nwas = listNonDotFiles(dir, '.nwa');
    assert.equal(nwas.length, expected);
    for (const f of nwas.slice(0, sampleLimit)) auditNwaFile(path.join(dir, f));
  }

  for (const [folder, expected] of [
    ['bgm', bgmOggCount],
    ['wav', oggCount],
  ]) {
    if (expected === undefined) continue;
    const dir = path.join(gameDir, folder);
    const oggs = listNonDotFiles(dir, '.ogg');
    assert.equal(oggs.length, expected);
    for (const f of oggs) auditOggFile(path.join(dir, f));
  }

  if (ovkCount !== undefined) {
    const ovks = listNonDotFiles(path.join(gameDir, 'koe'), '.ovk');
    assert.equal(ovks.length, ovkCount);
    for (const f of ovks.slice(0, sampleLimit)) await auditOvkFile(path.join(gameDir, 'koe', f));
  }

  // Native C_g00::set_data (0x6de310) skips the 24-byte outer atlas-crop table for Type 2 G00s;
  // verify multi-cut G00 files with non-zero outer (left, top) decode with frame.x === 0, frame.y === 0.
  const g00Dir = path.join(gameDir, 'g00');
  if (fs.existsSync(g00Dir)) {
    const g00Files = listNonDotFiles(g00Dir, '.g00');
    if (g00Count !== undefined) assert.equal(g00Files.length, g00Count);
    let checkedNonZeroOuter = 0;
    let cutCount = 0;
    for (const f of g00Files) {
      if (g00CutCount === undefined && checkedNonZeroOuter >= sampleLimit) break;
      const buf = new Uint8Array(fs.readFileSync(path.join(g00Dir, f)));
      const full = g00CutCount !== undefined ? new G00Image(buf) : undefined;
      if (full) {
        cutCount += full.count;
        if (full.type === 3) {
          assert.deepEqual([...full.jpeg().subarray(0, 2)], [255, 216], `${f}: invalid JPEG marker`);
        } else {
          for (let index = 0; index < full.count; index++) {
            const frame = full.frame(index);
            assert.equal(frame.bgra.length, frame.width * frame.height * 4, `${f} cut ${index}`);
          }
        }
      }
      if (buf.length < 33 || buf[0] !== 2) continue;
      const dv = new DataView(buf.buffer, buf.byteOffset, buf.byteLength);
      const cnt = dv.getUint32(5, true);
      let nzCut = -1;
      for (let i = 0; i < cnt && 9 + (i + 1) * 24 <= buf.length; i++) {
        const ox = dv.getInt32(9 + i * 24, true);
        const oy = dv.getInt32(13 + i * 24, true);
        if (ox !== 0 || oy !== 0) {
          nzCut = i;
          break;
        }
      }
      if (nzCut >= 0) {
        const img = full ?? new G00Image(buf);
        const fr = img.frame(nzCut);
        assert.equal(fr.x, 0, `${f} cut ${nzCut}: G00 Type 2 outer atlas X leaked into frame.x=${fr.x}`);
        assert.equal(fr.y, 0, `${f} cut ${nzCut}: G00 Type 2 outer atlas Y leaked into frame.y=${fr.y}`);
        assert.ok(fr.width > 0 && fr.height > 0, `${f} cut ${nzCut}: invalid dimensions`);
        assert.ok(Number.isFinite(fr.centerX) && Number.isFinite(fr.centerY), `${f} cut ${nzCut}: non-finite center`);
        checkedNonZeroOuter++;
      }
    }
    if (g00CutCount !== undefined) assert.equal(cutCount, g00CutCount);
  } else if (g00Count !== undefined) {
    assert.equal(g00Count, 0, 'Missing g00 directory');
  }
}
