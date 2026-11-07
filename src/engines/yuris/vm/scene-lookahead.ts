import type {YurisInstruction, YurisScript, YurisToken} from '../../../formats/yuris/ybn.js';
import {decodeLiteral} from './expression.js';
import {windowsPath} from './fileact.js';
import type {YurisMachine} from './machine.js';

// A brief hold keeps speculative worker jobs off the rapid-advance path.
const READING_PAUSE_MS = 60;

/** Macros known not to change the scenario flow, used until the macro analysis finishes. */
const LINEAR_MACROS = new Set([
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

/**
 * The scenario library variables the lookahead reads. Library revisions number them
 * differently, so `create` locates each one in the routine that uses it; the defaults are the
 * numbering of the revision whose YSTB addresses the comments cite.
 */
export interface LookaheadVariables {
  /** es.SCENARIO.PARSER+4 `IF H@waiting` (registered as @es.TX.CWAIT). */
  readonly waiting: number;
  /** es.SCENARIO.PARSER+16 `IF H@stopped`. */
  readonly stopped: number;
  /** es.SCENARIO.PARSER+20 `LET H@line = H@cursor`. */
  readonly line: number;
  readonly cursor: number;
  /** es.SCENARIO.PARSER+30 `GOSUB es.SCENARIO.L… PSTR=V$source[H@cursor]`. */
  readonly source: number;
  /** The parser's `DEBUGLIST ADD=H$file STR="$filename"`. */
  readonly file: number;
  /** es.CASH.ADD.MAIN+2..4: `IF H@count 8192 <`, `LET V@lines[count]`, `LET V$paths[count]`. */
  readonly cashCount: number;
  readonly cashLines: number;
  readonly cashPaths: number;
  /** es.TRDEF+3 and +6: the transition names and the rule images they map to. */
  readonly rules: number;
  readonly ruleImages: number;
  /** es.SP.CHK.SPLZ+3 `LOOP H@slots 1 +` and the slot arrays of its +5 and +6 tests. */
  readonly slots: number;
  readonly kind: number;
  readonly hidden: number;
  readonly alpha: number;
  readonly folder: number;
  readonly size: number;
  /** es.SP.RELOAD's sprite name array, indexed by slot. */
  readonly sprite: number;
  /** es.L.YMV.INIT's folder array, read at index 6. */
  readonly movieFolder: number;
}

const DEFAULT_VARIABLES: LookaheadVariables = {
  waiting: 1157,
  stopped: 1221,
  line: 3040,
  cursor: 3039,
  source: 2899,
  file: 3038,
  cashCount: 2930,
  cashLines: 2931,
  cashPaths: 2932,
  rules: 2502,
  ruleImages: 2503,
  slots: 5354,
  kind: 5236,
  hidden: 5247,
  alpha: 5273,
  folder: 5329,
  size: 5318,
  sprite: 5240,
  movieFolder: 5491,
};

/** An `ML.TEXT` macro or a TEXT token: the parser shows a dialogue and waits for a click. */
const dialogue = (tag: string | undefined) => tag === 'ML.TEXT' || tag === 'TEXT';

const latin1 = (text: string) => Uint8Array.from(text, (c) => c.charCodeAt(0));

/**
 * The scenario macros (es.ScenarioMacro.NAME) that run in line. A macro changes the flow when
 * the routines it calls with a constant label reach a write of the parser cursor H@cursor
 * (es.Scenario.JumpLabel → es.SCENARIO.com_no.pos.SET) or the choice routines ES.SEL and
 * ES.SEL.GO, whose buttons jump later. Computed targets (task and button dispatch) are not
 * followed. A routine extends to the next label of its script.
 */
async function linearMacros(m: YurisMachine, cursor: number): Promise<Set<string>> {
  const labels = m.project.labels.labels;
  const starts = new Map<number, number[]>();
  for (const l of labels) {
    let list = starts.get(l.script);
    if (!list) starts.set(l.script, (list = []));
    list.push(l.position);
  }
  for (const list of starts.values()) list.sort((a, b) => a - b);
  const choice = new Set(['ES.SEL', 'ES.SEL.GO'].map((name) => m.label(latin1(name))));
  const memo = new Map<number, boolean>();
  const active = new Set<number>();
  const changesFlow = async (index: number): Promise<boolean> => {
    const known = memo.get(index);
    if (known !== undefined) return known;
    if (choice.has(index)) return true;
    if (active.has(index)) return false;
    active.add(index);
    const label = labels[index]!;
    let result = false;
    try {
      const code = (await m.project.script(label.script)).instructions;
      const end = starts.get(label.script)!.find((p) => p > label.position) ?? code.length;
      for (let p = label.position; p < end && !result; p++) {
        const ins = code[p]!;
        const name = m.project.commands.commands[ins.command]?.name;
        const target = ins.args[0]?.tokens;
        if ((name === 'LET' || name === 'INT') && target?.[0]?.op === 0x48)
          result = variablesOf(ins)[0] === cursor;
        else if (name === 'GOSUB' && target?.length === 1 && target[0]!.op === 0x4d) {
          const callee = m.label(
            latin1(decodeLiteral(target[0]!.payload, 0, target[0]!.payload.length)),
          );
          if (callee >= 0) result = await changesFlow(callee);
        }
      }
    } catch {
      // A script that does not load is left to the normal loader.
      result = true;
    }
    active.delete(index);
    memo.set(index, result);
    return result;
  };
  const prefix = 'es.ScenarioMacro.';
  const names = new Set<string>();
  for (const [index, label] of labels.entries()) {
    const name = String.fromCharCode(...label.name);
    if (name.startsWith(prefix) && !(await changesFlow(index)))
      names.add(name.slice(prefix.length));
  }
  return names;
}

/** The H@/V@ variables an instruction names, in argument and token order; `op` keeps one kind. */
function variablesOf(instruction: YurisInstruction | undefined, op?: number): number[] {
  const ids: number[] = [];
  for (const arg of instruction?.args ?? [])
    for (const t of arg.tokens ?? [])
      if (
        (op === undefined ? t.op === 0x48 || t.op === 0x56 : t.op === op) &&
        t.payload.length >= 3
      )
        ids.push(t.payload[1]! | (t.payload[2]! << 8));
  return ids;
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
  /** The library's in-line macros, once `linearMacros` has read them. */
  private linearNames?: Set<string>;
  /** Settles when the macro analysis has finished. */
  macrosRead: Promise<void> = Promise.resolve();

  private linear(tag: string): boolean {
    return this.linearNames
      ? this.linearNames.has(tag)
      : LINEAR_MACROS.has(tag) || /^(?:VO|SE)[0-9]*$/.test(tag);
  }

  observeImage(path: string): void {
    const scale = /^cg\\stand\\(m_[0-9]+)\\/.exec(path)?.[1];
    if (scale) this.standScale = scale;
  }

  private constructor(
    private readonly machine: YurisMachine,
    private readonly transitionTable: boolean,
    private readonly scaleBands: readonly ScaleBand[],
    private readonly v: LookaheadVariables = DEFAULT_VARIABLES,
  ) {}

  static async create(m: YurisMachine): Promise<YurisSceneLookahead | undefined> {
    const label = (name: string) =>
      m.project.labels.labels[m.label(new TextEncoder().encode(name))];
    const routine = async (name: string) => {
      const at = label(name);
      if (!at) return;
      const code = await m.project.script(at.script);
      return {
        code,
        position: at.position,
        at: (i: number, op?: number) => variablesOf(code.instructions[at.position + i], op),
      };
    };
    const parser = await routine('es.SCENARIO.PARSER');
    const cash = await routine('es.CASH.ADD.MAIN');
    if (!parser || !cash) return;
    const single = (ids: number[]) => (ids.length === 1 ? ids : []);
    const [waiting] = single(parser.at(4)),
      [stopped] = single(parser.at(16)),
      [line, cursor] = parser.at(20).length === 2 ? parser.at(20) : [],
      [source, sourceIndex] = parser.at(30),
      [cashCount] = single(cash.at(2)),
      [cashLines, linesIndex] = cash.at(3),
      [cashPaths, pathsIndex] = cash.at(4);
    // The parser registers the scenario file name for its debugger.
    const file = parser.code.instructions
      .map((ins) => {
        const tokens = ins.args.flatMap((arg) => arg.tokens ?? []);
        const name = tokens.find((t) => t.op === 0x4d);
        return name &&
          decodeLiteral(name.payload, 0, name.payload.length) === '$filename' &&
          variablesOf(ins).length === 1
          ? variablesOf(ins)[0]
          : undefined;
      })
      .find((id) => id !== undefined);
    if (
      waiting === undefined ||
      stopped === undefined ||
      line === undefined ||
      cursor === undefined ||
      source === undefined ||
      sourceIndex !== cursor ||
      cashCount === undefined ||
      cashLines === undefined ||
      linesIndex !== cashCount ||
      cashPaths === undefined ||
      pathsIndex !== cashCount ||
      file === undefined
    )
      return;
    const transition = await routine('es.TRDEF');
    const [rules] = transition?.at(3) ?? [],
      [ruleImages] = transition?.at(6) ?? [];
    // es.SP.CHK.SPLZ (YSTB174:2) loops over slots 0..H@slots; visible stand slots
    // (kind = 5, hidden = 0, alpha > 224, folder > 0) whose draw size falls in another band
    // set the folder to that band's scale and call es.SP.RELOAD.
    const splz = await routine('es.SP.CHK.SPLZ');
    const [slots] = splz?.at(3) ?? [],
      [kind, hidden, alpha, folder] = splz?.at(5, 0x56) ?? [],
      [size] = splz?.at(6, 0x56) ?? [];
    // es.SP.RELOAD+6 `GOSUB es.SP.CGLOADEXEC PSTR2=V$sprite[slot]`; es.L.YMV.INIT+9
    // `YMV FILE=V$movieFolder[6] + V$sprite[slot] + ".ymv"` (YSTB172:1792).
    const [sprite] = (await routine('es.SP.RELOAD'))?.at(6, 0x56) ?? [];
    const [movieFolder, movieSprite] = (await routine('es.L.YMV.INIT'))?.at(9, 0x56) ?? [];
    const stand =
      splz &&
      slots !== undefined &&
      kind !== undefined &&
      hidden !== undefined &&
      alpha !== undefined &&
      folder !== undefined &&
      size !== undefined &&
      sprite !== undefined;
    const v: LookaheadVariables = {
      waiting,
      stopped,
      line,
      cursor,
      source,
      file,
      cashCount,
      cashLines,
      cashPaths,
      rules: rules ?? -1,
      ruleImages: ruleImages ?? -1,
      slots: stand ? slots : -1,
      kind: stand ? kind : -1,
      hidden: stand ? hidden : -1,
      alpha: stand ? alpha : -1,
      folder: stand ? folder : -1,
      size: stand ? size : -1,
      sprite: sprite ?? -1,
      movieFolder: movieSprite !== undefined && movieSprite === sprite ? movieFolder! : -1,
    };
    const lookahead = new YurisSceneLookahead(
      m,
      rules !== undefined && ruleImages !== undefined,
      stand ? scaleBands(splz.code, splz.position, folder) : [],
      v,
    );
    lookahead.macrosRead = linearMacros(m, cursor).then(
      (names) => void (lookahead.linearNames = names),
      () => undefined,
    );
    return lookahead;
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
    const vars = this.machine.variables.entries,
      v = this.v;
    const names = new Set<string>();
    const kind = vars[v.kind]?.ints,
      hidden = vars[v.hidden]?.ints,
      alpha = vars[v.alpha]?.ints,
      current = vars[v.folder]?.ints,
      size = vars[v.size]?.floats,
      sprite = vars[v.sprite]?.strings;
    if (this.scaleBands.length && kind && hidden && alpha && current && size && sprite) {
      const last = Number(vars[v.slots]?.ints?.[0] ?? -1n);
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
    const source = vars[v.source]?.strings,
      line = Number(vars[v.line]?.ints?.[0] ?? -1n);
    if (source && line >= 0)
      scan: for (let next = line; next <= line + 64 && next < source.length; next++) {
        const tags = macros(source[next] ?? '');
        if (!tags) break;
        for (const [tag, args] of tags) {
          if (dialogue(tag)) break scan;
          if (!this.linear(tag)) break scan;
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
    const vars = this.machine.variables.entries,
      v = this.v;
    const source = vars[v.source]?.strings,
      line = Number(vars[v.line]?.ints?.[0] ?? -1n);
    return source && line >= 0 ? voices(macros(source[line] ?? '') ?? []) : [];
  }

  /** Undefined means that the previous priority window still applies. */
  update(): readonly string[] | undefined {
    const vars = this.machine.variables.entries,
      v = this.v;
    if (vars[v.stopped]?.ints?.[0]) {
      this.waitingSince = undefined;
      if (this.line === -1) return;
      this.line = -1;
      return [];
    }
    if (vars[v.waiting]?.ints?.[0] !== 1n) {
      this.waitingSince = undefined;
      return;
    }
    const now = this.machine.now();
    this.waitingSince ??= now;
    if (now - this.waitingSince < READING_PAUSE_MS) return;
    const file = vars[v.file]?.strings?.[0] ?? '',
      cursor = Number(vars[v.cursor]?.ints?.[0] ?? -1n),
      line = Number(vars[v.line]?.ints?.[0] ?? -1n),
      source = vars[v.source]?.strings,
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
      !dialogue(current.at(-1)?.[0]) ||
      current.slice(0, -1).some(([tag]) => dialogue(tag))
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
        if (dialogue(tag)) {
          if (!dialogue(tags.at(-1)?.[0])) return [];
          this.nextVoices = cues;
          this.nextMovies = movies;
          const count = Number(vars[v.cashCount]?.ints?.[0] ?? 0n);
          const lines = vars[v.cashLines]?.ints,
            paths = vars[v.cashPaths]?.strings;
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
        if (!this.linear(tag)) return [];
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
          const index = vars[v.rules]?.strings?.indexOf(rule) ?? -1;
          const ruleName = index >= 0 ? vars[v.ruleImages]?.strings?.[index] : rule;
          const folders = vars[1174];
          const folder = folders?.strings?.[38 * (folders.dimensions[1] ?? 0) + 4];
          if (folder && ruleName) assets.add(folder + ruleName);
        }
        // es.L.YMV.INIT (YSTB172:1792) opens V$5491[6] + the sprite name + ".ymv".
        const movieFolder = vars[v.movieFolder]?.strings?.[6];
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
    if (!match) {
      // es.SCENARIO.LEXER (YSTB57:85–156): `/*` comments and `#` labels stop the scan;
      // anything else up to the next macro is a TEXT token, a dialogue line.
      const start = i + /^[ \t]*/.exec(syntax.slice(i))![0].length;
      if (start >= syntax.length) break;
      if (syntax[start] === '#' || syntax.startsWith('/*', start)) return;
      const end = syntax.indexOf('\\', start);
      tags.push(['TEXT', line.slice(start, end < 0 ? syntax.length : end)]);
      i = end < 0 ? syntax.length : end;
      continue;
    }
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
 * The bands of es.SP.CHK.SPLZ: `IF size low Z size high < &`, then `IF V@folder[slot] != scale`
 * and `LET V@folder[slot] = scale` (YSTB174:10–39).
 */
function scaleBands(script: YurisScript, from: number, folder: number): ScaleBand[] {
  const bands: ScaleBand[] = [];
  const same = (a: YurisToken, b: YurisToken) =>
    a.op === 0x48 && b.op === 0x48 && a.payload.every((byte, i) => byte === b.payload[i]);
  for (let p = from; p + 2 < script.instructions.length && p < from + 64; p++) {
    const t = script.instructions[p]!.args[0]?.tokens;
    if (t?.length !== 7 || !same(t[0]!, t[3]!) || t[2]!.op !== 0x5a) continue;
    if (t[5]!.op !== 0x3c || t[6]!.op !== 0x26) continue;
    const [target, value] = script.instructions[p + 2]!.args;
    const head = target?.tokens?.[0];
    if (head?.op !== 0x56 || (head.payload[1]! | (head.payload[2]! << 8)) !== folder) continue;
    const low = literalNumber(t[1]),
      high = literalNumber(t[4]),
      scale = value?.tokens?.length === 1 ? literalNumber(value.tokens[0]) : undefined;
    if (low !== undefined && high !== undefined && scale !== undefined)
      bands.push({low, high, scale});
  }
  return bands;
}
