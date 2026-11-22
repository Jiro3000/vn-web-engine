import assert from 'node:assert/strict';
import fs from 'node:fs';
import test from 'node:test';
import {
  computeAlignedNameLeft,
  computeColorMatrix,
  computeObjectPlacement,
  computeSpriteOffset,
  computeWakuButtonOrigin,
  listConfiguredWakuIndices,
  parseButtonActionStates,
  parseIconConfig,
  parseMwndLayout,
  parseWakuConfig,
} from '../dist/engines/siglus/mwnd.js';
import {layoutSelbtnItems, readSelbtnTemplate} from '../dist/engines/siglus/selbtn.js';
import {G00Image} from '../dist/formats/siglus/g00.js';
import {SiglusScenePack} from '../dist/formats/siglus/scene-pack.js';

const SSR_DIR = '/Users/paul/Torrents/Games/tsuki no kanata fan disk';
const HAS_SSR = fs.existsSync(`${SSR_DIR}/Gameexe.dat`) && fs.existsSync(`${SSR_DIR}/Scene.pck`);

test('parseMwndLayout honors NAME_WINDOW_POS, NAME_WINDOW_ALIGN, and NAME_MESSAGE_POS per native 0x5d82ea', () => {
  const ssrLike = new Map([
    ['MWND.000.EXTEND_TYPE', '0'],
    ['MWND.000.WINDOW_POS', '000, 804'],
    ['MWND.000.WINDOW_SIZE', '1920, 276'],
    ['MWND.000.MESSAGE_POS', '412, 080'],
    ['MWND.000.MESSAGE_MARGIN', '0, 0, 0, 0'],
    ['MWND.000.MOJI_CNT', '36, 3'],
    ['MWND.000.MOJI_SIZE', '38'],
    ['MWND.000.MOJI_SPACE', '-1, 20'],
    ['MWND.000.WAKU_NO', '0'],
    ['MWND.000.NAME_EXTEND_TYPE', '0'],
    ['MWND.000.NAME_WINDOW_ALIGN', '1'],
    ['MWND.000.NAME_WINDOW_POS', '524, 12'],
    ['MWND.000.NAME_MESSAGE_POS', '000, 000'],
    ['MWND.000.NAME_MESSAGE_MARGIN', '8, 8, 8, 8'],
    ['MWND.000.NAME_MOJI_SIZE', '40'],
    ['MWND.000.NAME_MOJI_SPACE', '-1, 10'],
  ]);

  const mw0 = parseMwndLayout(ssrLike, 0);
  assert.deepEqual(mw0.windowPos, [0, 804]);
  assert.deepEqual(mw0.windowSize, [1920, 276]);
  assert.equal(mw0.textX, 412);
  assert.equal(mw0.textY, 80);
  assert.equal(mw0.nameAlign, 1);
  assert.equal(mw0.nameAnchorX, 524);
  assert.equal(mw0.nameAnchorY, 12);
  assert.equal(mw0.nameMojiSize, 40);
  assert.deepEqual(mw0.nameMojiSpace, [-1, 10]);

  // Center alignment (align=1): 160px speaker name centers around x=524 -> [444..604]
  assert.equal(computeAlignedNameLeft(mw0.nameAnchorX, mw0.nameAlign, 160), 444);
  // Left alignment (align=0): starts at anchorX
  assert.equal(computeAlignedNameLeft(524, 0, 160), 524);
  // Right alignment (align=2): ends at anchorX
  assert.equal(computeAlignedNameLeft(524, 2, 160), 364);
});

