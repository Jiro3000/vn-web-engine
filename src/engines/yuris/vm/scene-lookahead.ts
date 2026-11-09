import type {YurisInstruction, YurisScript, YurisToken} from '../../../formats/yuris/ybn.js';
import {decodeCp932} from '../../../text/cp932.js';
import {decodeLiteral} from './expression.js';
import {windowsPath} from './fileact.js';
import type {YurisMachine} from './machine.js';
import {gbkAtlasDecoder} from './raster-text.js';
import {YurisScenarioText} from './scenario-text.js';
import {textLines} from './text.js';

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
  /**
   * es.L.YMV.INIT's folder array, read at index 6. es.SP.INIT.VER fills it with the folder of
   * each sprite kind, which es.SP.CGLOADEXEC prefixes to the sprite name (YSTB156:215).
   */
  readonly movieFolder: number;
  /** es.Scenario.SearchLABEL+2 `LOOP H@labelCount` and +3 `IF V$labelNames[...] = name`. */
  readonly labelCount: number;
  readonly labelNames: number;
  /** es.Scenario.JumpLabel+11: the line, token and file number of each label. */
  readonly labelLine: number;
  readonly labelFile: number;
  /** es.SCENARIO.FILENAME.GET+1 `RETURN RSTR=V$fileNames[number]`. */
  readonly fileNames: number;
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
  labelCount: 2909,
  labelNames: 2904,
  labelLine: 2907,
  labelFile: 2905,
  fileNames: 2966,
};

/** An `ML.TEXT` macro or a TEXT token: the parser shows a dialogue and waits for a click. */
/** Scenario lines a forecast reads ahead; scripted scenes run long macro sequences. */
const SCAN_LINES = 256;

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

/** A sprite image a scenario macro loads: the kind folder and the macro argument with its name. */
interface MacroImage {
  /** Index into the sprite kind folders (V$movieFolder). */
  readonly folder: number;
  /** The macro argument with the name, or -1 for the literal `name`. */
  readonly arg: number;
  readonly name?: string;
  /** The request is inside branches taken when each argument equals one of the values. */
  readonly when?: readonly ArgumentCondition[];
  /** A transition rule name, which es.SP.LOADTR maps through es.TRDEF.CHECK (YSTB160:135). */
  readonly rule: boolean;
}

interface MacroCalls {
  /** The images each es.ScenarioMacro.NAME requests, by NAME. */
  readonly images: ReadonlyMap<string, readonly MacroImage[]>;
  /** The macros that always jump to the label named by one of their arguments, by NAME. */
  readonly jumps: ReadonlyMap<string, number>;
}

interface ArgumentCondition {
  readonly arg: number;
  readonly values: readonly string[];
}

const PARAMETER = /^P(?:STR|INT|FLT)([0-9]*)$/;

/**
 * An IF or ELSE condition `H$v "a" = H$v "b" = | …` on one string variable that holds a macro
 * argument, as the argument and its literal values; anything else is undefined.
 */
function argumentCondition(
  tokens: readonly YurisToken[] | null | undefined,
  vars: ReadonlyMap<number, number>,
): ArgumentCondition | undefined {
  if (!tokens?.length) return;
  let variable: number | undefined;
  const values: string[] = [];
  for (let i = 0; i < tokens.length;) {
    const [v, literal, equal] = [tokens[i], tokens[i + 1], tokens[i + 2]];
    if (v?.op !== 0x48 || v.payload[0] !== 0x24 || literal?.op !== 0x4d || equal?.op !== 0x3d)
      return;
    const id = v.payload[1]! | (v.payload[2]! << 8);
    if (variable !== undefined && id !== variable) return;
    variable = id;
    values.push(decodeLiteral(literal.payload, 0, literal.payload.length));
    i += 3;
    if (values.length > 1) {
      if (tokens[i]?.op !== 0x7c) return;
      i++;
    }
  }
  const arg = variable === undefined ? undefined : vars.get(variable);
  return arg === undefined ? undefined : {arg, values};
}
const SYSTEM_STRING_PARAMETERS = 55;

