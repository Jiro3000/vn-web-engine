export type NameAlign = 0 | 1 | 2;

export interface ButtonActionState {
  cutOffset: number;
  dx: number;
  dy: number;
  alpha: number;
  bright: number;
  dark: number;
}

export interface ButtonActionSet {
  normal: ButtonActionState;
  hit: ButtonActionState;
  push: ButtonActionState;
  disable: ButtonActionState;
  select: ButtonActionState;
}

export interface ButtonSeSet {
  hit: number;
  push: number;
  decide: number;
}

export interface MwndColors {
  mojiColor: number;
  shadowColor: number;
  fuchiColor: number;
}

export interface MwndAnimation {
  type: number;
  time: number;
}

export interface MwndLayout {
  index: number;
  extendType: number;
  windowPos: [number, number];
  windowSize: [number, number];
  textX: number;
  textY: number;
  textWidth: number;
  textHeight: number;
  vertical: boolean;
  rows: number;
  mojiSize: number;
  mojiSpace: [number, number];
  rubySize: number;
  rubySpace: number;
  wakuNo: number;
  nameWakuNo: number;
  nameDispMode: number;
  nameNewline: boolean;
  nameBracket: boolean;
  nameExtendType: number;
  nameAlign: NameAlign;
  nameAnchorX: number;
  nameAnchorY: number;
  nameMojiSize: number;
  nameMojiSpace: [number, number];
  nameMojiCnt: number;
}

export interface WakuConfig {
  index: number;
  filterFile?: string;
  wakuFile?: string;
  filterConfigColor: boolean;
  filterConfigTr: boolean;
  facePos: [number, number];
  iconNo: number;
  iconPos: [anchor: number, x: number, y: number];
}

export interface IconConfig {
  index: number;
  file?: string;
  speed: number;
  count: number;
}

export interface ObjectPlacement {
  originX: number;
  originY: number;
  placedX: number;
  placedY: number;
  pivotX: number;
  pivotY: number;
}

export interface ObjectColorProps {
  bright?: number;
  dark?: number;
  mono?: number;
  reverse?: number;
  colorR?: number;
  colorG?: number;
  colorB?: number;
  colorRate?: number;
  addR?: number;
  addG?: number;
  addB?: number;
}

function parseNumbers(
  config: ReadonlyMap<string, string>,
  key: string,
  defaults: readonly number[],
): number[] {
  const raw = config.get(key);
  if (raw === undefined) return [...defaults];
  const parsed = raw.split(',').map((part) => Number(part.trim()));
  return defaults.map((fallback, i) => (Number.isFinite(parsed[i]) ? parsed[i]! : fallback));
}

function parseQuoted(config: ReadonlyMap<string, string>, key: string): string | undefined {
  const value = config.get(key)?.split('"')[1];
  return value || undefined;
}

/**
 * Parses Siglus Gameexe `MWND.nnn.*` layout parameters following native
 * `SiglusEngine.exe` (`0x696990`, `0x5d7780`, `0x5d7c20`).
 */
