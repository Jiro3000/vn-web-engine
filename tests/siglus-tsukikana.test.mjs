import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import {
  computeSpriteOffset,
  computeWakuButtonOrigin,
  parseButtonActionStates,
  parseButtonSe,
  parseMwndAnimation,
  parseMwndColors,
  parseMwndLayout,
  parseSpaceHideObjectIds,
  parseWakuConfig,
} from '../dist/engines/siglus/mwnd.js';
import {AsfDemuxer, readAsfLayout} from '../dist/formats/asf/demux.js';
import {SiglusDbs} from '../dist/formats/siglus/dbs.js';
import {G00Image} from '../dist/formats/siglus/g00.js';
import {readGan} from '../dist/formats/siglus/gan.js';
import {SiglusOmv} from '../dist/formats/siglus/omv.js';
import {SiglusScenePack} from '../dist/formats/siglus/scene-pack.js';
import {decodeNwa, decodeOwp, ovkIndex} from '../dist/formats/siglus/sound.js';
import {WindowsMediaDecoder} from '../dist/video/windows-media.js';

const REPO_ROOT = path.resolve(import.meta.dirname, '..');
const SIGLUS_DIR = path.join(REPO_ROOT, 'src/engines/siglus');
const TK_DIR = '/Volumes/Transcend/Torrents/1GAMES/Tsuki no Kanata de Aimashou';
const HAS_TK =
  fs.existsSync(`${TK_DIR}/SiglusEngine.exe`) &&
  fs.existsSync(`${TK_DIR}/Gameexe.dat`) &&
  fs.existsSync(`${TK_DIR}/Scene.pck`);

function sha256File(filePath) {
  return crypto.createHash('sha256').update(fs.readFileSync(filePath)).digest('hex');
}

function listNonDotFiles(dir, ext) {
  return fs
    .readdirSync(dir)
    .filter((name) => !name.startsWith('._') && name !== '.DS_Store' && name.toLowerCase().endsWith(ext))
    .sort();
}