test('parseMwndLayout handles NAME_EXTEND_TYPE=1 margins and legacy FORTUNE×WORLD fallback', () => {
  const extending = new Map([
    ['MWND.000.NAME_EXTEND_TYPE', '1'],
    ['MWND.000.NAME_WINDOW_POS', '500, 20'],
    ['MWND.000.NAME_MESSAGE_POS_REP', '4, -2'],
    ['MWND.000.NAME_MESSAGE_MARGIN', '12, 6, 14, 8'],
    ['MWND.000.NAME_WINDOW_ALIGN', '0'],
  ]);
  const leftExt = parseMwndLayout(extending, 0);
  assert.equal(leftExt.nameAnchorX, 500 + 4 + 12);
  assert.equal(leftExt.nameAnchorY, 20 - 2 + 6);

  extending.set('MWND.000.NAME_WINDOW_ALIGN', '1');
  const centerExt = parseMwndLayout(extending, 0);
  assert.equal(centerExt.nameAnchorX, 500 + 4);
  assert.equal(centerExt.nameAnchorY, 20 - 2 + 6);

  extending.set('MWND.000.NAME_WINDOW_ALIGN', '2');
  const rightExt = parseMwndLayout(extending, 0);
  assert.equal(rightExt.nameAnchorX, 500 + 4 - 14);

  // Legacy config without NAME_WINDOW_POS (FORTUNE×WORLD style)
  const legacy = new Map([
    ['MWND.000.WINDOW_POS', '7, 727'],
    ['MWND.000.WINDOW_SIZE', '1906, 353'],
    ['MWND.000.MESSAGE_POS', '362, 124'],
    ['MWND.000.NAME_MESSAGE_POS', '362, 60'],
    ['MWND.000.WAKU_NO', '0'],
  ]);
  const fw = parseMwndLayout(legacy, 0);
  assert.equal(fw.nameAlign, 0);
  assert.equal(fw.nameAnchorX, 362);
  assert.equal(fw.nameAnchorY, 60);
  assert.equal(fw.textX, 362 + 32);
  assert.equal(fw.textY, 124 + 32);
});

test('computeSpriteOffset and computeWakuButtonOrigin subtract G00 centerX/centerY across all 4 anchors', () => {
  // _mw00_base: 1920x1080 with center=(0,804) inside MWND.000 at y=804
  const filterPos = computeSpriteOffset(0, 0, {x: 0, y: 0, centerX: 0, centerY: 804});
  assert.deepEqual(filterPos, {left: 0, top: -804});

  // _mw00_frame: POS = 0, 0, 275, center=(0,46), size=1920x47 -> screen y = 1033..1080
  const frameBtn = computeWakuButtonOrigin(
    0,
    [0, 804],
    [1920, 276],
    0,
    275,
    {x: 0, y: 0, centerX: 0, centerY: 46},
  );
  assert.deepEqual(frameBtn, {left: 0, top: 1033});

  // _mw00_save: POS = 0, 668, 274, center=(0,59), size=126x60 -> screen y = 1019..1079
  const saveBtn = computeWakuButtonOrigin(
    0,
    [0, 804],
    [1920, 276],
    668,
    274,
    {x: 0, y: 0, centerX: 0, centerY: 59},
  );
  assert.deepEqual(saveBtn, {left: 668, top: 1019});

  // _mw00_close: POS = 0, 1881, 39, center=(15,15), size=32x32 -> screen (1866, 828)
  const closeBtn = computeWakuButtonOrigin(
    0,
    [0, 804],
    [1920, 276],
    1881,
    39,
    {x: 0, y: 0, centerX: 15, centerY: 15},
  );
  assert.deepEqual(closeBtn, {left: 1866, top: 828});

  // Anchor 1 (top-right), 2 (bottom-left), 3 (bottom-right) per native 0x5e44da
  assert.deepEqual(
    computeWakuButtonOrigin(1, [10, 800], [1900, 280], 100, 20, {x: 0, y: 0, centerX: 5, centerY: 5}),
    {left: 1805, top: 815},
  );
  assert.deepEqual(
    computeWakuButtonOrigin(2, [10, 800], [1900, 280], 100, 40, {x: 0, y: 0, centerX: 0, centerY: 0}),
    {left: 110, top: 1040},
  );
  assert.deepEqual(
    computeWakuButtonOrigin(3, [10, 800], [1900, 280], 100, 40, {x: 0, y: 0, centerX: 10, centerY: 10}),
    {left: 1800, top: 1030},
  );
});