export function parseMwndLayout(config: ReadonlyMap<string, string>, index: number): MwndLayout {
  const prefix = `MWND.${String(index).padStart(3, '0')}.`;
  const extendType = Number(config.get(prefix + 'EXTEND_TYPE') ?? 0) | 0;
  const [screenW, screenH] = parseNumbers(config, 'SCREEN_SIZE', [1920, 1080]) as [number, number];
  const [wx, wy] = parseNumbers(config, prefix + 'WINDOW_POS', [7, 727]) as [number, number];
  const defaultWindowSize: [number, number] =
    extendType === 1 ? [Math.max(0, screenW - wx), Math.max(0, screenH - wy)] : [1906, 353];
  const [ww, wh] = parseNumbers(config, prefix + 'WINDOW_SIZE', defaultWindowSize) as [
    number,
    number,
  ];
  const mojiSize = Number(config.get(prefix + 'MOJI_SIZE') ?? 38);
  const margin = parseNumbers(
    config,
    prefix + 'MESSAGE_MARGIN',
    index === 0 ? [32, 32, 0, 0] : [0, 0, 0, 0],
  );
  const defaultMsgPos: [number, number] = extendType === 1 ? [0, 0] : [362, 124];
  const [msgX, msgY] = parseNumbers(config, prefix + 'MESSAGE_POS', defaultMsgPos) as [
    number,
    number,
  ];
  const [columns, rows] = parseNumbers(config, prefix + 'MOJI_CNT', [32, 3]) as [number, number];
  const [spacing, lineSpace] = parseNumbers(config, prefix + 'MOJI_SPACE', [0, 18]) as [
    number,
    number,
  ];
  const textX = msgX + margin[0]!;
  const textY = msgY + margin[1]!;
  // 1.1.141.3 uses mode 1 for vertical flow (0x5df63b, 0x5df83c).
  const vertical = Number(config.get('TATEYOKO_MODE') ?? 0) === 1;
  const inlineSize = columns * (mojiSize + spacing);
  const blockSize = rows * (mojiSize + lineSpace);
  const textWidth = vertical ? blockSize : inlineSize;
  const textHeight = vertical ? inlineSize : blockSize;

  const wakuNo = Number(config.get(prefix + 'WAKU_NO') ?? -1);
  const nameWakuNo = Number(config.get(prefix + 'NAME_WAKU_NO') ?? -1);
  const nameDispMode = Number(config.get(prefix + 'NAME_DISP_MODE') ?? 0) | 0;
  const nameNewline = Number(config.get(prefix + 'NAME_NEWLINE') ?? 0) !== 0;
  const nameBracket = Number(config.get(prefix + 'NAME_BRACKET') ?? 0) !== 0;

  const nameExtendType = Number(config.get(prefix + 'NAME_EXTEND_TYPE') ?? 0) | 0;
  const rawAlign = Number(config.get(prefix + 'NAME_WINDOW_ALIGN') ?? 0) | 0;
  const nameAlign: NameAlign = rawAlign === 1 || rawAlign === 2 ? rawAlign : 0;
  const hasNameWindowPos = config.has(prefix + 'NAME_WINDOW_POS');
  const [nameWinX, nameWinY] = parseNumbers(config, prefix + 'NAME_WINDOW_POS', [0, 0]) as [
    number,
    number,
  ];
  const [nameMsgX, nameMsgY] = parseNumbers(
    config,
    prefix + 'NAME_MESSAGE_POS',
    hasNameWindowPos ? [0, 0] : [msgX, msgY - mojiSize],
  ) as [number, number];
  const [nameRepX, nameRepY] = parseNumbers(config, prefix + 'NAME_MESSAGE_POS_REP', [0, 0]) as [
    number,
    number,
  ];
  const nameMargin = parseNumbers(config, prefix + 'NAME_MESSAGE_MARGIN', [0, 0, 0, 0]);
  const nameMojiSize = Number(config.get(prefix + 'NAME_MOJI_SIZE') ?? 36);
  const nameMojiSpace = parseNumbers(config, prefix + 'NAME_MOJI_SPACE', [0, 0]) as [
    number,
    number,
  ];
  const nameMojiCnt = Number(config.get(prefix + 'NAME_MOJI_CNT') ?? 0);

  // Native C_elm_mwnd::disp_proc (0x5d82ea..0x5d84f1):
  // Name window origin relative to MWND WINDOW_POS is NAME_WINDOW_POS + NAME_MESSAGE_POS_REP.
  // For NAME_EXTEND_TYPE == 0: align 0 adds NAME_MESSAGE_POS.x, align 1 adds 0,
  // align 2 subtracts NAME_MESSAGE_POS.x; Y adds NAME_MESSAGE_POS.y.
  // For NAME_EXTEND_TYPE != 0: align 0 adds NAME_MESSAGE_MARGIN.left, align 1 adds 0,
  // align 2 subtracts NAME_MESSAGE_MARGIN.right; Y adds NAME_MESSAGE_MARGIN.top.
  const originX = nameWinX + nameRepX;
  const originY = nameWinY + nameRepY;
  let nameAnchorX: number;
  let nameAnchorY: number;
  if (nameExtendType === 0) {
    nameAnchorX =
      nameAlign === 0 ? originX + nameMsgX : nameAlign === 2 ? originX - nameMsgX : originX;
    nameAnchorY = originY + nameMsgY;
  } else {
    nameAnchorX =
      nameAlign === 0
        ? originX + nameMargin[0]!
        : nameAlign === 2
          ? originX - nameMargin[2]!
          : originX;
    nameAnchorY = originY + nameMargin[1]!;
  }

  return {
    index,
    extendType,
    windowPos: [wx, wy],
    windowSize: [ww, wh],
    textX,
    textY,
    textWidth,
    textHeight,
    vertical,
    rows,
    mojiSize,
    mojiSpace: [spacing, lineSpace],
    rubySize: Number(config.get(prefix + 'RUBY_SIZE') ?? 13),
    rubySpace: Number(config.get(prefix + 'RUBY_SPACE') ?? 2),
    wakuNo,
    nameWakuNo,
    nameDispMode,
    nameNewline,
    nameBracket,
    nameExtendType,
    nameAlign,
    nameAnchorX,
    nameAnchorY,
    nameMojiSize,
    nameMojiSpace,
    nameMojiCnt,
  };
}