test('Tsukikana engine fixes: global 115, cgtable 78.*, pcmevent 52.* oneshot/loop/wait/check, VK_SPACE 0x623b80, and backlog MSG_DOWN_BTN z-order', () => {
  const playerSrc = fs.readFileSync(path.join(SIGLUS_DIR, 'player.ts'), 'utf8');
  const displaySrc = fs.readFileSync(path.join(SIGLUS_DIR, 'display.ts'), 'utf8');

  // 1. Native 0x54f140 / 0x650bd0: global 115 (0x73) triggers pageInput(true)
  assert.match(playerSrc, /case 115:[\s\S]{0,200}await this\.pageInput\(true\)/);

  // 2. Native 0x559a80: cgtable root 78 full command surface (1, 2, 3, 4, 5, 6, 7, 8, 9)
  assert.match(playerSrc, /if \(root === 78\)/);
  assert.match(playerSrc, /if \(member === 1\)/);
  assert.match(playerSrc, /if \(member === 3\)/);
  assert.match(playerSrc, /if \(member === 4\) return this\.cgTable\.size;/);
  assert.match(playerSrc, /if \(member === 9\)/);

  // 3. Native 0x55fe50: pcmevent[slot] modes 0 (oneshot), 1 (loop), 4/6 (wait), 5 (check)
  assert.match(playerSrc, /private startPcmEventSequence\(/);
  assert.match(playerSrc, /this\.startPcmEventSequence\(slot, pcmchNo, entries, opts, op === 1\)/);
  assert.match(playerSrc, /if \(op === 5\)/);

  // 4. Native 0x623b80: VK_SPACE (0x20) toggles hide_mwnd without advancing dialogue
  assert.match(displaySrc, /toggleHideMessage\?: \(\) => boolean/);
  assert.match(displaySrc, /event\.key === ' ' &&[\s\S]{0,180}toggleHideMessage\?\.\(\)/);
  assert.match(playerSrc, /0x623b80[\s\S]{0,600}this\.setUserMessageHidden\(true\)/);

  // 5. Backlog slider track must be appended BEFORE MSG_UP_BTN / MSG_DOWN_BTN so down arrow is hit-testable
  const trackIdx = displaySrc.indexOf('overlay.append(track);');
  const upIdx = displaySrc.indexOf("makeButton('MSG_UP_BTN'");
  const downIdx = displaySrc.indexOf("makeButton('MSG_DOWN_BTN'");
  assert.ok(trackIdx > 0 && upIdx > 0 && downIdx > 0);
  assert.ok(
    trackIdx < upIdx && trackIdx < downIdx,
    'Backlog slider track must be appended before MSG_UP_BTN and MSG_DOWN_BTN',
  );
});

test(
  'Tsuki no Kanata de Aimashou pinned SHA-256 digests and 100% bytecode coverage across all 326 scenes',
  {skip: !HAS_TK},
  () => {
    const expectedDigests = {
      'SiglusEngine.exe': '2fd87b8186d768492a840987427c1db299854587fa47f00095b140128dcd70fd',
      'Gameexe.dat': '1c6d74be00c53b7a9784c93582ed6f1805fd20166f03b66d9a21ea1e93275c32',
      'Scene.pck': '64de8f467707b48b3765629fedbdc4f19b6433e6073506dbbdeabc0e93b97f97',
      'dat/BGM_LIST.dbs': 'ebffbc1bbe5d2c894665a919ec74d5df6da26bdee80550b0dba6d654557d56b2',
      'dat/CALENDAR.dbs': '72d03b6ec75dc134bbfd220894f2c21a3e92ac4b8b7af809fa41fc0149119ab4',
      'dat/G00list.dbs': '9db4844c3a30f3f68c0fde568fb321e9a3d8b0fe23c37b96920e83c56adf6d23',
      'dat/tcdata.tcr': 'd996af9c7d3569f46ad8e1f06535271e8f0eb07451d662ed8fd3c9850f2bedb2',
      'dat/font01.ttf': '403bedfa178cbda07d751d2f9316a191591f0921e3c936f68f22c0d06e69f984',
      'dat/font02.ttf': '9b12932d3be5e9b3937029acbe8feaa2e11575a4d216d267dce8148fcc040732',
      'mov/logo.wmv': '9d2432edac7db1e0814417a82e3eb101bde8c7c6d4f66853256f4854f7dd5ff9',
      'mov/OP.wmv': 'ddc14584ef8b0f8f3ebaf6260da7c635be291afc56f3069793ba3354aeef2558',
    };
    for (const [rel, expected] of Object.entries(expectedDigests)) {
      assert.equal(sha256File(path.join(TK_DIR, rel)), expected, `SHA-256 mismatch for ${rel}`);
    }

    const pack = new SiglusScenePack(new Uint8Array(fs.readFileSync(path.join(TK_DIR, 'Scene.pck'))));
    assert.equal(pack.sceneNames.length, 326);

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

    assert.equal(totalInstructions, 3_188_290);
    for (const op of unaryOps) assert.ok([1, 2, 48].includes(op), `Unhandled unary op ${op}`);
    for (const op of binaryOps)
      assert.ok([1, 2, 3, 4, 5, 16, 17, 18, 19, 20, 21, 32, 33, 49, 50, 51, 52, 53, 54].includes(op), `Unhandled binary op ${op}`);
  },
);

test(
  'Tsuki no Kanata de Aimashou Gameexe.dat 100% schema coverage & 1920x1080 static geometry invariants',
  {skip: !HAS_TK},
  () => {
    const pack = new SiglusScenePack(new Uint8Array(fs.readFileSync(path.join(TK_DIR, 'Scene.pck'))));
    const cfg = pack.configuration(new Uint8Array(fs.readFileSync(path.join(TK_DIR, 'Gameexe.dat'))));

    assert.equal(cfg.get('SCREEN_SIZE'), '1920, 1080');
    assert.deepEqual([...parseSpaceHideObjectIds(cfg)].sort((a, b) => a - b), [47, 58, 79, 120, 121]);
    assert.deepEqual(parseMwndColors(cfg, 0), {mojiColor: 0, shadowColor: 1, fuchiColor: 1});
    assert.deepEqual(parseButtonSe(cfg, 7), {hit: 13, push: -1, decide: 14});
    assert.equal(parseButtonActionStates(cfg, 1).select.cutOffset, 3);
    assert.deepEqual(parseMwndAnimation(cfg, 0, 'open'), {type: 1, time: 200});

    // All 6 MWND / WAKU static geometry invariants inside 1920x1080
    const mwndCnt = Number(cfg.get('MWND.CNT') ?? 0);
    assert.equal(mwndCnt, 6);
    for (let i = 0; i < mwndCnt; i++) {
      const layout = parseMwndLayout(cfg, i);
      assert.ok(layout.windowPos[0] >= 0 && layout.windowPos[1] >= 0, `MWND.${i} negative origin`);
      assert.ok(
        layout.windowPos[0] + layout.windowSize[0] <= 1920 &&
          layout.windowPos[1] + layout.windowSize[1] <= 1080,
        `MWND.${i} exceeds 1920x1080`,
      );
      const waku = parseWakuConfig(cfg, layout.wakuNo);
      if (waku.wakuFile) {
        const g00Path = path.join(TK_DIR, 'g00', `${waku.wakuFile}.g00`);
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
          origin.left >= -10 && origin.left <= 1930 && origin.top >= -10 && origin.top <= 1090,
          `WAKU.${tag}.BTN.${m[1]} origin out of bounds: ${JSON.stringify(origin)}`,
        );
      }
    }

    // 100% Gameexe.dat key schema coverage gate
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
      /^(?:DISCMARK|DUMMY_CHECK.*|GAMEVERSION|MANUAL_PATH|MOUSE_CURSOR\.(?:DEFAULT|CNT)|SAVE\.NO_DATA_STR)$/,
      /^(?:FLAG|GLOBAL_FLAG|CALL_FLAG|COUNTER|OBJBTNGROUP|FRAME_ACTION_CH|PCMCH|PCMEVENT|MASK|CHRKOE|BGM|FONT_FILE)\.CNT$/,
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
    assert.deepEqual(unclassified, [], `Unclassified Gameexe.dat keys: ${unclassified.join(', ')}`);
  },
);

