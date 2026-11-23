import type {Argument} from './vm.js';

export interface SelbtnItem {
  readonly index: number;
  readonly text: string;
  readonly dispFlag: number;
  readonly colorMode: number;
}

export interface SelbtnCall {
  readonly templateNo: number;
  readonly items: readonly SelbtnItem[];
  readonly syncType?: number;
}

export interface SelbtnTemplate {
  readonly baseFile: string;
  readonly backFile: string;
  readonly baseX: number;
  readonly baseY: number;
  readonly repX: number;
  readonly repY: number;
  readonly maxYCount: number;
  readonly xRep: number;
  readonly alignX: number;
  readonly alignY: number;
  readonly fontSize: number;
  readonly textX: number;
  readonly textY: number;
  readonly textAlignX: number;
  readonly textAlignY: number;
  readonly textColor: number;
  readonly textHitColor: number;
  readonly btnAction: number;
  readonly openAnime: readonly [type: number, time: number];
  readonly closeAnime: readonly [type: number, time: number];
  readonly decideAnime: readonly [type: number, time: number];
}

export interface SelbtnPlacement {
  readonly item: SelbtnItem;
  readonly x: number;
  readonly y: number;
}

export function selbtnPresentation(dispFlag: number): 'enabled' | 'disabled' | 'hidden' {
  // 1.1.102.1 draws flags 1 and 2 (0x58b520) and only hit-tests flag 1 (0x5882db).
  return dispFlag === 1 ? 'enabled' : dispFlag === 2 ? 'disabled' : 'hidden';
}

/**
 * Native 0x54da44..0x54db18 global.selbtn / selbtn_cancel argument parser.
 * Accepts optional leading int template index, then repeats of (str[, int disp=1[, int color=-1]]).
 */
export function parseSelbtnArgs(args: readonly Argument[], named: readonly number[]): SelbtnCall {
  const positionalCount = args.length - named.length;
  let templateNo = 0;
  let pos = 0;
  if (positionalCount > 0 && typeof args[0] === 'number') {
    templateNo = Number(args[0]);
    pos = 1;
  }
  const items: SelbtnItem[] = [];
  while (pos < positionalCount) {
    const entry = args[pos++];
    if (typeof entry !== 'string') continue;
    let dispFlag = 1;
    let colorMode = -1;
    if (pos < positionalCount && typeof args[pos] === 'number') {
      dispFlag = Number(args[pos++]);
      if (pos < positionalCount && typeof args[pos] === 'number') {
        colorMode = Number(args[pos++]);
      }
    }
    items.push({index: items.length, text: entry, dispFlag, colorMode});
  }
  let syncType: number | undefined;
  for (let i = 0; i < named.length; i++) {
    const id = named[i]!;
    const value = args[positionalCount + i];
    if (id === 1 && typeof value === 'number') syncType = value;
    else if (id === 3 && typeof value === 'number') templateNo = value;
  }
  return {templateNo, items, syncType};
}

