import type {YurisScript, YurisToken} from '../../../formats/yuris/ybn.js';
import {windowsPath} from './fileact.js';
import type {YurisMachine} from './machine.js';

// A brief hold keeps speculative worker jobs off the rapid-advance path.
const READING_PAUSE_MS = 60;

const linear = new Set([
  'S',
  'ML.S',
  'S.D',
  'S.CLXYZ',
  'S.XYZ',
  'S.ANLP',
  'S.BL',
  'S.TIP',
  'S.MV',
  'T',
  'T.NOP',
  'T.D',
  'T.XYZ',
  'FACE',
  'BG',
  'ML.BG',
  'BG.CMXYZ',
  'EV',
  'ML.CG.SET',
  'BGM',
  'FIN',
  'FOUT',
  'FLASH',
  'QUAKE',
  'C.XYZ',
]);

/** One `size >= low && size < high` band of es.SP.CHK.SPLZ and the scale folder it selects. */
interface ScaleBand {
  readonly low: number;
  readonly high: number;
  readonly scale: number;
}

/** Uses the scenario library's own CGCASH forecast (YSTB62:185–208) as read-only hints. */
export class YurisSceneLookahead {
  private file = '';
  private forecastKey = '';
  private line = -1;
  private source?: string[] | null;
  private language = -1;
  private standScale = '';
  private waitingSince?: number;
  /** The VO cues of the lines up to the next dialogue, as of the last forecast. */
  nextVoices: readonly string[] = [];
  /** The YMV files S.MV opens in the lines up to the next dialogue, as of the last forecast. */
  nextMovies: readonly string[] = [];

  observeImage(path: string): void {
    const scale = /^cg\\stand\\(m_[0-9]+)\\/.exec(path)?.[1];
    if (scale) this.standScale = scale;
  }

  private constructor(
    private readonly machine: YurisMachine,
    private readonly transitionTable: boolean,
    private readonly scaleBands: readonly ScaleBand[],
  ) {}

  static async create(m: YurisMachine): Promise<YurisSceneLookahead | undefined> {
    const label = (name: string) =>
      m.project.labels.labels[m.label(new TextEncoder().encode(name))];
    const parser = label('es.SCENARIO.PARSER');
    const cash = label('es.CASH.ADD.MAIN');
    const transition = label('es.TRDEF');
    if (!parser || !cash) return;
    const parserCode = await m.project.script(parser.script);
    const cashCode = await m.project.script(cash.script);
    const has = (script: typeof parserCode, position: number, variable: number) =>
      script.instructions[position]?.args.some((a) =>
        a.tokens?.some(
          (t) =>
            [72, 86].includes(t.op) &&
            t.payload[1] === (variable & 255) &&
            t.payload[2] === variable >>> 8,
        ),
      );
    if (
      has(parserCode, parser.position + 4, 1157) &&
      has(parserCode, parser.position + 20, 3039) &&
      has(parserCode, parser.position + 30, 2899) &&
      has(cashCode, cash.position + 2, 2930) &&
      has(cashCode, cash.position + 3, 2931) &&
      has(cashCode, cash.position + 4, 2932)
    ) {
      const trCode = transition ? await m.project.script(transition.script) : undefined;
      // es.SP.CHK.SPLZ (YSTB174:2) loops over slots 0..H@5354; visible stand slots
      // (V@5236 = 5, V@5247 = 0, V@5273 > 224, V@5329 > 0) whose draw size V@5318 falls in
      // another band set V@5329 to that band's scale and call es.SP.RELOAD.
      const splz = label('es.SP.CHK.SPLZ');
      const splzCode = splz ? await m.project.script(splz.script) : undefined;
      const bands =
        splz &&
        splzCode &&
        has(splzCode, splz.position + 3, 5354) &&
        [5236, 5247, 5273, 5329].every((id) => has(splzCode, splz.position + 5, id)) &&
        has(splzCode, splz.position + 6, 5318)
          ? scaleBands(splzCode, splz.position)
          : [];
      return new YurisSceneLookahead(
        m,
        !!transition &&
          !!trCode &&
          !!has(trCode, transition.position + 3, 2502) &&
          !!has(trCode, transition.position + 6, 2503),
        bands,
      );
    }
  }

