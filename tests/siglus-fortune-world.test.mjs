import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import {
  computeWakuButtonOrigin,
  parseButtonActionStates,
  parseButtonSe,
  parseMwndAnimation,
  parseMwndColors,
  parseMwndLayout,
  parseNoSaveObjectIds,
  parseWakuConfig,
} from '../dist/engines/siglus/mwnd.js';
import {AsfDemuxer, readAsfLayout} from '../dist/formats/asf/demux.js';
import {parseCgTable} from '../dist/formats/siglus/cgtable.js';
import {xorCycle} from '../dist/formats/siglus/compression.js';
import {SiglusScenePack} from '../dist/formats/siglus/scene-pack.js';
import {cgmXor} from '../dist/formats/siglus/tables.js';
import {WindowsMediaDecoder} from '../dist/video/windows-media.js';

const REPO_ROOT = path.resolve(import.meta.dirname, '..');
const SIGLUS_DIR = path.join(REPO_ROOT, 'src/engines/siglus');
const FW_DIR = '/Volumes/Transcend/Torrents/1GAMES/FORTUNE×WORLD/StartData/GameData';
const HAS_FW =
  fs.existsSync(`${FW_DIR}/SiglusEngine.exe`) &&
  fs.existsSync(`${FW_DIR}/Gameexe.dat`) &&
  fs.existsSync(`${FW_DIR}/Scene.pck`);

function sha256File(filePath) {
  return crypto.createHash('sha256').update(fs.readFileSync(filePath)).digest('hex');
}

test('parseCgTable decodes raw CGTABLE v1, packed CGTABLE2 v2, and rejects malformed inputs', () => {
  // 1. Raw CGTABLE v1 (36-byte entries)
  const v1 = new Uint8Array(32 + 36 * 2);
  v1.set(Buffer.from('CGTABLE', 'ascii'), 0);
  const v1Dv = new DataView(v1.buffer);
  v1Dv.setInt32(16, 2, true);
  v1Dv.setInt32(20, 0, true);
  v1.set(Buffer.from('CG_A_01', 'ascii'), 32);
  v1Dv.setInt32(32 + 32, 7, true);
  v1.set(Buffer.from('CG_B_02', 'ascii'), 32 + 36);
  v1Dv.setInt32(32 + 36 + 32, 42, true);
  const parsedV1 = parseCgTable(v1);
  assert.equal(parsedV1.version, 1);
  assert.equal(parsedV1.entries.length, 2);
  assert.equal(parsedV1.byName.get('cg_a_01'), 7);
  assert.equal(parsedV1.byName.get('cg_b_02'), 42);

  // 2. Packed + XORed CGTABLE2 v2 (60-byte entry, literal-only LZSS stream)
  const rawEntry = new Uint8Array(60);
  rawEntry.set(Buffer.from('CG_TEST_0101', 'ascii'), 0);
  const eDv = new DataView(rawEntry.buffer);
  eDv.setInt32(32, 19, true);
  eDv.setInt32(36, 2, true);
  eDv.setInt32(40, 101, true);
  eDv.setInt32(44, 202, true);
  const lzBody = [];
  for (let i = 0; i < rawEntry.length; i += 8) {
    lzBody.push(0xff);
    for (let j = 0; j < 8 && i + j < rawEntry.length; j++) lzBody.push(rawEntry[i + j]);
  }
  const lzStream = new Uint8Array(8 + lzBody.length);
  const lzDv = new DataView(lzStream.buffer);
  lzDv.setUint32(0, lzStream.length, true);
  lzDv.setUint32(4, rawEntry.length, true);
  lzStream.set(lzBody, 8);
  xorCycle(lzStream, cgmXor);

  const v2 = new Uint8Array(32 + lzStream.length);
  v2.set(Buffer.from('CGTABLE2', 'ascii'), 0);
  const v2Dv = new DataView(v2.buffer);
  v2Dv.setInt32(16, 1, true);
  v2Dv.setInt32(20, 1, true);
  v2.set(lzStream, 32);

  const parsedV2 = parseCgTable(v2);
  assert.equal(parsedV2.version, 2);
  assert.equal(parsedV2.entries.length, 1);
  assert.equal(parsedV2.entries[0].name, 'CG_TEST_0101');
  assert.equal(parsedV2.entries[0].flagNo, 19);
  assert.deepEqual(parsedV2.entries[0].codes, [101, 202]);
  assert.equal(parsedV2.byName.get('cg_test_0101'), 19);

  // 3. Rejects invalid magic / truncated files
  assert.throws(() => parseCgTable(new Uint8Array(10)), /Truncated/);
  assert.throws(() => parseCgTable(new Uint8Array(32)), /Unsupported/);
});