/**
 * Computes the left X coordinate for a rendered speaker name of width `textWidth`,
 * matching native `C_elm_mwnd_name::set_name` (`0x5e1284..0x5e13e9`).
 */
export function computeAlignedNameLeft(
  anchorX: number,
  align: NameAlign,
  textWidth: number,
): number {
  if (align === 1) return anchorX - Math.trunc(textWidth / 2);
  if (align === 2) return anchorX - textWidth;
  return anchorX;
}

/**
 * Computes sprite placement with G00 pivot (`centerX`, `centerY`) subtracted,
 * matching standard Siglus sprite/WAKU blitting.
 */
export function computeSpriteOffset(
  posX: number,
  posY: number,
  frame: {x: number; y: number; centerX: number; centerY: number},
): {left: number; top: number} {
  return {
    left: posX + frame.x - frame.centerX,
    top: posY + frame.y - frame.centerY,
  };
}

/**
 * Computes stage-space (left, top) for a `WAKU.nnn.BTN.mmm` element,
 * matching native `C_elm_mwnd_waku::disp_proc` (`0x5e44da..0x5e4563`):
 * anchor 0 = top-left, 1 = top-right, 2 = bottom-left, 3 = bottom-right of the MWND rect,
 * followed by G00 pivot `(centerX, centerY)` subtraction.
 */
export function computeWakuButtonOrigin(
  anchor: number,
  windowPos: readonly [number, number],
  windowSize: readonly [number, number],
  posX: number,
  posY: number,
  frame: {x: number; y: number; centerX: number; centerY: number},
): {left: number; top: number} {
  const [wx, wy] = windowPos;
  const [ww, wh] = windowSize;
  const anchorX = anchor === 1 || anchor === 3 ? wx + ww - posX : wx + posX;
  const anchorY = anchor === 2 || anchor === 3 ? wy + wh - posY : wy + posY;
  return computeSpriteOffset(anchorX, anchorY, frame);
}

/**
 * Computes native `C_d3d_sprite` object placement and transform pivot matching
 * `SiglusEngine.exe` `0x6f1865..0x6f1921` and `0x62a170`:
 *   totalCenter = frame.center + object.center + object.centerRep
 *   placedPos   = object.pos + sum(posRep) + frame.xy - frame.center - object.center
 * (`centerRep` adds to both render pos and center, shifting only the scale/rotate pivot.)
 */
export function computeObjectPlacement(
  object: {
    x: number;
    y: number;
    center?: readonly [number, number];
    centerRep?: readonly [number, number];
    positionOffsets?: {x?: readonly number[]; y?: readonly number[]};
  },
  frame?: {x: number; y: number; centerX: number; centerY: number},
): ObjectPlacement {
  const fx = frame?.x ?? 0;
  const fy = frame?.y ?? 0;
  const fcx = frame?.centerX ?? 0;
  const fcy = frame?.centerY ?? 0;
  const ocx = object.center?.[0] ?? 0;
  const ocy = object.center?.[1] ?? 0;
  const rx = object.centerRep?.[0] ?? 0;
  const ry = object.centerRep?.[1] ?? 0;
  const repX = object.positionOffsets?.x?.reduce((sum, v) => sum + v, 0) ?? 0;
  const repY = object.positionOffsets?.y?.reduce((sum, v) => sum + v, 0) ?? 0;
  const originX = fx - fcx - ocx;
  const originY = fy - fcy - ocy;
  return {
    originX,
    originY,
    placedX: object.x + repX + originX,
    placedY: object.y + repY + originY,
    pivotX: fcx + ocx + rx,
    pivotY: fcy + ocy + ry,
  };
}

/**
 * Computes a 20-element SVG `<feColorMatrix type="matrix">` matching Siglus
 * Direct3D pixel color operations: mono -> reverse -> colorRate tint -> bright -> dark -> colorAdd.
 * Returns `undefined` if all color properties are neutral.
 */
