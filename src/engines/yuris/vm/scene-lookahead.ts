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

/** Uses the scenario library's own CGCASH forecast (YSTB62:185–208) as read-only hints. */
export class YurisSceneLookahead {
  private file = '';
  private line = -1;
  private source?: string[] | null;
  private language = -1;
  private standScale = '';
  private waitingSince?: number;
  /** The VO cues of the lines up to the next dialogue, as of the last forecast. */
  nextVoices: readonly string[] = [];

  observeImage(path: string): void {
    const scale = /^cg\\stand\\(m_[0-9]+)\\/.exec(path)?.[1];
    if (scale) this.standScale = scale;
  }

  private constructor(
    private readonly machine: YurisMachine,
    private readonly transitionTable: boolean,
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
      return new YurisSceneLookahead(
        m,
        !!transition &&
          !!trCode &&
          !!has(trCode, transition.position + 3, 2502) &&
          !!has(trCode, transition.position + 6, 2503),
      );
    }
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
    let standScale = this.standScale;
    for (let next = line + 1; next <= line + 64 && next < source.length; next++) {
      const tags = macros(source[next] ?? '');
      if (!tags) return [];
      cues.push(...voices(tags));
      for (const [tag, args] of tags) {
        if (tag === 'ML.TEXT') {
          if (tags.at(-1)?.[0] !== 'ML.TEXT') return [];
          this.nextVoices = cues;
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
        if (tag === 'C.XYZ') standScale = '';
        if ((tag === 'T' || tag === 'FACE') && first && /^[A-Za-z0-9_]{9,}$/.test(first)) {
          // es.CASH.ADD's character/pose prefix lengths, with the foreground
          // sprite's last observed resolution as a hint for a stable camera.
          const root = tag === 'FACE' ? 'cg/face' : standScale ? 'cg/stand/' + standScale : '';
          if (root) {
            const prefix = root + '/' + first.slice(0, 5) + '/' + first.slice(0, 8) + '/';
            assets.add(prefix + first.slice(0, 8) + '0100');
            assets.add(prefix + first);
          }
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