test('parseNoSaveObjectIds and EXTEND_TYPE=1 MWND layout defaults work cleanly', () => {
  const cfg = new Map([
    ['SCREEN_SIZE', '1920, 1080'],
    ['OBJECT.245.SAVE', '0'],
    ['OBJECT.10.SAVE', '1'],
    ['MWND.001.EXTEND_TYPE', '1'],
    ['MWND.001.WINDOW_POS', '16, 16'],
    ['MWND.001.MESSAGE_MARGIN', '32, 32, 32, 32'],
    ['MWND.001.MOJI_SIZE', '20'],
    ['MWND.001.MOJI_SPACE', '0, 8'],
  ]);
  assert.deepEqual([...parseNoSaveObjectIds(cfg)], [245]);
  const layout = parseMwndLayout(cfg, 1);
  assert.equal(layout.extendType, 1);
  assert.deepEqual(layout.windowPos, [16, 16]);
  assert.deepEqual(layout.windowSize, [1904, 1064]);
  assert.equal(layout.windowPos[0] + layout.windowSize[0], 1920);
  assert.equal(layout.windowPos[1] + layout.windowSize[1], 1080);
  assert.equal(layout.textX, 32);
  assert.equal(layout.textY, 32);
});

test('player.ts & display.ts implement cgtable (78.2), OBJECT.<n>.SAVE=0, _sound audio, and stage focus preservation', () => {
  const playerSrc = fs.readFileSync(path.join(SIGLUS_DIR, 'player.ts'), 'utf8');
  const displaySrc = fs.readFileSync(path.join(SIGLUS_DIR, 'display.ts'), 'utf8');
  assert.match(displaySrc, /private preserveStageFocus\(/);
  assert.match(displaySrc, /if \(this\.stage\.contains\(event\.relatedTarget as Node \| null\)\) return;/);
  assert.match(playerSrc, /parseCgTable/);
  assert.match(playerSrc, /localStorage\.getItem\(game\.saveKey \+ ':cgtable'\)/);
  assert.match(playerSrc, /if \(root === 78\)/);
  assert.match(playerSrc, /parseNoSaveObjectIds\(config\)/);
  assert.match(playerSrc, /!this\.noSaveObjectIds\.has\(id\)/);
  for (const needle of [
    'case 69: // global.koe_check',
    'case 85: // global.koe_wait',
    'case 99: // global.koe_wait_key',
    'case 87: // global.exkoe_play',
    'case 88: // global.exkoe_play_wait',
    'case 89: // global.exkoe_play_wait_key',
    "if (member === 3 || member === 14) return this.waitAudio('bgm', member === 14);",
    "if (member === 8 || member === 10) return this.waitAudio('se', member === 10);",
    "if (member === 11) return this.audio.channelState('se');",
  ]) {
    assert.ok(playerSrc.includes(needle), `player.ts missing expected handler: ${needle}`);
  }
});

test(
  'FORTUNE×WORLD pinned SHA-256 digests and 100% bytecode opcode coverage across all 49 scenes',
  {skip: !HAS_FW},
  () => {
    assert.equal(
      sha256File(`${FW_DIR}/SiglusEngine.exe`),
      '5a8d3539530e73ad10c07a3757d2081ccb9265cb08455df998ac2a66d3da18a2',
    );
    assert.equal(
      sha256File(`${FW_DIR}/Gameexe.dat`),
      '492bccbb33ca3ce6e6ff074fe66d52281bb1e80dca5d528696494574b3cb892f',
    );
    assert.equal(
      sha256File(`${FW_DIR}/Scene.pck`),
      '98ce9b7f4e16b65f47871af6068b43a07b8717ddf22a4e49ccd6a312979cd523',
    );

    const pack = new SiglusScenePack(new Uint8Array(fs.readFileSync(`${FW_DIR}/Scene.pck`)));
    assert.equal(pack.sceneNames.length, 49);

    const readFlagGlobalRoots = new Set([0x0c, 0x12, 0x13, 0x4c, 0x4d, 0x5a, 0x5b, 0x64, 0x65, 0x66, 0x7f]);
    const readFlagMwndMembers = new Set([4, 5, 9, 0x1a, 0x1b, 0x32, 0x33, 0x34]);
    const hasTrailingReadFlag = (p) => {
      if (p.length === 1) return readFlagGlobalRoots.has(p[0]);
      if (p.length >= 4) {
        const m = p.at(-1);
        if (
          readFlagMwndMembers.has(m) &&
          p[p.length - 4] === 3 &&
          p[p.length - 3] === -1 &&
          (p[0] === 37 || p[0] === 38 || p[0] === 49 || p[0] === 65)
        )
          return true;
      }
      return false;
    };

    const unaryOps = new Set();
    const binaryOps = new Set();
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
          if (ret !== 0) stack.push(0);
        } else {
          assert.fail(`Unknown Siglus opcode ${op} in ${sceneName} at pc=${pc - 1}`);
        }
      }
      assert.equal(pc, code.length, `Scene ${sceneName} bytecode ended misaligned`);
    }

    assert.ok(totalInstructions > 1_000_000, `Expected >1M instructions, got ${totalInstructions}`);
    for (const op of unaryOps) assert.ok([1, 2, 48].includes(op), `Unhandled unary op ${op}`);
    for (const op of binaryOps)
      assert.ok([1, 2, 3, 4, 5, 16, 17, 18, 19, 20, 21, 32, 33, 49, 50, 51, 52, 53, 54].includes(op), `Unhandled binary op ${op}`);
  },
);