export function computeColorMatrix(cp?: ObjectColorProps): string | undefined {
  if (!cp) return undefined;
  const mono = Math.max(0, Math.min(255, cp.mono ?? 0)) / 255;
  const rev = Math.max(0, Math.min(255, cp.reverse ?? 0)) / 255;
  const cRate = Math.max(0, Math.min(255, cp.colorRate ?? 0)) / 255;
  const cR = Math.max(0, Math.min(255, cp.colorR ?? 0)) / 255;
  const cG = Math.max(0, Math.min(255, cp.colorG ?? 0)) / 255;
  const cB = Math.max(0, Math.min(255, cp.colorB ?? 0)) / 255;
  const bright = Math.max(0, Math.min(255, cp.bright ?? 0)) / 255;
  const dark = Math.max(0, Math.min(255, cp.dark ?? 0)) / 255;
  const addR = (cp.addR ?? 0) / 255;
  const addG = (cp.addG ?? 0) / 255;
  const addB = (cp.addB ?? 0) / 255;
  if (!mono && !rev && !cRate && !bright && !dark && !addR && !addG && !addB) return undefined;

  // Start with identity RGB 3x3 + bias 3x1
  let m = [
    [1, 0, 0, 0],
    [0, 1, 0, 0],
    [0, 0, 1, 0],
  ];
  const apply = (fn: (row: number[], ch: number) => number[]) => {
    m = m.map((row, ch) => fn(row, ch));
  };

  // 1. Monochrome (BT.601 luma blend)
  if (mono > 0) {
    const inv = 1 - mono;
    const lum = [0.299 * mono, 0.587 * mono, 0.114 * mono];
    m = [
      [inv + lum[0]!, lum[1]!, lum[2]!, 0],
      [lum[0]!, inv + lum[1]!, lum[2]!, 0],
      [lum[0]!, lum[1]!, inv + lum[2]!, 0],
    ];
  }
  // 2. Reverse: rgb' = (1 - 2*rev)*rgb + rev
  if (rev > 0) {
    const s = 1 - 2 * rev;
    apply((row) => [row[0]! * s, row[1]! * s, row[2]! * s, row[3]! * s + rev]);
  }
  // 3. Color tint blend: rgb' = (1 - cRate)*rgb + cRate*targetColor
  if (cRate > 0) {
    const inv = 1 - cRate;
    const target = [cR, cG, cB];
    apply((row, ch) => [
      row[0]! * inv,
      row[1]! * inv,
      row[2]! * inv,
      row[3]! * inv + cRate * target[ch]!,
    ]);
  }
  // 4. Bright (blend toward white): rgb' = (1 - bright)*rgb + bright
  if (bright > 0) {
    const inv = 1 - bright;
    apply((row) => [row[0]! * inv, row[1]! * inv, row[2]! * inv, row[3]! * inv + bright]);
  }
  // 5. Dark (scale toward black): rgb' = (1 - dark)*rgb
  if (dark > 0) {
    const inv = 1 - dark;
    apply((row) => [row[0]! * inv, row[1]! * inv, row[2]! * inv, row[3]! * inv]);
  }
  // 6. Additive color
  if (addR || addG || addB) {
    const add = [addR, addG, addB];
    apply((row, ch) => [row[0]!, row[1]!, row[2]!, row[3]! + add[ch]!]);
  }
  const fmt = (v: number) => (Math.abs(v) < 1e-5 ? '0' : Number(v.toFixed(4)).toString());
  return [
    `${fmt(m[0]![0]!)} ${fmt(m[0]![1]!)} ${fmt(m[0]![2]!)} 0 ${fmt(m[0]![3]!)}`,
    `${fmt(m[1]![0]!)} ${fmt(m[1]![1]!)} ${fmt(m[1]![2]!)} 0 ${fmt(m[1]![3]!)}`,
    `${fmt(m[2]![0]!)} ${fmt(m[2]![1]!)} ${fmt(m[2]![2]!)} 0 ${fmt(m[2]![3]!)}`,
    '0 0 0 1 0',
  ].join(' ');
}

/**
 * Parses `WAKU.nnn.*` configuration (filter file, waku file, filter config flags, face pos, wait icon).
 */
