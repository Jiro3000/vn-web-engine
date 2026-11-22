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
import {SiglusDbs} from '../../dist/formats/siglus/dbs.js';
import {G00Image} from '../../dist/formats/siglus/g00.js';
import {readGan} from '../../dist/formats/siglus/gan.js';
import {SiglusOmv} from '../../dist/formats/siglus/omv.js';
import {decodeNwa, decodeOwp, ovkIndex} from '../../dist/formats/siglus/sound.js';
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
  /^(?:FLAG|GLOBAL_FLAG|CALL_FLAG|COUNTER|OBJBTNGROUP|FRAME_ACTION_CH|PCMCH|PCMEVENT|MASK|CHRKOE|BGM|FONT_FILE|SELBTN|WORLD|WAKU|MWND|OBJECT|EFFECT|QUAKE|MOVIE|KOE|SE|DATABASE)\.CNT$/,
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

  if (checkGeometry && mwndCnt > 0) {
    for (let i = 0; i < mwndCnt; i++) {
      const layout = parseMwndLayout(cfg, i);
      assert.ok(
        layout.windowPos[0] >= 0 && layout.windowPos[1] >= 0,
        `MWND.${i} negative origin: ${JSON.stringify(layout.windowPos)}`,
      );
      assert.ok(
        layout.windowPos[0] + layout.windowSize[0] <= screenW &&
          layout.windowPos[1] + layout.windowSize[1] <= screenH,
        `MWND.${i} exceeds ${screenW}x${screenH}`,
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
          origin.left >= -10 &&
            origin.left <= screenW + 10 &&
            origin.top >= -10 &&
            origin.top <= screenH + 10,
          `WAKU.${tag}.BTN.${m[1]} origin out of bounds: ${JSON.stringify(origin)}`,
        );
      }
    }
  }

  const engineCode = fs
    .readdirSync(SIGLUS_DIR)
    .filter((f) => f.endsWith('.ts'))
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
    nwaCount,
    ovkCount,
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

  if (nwaCount !== undefined) {
    const nwas = listNonDotFiles(path.join(gameDir, 'wav'), '.nwa');
    assert.equal(nwas.length, nwaCount);
    for (const f of nwas.slice(0, sampleLimit)) {
      const dec = decodeNwa(new Uint8Array(fs.readFileSync(path.join(gameDir, 'wav', f))));
      assert.ok(dec.rate > 0 && dec.pcm.length > 0, `NWA ${f} decoded empty`);
    }
  }

  if (ovkCount !== undefined) {
    const ovks = listNonDotFiles(path.join(gameDir, 'koe'), '.ovk');
    assert.equal(ovks.length, ovkCount);
    for (const f of ovks.slice(0, sampleLimit)) {
      const buf = new Uint8Array(fs.readFileSync(path.join(gameDir, 'koe', f)));
      const idx = await ovkIndex({
        size: buf.length,
        read: async (offset, length) => buf.subarray(offset, offset + length),
      });
      assert.ok(idx.size > 0, `OVK ${f} empty index`);
    }
  }
}