/**
 * Reads what the scenario macros load and where they jump, following arguments through the
 * routines they call with constant labels (three levels deep). es.ScenarioMacro.SetParam
 * (YSTB62:5–14) copies argument k into the k-th string it sets; a callee reads its k-th
 * parameter as V$55[k] (GOSUB 0x442C84). A sprite request is es.SP.CG.SET with a literal kind
 * (PINT) and a name (PSTR2), or es.SP.TR.SET with a rule name (PSTR), which es.SP.LOADTR loads
 * from kind folder `trFolder`. A jump is es.Scenario.JumpLabel outside any IF or LOOP block.
 */
async function macroCalls(m: YurisMachine, trFolder: number): Promise<MacroCalls> {
  const images = new Map<string, MacroImage[]>(),
    jumps = new Map<string, number>();
  const labels = m.project.labels.labels,
    commands = m.project.commands.commands;
  const ends = routineEnds(m);
  const index = (name: string) => m.label(latin1(name));
  const cgSet = index('es.SP.CG.SET'),
    trSet = index('es.SP.TR.SET'),
    jumpLabel = index('es.Scenario.JumpLabel');
  const setParam = labels[index('es.ScenarioMacro.SetParam')];
  if (!setParam) return {images, jumps};
  const argumentVars = new Map<number, number>();
  const setCode = (await m.project.script(setParam.script)).instructions;
  const setEnd = Math.min(setCode.length, ends(setParam.script, setParam.position));
  for (let p = setParam.position; p < setEnd; p++) {
    const ins = setCode[p]!,
      name = commands[ins.command]?.name;
    if (name === 'RETURN') break;
    if (name === 'LET' && ins.args[0]?.type === 3) {
      const [id] = variablesOf(ins);
      if (id !== undefined) argumentVars.set(id, argumentVars.size);
    }
  }
  const single = (tokens: readonly YurisToken[] | null | undefined) =>
    tokens?.length === 1 && tokens[0]!.op === 0x48
      ? tokens[0]!.payload[1]! | (tokens[0]!.payload[2]! << 8)
      : undefined;
  const walk = async (
    labelIndex: number,
    vars: Map<number, number>,
    parameters: ReadonlyMap<number, number>,
    depth: number,
    out: MacroImage[],
    conditional: boolean,
  ): Promise<number | undefined> => {
    const label = labels[labelIndex]!;
    let jump: number | undefined,
      nesting = 0;
    // The condition of each open IF or ELSE branch and LOOP (undefined when not an argument test).
    const branches: (ArgumentCondition | undefined)[] = [];
    const code = (await m.project.script(label.script)).instructions;
    const end = Math.min(code.length, ends(label.script, label.position));
    for (let p = label.position; p < end; p++) {
      const ins = code[p]!,
        name = commands[ins.command]?.name;
      if (name === 'IF' || name === 'LOOP') {
        nesting++;
        branches.push(name === 'IF' ? argumentCondition(ins.args[0]?.tokens, vars) : undefined);
      } else if (name === 'ELSE') {
        // An ELSE chain on the preset name: the later tests still hold where this one runs.
        if (branches.length)
          branches[branches.length - 1] = argumentCondition(ins.args[0]?.tokens, vars);
      } else if (name === 'IFEND' || name === 'LOOPEND') {
        nesting--;
        branches.pop();
      } else if (name === 'RETURN' && nesting <= 0) break;
      else if (name === 'STR' || name === 'LET') {
        const target = single(ins.args[0]?.tokens),
          source = ins.args[1]?.tokens;
        if (target === undefined) continue;
        const copied = single(source);
        const parameter =
          source?.length === 3 &&
          source[0]!.op === 0x56 &&
          (source[0]!.payload[1]! | (source[0]!.payload[2]! << 8)) === SYSTEM_STRING_PARAMETERS &&
          source[2]!.op === 0x29
            ? literalNumber(source[1])
            : undefined;
        const value =
          copied !== undefined
            ? vars.get(copied)
            : parameter !== undefined
              ? parameters.get(parameter)
              : undefined;
        if (value !== undefined) vars.set(target, value);
        // A conditional default (an omitted argument) leaves the argument's value possible.
        else if (nesting <= 0) vars.delete(target);
      } else if (name === 'GOSUB') {
        const target = ins.args[0]?.tokens;
        if (target?.length !== 1 || target[0]!.op !== 0x4d) continue;
        const callee = m.label(
          latin1(decodeLiteral(target[0]!.payload, 0, target[0]!.payload.length)),
        );
        if (callee < 0) continue;
        const passed = new Map<number, number>(),
          literals = new Map<number, number>(),
          strings = new Map<number, string>();
        for (const arg of ins.args.slice(1)) {
          const match = PARAMETER.exec(commands[ins.command]?.args[arg.id]?.name ?? '');
          if (!match) continue;
          const position = match[1] ? Number(match[1]) : 1;
          const id = single(arg.tokens);
          if (id !== undefined && vars.has(id)) passed.set(position, vars.get(id)!);
          const literal = arg.tokens?.length === 1 ? literalNumber(arg.tokens[0]) : undefined;
          if (literal !== undefined) literals.set(position, literal);
          const text = arg.tokens?.length === 1 ? arg.tokens[0]! : undefined;
          if (text?.op === 0x4d)
            strings.set(position, decodeLiteral(text.payload, 0, text.payload.length));
        }
        // es.SP.CG.SET with a literal kind and name inside branches that test macro arguments
        // against literals (the PSET preset table, YSTB304:25–) loads when the arguments match.
        const when = branches.filter((condition) => condition) as ArgumentCondition[];
        if (
          callee === cgSet &&
          !conditional &&
          nesting > 0 &&
          when.length === branches.length &&
          when.length === nesting &&
          literals.has(1)
        ) {
          const literalName = strings.get(2),
            arg = passed.get(2);
          if (literalName)
            out.push({folder: literals.get(1)!, arg: -1, name: literalName, rule: false, when});
          else if (arg !== undefined) out.push({folder: literals.get(1)!, arg, rule: false, when});
          continue;
        }
        // Only requests every call makes count: none inside an IF or LOOP block at any level.
        const branch = conditional || nesting > 0;
        if (callee === jumpLabel) {
          if (!branch && jump === undefined) jump = passed.get(1);
        } else if (branch) {
          continue;
        } else if (callee === cgSet) {
          const kind = literals.get(1),
            arg = passed.get(2),
            literalName = strings.get(2);
          if (kind !== undefined && arg !== undefined) out.push({folder: kind, arg, rule: false});
          else if (kind !== undefined && literalName)
            out.push({folder: kind, arg: -1, name: literalName, rule: false});
        } else if (callee === trSet) {
          const arg = passed.get(1);
          if (arg !== undefined && trFolder >= 0) out.push({folder: trFolder, arg, rule: true});
        } else if (depth < 3 && passed.size) {
          await walk(callee, new Map(), passed, depth + 1, out, false);
        }
      }
    }
    return jump;
  };
  const prefix = 'es.ScenarioMacro.';
  for (const [i, label] of labels.entries()) {
    const name = String.fromCharCode(...label.name);
    if (!name.startsWith(prefix)) continue;
    const out: MacroImage[] = [];
    try {
      const jump = await walk(i, new Map(argumentVars), new Map(), 0, out, false);
      if (jump !== undefined) jumps.set(name.slice(prefix.length), jump);
    } catch {
      // A script that does not load contributes nothing.
    }
    if (out.length) images.set(name.slice(prefix.length), out);
  }
  return {images, jumps};
}