  /**
   * Stand images worth decoding in parallel when the VM reads `path`, the first stand image of
   * a pass at its scale folder: the slots es.SP.CHK.SPLZ moves to another folder in this pass,
   * which it reloads one after another, and the T/FACE sprites of the scenario lines the
   * parser runs before the next dialogue, at the folder just read.
   */
  standForecast(path: string): string[] {
    const scale = /^cg[\\/]stand[\\/](m_[0-9]+)[\\/]/i.exec(path)?.[1]?.toLowerCase();
    if (!scale) return [];
    const key = `${this.machine.system.passes}:${scale}`;
    if (key === this.forecastKey) return [];
    this.forecastKey = key;
    const vars = this.machine.variables.entries;
    const names = new Set<string>();
    const kind = vars[5236]?.ints,
      hidden = vars[5247]?.ints,
      alpha = vars[5273]?.ints,
      current = vars[5329]?.ints,
      size = vars[5318]?.floats,
      sprite = vars[5240]?.strings;
    if (this.scaleBands.length && kind && hidden && alpha && current && size && sprite) {
      const last = Number(vars[5354]?.ints?.[0] ?? -1n);
      for (let slot = 0; slot <= last && slot < kind.length; slot++) {
        if (kind[slot] !== 5n || hidden[slot] !== 0n || !(alpha[slot]! > 224n)) continue;
        const folder = current[slot] ?? 0n,
          drawn = size[slot] ?? 0;
        if (folder <= 0n || !(drawn > 0)) continue;
        const band = this.scaleBands.find((b) => drawn >= b.low && drawn < b.high);
        if (band && BigInt(band.scale) !== folder)
          addSprite(names, 'cg/stand/m_' + String(band.scale).padStart(3, '0'), sprite[slot] ?? '');
      }
    }
    const source = vars[2899]?.strings,
      line = Number(vars[3040]?.ints?.[0] ?? -1n);
    if (source && line >= 0)
      scan: for (let next = line; next <= line + 64 && next < source.length; next++) {
        const tags = macros(source[next] ?? '');
        if (!tags) break;
        for (const [tag, args] of tags) {
          if (tag === 'ML.TEXT') break scan;
          if (!linear.has(tag) && !/^(?:VO|SE)[0-9]*$/.test(tag)) break scan;
          if (tag !== 'T' && tag !== 'FACE') continue;
          const first = args
            .split(',')[0]!
            .trim()
            .replace(/^"(.*)"$/, '$1');
          addSprite(names, tag === 'FACE' ? 'cg/face' : 'cg/stand/' + scale, first);
        }
      }
    return [...names];
  }

  /** The VO cues of the line the scenario parser is executing (H@3040). */
  currentVoices(): string[] {
    const vars = this.machine.variables.entries;
    const source = vars[2899]?.strings,
      line = Number(vars[3040]?.ints?.[0] ?? -1n);
    return source && line >= 0 ? voices(macros(source[line] ?? '') ?? []) : [];
  }