test(
  'Tsuki no Kanata de Aimashou dat/*.dbs, gan/*.gan, mov/*.omv, bgm/*.owp, wav/*.nwa, and koe/*.ovk parse cleanly',
  {skip: !HAS_TK},
  async () => {
    // 1. DBS files
    const bgmDbs = new SiglusDbs(new Uint8Array(fs.readFileSync(path.join(TK_DIR, 'dat/BGM_LIST.dbs'))));
    const calDbs = new SiglusDbs(new Uint8Array(fs.readFileSync(path.join(TK_DIR, 'dat/CALENDAR.dbs'))));
    const g00Dbs = new SiglusDbs(new Uint8Array(fs.readFileSync(path.join(TK_DIR, 'dat/G00list.dbs'))));
    assert.equal(bgmDbs.rowCount, 54);
    assert.equal(bgmDbs.columnCount, 5);
    assert.equal(calDbs.rowCount, 66);
    assert.equal(calDbs.columnCount, 32);
    assert.equal(g00Dbs.rowCount, 3001);
    assert.equal(g00Dbs.columnCount, 1);

    // 2. All 5 GAN files
    const gans = listNonDotFiles(path.join(TK_DIR, 'gan'), '.gan');
    assert.equal(gans.length, 5);
    for (const f of gans) {
      const sets = readGan(new Uint8Array(fs.readFileSync(path.join(TK_DIR, 'gan', f))));
      assert.ok(Array.isArray(sets) && sets.length > 0, `GAN ${f} has 0 sets`);
    }

    // 3. All 28 OMV files (7 ending SR_*.omv + 21 effect OMVs)
    const omvs = listNonDotFiles(path.join(TK_DIR, 'mov'), '.omv');
    assert.equal(omvs.length, 28);
    let endingCount = 0;
    for (const f of omvs) {
      const omv = new SiglusOmv(new Uint8Array(fs.readFileSync(path.join(TK_DIR, 'mov', f))));
      assert.ok(omv.width > 0 && omv.height > 0, `OMV ${f} invalid dimensions`);
      if (f.startsWith('SR_')) {
        endingCount++;
        assert.equal(omv.width, 1920);
        assert.equal(omv.height, 1080);
      }
    }
    assert.equal(endingCount, 7);

    // 4. All 49 BGM .owp files decode to OggS
    const bgms = listNonDotFiles(path.join(TK_DIR, 'bgm'), '.owp');
    assert.equal(bgms.length, 49);
    for (const f of bgms) {
      const raw = new Uint8Array(fs.readFileSync(path.join(TK_DIR, 'bgm', f))).subarray(0, 16);
      const dec = decodeOwp(raw);
      assert.equal(Buffer.from(dec.subarray(0, 4)).toString('ascii'), 'OggS', `BGM ${f} not OggS`);
    }

    // 5. Representative WAV .nwa & KOE .ovk banks
    const nwas = listNonDotFiles(path.join(TK_DIR, 'wav'), '.nwa');
    assert.equal(nwas.length, 363);
    for (const f of nwas.slice(0, 20)) {
      const dec = decodeNwa(new Uint8Array(fs.readFileSync(path.join(TK_DIR, 'wav', f))));
      assert.ok(dec.rate > 0 && dec.pcm.length > 0, `NWA ${f} decoded empty`);
    }
    const ovks = listNonDotFiles(path.join(TK_DIR, 'koe'), '.ovk');
    assert.equal(ovks.length, 271);
    for (const f of ovks.slice(0, 20)) {
      const buf = new Uint8Array(fs.readFileSync(path.join(TK_DIR, 'koe', f)));
      const idx = await ovkIndex({
        size: buf.length,
        read: async (offset, length) => buf.subarray(offset, offset + length),
      });
      assert.ok(idx.size > 0, `OVK ${f} empty index`);
    }
  },
);