/** The end of the routine at `position` of `script`: the next label of that script. */
function routineEnds(m: YurisMachine): (script: number, position: number) => number {
  const starts = new Map<number, number[]>();
  for (const l of m.project.labels.labels) {
    let list = starts.get(l.script);
    if (!list) starts.set(l.script, (list = []));
    list.push(l.position);
  }
  for (const list of starts.values()) list.sort((a, b) => a - b);
  return (script, position) =>
    starts.get(script)?.find((p) => p > position) ?? Number.MAX_SAFE_INTEGER;
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
/** A dialogue line of the scenario, as `currentDialogue` reads it. */
export interface YurisDialogueLine {
  readonly file: string;
  readonly line: number;
  readonly text: string;
  readonly voiced: boolean;
}

export class YurisSceneLookahead {
  private file = '';
  private forecastKey = '';
  private line = -1;
  private source?: string[] | null;
  private language = -1;
  private standScale = '';
  /** How many stand images each scale folder has supplied, for scans after a camera move. */
  private readonly scaleUses = new Map<string, number>();
  private waitingSince?: number;
  /** The VO cues of the lines up to the next dialogue, as of the last forecast. */
  nextVoices: readonly string[] = [];
  /** The YMV files S.MV opens in the lines up to the next dialogue, as of the last forecast. */
  nextMovies: readonly string[] = [];
  /** The library's in-line macros, once `linearMacros` has read them. */
  private linearNames?: Set<string>;
  /** The images and jumps of the library's macros, once `macroCalls` has read them. */
  private calls?: MacroCalls;
  /** Other scenario files a jump continues into: their TEXT lines, or the pending read. */
  private readonly sources = new Map<string, readonly string[] | null | Promise<void>>();
  /** The library splits scenario lines for ML.TEXT (es.SCENARIO.LOAD, see `installText`). */
  private bilingual = false;
  private dialogueDecoder?: TextDecoder;
  /** Settles when the macro analysis has finished. */
  macrosRead: Promise<void> = Promise.resolve();

  private linear(tag: string): boolean {
    return this.linearNames
      ? this.linearNames.has(tag)
      : LINEAR_MACROS.has(tag) || /^(?:VO|SE)[0-9]*$/.test(tag);
  }

  observeImage(path: string): void {
    const scale = /^cg\\stand\\(m_[0-9]+)\\/.exec(path)?.[1];
    if (!scale) return;
    this.standScale = scale;
    this.scaleUses.set(scale, (this.scaleUses.get(scale) ?? 0) + 1);
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
    // es.Scenario.SearchLABEL+2/+3 (YSTB59:74–75), es.Scenario.JumpLabel+11
    // `GOSUB es.SCENARIO.com_no.pos.SET PINT2=V@line[i] PINT3=V@token[i] PINT4=V@file[i]`
    // (YSTB59:92) and es.SCENARIO.FILENAME.GET+1 `RETURN RSTR=V$names[n]` (YSTB54:45).
    const search = await routine('es.Scenario.SearchLABEL');
    const [labelCount] = single(search?.at(2, 0x48) ?? []),
      [labelNames] = single(search?.at(3, 0x56) ?? []);
    const [labelLine, , labelFile] = (await routine('es.Scenario.JumpLabel'))?.at(11, 0x56) ?? [];
    const [fileNames] = single((await routine('es.SCENARIO.FILENAME.GET'))?.at(1, 0x56) ?? []);
    const labelTable =
      labelCount !== undefined &&
      labelNames !== undefined &&
      labelLine !== undefined &&
      labelFile !== undefined &&
      fileNames !== undefined;
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
      labelCount: labelTable ? labelCount : -1,
      labelNames: labelTable ? labelNames : -1,
      labelLine: labelTable ? labelLine : -1,
      labelFile: labelTable ? labelFile : -1,
      fileNames: labelTable ? fileNames : -1,
    };
    const lookahead = new YurisSceneLookahead(
      m,
      rules !== undefined && ruleImages !== undefined,
      stand ? scaleBands(splz.code, splz.position, folder) : [],
      v,
    );
    // es.SP.LOADTR `LET H$path = V$folders[k] + H$rule` (YSTB160:149) names the rule folder.
    let trFolder = -1;
    const loadTr = await routine('es.SP.LOADTR');
    if (loadTr && v.movieFolder >= 0)
      search: for (let i = 0; i < 64 && loadTr.position + i < loadTr.code.instructions.length; i++)
        for (const arg of loadTr.code.instructions[loadTr.position + i]!.args) {
          const tokens = arg.tokens ?? [];
          for (let t = 0; t + 2 < tokens.length; t++) {
            const token = tokens[t]!;
            if (
              token.op !== 0x56 ||
              (token.payload[1]! | (token.payload[2]! << 8)) !== v.movieFolder
            )
              continue;
            const k = literalNumber(tokens[t + 1]);
            if (k !== undefined && tokens[t + 2]!.op === 0x29) {
              trFolder = k;
              break search;
            }
          }
        }
    lookahead.bilingual = !!label('es.SCENARIO.LOAD') && !!label('es.ScenarioMacro.ML.TEXT');
    // es.ZENKAKU.LOAD+5 assigns the first atlas name. The Sarasa SC atlas library uses GBK
    // for both language arguments to ML.TEXT, even when the script displays Japanese.
    const atlas = await routine('es.ZENKAKU.LOAD');
    const firstName = atlas?.code.instructions[atlas.position + 5];
    if (firstName && m.project.commands.commands[firstName.command]?.name === 'LET') {
      const [target, value] = firstName.args;
      const array = target?.tokens?.[0],
        literal = value?.tokens?.[0];
      if (
        array?.op === 0x56 &&
        array.payload[0] === 0x24 &&
        literal?.op === 0x4d &&
        value?.tokens?.length === 1
      )
        lookahead.dialogueDecoder = gbkAtlasDecoder(
          decodeLiteral(literal.payload, 0, literal.payload.length),
        );
    }
    lookahead.macrosRead = Promise.all([
      linearMacros(m, cursor).then(
        (names) => void (lookahead.linearNames = names),
        () => undefined,
      ),
      macroCalls(m, trFolder).then(
        (calls) => void (lookahead.calls = calls),
        () => undefined,
      ),
    ]).then(() => undefined);
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
      scan: for (
        let next = line, state = {comment: false};
        next <= line + SCAN_LINES && next < source.length;
        next++
      ) {
        const tags = macros(source[next] ?? '', state);
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

  /**
   * The dialogue of the line the scenario parser is executing (H@3040), or undefined for a
   * line without one. The text joins the line's TEXT tokens, or takes the ML.TEXT argument of
   * the language H@1176 selects, with `\R` as a line break. `voiced` tells whether a VO
   * macro on the line plays a voice cue with it.
   */
  currentDialogue(): YurisDialogueLine | undefined {
    const vars = this.machine.variables.entries,
      v = this.v;
    if (vars[v.stopped]?.ints?.[0]) return;
    const file = vars[v.file]?.strings?.[0] ?? '',
      source = vars[v.source]?.strings,
      line = Number(vars[v.line]?.ints?.[0] ?? -1n);
    if (!source || line < 0) return;
    const tags = macros(source[line] ?? '');
    if (!tags?.some(([tag]) => dialogue(tag))) return;
    const lang = vars[1176],
      language = Number(lang?.ints?.[255 * (lang.dimensions[1] ?? 0)] ?? -1n);
    let text = '';
    for (const [tag, args] of tags) {
      if (tag === 'TEXT') text += args;
      else if (tag === 'R') text += '\n';
      else if (tag === 'ML.TEXT') {
        const strings = [...args.matchAll(/"([^"]*)"/g)].map((match) => match[1]!);
        text += strings[language] ?? strings[0] ?? '';
      }
    }
    // A bilingual argument keeps its inline macros; a voice cue there is in `tags` already.
    // Decoded first, so that a DBCS trail byte 0x5C does not read as a macro.
    const bytes = latin1(text);
    text = (this.dialogueDecoder ? this.dialogueDecoder.decode(bytes) : decodeCp932(bytes))
      .replace(/\\[A-Z][A-Z0-9_.]*(?:\([^)]*\))?/g, '')
      .trim();
    return text ? {file, line, text, voiced: voices(tags).length > 0} : undefined;
  }

  /** A transition's rule image: es.TRDEF maps transition names to rules (es.TRDEF.CHECK). */
  private addRule(assets: Set<string>, rule: string): void {
    if (!this.transitionTable || !/^[A-Za-z0-9_-]+$/.test(rule)) return;
    const vars = this.machine.variables.entries,
      v = this.v;
    const index = vars[v.rules]?.strings?.indexOf(rule) ?? -1;
    const ruleName = index >= 0 ? vars[v.ruleImages]?.strings?.[index] : rule;
    const folders = vars[1174];
    const folder = folders?.strings?.[38 * (folders.dimensions[1] ?? 0) + 4];
    if (folder && ruleName) assets.add(folder + ruleName);
  }

  /**
   * Where a jump to label `name` continues: es.Scenario.SearchLABEL takes the first label of
   * that name, and es.SCENARIO.com_no.pos.SET (YSTB59:26–45) loads the label's file when it
   * is not the current one and resumes at the label's line. Undefined for an unknown label and
   * while another file's lines are read.
   */
  private jumpTarget(
    name: string,
    file: string,
    source: readonly string[],
  ): {lines: readonly string[]; next: number} | undefined {
    const vars = this.machine.variables.entries,
      v = this.v;
    if (v.labelNames < 0 || !name) return;
    const count = Number(vars[v.labelCount]?.ints?.[0] ?? 0n);
    const index = vars[v.labelNames]?.strings?.slice(0, Math.max(0, count)).indexOf(name) ?? -1;
    if (index < 0) return;
    const at = Number(vars[v.labelLine]?.ints?.[index] ?? -1n),
      number = vars[v.labelFile]?.ints?.[index];
    const target = number === undefined ? undefined : vars[v.fileNames]?.strings?.[Number(number)];
    if (at < 0 || !target) return;
    if (target === file) return {lines: source, next: at};
    const lines = this.sources.get(target);
    if (Array.isArray(lines)) return {lines, next: at};
    if (lines === undefined) {
      if (this.sources.size >= 8) this.sources.clear();
      this.sources.set(target, this.readSource(target));
    }
  }

  /** es.SCENARIO.LOAD's TEXT lines of scenario file `name`; the next update scans again. */
  private async readSource(name: string): Promise<void> {
    let lines: readonly string[] | null = null;
    try {
      const bytes = await this.machine.files.read(windowsPath(name));
      const bound = BigInt(this.machine.variables.entries[this.v.source]?.dimensions[0] ?? 0);
      lines = textLines(bytes, bound, this.bilingual ? new YurisScenarioText() : undefined);
    } catch {
      // A file that does not read ends the scan at the jump.
    }
    this.sources.set(name, lines);
    this.line = -1;
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
    // After C.XYZ the sprite's folder depends on the new camera, so the scan names the
    // last observed folder and the one that has supplied the most stand images.
    let common = '',
      uses = 0;
    for (const [scale, n] of this.scaleUses) if (n > uses) [common, uses] = [scale, n];
    const movedScales = [...new Set([this.standScale, common])].filter(Boolean);
    let cameraMoved = false;
    const folders = vars[v.movieFolder]?.strings;
    // The scan follows unconditional jumps into the lines they continue at, within
    // SCAN_LINES lines, and skips block comments.
    let lines: readonly string[] = source,
      next = line + 1,
      jumped = false;
    const state: LexerState = {comment: false};
    for (let step = 0; step < SCAN_LINES; step++, next++) {
      if (next >= lines.length) return [];
      const tags = macros(lines[next] ?? '', state);
      if (!tags) return [];
      cues.push(...voices(tags));
      let target: {lines: readonly string[]; next: number} | undefined;
      for (const [tag, args] of tags) {
        if (dialogue(tag)) {
          if (!dialogue(tags.at(-1)?.[0])) return [];
          this.nextVoices = cues;
          this.nextMovies = movies;
          const count = Number(vars[v.cashCount]?.ints?.[0] ?? 0n);
          const cashLines = vars[v.cashLines]?.ints,
            paths = vars[v.cashPaths]?.strings;
          // The library's CGCASH list covers the current file only.
          if (cashLines && paths && !jumped) {
            // es.CASH.ADD stores 1-based source lines, sorted by its parser.
            let lo = 0,
              hi = Math.min(Math.max(0, count), cashLines.length, paths.length);
            while (lo < hi) {
              const mid = (lo + hi) >>> 1;
              if (cashLines[mid]! <= BigInt(line + 1)) lo = mid + 1;
              else hi = mid;
            }
            for (
              let i = lo;
              i < count && i < paths.length && cashLines[i]! <= BigInt(next + 1);
              i++
            ) {
              const path = paths[i];
              // The authored distant list includes two default sprite scales.
              // The near pass already uses the observed scale where it can.
              if (path && !(standScale && /^cg\/stand\//i.test(path))) assets.add(path);
            }
          }
          return [...assets].slice(0, 20);
        }
        const values = args.split(',').map((arg) => arg.trim().replace(/^"(.*)"$/, '$1'));
        if (!this.linear(tag)) {
          const jump = this.calls?.jumps.get(tag);
          target =
            jump === undefined ? undefined : this.jumpTarget(values[jump] ?? '', file, source);
          if (!target) return [];
          break;
        }
        const [first, second, , fourth] = values;
        const rule =
          tag === 'FIN' || tag === 'FOUT'
            ? second
            : tag === 'BG' || tag === 'ML.BG'
              ? fourth
              : undefined;
        if (rule) this.addRule(assets, rule);
        // es.SP.CG.SET and es.SP.TR.SET requests: the kind folder and the argument's name.
        for (const image of this.calls?.images.get(tag) ?? []) {
          if (image.when?.some(({arg, values: wanted}) => !wanted.includes(values[arg] ?? '')))
            continue;
          const name = image.arg < 0 ? image.name : values[image.arg];
          if (!name || !/^[^"',()\\$@ ]+$/.test(name)) continue;
          if (image.rule) this.addRule(assets, name);
          else if (folders?.[image.folder]) assets.add(folders[image.folder] + name);
        }
        // es.L.YMV.INIT (YSTB172:1792) opens V$5491[6] + the sprite name + ".ymv".
        const movieFolder = folders?.[6];
        if (tag === 'S.MV' && movieFolder && second && !/["',()\\]/.test(second))
          movies.push(windowsPath(movieFolder + second + '.ymv'));
        if (tag === 'C.XYZ') {
          standScale = '';
          cameraMoved = true;
        }
        if (tag === 'T' || tag === 'FACE') {
          // The foreground sprite's last observed resolution is a hint for a stable camera.
          const roots =
            tag === 'FACE'
              ? ['cg/face']
              : standScale
                ? ['cg/stand/' + standScale]
                : cameraMoved
                  ? movedScales.map((scale) => 'cg/stand/' + scale)
                  : [];
          if (first) for (const root of roots) addSprite(assets, root, first);
        }
        // Standard multilingual variants (es.ScenarioMacro.ML.S / ML.BG).
        const name = tag === 'ML.S' ? second : tag === 'ML.BG' ? first : undefined;
        if (name && /^[A-Za-z0-9_/-]+$/.test(name) && (language === 0 || language === 1))
          assets.add((tag === 'ML.S' ? 'cg/' : 'cg/bg/') + name + (language === 0 ? '_c' : ''));
      }
      if (target) {
        lines = target.lines;
        next = target.next - 1;
        jumped = true;
        // A jump lands on a label line, which the lexer reads outside any comment.
        state.comment = false;
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

/** es.SCENARIO.LEXER's block comment flag H@2909, which carries over to the next lines. */
interface LexerState {
  comment: boolean;
}

/**
 * The macros and TEXT tokens of a scenario line. Without `state` a block comment is unknown
 * ground and the line is undefined; with it, the comment is skipped as the lexer does.
 */
function macros(line: string, state?: LexerState): [string, string][] | undefined {
  // A DBCS trail byte may be a slash, backslash, quote or parenthesis.
  const syntax = line.trimEnd().replace(/[\x81-\xfe][\s\S]/g, '\0\0');
  const token = /[ \t]*\\([A-Z][A-Z0-9_.]*)(?:\(((?:"[^"]*"|'[^']*'|[^"'()])*)\))?/dy;
  const tags: [string, string][] = [];
  let i = 0;
  if (state?.comment) {
    // State 99 (YSTB57:264–271): `*/` clears H@2909 and lexing resumes after it.
    const end = syntax.indexOf('*/');
    if (end < 0) return tags;
    state.comment = false;
    i = end + 2;
  }
  while (i < syntax.length) {
    if (/^[ \t]*\/\//.test(syntax.slice(i))) break;
    token.lastIndex = i;
    const match = token.exec(syntax);
    if (!match) {
      // es.SCENARIO.LEXER (YSTB57:85–156): a `/*` starts a block comment and a `#` label
      // ends the line; anything else up to the next macro is a TEXT token, a dialogue line.
      const start = i + /^[ \t]*/.exec(syntax.slice(i))![0].length;
      if (start >= syntax.length) break;
      // A label line runs no command: es.SCENARIO.PARSER (YSTB59:163–192) only calls the
      // es.NEXTSEL skip routines with H@1003 set.
      if (syntax[start] === '#') break;
      if (syntax.startsWith('/*', start)) {
        // YSTB57:96–98 sets H@2909 and state 99, which tests from the next character on.
        if (!state) return;
        const end = syntax.indexOf('*/', start + 1);
        if (end < 0) {
          state.comment = true;
          break;
        }
        i = end + 2;
        continue;
      }
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