export function parseWakuConfig(config: ReadonlyMap<string, string>, index: number): WakuConfig {
  const id = String(index).padStart(3, '0');
  const prefix = `WAKU.${id}.`;
  const faceKey = config.has(prefix + 'FACE.000.POS')
    ? prefix + 'FACE.000.POS'
    : 'WAKU.000.FACE.000.POS';
  const [faceX, faceY] = parseNumbers(config, faceKey, [24, 24]) as [number, number];
  const iconNo = Number(config.get(prefix + 'ICON_NO') ?? -1);
  const iconPos = parseNumbers(config, prefix + 'ICON_POS', [0, 0, 0]) as [number, number, number];
  return {
    index,
    filterFile: parseQuoted(config, prefix + 'FILTER_FILE'),
    wakuFile: parseQuoted(config, prefix + 'WAKU_FILE'),
    filterConfigColor: Number(config.get(prefix + 'FILTER_CONFIG_COLOR') ?? 1) !== 0,
    filterConfigTr: Number(config.get(prefix + 'FILTER_CONFIG_TR') ?? 1) !== 0,
    facePos: [faceX, faceY],
    iconNo: Number.isFinite(iconNo) ? iconNo | 0 : -1,
    iconPos,
  };
}

/**
 * Parses `ICON.nnn.{FILE,SPEED,CNT}` for message-window wait icons.
 */
export function parseIconConfig(config: ReadonlyMap<string, string>, index: number): IconConfig {
  const prefix = `ICON.${String(Math.max(0, index)).padStart(3, '0')}.`;
  const speed = Number(config.get(prefix + 'SPEED') ?? 120);
  const count = Number(config.get(prefix + 'CNT') ?? 1);
  return {
    index,
    file: parseQuoted(config, prefix + 'FILE'),
    speed: Number.isFinite(speed) && speed > 0 ? speed : 120,
    count: Number.isFinite(count) && count > 0 ? count | 0 : 1,
  };
}

/**
 * Returns every unique `WAKU.nnn` index configured in Gameexe.
 */
export function listConfiguredWakuIndices(config: ReadonlyMap<string, string>): number[] {
  const indices = new Set<number>();
  for (const key of config.keys()) {
    const match = /^WAKU\.(\d+)\./.exec(key);
    if (match) indices.add(Number(match[1]));
  }
  return [...indices].sort((a, b) => a - b);
}

/**
 * Parses `BUTTON.ACTION.nnn.{NORMAL,HIT,PUSH,DISABLE}` template states.
 * Falls back to legacy sequential cuts (0, 1, 2, 3) when no template is defined.
 */
export function parseButtonActionStates(
  config: ReadonlyMap<string, string>,
  actionIndex?: number,
): ButtonActionSet {
  const parseState = (
    suffix: string,
    defaultCut: number,
    hasTemplate: boolean,
  ): ButtonActionState => {
    const key =
      actionIndex !== undefined && actionIndex >= 0
        ? `BUTTON.ACTION.${String(actionIndex).padStart(3, '0')}.${suffix}`
        : '';
    if (!hasTemplate || !key || !config.has(key)) {
      return {cutOffset: defaultCut, dx: 0, dy: 0, alpha: 255, bright: 0, dark: 0};
    }
    const [cutOffset, dx, dy, alpha, bright, dark] = parseNumbers(config, key, [
      defaultCut,
      0,
      0,
      255,
      0,
      0,
    ]);
    return {
      cutOffset: cutOffset! | 0,
      dx: dx! | 0,
      dy: dy! | 0,
      alpha: Math.max(0, Math.min(255, alpha! | 0)),
      bright: Math.max(0, Math.min(255, bright! | 0)),
      dark: Math.max(0, Math.min(255, dark! | 0)),
    };
  };
  const hasTemplate =
    actionIndex !== undefined &&
    actionIndex >= 0 &&
    config.has(`BUTTON.ACTION.${String(actionIndex).padStart(3, '0')}.NORMAL`);
  const normal = parseState('NORMAL', 0, hasTemplate);
  const selectKey =
    actionIndex !== undefined && actionIndex >= 0
      ? `BUTTON.ACTION.${String(actionIndex).padStart(3, '0')}.SELECT`
      : '';
  const select =
    hasTemplate && selectKey && config.has(selectKey)
      ? parseState('SELECT', 0, true)
      : {...normal};
  return {
    normal,
    hit: parseState('HIT', 1, hasTemplate),
    push: parseState('PUSH', 2, hasTemplate),
    disable: parseState('DISABLE', 3, hasTemplate),
    select,
  };
}

/**
 * Resolves `BUTTON.SE.nnn.{HIT,PUSH,DECIDE}` sound-effect indices into `SE.mmm` slots.
 * Returns `-1` for silent events. If the config defines no `BUTTON.SE.*` table at all
 * (minimal legacy fixture), falls back to treating `seIndex` directly as the decide SE.
 */