  /** Undefined means that the previous priority window still applies. */
  update(): readonly string[] | undefined {
    const vars = this.machine.variables.entries;
    if (vars[1221]?.ints?.[0]) {
      this.waitingSince = undefined;
      if (this.line === -1) return;
      this.line = -1;
      return [];
    }
    if (vars[1157]?.ints?.[0] !== 1n) {
      this.waitingSince = undefined;
      return;
    }
    const now = this.machine.now();
    this.waitingSince ??= now;
    if (now - this.waitingSince < READING_PAUSE_MS) return;
    const file = vars[3038]?.strings?.[0] ?? '',
      cursor = Number(vars[3039]?.ints?.[0] ?? -1n),
      line = Number(vars[3040]?.ints?.[0] ?? -1n),
      source = vars[2899]?.strings,
      lang = vars[1176],
      language = Number(lang?.ints?.[255 * (lang.dimensions[1] ?? 0)] ?? -1n);
    if (
      file === this.file &&
      line === this.line &&
      source === this.source &&
      language === this.language
    )
      return;
    this.file = file;
    this.line = line;
    this.source = source;
    this.language = language;
    this.nextVoices = [];
    this.nextMovies = [];
    // The parser records the lexed line in H@3040 before H@3039
    // advances to the next line (YSTB61:118, 140).
    if (!source || !file || line < 0 || (cursor !== line && cursor !== line + 1)) return [];

    // A macro after the current dialogue could execute when it is dismissed.
    // Leave this case, choices, jumps and unknown commands to the normal loader.
    const current = macros(source[line] ?? '');
    if (
      !current ||
      current.at(-1)?.[0] !== 'ML.TEXT' ||
      current.slice(0, -1).some(([tag]) => tag === 'ML.TEXT')
    )
      return [];
    const assets = new Set<string>();
    const cues: string[] = [];
    const movies: string[] = [];
    let standScale = this.standScale;
    for (let next = line + 1; next <= line + 64 && next < source.length; next++) {
      const tags = macros(source[next] ?? '');
      if (!tags) return [];
      cues.push(...voices(tags));
      for (const [tag, args] of tags) {
        if (tag === 'ML.TEXT') {
          if (tags.at(-1)?.[0] !== 'ML.TEXT') return [];
          this.nextVoices = cues;
          this.nextMovies = movies;
          const count = Number(vars[2930]?.ints?.[0] ?? 0n);
          const lines = vars[2931]?.ints,
            paths = vars[2932]?.strings;
          if (lines && paths) {
            // es.CASH.ADD stores 1-based source lines, sorted by its parser.
            let lo = 0,
              hi = Math.min(Math.max(0, count), lines.length, paths.length);
            while (lo < hi) {
              const mid = (lo + hi) >>> 1;
              if (lines[mid]! <= BigInt(line + 1)) lo = mid + 1;
              else hi = mid;
            }
            for (let i = lo; i < count && i < paths.length && lines[i]! <= BigInt(next + 1); i++) {
              const path = paths[i];
              // The authored distant list includes two default sprite scales.
              // The near pass already uses the observed scale where it can.
              if (path && !(standScale && /^cg\/stand\//i.test(path))) assets.add(path);
            }
          }
          return [...assets].slice(0, 20);
        }
        if (!linear.has(tag) && !/^(?:VO|SE)[0-9]*$/.test(tag)) return [];
        const [first, second, , fourth] = args
          .split(',')
          .map((arg) => arg.trim().replace(/^"(.*)"$/, '$1'));
        const rule =
          tag === 'FIN' || tag === 'FOUT'
            ? second
            : tag === 'BG' || tag === 'ML.BG'
              ? fourth
              : undefined;
        if (this.transitionTable && rule && /^[A-Za-z0-9_-]+$/.test(rule)) {
          const index = vars[2502]?.strings?.indexOf(rule) ?? -1;
          const ruleName = index >= 0 ? vars[2503]?.strings?.[index] : rule;
          const folders = vars[1174];
          const folder = folders?.strings?.[38 * (folders.dimensions[1] ?? 0) + 4];
          if (folder && ruleName) assets.add(folder + ruleName);
        }
        // es.L.YMV.INIT (YSTB172:1792) opens V$5491[6] + the sprite name + ".ymv".
        const movieFolder = vars[5491]?.strings?.[6];
        if (tag === 'S.MV' && movieFolder && second && !/["',()\\]/.test(second))
          movies.push(windowsPath(movieFolder + second + '.ymv'));
        if (tag === 'C.XYZ') standScale = '';
        if (tag === 'T' || tag === 'FACE') {
          // The foreground sprite's last observed resolution is a hint for a stable camera.
          const root = tag === 'FACE' ? 'cg/face' : standScale ? 'cg/stand/' + standScale : '';
          if (root && first) addSprite(assets, root, first);
        }
        // Standard multilingual variants (es.ScenarioMacro.ML.S / ML.BG).
        const name = tag === 'ML.S' ? second : tag === 'ML.BG' ? first : undefined;
        if (name && /^[A-Za-z0-9_/-]+$/.test(name) && (language === 0 || language === 1))
          assets.add((tag === 'ML.S' ? 'cg/' : 'cg/bg/') + name + (language === 0 ? '_c' : ''));
      }
    }
    return [];
  }
}

/** The cue (first argument) of each VO tag, when it is a plain name. */
function voices(tags: readonly [string, string][]): string[] {
  const cues: string[] = [];
  for (const [tag, args] of tags) {
    if (!/^VO[0-9]*$/.test(tag)) continue;
    const cue = args
      .split(',')[0]!
      .trim()
      .replace(/^"(.*)"$/, '$1');
    if (/^[A-Za-z0-9_]{4,}$/.test(cue)) cues.push(cue);
  }
  return cues;
}

function macros(line: string): [string, string][] | undefined {
  // A DBCS trail byte may be a slash, backslash, quote or parenthesis.
  const syntax = line.trimEnd().replace(/[\x81-\xfe][\s\S]/g, '\0\0');
  const token = /[ \t]*\\([A-Z][A-Z0-9_.]*)(?:\(((?:"[^"]*"|'[^']*'|[^"'()])*)\))?/dy;
  const tags: [string, string][] = [];
  let i = 0;
  while (i < syntax.length) {
    if (/^[ \t]*\/\//.test(syntax.slice(i))) break;
    token.lastIndex = i;
    const match = token.exec(syntax);
    if (!match) return;
    const part = match.indices![2];
    tags.push([match[1]!, part ? line.slice(part[0], part[1]) : '']);
    i = token.lastIndex;
  }
  return tags;
}

/** es.CASH.ADD's character/pose prefix lengths: the pose's base image and the named part. */
function addSprite(names: Set<string>, root: string, name: string): void {
  if (!/^[A-Za-z0-9_]{9,}$/.test(name)) return;
  const prefix = root + '/' + name.slice(0, 5) + '/' + name.slice(0, 8) + '/';
  names.add(prefix + name.slice(0, 8) + '0100');
  names.add(prefix + name);
}

function literalNumber(token: YurisToken | undefined): number | undefined {
  if (!token) return;
  const p = token.payload,
    v = new DataView(p.buffer, p.byteOffset, p.byteLength);
  if (token.op === 0x42 && p.length === 1) return v.getInt8(0);
  if (token.op === 0x57 && p.length === 2) return v.getInt16(0, true);
  if (token.op === 0x49 && p.length === 4) return v.getInt32(0, true);
  if (token.op === 0x4c && p.length === 8) return Number(v.getBigInt64(0, true));
}

/**
 * The bands of es.SP.CHK.SPLZ: `IF size low Z size high < &`, then `IF V@5329[slot] != scale`
 * and `LET V@5329[slot] = scale` (YSTB174:10–39).
 */
function scaleBands(script: YurisScript, from: number): ScaleBand[] {
  const bands: ScaleBand[] = [];
  const same = (a: YurisToken, b: YurisToken) =>
    a.op === 0x48 && b.op === 0x48 && a.payload.every((byte, i) => byte === b.payload[i]);
  for (let p = from; p + 2 < script.instructions.length && p < from + 64; p++) {
    const t = script.instructions[p]!.args[0]?.tokens;
    if (t?.length !== 7 || !same(t[0]!, t[3]!) || t[2]!.op !== 0x5a) continue;
    if (t[5]!.op !== 0x3c || t[6]!.op !== 0x26) continue;
    const [target, value] = script.instructions[p + 2]!.args;
    const head = target?.tokens?.[0];
    if (head?.op !== 0x56 || (head.payload[1]! | (head.payload[2]! << 8)) !== 5329) continue;
    const low = literalNumber(t[1]),
      high = literalNumber(t[4]),
      scale = value?.tokens?.length === 1 ? literalNumber(value.tokens[0]) : undefined;
    if (low !== undefined && high !== undefined && scale !== undefined)
      bands.push({low, high, scale});
  }
  return bands;
}