test('parseWakuConfig and parseButtonActionStates honor FILTER_CONFIG_* and BUTTON.ACTION templates', () => {
  const cfg = new Map([
    ['WAKU.000.FILTER_FILE', '"_mw00_base"'],
    ['WAKU.000.FILTER_CONFIG_COLOR', '0'],
    ['WAKU.000.FILTER_CONFIG_TR', '1'],
    ['WAKU.002.WAKU_FILE', '"ef_novel"'],
    ['WAKU.004.FILTER_FILE', '"_mw04_base"'],
    ['WAKU.004.FILTER_CONFIG_COLOR', '0'],
    ['WAKU.004.FILTER_CONFIG_TR', '0'],
    ['BUTTON.ACTION.001.NORMAL', '0, 0, 0, 255, 0, 0'],
    ['BUTTON.ACTION.001.HIT', '1, 0, 0, 255, 0, 0'],
    ['BUTTON.ACTION.001.PUSH', '2, 0, 0, 255, 0, 0'],
    ['BUTTON.ACTION.001.DISABLE', '4, 0, 0, 255, 0, 0'],
    ['BUTTON.ACTION.015.NORMAL', '0, 0, 0, 255, 0, 0'],
    ['BUTTON.ACTION.015.HIT', '1, 0, 0, 255, 0, 0'],
    ['BUTTON.ACTION.015.PUSH', '2, 2, 2, 255, 0, 0'],
    ['BUTTON.ACTION.015.DISABLE', '0, 0, 0, 128, 0, 128'],
  ]);
  assert.deepEqual(listConfiguredWakuIndices(cfg), [0, 2, 4]);
  const w0 = parseWakuConfig(cfg, 0);
  assert.equal(w0.filterFile, '_mw00_base');
  assert.equal(w0.filterConfigColor, false);
  assert.equal(w0.filterConfigTr, true);
  const w2 = parseWakuConfig(cfg, 2);
  assert.equal(w2.wakuFile, 'ef_novel');
  assert.equal(w2.filterFile, undefined);
  const w4 = parseWakuConfig(cfg, 4);
  assert.equal(w4.filterConfigColor, false);
  assert.equal(w4.filterConfigTr, false);

  const act1 = parseButtonActionStates(cfg, 1);
  assert.equal(act1.disable.cutOffset, 4);
  const act15 = parseButtonActionStates(cfg, 15);
  assert.equal(act15.push.dx, 2);
  assert.equal(act15.push.dy, 2);
  assert.equal(act15.disable.cutOffset, 0);
  assert.equal(act15.disable.alpha, 128);
  assert.equal(act15.disable.dark, 128);
  const fallback = parseButtonActionStates(cfg, 99);
  assert.equal(fallback.disable.cutOffset, 3);
});