export function readSelbtnTemplate(config: ReadonlyMap<string, string>, templateNo: number): SelbtnTemplate {
  const prefix = `SELBTN.${String(Math.max(0, templateNo)).padStart(3, '0')}.`;
  const pair = (key: string, fallback: [number, number]): [number, number] => {
    const parts = config.get(prefix + key)?.split(',').map((v) => Number(v.trim()));
    return [
      Number.isFinite(parts?.[0]) ? parts![0]! : fallback[0],
      Number.isFinite(parts?.[1]) ? parts![1]! : fallback[1],
    ];
  };
  const baseFile = config.get(prefix + 'BASE_FILE')?.split('"')[1] ?? '';
  const backFile = config.get(prefix + 'BACK_FILE')?.split('"')[1] ?? '';
  const [baseX, baseY] = pair('BASE_POS', [960, 540]);
  const [repX, repY] = pair('REP_POS', [0, 108]);
  const [alignX, alignY] = pair('ALIGN', [1, 1]);
  const [textX, textY] = pair('MOJI_POS', [0, 50]);
  const [textAlignX, textAlignY] = pair('MOJI_ALIGN', [1, 1]);
  const fontSize = Number(config.get(prefix + 'MOJI_SIZE')?.split(',')[0]?.trim() ?? 36) || 36;
  const maxYCount = Number(config.get(prefix + 'MAX_Y_CNT') ?? 0) || 0;
  const xRep = Number(config.get(prefix + 'X_REP') ?? 0) || 0;
  const textColorRaw = config.get(prefix + 'MOJI_COLOR');
  const textHitColorRaw = config.get(prefix + 'MOJI_HIT_COLOR');
  const btnActionRaw = config.get(prefix + 'BTN_ACTION');
  const textColor = textColorRaw !== undefined && Number.isFinite(Number(textColorRaw)) ? Number(textColorRaw) | 0 : -1;
  const textHitColor =
    textHitColorRaw !== undefined && Number.isFinite(Number(textHitColorRaw))
      ? Number(textHitColorRaw) | 0
      : -1;
  const btnAction =
    btnActionRaw !== undefined && Number.isFinite(Number(btnActionRaw)) ? Number(btnActionRaw) | 0 : 1;
  const openAnime = pair('OPEN_ANIME', [0, 0]);
  const closeAnime = pair('CLOSE_ANIME', [0, 0]);
  const decideAnime = pair('DECIDE_ANIME', [0, 0]);
  return {
    baseFile,
    backFile,
    baseX,
    baseY,
    repX,
    repY,
    maxYCount,
    xRep,
    alignX,
    alignY,
    fontSize,
    textX,
    textY,
    textAlignX,
    textAlignY,
    textColor,
    textHitColor,
    btnAction,
    openAnime: [Math.max(0, openAnime[0] | 0), Math.max(0, openAnime[1] | 0)],
    closeAnime: [Math.max(0, closeAnime[0] | 0), Math.max(0, closeAnime[1] | 0)],
    decideAnime: [Math.max(0, decideAnime[0] | 0), Math.max(0, decideAnime[1] | 0)],
  };
}

/**
 * Native 0x5b0d60 C_elm_selbtn::set_pos exact layout calculation:
 * Nonzero flags reserve a position, including hidden spacers. Wraps at maxYCount > 0;
 * aligns total bounding box by alignX/alignY (0=left/top, 1=-trunc(total/2), 2=-total).
 */
export function layoutSelbtnItems(
  items: readonly SelbtnItem[],
  template: SelbtnTemplate,
  itemWidth: number,
  itemHeight: number,
): SelbtnPlacement[] {
  const positioned = items.filter((item) => item.dispFlag !== 0);
  if (!positioned.length) return [];
  const raw: {item: SelbtnItem; x: number; y: number}[] = [];
  let colBaseX = 0;
  let x = 0;
  let y = 0;
  let rowInCol = 0;
  let maxX = 0;
  let maxY = 0;
  for (const item of positioned) {
    raw.push({item, x, y});
    x += template.repX;
    y += template.repY;
    if (x > maxX) maxX = x;
    if (y > maxY) maxY = y;
    rowInCol++;
    if (template.maxYCount > 0 && rowInCol >= template.maxYCount) {
      rowInCol = 0;
      colBaseX += template.xRep;
      x = colBaseX;
      y = 0;
    }
  }
  const totalWidth = itemWidth - template.repX + maxX;
  const totalHeight = itemHeight - template.repY + maxY;
  const offsetX =
    template.alignX === 1
      ? -Math.trunc(totalWidth / 2)
      : template.alignX === 2
        ? -totalWidth
        : 0;
  const offsetY =
    template.alignY === 1
      ? -Math.trunc(totalHeight / 2)
      : template.alignY === 2
        ? -totalHeight
        : 0;
  return raw.map(({item, x: px, y: py}) => ({
    item,
    x: template.baseX + offsetX + px,
    y: template.baseY + offsetY + py,
  }));
}