test(
  'FORTUNE×WORLD dat/mode.cgm (CGTABLE2) parses all 228 entries cleanly',
  {skip: !HAS_FW || !fs.existsSync(`${FW_DIR}/dat/mode.cgm`)},
  () => {
    const cgTable = parseCgTable(new Uint8Array(fs.readFileSync(`${FW_DIR}/dat/mode.cgm`)));
    assert.equal(cgTable.version, 2);
    assert.equal(cgTable.entries.length, 228);
    assert.equal(cgTable.entries[0].name, 'CG_RM03_0101');
    assert.equal(cgTable.entries[0].flagNo, 0);
    assert.equal(cgTable.entries[227].name, 'CG_EX19_0101');
    assert.equal(cgTable.entries[227].flagNo, 227);
    assert.equal(cgTable.byName.get('cg_rm03_0101'), 0);
    assert.equal(cgTable.byName.get('cg_ex19_0101'), 227);
  },
);

test(
  'Audit A & D (FORTUNE×WORLD Gameexe.dat): schema coverage gate and 1920x1080 static geometry invariants',
  {skip: !HAS_FW},
  () => {
    const pack = new SiglusScenePack(new Uint8Array(fs.readFileSync(`${FW_DIR}/Scene.pck`)));
    const cfg = pack.configuration(new Uint8Array(fs.readFileSync(`${FW_DIR}/Gameexe.dat`)));

    // Concrete FORTUNE×WORLD config checks
    assert.equal(cfg.get('SCREEN_SIZE'), '1920, 1080');
    assert.equal(cfg.get('CGTABLE_FILE'), '"mode.cgm"');
    assert.equal(cfg.get('CGTABLE_FLAG_CNT'), '10000');
    assert.deepEqual([...parseNoSaveObjectIds(cfg)], [245]);
    assert.deepEqual(parseMwndColors(cfg, 0), {mojiColor: 0, shadowColor: 1, fuchiColor: 1});
    assert.deepEqual(parseMwndAnimation(cfg, 0, 'open'), {type: 1, time: 250});
    assert.deepEqual(parseMwndAnimation(cfg, 0, 'close'), {type: 1, time: 250});
    assert.ok(parseButtonActionStates(cfg, 1));
    assert.ok(parseButtonSe(cfg, 0));

    // Audit D: Every configured MWND (000, 001, 004, 005) fits inside 1920x1080 with finite coordinates
    for (const mwndIdx of [0, 1, 4, 5]) {
      const l = parseMwndLayout(cfg, mwndIdx);
      for (const v of [
        l.windowPos[0],
        l.windowPos[1],
        l.windowSize[0],
        l.windowSize[1],
        l.textX,
        l.textY,
        l.textWidth,
        l.textHeight,
        l.nameAnchorX,
        l.nameAnchorY,
      ]) {
        assert.ok(Number.isFinite(v), `MWND.${mwndIdx} has non-finite coordinate`);
      }
      assert.ok(l.windowPos[0] >= 0 && l.windowPos[0] + l.windowSize[0] <= 1920, `MWND.${mwndIdx} horizontal overflow`);
      assert.ok(l.windowPos[1] >= 0 && l.windowPos[1] + l.windowSize[1] <= 1080, `MWND.${mwndIdx} vertical overflow`);
    }
    // MWND.000 speaker name is centered at stage X = 7 + 509 = 516
    const l0 = parseMwndLayout(cfg, 0);
    assert.equal(l0.nameAlign, 1);
    assert.equal(l0.windowPos[0] + l0.nameAnchorX, 516);
    assert.ok(l0.windowPos[1] + l0.nameAnchorY >= 727 && l0.windowPos[1] + l0.nameAnchorY <= 1080);

    // WAKU.000 config & icon positioning sanity
    const w0 = parseWakuConfig(cfg, 0);
    assert.ok(w0.wakuFile || w0.filterFile, 'WAKU.000 must specify graphic');
    const iconOrigin = computeWakuButtonOrigin(
      w0.iconPos[0],
      l0.windowPos,
      l0.windowSize,
      w0.iconPos[1],
      w0.iconPos[2],
      {x: 0, y: 0, centerX: 0, centerY: 0},
    );
    assert.ok(Number.isFinite(iconOrigin.left) && Number.isFinite(iconOrigin.top));
    assert.ok(iconOrigin.left >= 0 && iconOrigin.left <= 1920);
    assert.ok(iconOrigin.top >= 0 && iconOrigin.top <= 1080);

    // Audit A: Permanent Gameexe.dat key coverage gate (zero unclassified unread schemas)
    const engineCode = fs
      .readdirSync(SIGLUS_DIR)
      .filter((f) => f.endsWith('.ts'))
      .map((f) => fs.readFileSync(path.join(SIGLUS_DIR, f), 'utf8'))
      .join('\n');

    const auditedAllowlist = [
      /^DIALOG(?:_EXIST|_TAB_EXIST|_STYLE)?\./,
      /^(?:SAVEINFO|LOADINFO|WARNINGINFO|SAVELOAD_DIALOG)\./,
      /^SYSCOMMENU\./,
      /^TWITTER\./,
      /^(?:DISCMARK|DUMMY_CHECK.*|GAMEVERSION|MANUAL_PATH|MOUSE_CURSOR\.(?:DEFAULT|CNT|NNN\.FILE)|SAVE\.NO_DATA_STR)$/,
      /^(?:FLAG|GLOBAL_FLAG|CALL_FLAG|COUNTER|OBJBTNGROUP|FRAME_ACTION_CH|PCMCH|PCMEVENT|MASK|CHRKOE|BGM|FONT_FILE|EDITBOX|EFFECT|END_SAVE|QUAKE|WORLD)\.CNT$/,
      /^FONT_FILE\.NNN\.NAME$/,
      /^CHRKOE\.NOT_LOOK_NAME_STR$/,
      /^CONFIG\.GLOBAL_EXTRA_MODE\./,
      /^EMOJI\./,
      /^SHAKE\./,
      /^TONECURVE_FILE$/,
      /^SYSTEM\.EXTRA_STR_VALUE\./,
      /^LOAD\.WIPE$/,
      /^(?:EXCALL|MSGBK|MWND)\.ORDER$/,
      /^MWND\.(?:FACE|FILTER|FUCHI|MOJI|SHADOW|WAKU)_LAYER_REP$/,
      /^MWND\.DEFAULT_SEL_MWND_NO$/,
      /^MWND\.NNN\.(?:MSG_BACK_INSERT_NL|NAME_WINDOW_SIZE|NOVEL_MODE|OVERFLOW_CHECK_SIZE|TALK_MARGIN)$/,
      /^MSGBK\.(?:ACTIVE_MOJI_(?:FUCHI|SHADOW)_COLOR|DEBUG_MOJI_.*|FILTER_MARGIN|MOJI_SHADOW_COLOR)$/,
      /^MESSAGE_BACK_SAVE\.INTERVAL$/,
      /^WAKU\.NNN\.FILTER_MARGIN$/,
    ];

    const schemas = new Set([...cfg.keys()].map((k) => k.replace(/\.\d+(?=\.|$)/g, '.NNN')));
    const unclassified = [];
    for (const schema of schemas) {
      if (auditedAllowlist.some((re) => re.test(schema))) continue;
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
    assert.deepEqual(
      unclassified,
      [],
      `Unclassified unread FORTUNE×WORLD Gameexe.dat schemas: ${unclassified.join(', ')}`,
    );
  },
);

test(
  'FORTUNE×WORLD mov/OP.wmv decodes 48kHz stereo 16-bit WMA v2 (0x161) identically across JS and WASM',
  {skip: !HAS_FW || !fs.existsSync(`${FW_DIR}/mov/OP.wmv`)},
  () => {
    const buf = new Uint8Array(fs.readFileSync(`${FW_DIR}/mov/OP.wmv`));
    const layout = readAsfLayout(buf);
    const videoStream = layout.streams.find((s) => s.kind === 'video');
    const audioStream = layout.streams.find((s) => s.kind === 'audio');
    assert.ok(videoStream && videoStream.width === 1920 && videoStream.height === 1080);
    assert.ok(audioStream && audioStream.kind === 'audio');
    assert.equal(audioStream.codec, 0x161);
    assert.equal(audioStream.sampleRate, 48000);
    const jsDec = new WindowsMediaDecoder(audioStream, {wasm: false});
    const wasmDec = new WindowsMediaDecoder(audioStream, {wasm: true});
    const demux = new AsfDemuxer(layout);
    let frames = 0;
    let maxAbs = 0;
    let maxDiff = 0;
    for (
      let off = layout.dataOffset, count = 0;
      off + layout.packetSize <= buf.length && count < Math.min(layout.packetCount, 500) && frames < 12;
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
    assert.ok(frames >= 5, `Expected decoded WMA frames, got ${frames}`);
    assert.ok(maxAbs > 0.01 && maxAbs < 2.0, `Unexpected PCM peak ${maxAbs}`);
    assert.equal(maxDiff, 0, 'JS and WASM WMA 48kHz outputs must match bit-for-bit');
  },
);