test(
  'Tsuki no Kanata de Aimashou mov/logo.wmv and mov/OP.wmv decode identically across JS and WASM WMA v2',
  {skip: !HAS_TK},
  () => {
    for (const [file, expectedRate] of [
      ['mov/logo.wmv', 44100],
      ['mov/OP.wmv', 48000],
    ]) {
      const buf = new Uint8Array(fs.readFileSync(path.join(TK_DIR, file)));
      const layout = readAsfLayout(buf);
      const audioStream = layout.streams.find((s) => s.kind === 'audio');
      assert.ok(audioStream && audioStream.kind === 'audio');
      assert.equal(audioStream.codec, 0x161);
      assert.equal(audioStream.sampleRate, expectedRate);
      const jsDec = new WindowsMediaDecoder(audioStream, {wasm: false});
      const wasmDec = new WindowsMediaDecoder(audioStream, {wasm: true});
      const demux = new AsfDemuxer(layout);
      let frames = 0;
      let maxAbs = 0;
      let maxDiff = 0;
      for (
        let off = layout.dataOffset, count = 0;
        off + layout.packetSize <= buf.length && count < Math.min(layout.packetCount, 25);
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
      assert.ok(frames >= 5, `${file}: expected >=5 decoded WMA frames, got ${frames}`);
      assert.ok(maxAbs > 0.005 && maxAbs < 2.0, `${file}: unexpected PCM peak ${maxAbs}`);
      assert.equal(maxDiff, 0, `${file}: JS vs WASM WMA mismatch`);
    }
  },
);