export function parseButtonSe(
  config: ReadonlyMap<string, string>,
  seIndex?: number,
): ButtonSeSet {
  if (seIndex === undefined || !Number.isFinite(seIndex) || seIndex < 0) {
    return {hit: -1, push: -1, decide: -1};
  }
  const index = seIndex | 0;
  const prefix = `BUTTON.SE.${String(index).padStart(3, '0')}.`;
  const hasEntry =
    config.has(prefix + 'HIT') || config.has(prefix + 'PUSH') || config.has(prefix + 'DECIDE');
  const hasTable = hasEntry || config.has('BUTTON.SE.CNT');
  if (!hasTable) {
    let anyButtonSe = false;
    for (const key of config.keys()) {
      if (key.startsWith('BUTTON.SE.')) {
        anyButtonSe = true;
        break;
      }
    }
    if (!anyButtonSe) return {hit: -1, push: -1, decide: index};
  }
  const read = (suffix: string): number => {
    const raw = config.get(prefix + suffix);
    if (raw === undefined) return -1;
    const n = Number(raw.trim());
    return Number.isFinite(n) ? n | 0 : -1;
  };
  return {
    hit: read('HIT'),
    push: read('PUSH'),
    decide: read('DECIDE'),
  };
}

/**
 * Returns the set of stage object slot indices configured with `OBJECT.<n>.SPACE_HIDE = 1`,
 * which hide alongside the message window when the user toggles window visibility.
 */
export function parseSpaceHideObjectIds(config: ReadonlyMap<string, string>): ReadonlySet<number> {
  const ids = new Set<number>();
  for (const [key, value] of config) {
    const match = /^OBJECT\.(\d+)\.SPACE_HIDE$/.exec(key);
    if (match && Number(value.trim()) !== 0) {
      ids.add(Number(match[1]));
    }
  }
  return ids;
}

/**
 * Returns the set of stage object slot indices configured with `OBJECT.<n>.SAVE = 0`,
 * which are transient overlays excluded from save snapshots.
 */
export function parseNoSaveObjectIds(config: ReadonlyMap<string, string>): ReadonlySet<number> {
  const ids = new Set<number>();
  for (const [key, value] of config) {
    const match = /^OBJECT\.(\d+)\.SAVE$/.exec(key);
    if (match && Number(value.trim()) === 0) {
      ids.add(Number(match[1]));
    }
  }
  return ids;
}

/**
 * Resolves `MWND.MOJI_COLOR`, `MWND.SHADOW_COLOR`, and `MWND.FUCHI_COLOR` palette indices
 * (with optional per-window `MWND.nnn.*` overrides). Returns `-1` when unset.
 */
export function parseMwndColors(
  config: ReadonlyMap<string, string>,
  mwndIndex: number,
): MwndColors {
  const prefix = `MWND.${String(Math.max(0, mwndIndex)).padStart(3, '0')}.`;
  const read = (suffix: string): number => {
    const raw = config.get(prefix + suffix) ?? config.get('MWND.' + suffix);
    if (raw === undefined) return -1;
    const n = Number(raw.trim());
    return Number.isFinite(n) ? n | 0 : -1;
  };
  return {
    mojiColor: read('MOJI_COLOR'),
    shadowColor: read('SHADOW_COLOR'),
    fuchiColor: read('FUCHI_COLOR'),
  };
}

/**
 * Resolves `MWND.nnn.{OPEN,CLOSE}_ANIME_{TYPE,TIME}` with optional runtime script overrides.
 */
export function parseMwndAnimation(
  config: ReadonlyMap<string, string>,
  mwndIndex: number,
  kind: 'open' | 'close',
  override?: {type?: number; time?: number},
): MwndAnimation {
  const prefix = `MWND.${String(Math.max(0, mwndIndex)).padStart(3, '0')}.${kind === 'open' ? 'OPEN' : 'CLOSE'}_ANIME_`;
  const configType = Number(config.get(prefix + 'TYPE') ?? 0);
  const configTime = Number(config.get(prefix + 'TIME') ?? 0);
  const type = override?.type ?? (Number.isFinite(configType) ? configType : 0);
  const time = override?.time ?? (Number.isFinite(configTime) ? configTime : 0);
  return {
    type: Math.max(0, type | 0),
    time: Math.max(0, time | 0),
  };
}