test('SSR Gameexe + G00 geometric invariants: every MWND/WAKU background, speaker, and button lands inside 1920x1080', {skip: !HAS_SSR}, () => {
  const pack = new SiglusScenePack(new Uint8Array(fs.readFileSync(`${SSR_DIR}/Scene.pck`)));
  const cfg = pack.configuration(new Uint8Array(fs.readFileSync(`${SSR_DIR}/Gameexe.dat`)));
  const g00Dir = fs.readdirSync(`${SSR_DIR}/g00`);
  const loadG00 = (name) => {
    const file = g00Dir.find((f) => f.toLowerCase() === `${name.toLowerCase()}.g00`);
    assert.ok(file, `Missing G00 ${name}`);
    return new G00Image(new Uint8Array(fs.readFileSync(`${SSR_DIR}/g00/${file}`)));
  };

  for (let mwIndex = 0; mwIndex < 8; mwIndex++) {
    const layout = parseMwndLayout(cfg, mwIndex);
    // 1. Speaker name in non-NVL windows must never sit at left border x=0
    if (layout.nameDispMode !== 2) {
      assert.ok(
        layout.nameAnchorX >= 400 && layout.nameAnchorX <= 800,
        `MWND.${mwIndex} nameAnchorX=${layout.nameAnchorX} should be in nameplate column`,
      );
      assert.ok(
        layout.windowPos[1] + layout.nameAnchorY >= 800 &&
          layout.windowPos[1] + layout.nameAnchorY < layout.windowPos[1] + layout.textY,
        `MWND.${mwIndex} speaker Y must sit above dialogue text`,
      );
    }
    if (layout.wakuNo < 0) continue;

    // 2. WAKU filter / waku artwork opaque bounds must land inside 1920x1080
    const waku = parseWakuConfig(cfg, layout.wakuNo);
    for (const assetName of [waku.filterFile, waku.wakuFile].filter(Boolean)) {
      const fr = loadG00(assetName).frame(0);
      const off = computeSpriteOffset(0, 0, fr);
      const [bx0, by0, bx1, by1] = fr.contentBounds ?? [0, 0, fr.width, fr.height];
      const screenLeft = layout.windowPos[0] + off.left + bx0;
      const screenTop = layout.windowPos[1] + off.top + by0;
      const screenRight = layout.windowPos[0] + off.left + bx1;
      const screenBottom = layout.windowPos[1] + off.top + by1;
      assert.ok(
        screenLeft >= 0 && screenRight <= 1920 && screenTop >= 0 && screenBottom <= 1080,
        `MWND.${mwIndex}/WAKU.${layout.wakuNo} ${assetName} opaque bbox [${screenLeft}..${screenRight}, ${screenTop}..${screenBottom}] out of 1920x1080`,
      );
    }

    // 3. Every WAKU button must land cleanly inside 1920x1080 (with pivot subtracted!)
    const wakuTag = String(layout.wakuNo).padStart(3, '0');
    const btnRe = new RegExp(`^WAKU\\.${wakuTag}\\.BTN\\.(\\d+)\\.FILE$`);
    for (const [k, v] of cfg) {
      const m = btnRe.exec(k);
      if (!m) continue;
      const btnId = Number(m[1]);
      const file = v.split('"')[1];
      const prefix = k.slice(0, -4);
      const [anchor, x, y] = (cfg.get(prefix + 'POS') ?? '').split(',').map(Number);
      const fr = loadG00(file).frame(0);
      const origin = computeWakuButtonOrigin(anchor, layout.windowPos, layout.windowSize, x, y, fr);
      assert.ok(
        origin.left >= 0 &&
          origin.left + fr.width <= 1920 &&
          origin.top >= 0 &&
          origin.top + fr.height <= 1080,
        `WAKU.${wakuTag}.BTN.${btnId} (${file}) rect [${origin.left}..${origin.left + fr.width}, ${origin.top}..${origin.top + fr.height}] out of 1920x1080`,
      );
    }

    // 4. Wait icon (WAKU.nnn.ICON_NO / ICON_POS) lands inside 1920x1080
    if (waku.iconNo >= 0) {
      const iconCfg = parseIconConfig(cfg, waku.iconNo);
      assert.ok(iconCfg.file, `ICON.${waku.iconNo}.FILE missing`);
      const iconFr = loadG00(iconCfg.file).frame(0);
      const [anchor, ix, iy] = waku.iconPos;
      const iconOrigin = computeWakuButtonOrigin(
        anchor,
        layout.windowPos,
        layout.windowSize,
        ix,
        iy,
        iconFr,
      );
      assert.ok(
        iconOrigin.left >= 0 &&
          iconOrigin.left + iconFr.width <= 1920 &&
          iconOrigin.top >= 0 &&
          iconOrigin.top + iconFr.height <= 1080,
        `WAKU.${wakuTag} wait icon out of bounds: ${JSON.stringify(iconOrigin)}`,
      );
    }
  }

  // 5. SELBTN.000 choices + MSGBK backlog buttons land inside 1920x1080 with pivots subtracted
  const selTpl = readSelbtnTemplate(cfg, 0);
  assert.equal(selTpl.textColor, 4);
  assert.equal(selTpl.textHitColor, 103);
  assert.equal(selTpl.btnAction, 1);
  const selFr = loadG00(selTpl.baseFile).frame(0);
  const selPlacements = layoutSelbtnItems(
    [
      {index: 0, text: 'Choice 1', dispFlag: 1, colorMode: -1},
      {index: 1, text: 'Choice 2', dispFlag: 1, colorMode: -1},
    ],
    selTpl,
    selFr.width,
    selFr.height,
  );
  for (const p of selPlacements) {
    const left = p.x - selFr.centerX;
    const top = p.y - selFr.centerY;
    assert.ok(
      left >= 0 && left + selFr.width <= 1920 && top >= 0 && top + selFr.height <= 1080,
      `SELBTN placement [${left}..${left + selFr.width}, ${top}..${top + selFr.height}] out of 1920x1080`,
    );
  }
  for (const kind of ['CLOSE_BTN', 'MSG_UP_BTN', 'MSG_DOWN_BTN']) {
    const f = cfg.get(`MSGBK_ITEM.${kind}.FILE`)?.split('"')[1];
    const [bx, by] = (cfg.get(`MSGBK_ITEM.${kind}.POS`) ?? '').split(',').map(Number);
    const fr = loadG00(f).frame(0);
    const off = computeSpriteOffset(bx, by, fr);
    assert.ok(
      off.left >= 0 && off.left + fr.width <= 1920 && off.top >= 0 && off.top + fr.height <= 1080,
      `MSGBK_ITEM.${kind} [${off.left}..${off.left + fr.width}, ${off.top}..${off.top + fr.height}] out of 1920x1080`,
    );
  }
});

test('computeObjectPlacement matches native C_d3d_sprite 0x6f1865 + 0x62a170 pivot math', () => {
  // Title button _mm00_quit at x=1616, center=(107, 22): placed at 1509, NOT 1616 (which overflowed 1920)
  const quit = computeObjectPlacement(
    {x: 1616, y: 896},
    {x: 0, y: 0, centerX: 107, centerY: 22},
  );
  assert.equal(quit.placedX, 1509);
  assert.equal(quit.placedY, 874);
  assert.equal(quit.pivotX, 107);
  assert.equal(quit.pivotY, 22);

  // center shifts both quad position and pivot; centerRep shifts ONLY scale/rotate pivot
  const bustup = computeObjectPlacement(
    {x: 960, y: 300, center: [10, -5], centerRep: [50, 20], positionOffsets: {x: [-20, 5], y: [10]}},
    {x: 0, y: 0, centerX: 756, centerY: 240},
  );
  assert.equal(bustup.originX, -766);
  assert.equal(bustup.originY, -235);
  assert.equal(bustup.placedX, 960 - 15 - 766);
  assert.equal(bustup.placedY, 300 + 10 - 235);
  assert.equal(bustup.pivotX, 756 + 10 + 50);
  assert.equal(bustup.pivotY, 240 - 5 + 20);
});

test('computeColorMatrix produces exact Siglus Direct3D affine color transforms', () => {
  assert.equal(computeColorMatrix(undefined), undefined);
  assert.equal(computeColorMatrix({bright: 0, dark: 0, mono: 0, colorRate: 0}), undefined);

  const evalRgb = (matrixStr, [r, g, b]) => {
    const nums = matrixStr.split(' ').map(Number);
    return [0, 1, 2].map(
      (row) => nums[row * 5] * r + nums[row * 5 + 1] * g + nums[row * 5 + 2] * b + nums[row * 5 + 4],
    );
  };

  // bright=255 blends black -> white (1, 1, 1)
  const whiteFlash = computeColorMatrix({bright: 255});
  assert.ok(whiteFlash);
  assert.deepEqual(evalRgb(whiteFlash, [0, 0, 0]).map((v) => Math.round(v * 100) / 100), [1, 1, 1]);

  // dark=255 scales white -> black (0, 0, 0)
  const blackout = computeColorMatrix({dark: 255});
  assert.deepEqual(evalRgb(blackout, [1, 1, 1]).map((v) => Math.round(v * 100) / 100), [0, 0, 0]);

  // colorRate=255 tints any color to exact (colorR, colorG, colorB)
  const sunset = computeColorMatrix({colorRate: 255, colorR: 255, colorG: 128, colorB: 0});
  const [sr, sg, sb] = evalRgb(sunset, [0.2, 0.8, 0.9]);
  assert.ok(Math.abs(sr - 1) < 1e-3 && Math.abs(sg - 128 / 255) < 1e-3 && Math.abs(sb) < 1e-3);

  // reverse=255 inverts RGB
  const inverted = computeColorMatrix({reverse: 255});
  const [ir, ig, ib] = evalRgb(inverted, [0.25, 0.5, 1]);
  assert.ok(Math.abs(ir - 0.75) < 1e-3 && Math.abs(ig - 0.5) < 1e-3 && Math.abs(ib) < 1e-3);
});
