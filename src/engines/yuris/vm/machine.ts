import {
  type YurisArgument,
  type YurisInstruction,
  type YurisProject,
  type YurisScript,
  findYurisLabel,
} from '../../../formats/yuris/ybn.js';
import {YurisLayers, type YurisImageHost} from './cg.js';
import {
  type GuardLoop,
  type InactiveLoop,
  applyCopyLoop,
  applyInitializer,
  applyRowShift,
  copyLoop,
  scanGuardLoop,
  scanInactiveLoop,
  scanInitializer,
  scanRowShift,
  skipGuardLoop,
  skipInactiveLoop,
} from './copy-loop.js';
import {YurisError} from './errors.js';
import {YurisExpression} from './expression.js';
import {type YurisFolderHost, type YurisImageEncoder, installFiles} from './fileact.js';
import {type YurisFileHost, YurisFiles} from './files.js';
import {type YurisInputHost, YurisInput, installInput} from './input.js';
import {type ByteString, STRING_CAPACITY, fistp, i64, isLeadByte} from './numbers.js';
import {asciiLower} from './sjis.js';
import {YurisFramePacer} from './pacing.js';
import {YurisSystem, type YurisSystemHost} from './system.js';
import {type YurisNode, YurisTree} from './nodes.js';
import {type YurisLoopEntry, NESTING_LIMIT, YurisTask} from './task.js';
import {installTasks} from './tasks.js';
import {installProduct, type YurisProductHost} from './product.js';
import {installSave, type YurisSaveData} from './save.js';
import {installText} from './text.js';
import {installMath3d} from './math3d.js';
import {installYmv} from './ymv.js';
import {installDialog, type YurisDialogHost} from './dialog.js';
import {YurisMovie, type YurisMovieHost} from './movie.js';
import {YurisMenus} from './menu.js';
import type {WindowsMenusHost} from '../../../platform/windows-menus.js';
import {STARTUP_SETTINGS_MISSING, YurisStartupSettings} from './startup.js';
import {SYSTEM_VARIABLE_LIMIT, YurisType, YurisVariables} from './variables.js';
import {installMath} from './math.js';
import {type YurisFontHost, YurisFonts, installFonts} from './font.js';
import {type YurisSoundHost, YurisSounds} from './sound.js';
import {characterOffsets, installVariableCommands} from './vars.js';
import {
  scanArrayRanges,
  scanCharacterSearch,
  scanLexerRun,
  scanStringSlice,
  type LexerRun,
} from './library-fast-paths.js';
import {type YurisWindowHost, YurisWindows} from './window.js';

/**
 * A command handler (table at 0x78B040, filled by 0x4635A8). It returns 0 to continue with
 * the next instruction or a nonzero value to yield the task until the next frame; a promise
 * suspends the dispatcher until the resource the command waits for is ready.
 */
export type YurisCommandHandler = (machine: YurisMachine) => number | Promise<number>;

/** Command ids of the core handlers (`ysc.ybn` order). */
export const enum Command {
  Alias = 0x00,
  DebugList = 0x09,
  Else = 0x0b,
  End = 0x0d,
  Flt = 0x19,
  Fps = 0x1c,
  Go = 0x2a,
  Gosub = 0x2b,
  If = 0x2c,
  IfBlend = 0x2d,
  IfBreak = 0x2e,
  IfContinue = 0x2f,
  IfEnd = 0x30,
  Int = 0x32,
  Label = 0x33,
  LabelInfo = 0x34,
  Let = 0x35,
  Loop = 0x37,
  LoopBreak = 0x38,
  LoopContinue = 0x39,
  LoopEnd = 0x3a,
  Prep = 0x4d,
  Return = 0x4f,
  ReturnBreak = 0x50,
  SFlt = 0x52,
  SInt = 0x53,
  SStr = 0x54,
  Str = 0x5c,
  Wait = 0x68,
}

/** Minimum and maximum of the decoder range checks 3..0x17 (tables 0x59B5C0 / 0x59B620). */
const RANGES: readonly (readonly [number, number])[] = [
  [0, 0],
  [0, 0],
  [1, 0],
  [0, 1],
  [0, 2],
  [0, 3],
  [1, 3],
  [0, 4],
  [0, 8],
  [1, 8],
  [0, 15],
  [0, 18],
  [0, 256],
  [1, 256],
  [0, 512],
  [0, 1024],
  [1, 1024],
  [128, 1024],
  [0, 2048],
  [1, 2048],
  [0, 8192],
  [1, 8192],
  [16, 8192],
  [128, 8192],
];

/** Argument slots filled by the decoder 0x4253C9 (arrays at 0x661100..0x6624C0), 1-based. */
export class YurisArguments {
  count = 0;
  /** 0x6624C0: slot of each argument id (0 when absent). */
  readonly slot = new Uint8Array(100);
  readonly id = new Uint8Array(101);
  readonly type = new Uint8Array(101);
  readonly op = new Uint8Array(101);
  readonly size = new Uint32Array(101);
  readonly offset = new Uint32Array(101);
  /** 0x661920: numeric values (kind 0); stale for other kinds, as natively. */
  readonly value = new Array<bigint>(101).fill(0n);
  /** 0x662320: string values (kind 1). */
  readonly string: ByteString[] = new Array(101).fill('');
  /** 0x662180: expressions (kind 2). */
  readonly expression: Uint8Array[] = new Array(101).fill(new Uint8Array(0));
  /** 0x661C40, 0x661DE0, 0x662100: the variable each expression named last. */
  readonly variable = new Uint32Array(101);
  readonly variableIndex = new Array<bigint>(101).fill(0n);
  readonly whole = new Uint8Array(101);
  readonly records: YurisArgument[] = [];

  /** Slot of argument `id`, 0 when the instruction does not carry it. */
  has(id: number): number {
    return this.slot[id]!;
  }
  int(id: number): bigint {
    return this.value[this.slot[id]!]!;
  }
  text(id: number): ByteString {
    return this.string[this.slot[id]!]!;
  }
}

/** A script with the load-time state of 0x4511C1. */
interface LoadedScript {
  readonly index: number;
  readonly script: YurisScript;
  /** GO label resolved at load (`size + 0x10000000`), -1 for a runtime lookup. */
  readonly goLabel: Int32Array;
  /** GOSUB label index stored in the label argument's type/op bytes, 0 for a runtime lookup. */
  readonly gosubLabel: Uint16Array;
}

interface LexerScan {
  readonly run: LexerRun;
  readonly calleeScript: number;
  readonly calleePosition: number;
}

export interface YurisMachineHost
  extends
    YurisSystemHost,
    YurisFileHost,
    YurisImageHost,
    YurisFolderHost,
    YurisImageEncoder,
    YurisInputHost,
    YurisWindowHost,
    YurisFontHost,
    YurisSoundHost,
    YurisDialogHost,
    YurisMovieHost,
    YurisProductHost {
  readonly menus: WindowsMenusHost;
  /** A fatal script error with its formatted `YSER` message, after the quit flag is set. */
  error(message: string, error: YurisError): void;
  /** `Sleep` of the frame pacing 0x4109A8. */
  sleep(milliseconds: number): Promise<void>;
  /** `MessageBoxA` of 0x409070: a message the command shows before yielding. */
  messageBox(text: string): void;
  /** Keep optional glyph provenance for browser presentation. */
  readonly rasterText?: boolean;
  /** Called after every executed instruction when tracing. */
  trace?(task: YurisTask, position: number, instruction: YurisInstruction, script: number): void;
  /** A trace observer may return false for a range whose intermediate state it never reads. */
  traceRange?(script: number, first: number, last: number): boolean;
  /** The window output of a frame (0x404824, 0x40FCAC), before its marks are cleared. */
  present?(layers: YurisLayers): void;
}

/**
 * The YU-RIS script machine: tasks, the per-frame dispatcher 0x40449C, the argument decoder
 * 0x4253C9 and the control-flow and variable commands. Media commands register their handlers
 * with `define`.
 */
export class YurisMachine {
  readonly variables: YurisVariables;
  readonly expression: YurisExpression;
  readonly system: YurisSystem;
  readonly args = new YurisArguments();
  readonly pacer = new YurisFramePacer();
  readonly input: YurisInput;
  readonly windows: YurisWindows;
  /** 0x87241C: the task tree; the dispatcher runs its leaves. */
  readonly taskTree = new YurisTree<YurisTask>();
  /** 0x872434: the running task; 0x872438: its node. */
  task!: YurisTask;
  taskNode!: YurisNode<YurisTask>;
  /** 0x871F50: TASK RESTART asks the frame for another dispatcher pass. */
  restartPending = false;
  /** 0x871F58: that pass skips the tasks above this Z (0: none). */
  restartZ = 0n;
  /** 0x872448: the running instruction. */
  position = 0;
  /** 0x87260C: set by END and by every script error. */
  quit = false;
  /** 0x872258: END's exit code. */
  exitCode = 0;
  /** 0x667E60: per command, whether a missing target is an error (ERROR COM_<command>). */
  readonly errorFlags = new Uint8Array(0x80).fill(1);
  readonly files: YurisFiles;
  readonly layers: YurisLayers;
  /** The SAVE/LOAD block and memory-slot buffers. */
  readonly saveData: YurisSaveData;
  readonly fonts: YurisFonts;
  readonly sounds: YurisSounds;
  readonly movie: YurisMovie;
  readonly menus: YurisMenus;
  private readonly handlers: (YurisCommandHandler | undefined)[] = [];
  private readonly letHandler = () => this.let();
  private readonly loopHandler = () => this.loop();
  private readonly loopEndHandler = () => this.loopEnd();
  private readonly ifHandler = () => this.if();
  private readonly elseHandler = () => this.else();
  private readonly ifBlendHandler = () => this.ifBlend();
  private readonly ifEndHandler = () => this.ifEnd();
  private readonly gosubHandler = () => this.gosub();
  private readonly returnHandler = () => this.return();
  private readonly intHandler = () => this.declare(YurisType.Int);
  private readonly strHandler = () => this.declare(YurisType.String);
  private readonly nativeVarInfo: YurisCommandHandler | undefined;
  private readonly nativeVarAct: YurisCommandHandler | undefined;
  private readonly arrayRanges = new WeakMap<
    YurisInstruction,
    ReturnType<typeof scanArrayRanges>
  >();
  private readonly stringSlices = new WeakMap<
    YurisInstruction,
    ReturnType<typeof scanStringSlice>
  >();
  private readonly initializerLoops = new WeakMap<
    YurisInstruction,
    ReturnType<typeof scanInitializer>
  >();
  private readonly copyLoops = new WeakMap<YurisInstruction, ReturnType<typeof copyLoop>>();
  private readonly rowShifts = new WeakMap<YurisInstruction, ReturnType<typeof scanRowShift>>();
  private readonly guardLoops = new WeakMap<YurisInstruction, GuardLoop | null>();
  private readonly inactiveLoops = new WeakMap<YurisInstruction, InactiveLoop | null>();
  private readonly lexerRuns = new WeakMap<YurisInstruction, LexerScan | null>();
  private readonly characterSearches = new WeakMap<
    YurisInstruction,
    ReturnType<typeof scanCharacterSearch>
  >();
  private readonly activeScans = new WeakMap<
    YurisLoopEntry,
    {script: number} & ({guard: GuardLoop} | {inactive: InactiveLoop} | {lexer: LexerScan})
  >();
  private readonly loaded = new Map<number, LoadedScript>();
  private current!: LoadedScript;

  private constructor(
    readonly project: YurisProject,
    private readonly scripts: ReadonlyMap<number, YurisScript>,
    private readonly host: YurisMachineHost,
    settings: YurisStartupSettings,
  ) {
    this.variables = new YurisVariables(project.table.variableCount);
    this.system = new YurisSystem(this.variables, project.commands.table, host);
    this.expression = new YurisExpression(this.variables, this.system);
    this.system.textCount = project.table.textCount;
    this.system.settings = settings;
    this.system.simd = settings.simd !== 0;
    this.system.preloadEnabled = settings.preload !== 0;
    this.system.value79 = settings.value10;
    this.system.config23 = settings.value23;
    this.system.startTimers(host.now());
    // 0x468EB0: the desktop's size and colour depth.
    const desktop = host.desktop();
    this.system.desktopWidth = desktop.width;
    this.system.desktopHeight = desktop.height;
    this.system.bitsPerPixel = desktop.bitsPerPixel;
    this.files = new YurisFiles(host, project.config);
    // 0x46436C: an archive entry named `ysbin\yscfg.ybn` marks an archive installation.
    this.system.archives = this.files
      .archiveNames()
      .some((names) => names.some((name) => asciiLower(name) === 'ysbin\\yscfg.ybn'))
      ? 1
      : 0;
    this.installCore();
    this.nativeVarInfo = this.handlers[0x67];
    this.nativeVarAct = this.handlers[0x66];
    this.layers = new YurisLayers(this, this.files, host);
    this.layers.install();
    installYmv(this, host);
    installDialog(this, host);
    installFiles(this, host, host);
    this.input = new YurisInput(this.system, host);
    // 0x46C028: joyGetNumDevs at start-up.
    this.input.padsPresent = host.readPads().length > 0;
    installInput(this, this.input, host);
    this.windows = new YurisWindows(
      this,
      host,
      project.config.width || 640,
      project.config.height || 480,
    );
    this.windows.install();
    this.menus = new YurisMenus(this, host.menus);
    this.movie = new YurisMovie(this, host, host);
    this.fonts = new YurisFonts(host);
    installFonts(this, this.fonts);
    installTasks(this);
    // YSCF setting 0x8722D4: 0 no sound, 1 sound, 2 sound required.
    this.sounds = new YurisSounds(this, this.files, host, project.config.settings[3] ?? 0);
    this.sounds.install();
    installProduct(this, host, host, host);
    this.saveData = installSave(this, host);
    installText(this);
    installMath3d(this);
  }

  /**
   * Start-up (0x46BA54): the project files are loaded, the global variables (YSVR scopes 1 and
   * 3) initialised, and the main task starts at `SYSTEM_START` with that label's nesting.
   */
  static async create(project: YurisProject, host: YurisMachineHost): Promise<YurisMachine> {
    // 0x46BA54 calls 0x466AC0 first and stops when yscfg.dat cannot be read.
    const file = await host.readFile('yscfg.dat');
    if (file === null) {
      host.messageBox(STARTUP_SETTINGS_MISSING);
      throw new Error(STARTUP_SETTINGS_MISSING);
    }
    const scripts = new Map<number, YurisScript>();
    for (const file of project.files) scripts.set(file.index, await project.script(file.index));
    const machine = new YurisMachine(project, scripts, host, YurisStartupSettings.read(file));
    machine.variables.initialize(project.variables, -1, (bytes) =>
      machine.expression.string(bytes),
    );
    const index = machine.label(bytes('SYSTEM_START'));
    if (index < 0) throw new YurisError(0x1a694, ['SYSTEM_START']);
    const label = project.labels.labels[index]!;
    // 0x468ADA: the root and the group "" carry tasks; the leaf SYSTEM runs the program.
    const tree = machine.taskTree;
    tree.root.payload = new YurisTask('');
    tree.create('', true, 100n, new YurisTask(''));
    const task = new YurisTask('SYSTEM');
    task.noReturn = 1;
    task.node = tree.create('SYSTEM', false, 100n, task);
    machine.taskNode = task.node;
    machine.task = task;
    machine.system.task = task;
    task.script = label.script;
    machine.load(label.script);
    task.position = label.position;
    task.ifDepth = label.ifNest;
    task.loopDepth = label.loopNest;
    await machine.sounds.open();
    return machine;
  }

  /** `timeGetTime()` in milliseconds. */
  now(): number {
    return this.host.now();
  }

  /** WM_ACTIVATE of window `no` (0x45D738); the input reads the keyboard only while active. */
  activate(no: number, active: boolean): void {
    this.windows.activate(no, active);
    this.input.active = this.windows.windows.some((w) => w.exists && w.active);
  }

  /** Installs a command handler. */
  define(command: number, handler: YurisCommandHandler): void {
    this.handlers[command] = handler;
  }

  /** The command names of `ysc.ybn`. */
  commandName(command: number): string {
    return this.project.commands.commands[command]?.name ?? `#${command}`;
  }

  /** The name of argument `id` of the running command (`ysc.ybn`). */
  argName(id: number): string {
    return this.project.commands.commands[this.instruction.command]?.args[id]?.name ?? `#${id}`;
  }

  get tracksRasterText(): boolean {
    return this.host.rasterText === true;
  }

  get instruction(): YurisInstruction {
    return this.current.script.instructions[this.position]!;
  }

  /** The source line of the running instruction. */
  get line(): number {
    return this.current.script.lines[this.position] ?? 0;
  }

  /** Label lookup 0x451610; -1 when absent. */
  label(name: Uint8Array): number {
    return findYurisLabel(this.project.labels, name);
  }

  /**
   * One frame of 0x404164: the frame counter 0x871F48 advances, the dispatcher runs, the
   * windows are output and the frame's layer marks are cleared (0x410D30).
   */
  async frame(): Promise<void> {
    // 0x41022A..0x410261, then the suspended main loop 0x45C970 (messages and 10 ms sleeps).
    this.windows.background();
    this.movie.poll();
    while (this.system.suspended && !this.quit) {
      await this.host.sleep(10);
      this.windows.background();
    }
    this.input.poll(this.screenWidth, this.screenHeight);
    this.system.frames++;
    this.input.update(this.host.now(), this.pacer.time);
    // 0x404237: a TASK RESTART during a pass runs the dispatcher again.
    do {
      this.restartPending = false;
      this.system.passes++;
      await this.dispatch(this.taskTree.root);
    } while (this.restartPending && !this.quit);
    // One pass of the sound thread 0x41C6DC, which natively runs every 3 to 20 ms.
    await this.sounds.update();
    if (this.quit) return;
    const pacer = this.pacer,
      skipping = pacer.skipping;
    // 0x4109A8 between the window preparation 0x404824 and the output 0x40FCAC.
    const wait = pacer.begin(this.host.now());
    if (wait > 0) await this.host.sleep(wait);
    pacer.end(this.host.now(), wait > 0);
    // 0x4042A9/0x404352: tasks keep running during the OS movie; window
    // preparation/output is suppressed unless PRODUCT COM 0x1B enabled it.
    if (!skipping && (!this.movie.playing || this.system.runDuringMovie)) {
      this.host.present?.(this.layers);
      pacer.countDrawn();
      this.layers.frameEnd();
    }
    pacer.advance();
  }

  /**
   * The dispatcher 0x40449C: the children of `group` from the highest Z down (by position, so
   * nodes added or removed meanwhile shift the walk). After a RESTART the pass skips the
   * tasks above the restart Z until it reaches one at or below it. Groups recurse; a leaf
   * whose E and A are set and whose waits are over runs until a handler yields.
   */
  private async dispatch(group: YurisNode<YurisTask>): Promise<void> {
    for (let i = group.children.length - 1; i >= 0; i--) {
      const node = group.childAt(i + 1);
      if (!node) continue;
      if (!this.restartPending && this.restartZ !== 0n) {
        if (node.z > this.restartZ) continue;
        this.restartZ = 0n;
      }
      const task = node.payload!;
      if (!(task.enabled & task.active)) continue;
      if (node.group) {
        await this.dispatch(node);
        continue;
      }
      this.taskNode = node;
      task.pass = this.system.passes;
      this.select(task);
      if (task.flushText) {
        task.flushText = 0;
        this.system.text = '';
        this.system.textKinds = '';
      }
      if (task.waitFrames !== 0) task.waitFrames--;
      if (task.waitUntil !== 0 && this.host.now() >= task.waitUntil) task.waitUntil = 0;
      if (task.waitFrames + task.waitUntil !== 0) continue;
      await this.run(task);
    }
  }

  private select(task: YurisTask): void {
    this.task = task;
    this.system.task = task;
    if (this.current?.index !== task.script) this.current = this.loaded.get(task.script)!;
  }

  private async run(task: YurisTask): Promise<void> {
    let yielded = false;
    while (!this.quit && !yielded) {
      if (this.task !== task || this.system.task !== task || this.current.index !== task.script)
        this.select(task);
      const position = (this.position = task.position);
      const script = task.script;
      task.position = position + 1;
      const instruction = this.current.script.instructions[position];
      try {
        if (!instruction) throw new YurisError(0xdbbd2);
        const handler = this.handlers[instruction.command];
        // 0x45C958: commands without a handler.
        if (!handler) throw new YurisError(0xdbbd2);
        let result = handler(this);
        if (typeof result !== 'number') result = await result;
        // GOSUB/RETURN may have switched task.script; report the instruction's
        // source script, not the destination, for control-flow verification.
        this.host.trace?.(task, position, instruction, script);
        yielded = result !== 0;
      } catch (error) {
        if (!(error instanceof YurisError)) throw error;
        this.fail(error);
      }
    }
  }

  /** 0x409070: shows a message box; the command then yields (returns -1). */
  messageBox(text: string): number {
    this.host.messageBox(text);
    return -1;
  }

  /** 0x46C2BC: formats the `YSER` message with the file and line prefix and quits. */
  fail(error: YurisError): void {
    this.quit = true;
    const template = this.project.errors.get(error.code);
    const text = template ? sjisText(template) : `error ${error.code}`;
    const file = this.project.files.find((f) => f.index === this.task?.script);
    const prefix = file && error.prefix ? `${sjisText(file.name)}(${this.line}) ` : '';
    this.host.error(prefix + printf(text, error.args), error);
  }

  /** 0x4511C1: first use of a script resolves constant labels and initialises its variables. */
  load(index: number): void {
    if (this.loaded.has(index)) {
      this.current = this.loaded.get(index)!;
      return;
    }
    const script = this.scripts.get(index);
    if (!script) throw new YurisError(0xdbbd2);
    const count = script.instructions.length;
    const loaded: LoadedScript = {
      index,
      script,
      goLabel: new Int32Array(count).fill(-1),
      gosubLabel: new Uint16Array(count),
    };
    script.instructions.forEach((instruction, i) => {
      if (instruction.command === Command.Go) {
        const arg = instruction.args[0]!;
        const {value, constant} = this.expression.constant(arg.expression);
        const label = constant ? this.label(latin1(value)) : -1;
        if (label >= 0) loaded.goLabel[i] = label;
      } else if (instruction.command === Command.Gosub) {
        for (const arg of instruction.args) {
          if (arg.id !== 0) continue;
          const {value, constant} = this.expression.constant(arg.expression);
          const label = constant ? this.label(latin1(value)) : -1;
          if (label >= 0) loaded.gosubLabel[i] = label & 0xffff;
        }
      }
    });
    this.loaded.set(index, loaded);
    this.current = loaded;
    this.variables.initialize(this.project.variables, index, (b) => this.expression.string(b));
  }

  /** Loads a script for another task (0x4511C1) and keeps the running script current. */
  loadFor(index: number): void {
    const current = this.current;
    this.load(index);
    this.current = current;
  }

  /** The source line of `position` in a loaded script. */
  lineOf(script: number, position: number): number {
    return this.loaded.get(script)?.script.lines[position] ?? 0;
  }

  /** 0x8725F0: the source file name of a script number. */
  scriptName(script: number): ByteString {
    const file = this.project.files.find((f) => f.index === script);
    return file ? String.fromCharCode(...file.name) : '';
  }

  /** 0x46F350 over the script names: the script whose name matches, ASCII case-folded. */
  findScript(name: ByteString): number {
    const fold = (t: ByteString) => t.replace(/[A-Z]/g, (c) => c.toLowerCase());
    const wanted = fold(name);
    for (let i = 0; i < this.project.files.length; i++)
      if (fold(this.scriptName(i)) === wanted) return i;
    return -1;
  }

  /** Moves the task to a label's script position, loading the script when it changes. */
  private enter(script: number, position: number): void {
    this.task.position = position;
    if (this.task.script !== script) {
      this.task.script = script;
      this.load(script);
    }
    this.current = this.loaded.get(script)!;
  }

  /**
   * The argument decoder 0x4253C9 (0x4430C5 for GOSUB): records the arguments by slot,
   * evaluates them by their YSCM kind (0 number, 1 string, 2 expression kept, other kinds
   * left to the command) and applies the YSCM range check to the numeric slot value.
   */
  decode(): void {
    const a = this.args,
      instruction = this.instruction,
      declared = this.project.commands.commands[instruction.command]!;
    a.slot.fill(0);
    a.count = instruction.args.length;
    a.records.length = 0;
    for (let i = 1; i <= a.count; i++) {
      const arg = instruction.args[i - 1]!;
      a.records.push(arg);
      a.id[i] = arg.id;
      a.type[i] = arg.type;
      a.op[i] = arg.op;
      a.size[i] = arg.size;
      a.offset[i] = arg.offset;
      a.slot[arg.id] = i;
      const spec = declared.args[arg.id];
      const kind = spec?.kind ?? 3;
      if (kind === 0) {
        a.value[i] = this.expression.intOf(arg.type, arg.expression);
        this.recordVariable(i);
      } else if (kind === 1) {
        a.string[i] = this.expression.string(arg.expression);
        this.recordVariable(i);
      } else if (kind === 2) {
        a.expression[i] = arg.expression;
      }
      this.check(spec?.check ?? 0, a.value[i]!, declared.name, spec?.name ?? '');
    }
  }

  private recordVariable(i: number): void {
    const e = this.expression;
    this.args.variable[i] = e.lastId;
    this.args.variableIndex[i] = e.lastIndex;
    this.args.whole[i] = e.wholeVariable ? 1 : 0;
  }

  private check(code: number, value: bigint, command: string, name: string): void {
    if (code === 0) return;
    const low = Number(value & 0xffffffffn) >>> 0;
    if (code === 1 || code === 2) {
      const min = RANGES[code]![0];
      if (value < BigInt(min)) throw new YurisError(0x18a92, [command, name, value, min]);
    } else if (code >= 3 && code <= 0x17) {
      const [min, max] = RANGES[code]!;
      if ((low - min) >>> 0 > (max - min) >>> 0)
        throw new YurisError(0x18a88, [command, name, value, min, max]);
    } else if (code === 0x18) {
      if ((low + 1) >>> 0 >= 0x1000001) throw new YurisError(0x18a9c, [command, name, value]);
    } else if (code === 0x19) {
      if (low >= 0x1000000) throw new YurisError(0x18aa6, [command, name, value]);
    } else if (code === 0x1a || code === 0x1b) {
      const limit = (code === 0x1a ? this.screenWidth : this.screenHeight) - 1;
      if (low > limit >>> 0) throw new YurisError(0x18a88, [command, name, value, 0, limit]);
    } else if (code === 0x1c) {
      if (value < 0n) throw new YurisError(0x18b64, [command, name, value]);
      if (value > 3n) throw new YurisError(0x18b5a, [command, name, value]);
    }
  }

  /**
   * LABELINFO 0x443A38: with EXIST, the LET element becomes 1 when the label `#` exists and 0
   * otherwise (1.0 / 0.0 for a float element).
   */
  private labelInfo(): number {
    const a = this.args;
    this.decode();
    if (!a.has(2)) return 0;
    const slot = a.has(1);
    const found = this.label(latin1(a.text(0))) >= 0;
    this.setInt(a.variable[slot]!, a.variableIndex[slot]!, found ? 1n : 0n);
    return 0;
  }

  /** FPS 0x442A68: SET (0x442AB8) sets the frame rate, SKIP whether late frames skip output. */
  private fps(): number {
    const a = this.args;
    this.decode();
    if (a.has(0)) this.pacer.setRate(Number(BigInt.asIntN(32, a.int(0))), this.host.now());
    if (a.has(1)) this.pacer.skip = Number(BigInt.asIntN(32, a.int(1)));
    return 0;
  }

  /** Width and height of the main window's screen (0x87279C + 0xC / + 0x10). */
  get screenWidth(): number {
    return this.windows?.windows[0]!.width ?? (this.project.config.width || 640);
  }
  get screenHeight(): number {
    return this.windows?.windows[0]!.height ?? (this.project.config.height || 480);
  }

  /** The expression bytes of the running instruction's argument at `position` (1-based). */
  argument(position: number): YurisArgument {
    return this.instruction.args[position - 1]!;
  }

  private installCore(): void {
    const nothing = () => 0;
    // 0x469A24: ALIAS, DEBUGLIST, PREP, RETURNBREAK, S_INT, S_FLT, S_STR.
    for (const c of [
      Command.Alias,
      Command.DebugList,
      Command.Prep,
      Command.ReturnBreak,
      Command.SFlt,
      Command.SInt,
      Command.SStr,
    ])
      this.define(c, nothing);
    this.define(Command.Label, nothing);
    this.define(Command.LabelInfo, () => this.labelInfo());
    this.define(Command.Fps, () => this.fps());
    this.define(Command.If, this.ifHandler);
    this.define(Command.Else, this.elseHandler);
    this.define(Command.IfBlend, this.ifBlendHandler);
    this.define(Command.IfEnd, this.ifEndHandler);
    this.define(Command.IfBreak, () => this.ifBreak(false));
    this.define(Command.IfContinue, () => this.ifBreak(true));
    this.define(Command.Loop, this.loopHandler);
    this.define(Command.LoopEnd, this.loopEndHandler);
    this.define(Command.LoopBreak, () => this.loopBreak(true));
    this.define(Command.LoopContinue, () => this.loopBreak(false));
    this.define(Command.Go, () => this.go());
    this.define(Command.Gosub, this.gosubHandler);
    this.define(Command.Return, this.returnHandler);
    this.define(Command.Wait, () => this.wait());
    this.define(Command.End, () => this.end());
    this.define(Command.Int, this.intHandler);
    this.define(Command.Flt, () => this.declare(YurisType.Float));
    this.define(Command.Str, this.strHandler);
    this.define(Command.Let, this.letHandler);
    installVariableCommands(this);
    installMath(this, this.host.now());
  }

  /** IF 0x4435B0: pushes the IF entry, then jumps to the next branch or IFEND when false. */
  private if(): number {
    const task = this.task,
      [condition, next, end] = this.instruction.args as [
        YurisArgument,
        YurisArgument,
        YurisArgument,
      ];
    const entry = task.ifEntry(task.ifDepth);
    entry.position = this.position;
    entry.loopDepth = task.loopDepth;
    entry.end = end.size;
    task.ifDepth++;
    if (task.ifDepth >= NESTING_LIMIT) throw new YurisError(0x18ce0, ['IF', 'IF', NESTING_LIMIT]);
    if (this.expression.intOf(condition.type, condition.expression) === 0n)
      task.position = next.size !== 0 ? next.size : end.size;
    return 0;
  }

  /** ELSE 0x43D710: a conditional ELSE tests like IF; a plain ELSE continues. */
  private else(): number {
    const task = this.task;
    if (task.ifDepth === 0) throw new YurisError(0x18bb4, ['ELSE', 'ELSE', 'IF']);
    if (this.instruction.args.length === 0) return 0;
    const [condition, next] = this.instruction.args as [YurisArgument, YurisArgument];
    if (this.expression.intOf(condition.type, condition.expression) === 0n)
      task.position = next.size !== 0 ? next.size : task.ifs[task.ifDepth - 1]!.end;
    return 0;
  }

  /** IFBLEND 0x4436A8: the end of a taken branch jumps to IFEND. */
  private ifBlend(): number {
    const task = this.task;
    if (task.ifDepth === 0) throw new YurisError(0x18bb4, ['IFBLEND', 'IFBLEND', 'IF']);
    task.position = task.ifs[task.ifDepth - 1]!.end;
    return 0;
  }

  /** IFEND 0x4437F8. */
  private ifEnd(): number {
    const task = this.task;
    if (task.ifDepth === 0) throw new YurisError(0x18bb4, ['IFEND', 'IFEND', 'IF']);
    task.ifDepth--;
    task.ifs[task.ifDepth]!.end = 0;
    return 0;
  }

  /** IFBREAK 0x4436E8 and IFCONTINUE 0x443770: leave or restart the LV-th enclosing IF. */
  private ifBreak(restart: boolean): number {
    this.decode();
    const task = this.task;
    const levels = this.args.has(0) ? Number(this.args.int(0)) : 1;
    if (levels < 1) return 0;
    const depth = task.ifDepth - levels + 1;
    if (depth <= 0) throw new YurisError(0x18bb4, [restart ? 'IFCONTINUE' : 'IFBREAK', 'IF', 'IF']);
    const entry = task.ifs[depth - 1]!;
    if (restart) {
      task.ifDepth = depth - 1;
      task.position = entry.position;
    } else {
      task.ifDepth = depth;
      task.position = entry.end;
    }
    task.loopDepth = entry.loopDepth;
    return 0;
  }

  /** LOOP 0x445DC4: pushes the loop; a count of 0 jumps to LOOPEND, -1 loops forever. */
  private loop(): number {
    this.decode();
    const task = this.task,
      [count, end] = this.instruction.args as [YurisArgument, YurisArgument];
    const entry = task.loopEntry(task.loopDepth);
    this.activeScans.delete(entry);
    entry.start = this.position + 1;
    entry.ifDepth = task.ifDepth;
    entry.limit = this.expression.intOf(count.type, count.expression);
    entry.end = end.size;
    entry.counter = 1n;
    task.loopDepth++;
    if (task.loopDepth >= NESTING_LIMIT)
      throw new YurisError(0x18ce0, ['LOOP', 'LOOP', NESTING_LIMIT]);
    if (entry.limit === 0n) {
      entry.counter = 0n;
      task.position = entry.end;
    } else if (
      entry.limit > 2n &&
      entry.end === entry.start + 5 &&
      this.batchCharacterSearch(entry)
    ) {
      return 0;
    } else if (entry.limit === -1n || (entry.limit >= 64n && entry.limit <= 4_000_000n))
      this.batchLoop(entry);
    return 0;
  }

  private batchCharacterSearch(entry: YurisLoopEntry): boolean {
    const instruction = this.instruction;
    let search = this.characterSearches.get(instruction);
    if (search === undefined) {
      search = scanCharacterSearch(
        this.current.script.instructions,
        entry.start,
        entry.end,
        this.project.commands,
      );
      this.characterSearches.set(instruction, search);
    }
    if (
      !search ||
      entry.ifDepth + 1 >= NESTING_LIMIT ||
      this.handlers[0x66] !== this.nativeVarAct ||
      this.handlers[Command.If] !== this.ifHandler ||
      this.handlers[Command.IfEnd] !== this.ifEndHandler ||
      this.handlers[Command.LoopEnd] !== this.loopEndHandler ||
      !this.canBatchLoop(this.task.script, this.position, entry.end)
    )
      return false;
    const variables = this.variables.entries;
    const strings = variables[55],
      counter = variables[48];
    const cursor = variables[search.cursor],
      length = variables[search.length];
    const scratch = variables[search.scratch];
    if (
      strings?.type !== YurisType.String ||
      strings.dimensions.length !== 1 ||
      strings.dimensions[0]! < 3 ||
      !strings.has(1) ||
      counter?.type !== YurisType.Int ||
      cursor?.type !== YurisType.Int ||
      cursor.ints?.[0] === undefined ||
      length?.type !== YurisType.Int ||
      length.ints?.[0] !== 1n ||
      scratch?.type !== YurisType.String ||
      scratch.dimensions.length !== 0 ||
      !scratch.has(0)
    )
      return false;
    const source = this.system.string(55, 1, 0);
    const needle = this.system.string(55, 2, 0);
    if (!needle || needle.length > 2 || needle.includes('\0') || source.includes('\0'))
      return false;
    const {count, offsets} = characterOffsets(this, source);
    const first = Number(cursor.ints[0]);
    const limit = Number(entry.limit);
    if (
      !Number.isSafeInteger(first) ||
      first < 0 ||
      limit > count - first ||
      offsets[first + limit]! > source.length
    )
      return false;
    const end = first + limit;
    let at = first;
    while (
      at < end &&
      (offsets[at + 1]! - offsets[at]! !== needle.length ||
        !source.startsWith(needle, offsets[at]!))
    )
      at++;
    // Re-run the last rejected iteration, or the sole matching iteration if it is first.
    entry.counter = BigInt(Math.max(1, Math.min(limit, at - first)));
    return true;
  }

  private batchLoop(entry: YurisLoopEntry): void {
    const script = this.task.script;
    if (
      this.handlers[Command.Let] !== this.letHandler ||
      this.handlers[Command.LoopEnd] !== this.loopEndHandler ||
      !this.canBatchLoop(script, this.position, entry.end)
    )
      return;
    const instruction = this.instruction;
    const instructions = this.current.script.instructions;
    if (entry.limit !== -1n) {
      let copy = this.copyLoops.get(instruction);
      if (copy === undefined) {
        copy = copyLoop(instructions, entry.start, entry.end);
        this.copyLoops.set(instruction, copy);
      }
      if (copy && applyCopyLoop(copy, this.variables, Number(entry.limit))) {
        entry.counter = entry.limit;
        return;
      }
      if (
        this.task.loopDepth + 1 < NESTING_LIMIT &&
        this.handlers[Command.Loop] === this.loopHandler
      ) {
        let shift = this.rowShifts.get(instruction);
        if (shift === undefined) {
          shift = scanRowShift(instructions, entry.start, entry.end);
          this.rowShifts.set(instruction, shift);
        }
        if (shift && applyRowShift(shift, this.variables, Number(entry.limit))) {
          entry.counter = entry.limit;
          return;
        }
      }
      if (
        this.task.gosubDepth < 0x3f &&
        this.handlers[Command.Gosub] === this.gosubHandler &&
        this.handlers[Command.Return] === this.returnHandler &&
        this.handlers[Command.Int] === this.intHandler
      ) {
        let initializer = this.initializerLoops.get(instruction);
        if (initializer === undefined) {
          const label = this.current.gosubLabel[entry.start];
          const target = label ? this.project.labels.labels[label] : undefined;
          initializer =
            target?.script === script
              ? scanInitializer(instructions, entry.start, entry.end, target.position)
              : null;
          this.initializerLoops.set(instruction, initializer);
        }
        if (
          initializer &&
          this.canBatchLoop(script, initializer.start, initializer.end) &&
          applyInitializer(initializer, this.variables, Number(entry.limit))
        ) {
          entry.counter = entry.limit;
          return;
        }
      }
    }
    if (
      entry.ifDepth >= NESTING_LIMIT - 1 ||
      this.handlers[Command.If] !== this.ifHandler ||
      this.handlers[Command.IfEnd] !== this.ifEndHandler
    )
      return;
    if (entry.limit === -1n) {
      if (entry.end - entry.start === 241) {
        let lexer = this.lexerRuns.get(instruction);
        if (lexer === undefined) {
          lexer = this.findLexerScan(entry);
          this.lexerRuns.set(instruction, lexer);
        }
        if (lexer) {
          this.activeScans.set(entry, {script, lexer});
          return;
        }
      }
      let inactive = this.inactiveLoops.get(instruction);
      if (inactive === undefined) {
        inactive = scanInactiveLoop(instructions, entry.start, entry.end);
        this.inactiveLoops.set(instruction, inactive);
      }
      if (inactive) {
        this.activeScans.set(entry, {script, inactive});
        entry.counter += BigInt(skipInactiveLoop(inactive, this.variables));
      }
    } else {
      let guard = this.guardLoops.get(instruction);
      if (guard === undefined) {
        guard = scanGuardLoop(instructions, entry.start, entry.end);
        this.guardLoops.set(instruction, guard);
      }
      if (guard && this.canSkipBranches(guard, entry.ifDepth)) {
        this.activeScans.set(entry, {script, guard});
        entry.counter = BigInt(skipGuardLoop(guard, this.variables, 1, Number(entry.limit)));
      }
    }
  }

  /** LOOPEND 0x4460AC: counts the iteration and repeats until the counter reaches the limit. */
  private loopEnd(): number {
    const task = this.task;
    if (task.loopDepth === 0) throw new YurisError(0x1a658);
    const entry = task.loops[task.loopDepth - 1]!;
    if (entry.limit !== -1n && entry.counter >= entry.limit) {
      task.loopDepth--;
      this.activeScans.delete(entry);
      entry.counter = 0n;
      entry.limit = 0n;
      entry.start = 0;
      return 0;
    }
    entry.counter = i64(entry.counter + 1n);
    const scan = this.activeScans.get(entry);
    if (
      scan?.script === task.script &&
      this.position === entry.end &&
      this.handlers[Command.Let] === this.letHandler &&
      this.handlers[Command.If] === this.ifHandler &&
      this.handlers[Command.IfEnd] === this.ifEndHandler &&
      this.canBatchLoop(task.script, entry.start, entry.end)
    ) {
      if ('inactive' in scan)
        entry.counter = i64(
          entry.counter + BigInt(skipInactiveLoop(scan.inactive, this.variables)),
        );
      else if ('lexer' in scan)
        entry.counter = i64(entry.counter + BigInt(this.skipLexerRun(scan.lexer, entry.ifDepth)));
      else if (this.canSkipBranches(scan.guard, entry.ifDepth))
        entry.counter = BigInt(
          skipGuardLoop(scan.guard, this.variables, Number(entry.counter), Number(entry.limit)),
        );
    }
    task.position = entry.start;
    task.ifDepth = entry.ifDepth;
    return 0;
  }

  private findLexerScan(entry: YurisLoopEntry): LexerScan | null {
    const {start, end} = entry;
    const run = scanLexerRun(this.current.script.instructions, start, end, this.project.commands);
    const target = this.current.gosubLabel[start + 3];
    if (!run || !target || target !== this.current.gosubLabel[start + 5]) return null;
    const callee = this.project.labels.labels[target];
    const code = callee && this.scripts.get(callee.script)?.instructions;
    if (!code) return null;
    const slice = scanStringSlice(code, callee.position, this.project.commands);
    if (!slice) return null;
    const used = new Set([run.text, run.cursor, run.count, run.state, ...run.scratch]);
    if (run.word) {
      used.add(run.word.high);
      used.add(run.word.low);
      used.add(run.word.result);
    }
    if ([slice.result, slice.start, slice.length, slice.count].some((id) => used.has(id)))
      return null;
    return {run, calleeScript: callee.script, calleePosition: callee.position};
  }

  private skipLexerRun(scan: LexerScan, ifDepth: number): number {
    const {run, calleeScript, calleePosition} = scan;
    const variables = this.variables.entries;
    const cursor = variables[run.cursor],
      state = variables[run.state];
    const phase = Number(state?.ints?.[0]);
    if (
      state?.type !== YurisType.Int ||
      state.dimensions.length !== 0 ||
      !(
        phase === 22 ||
        (run.spaces && (phase === 31 || phase === 32)) ||
        (run.comments && phase === 99) ||
        (run.word && phase >= 91 && phase <= 96)
      ) ||
      cursor?.type !== YurisType.Int ||
      cursor.dimensions.length !== 0 ||
      !cursor.ints ||
      ifDepth + 3 >= NESTING_LIMIT ||
      this.task.gosubDepth >= 0x3f ||
      !this.loaded.has(calleeScript) ||
      !this.canBatchLoop(calleeScript, calleePosition, calleePosition + 13) ||
      this.handlers[Command.Else] !== this.elseHandler ||
      this.handlers[Command.IfBlend] !== this.ifBlendHandler ||
      this.handlers[Command.Gosub] !== this.gosubHandler ||
      this.handlers[Command.Return] !== this.returnHandler ||
      this.handlers[Command.Str] !== this.strHandler ||
      this.handlers[Command.Int] !== this.intHandler ||
      this.handlers[0x66] !== this.nativeVarAct ||
      this.handlers[0x67] !== this.nativeVarInfo
    )
      return 0;
    const text = variables[run.text],
      count = variables[run.count];
    const result = variables[62],
      ints = variables[53],
      strings = variables[55];
    if (
      text?.type !== YurisType.String ||
      text.dimensions.length !== 0 ||
      !text.has(0) ||
      count?.type !== YurisType.Int ||
      count.dimensions.length !== 0 ||
      result?.type !== YurisType.String ||
      result.dimensions.length !== 1 ||
      result.dimensions[0]! < 2 ||
      ints?.type !== YurisType.Int ||
      ints.dimensions.length !== 1 ||
      ints.dimensions[0]! < 4 ||
      strings?.type !== YurisType.String ||
      strings.dimensions.length !== 1 ||
      strings.dimensions[0]! < 2 ||
      !strings.has(1)
    )
      return 0;
    for (let i = 0; i < run.scratch.length; i++) {
      const scratch = variables[run.scratch[i]!];
      if (
        scratch?.type !== (i < 2 ? YurisType.String : YurisType.Int) ||
        scratch.dimensions.length !== 0 ||
        !scratch.has(0)
      )
        return 0;
    }
    const source = text.strings?.[0];
    if (source === undefined || source.includes('\0')) return 0;
    const offsets = characterOffsets(this, source);
    const from = Number(cursor.ints[0]) - 1;
    if (from < 0 || from >= offsets.count || count.ints?.[0] !== BigInt(offsets.count)) return 0;
    let to = from;
    if (phase >= 91 && phase <= 96) {
      const word = run.word!;
      const high = variables[word.high],
        low = variables[word.low];
      const result = variables[word.result];
      if (
        high?.type !== YurisType.Int ||
        high.dimensions.length !== 1 ||
        low?.type !== YurisType.Int ||
        low.dimensions.length !== 1 ||
        result?.type !== YurisType.Int ||
        result.dimensions.length !== 0 ||
        !result.has(0)
      )
        return 0;
      while (to < offsets.count) {
        const at = offsets.offsets[to]!;
        const byte = source.charCodeAt(at);
        const lead = isLeadByte(byte);
        const hi = high.ints?.[lead ? byte : 0];
        const lo = low.ints?.[lead ? 0 : byte];
        if (hi === undefined || lo === undefined || i64(hi + lo) === 0n) break;
        to++;
      }
    } else {
      const single = phase === 31 ? 32 : 9;
      while (to < offsets.count) {
        const byte = source.charCodeAt(offsets.offsets[to]!);
        if (
          phase === 22
            ? byte === 34 || byte === 13
            : phase === 99
              ? byte === 13 ||
                (byte === 42 &&
                  to + 1 < offsets.count &&
                  source.charCodeAt(offsets.offsets[to + 1]!) === 47)
              : byte !== single
        )
          break;
        to++;
      }
    }
    const skipped = Math.max(0, to - from - 1);
    if (skipped) cursor.ints[0] = BigInt(from + skipped + 1);
    return skipped;
  }

  private canBatchLoop(script: number, first: number, last: number): boolean {
    return !this.host.trace || this.host.traceRange?.(script, first, last) === false;
  }

  private canSkipBranches(guard: GuardLoop, depth: number): boolean {
    return (
      guard.branchDepth === undefined ||
      (depth + guard.branchDepth < NESTING_LIMIT &&
        this.handlers[Command.Else] === this.elseHandler &&
        this.handlers[Command.IfBlend] === this.ifBlendHandler)
    );
  }

  /** LOOPBREAK 0x445F60 and LOOPCONTINUE 0x446018: jump to the LV-th enclosing LOOPEND. */
  private loopBreak(leave: boolean): number {
    this.decode();
    const task = this.task;
    const levels = this.args.has(0) ? Number(this.args.int(0)) : 1;
    if (levels < 1) return 0;
    const depth = task.loopDepth - levels + 1;
    if (depth <= 0)
      throw new YurisError(0x18bb4, [leave ? 'LOOPBREAK' : 'LOOPCONTINUE', 'LOOP', 'LOOP']);
    task.loopDepth = depth;
    const entry = task.loops[depth - 1]!;
    task.position = entry.end;
    task.ifDepth = entry.ifDepth;
    if (leave) {
      entry.counter = 0n;
      entry.limit = 0n;
    }
    return 0;
  }

  /** GO 0x442AF0: jumps to a label, taking its nesting relative to the GOSUB caller. */
  private go(): number {
    const task = this.task;
    let index = this.current.goLabel[this.position]!;
    if (index < 0) {
      const name = this.expression.string(this.instruction.args[0]!.expression);
      index = this.label(latin1(name));
      if (index < 0) throw new YurisError(0x1a694, [name]);
    }
    const label = this.project.labels.labels[index]!;
    let ifDepth = label.ifNest,
      loopDepth = label.loopNest;
    if (task.gosubDepth > 0) {
      const caller = task.frameAt(task.gosubDepth - 1);
      ifDepth = ((ifDepth + caller.ifDepth) << 24) >> 24;
      loopDepth = ((loopDepth + caller.loopDepth) << 24) >> 24;
    }
    task.ifDepth = ifDepth;
    task.loopDepth = loopDepth;
    if (ifDepth > 0x3f) throw new YurisError(0x18ce0, ['GO', 'IF', NESTING_LIMIT]);
    if (loopDepth > 0x3f) throw new YurisError(0x18ce0, ['GO', 'LOOP', NESTING_LIMIT]);
    this.enter(label.script, label.position);
    return 0;
  }

  /**
   * GOSUB 0x442C84: fills the callee frame's PINT/PFLT/PSTR (counts from the instruction's
   * u16: ints `(x & 0xFF) >> 3`, floats `(x & 7) * 4 + (x >> 14)`, strings `(x >> 9) & 0x1F`),
   * saves the return position and nesting in the current frame and jumps.
   */
  private gosub(): number {
    this.decode();
    const task = this.task,
      a = this.args,
      depth = task.gosubDepth;
    if (depth === 0x3f) throw new YurisError(0x18ce0, ['GOSUB', 'GOSUB', NESTING_LIMIT]);
    const callee = task.frameAt(depth + 1);
    const extra = this.instruction.extra;
    const ints = (extra & 0xff) >> 3,
      floats = (((extra & 7) * 4 + (extra >> 14)) << 24) >> 24,
      strings = (extra >> 9) & 0x1f;
    callee.flags[0]![0] = ints;
    callee.flags[1]![0] = floats;
    callee.flags[2]![0] = strings;
    if (a.count !== 1 || a.slot[0] === 0) {
      for (let i = 1; i <= ints; i++) {
        const s = a.slot[i]!;
        callee.ints[0]![i] = s ? a.value[s]! : 0n;
        callee.flags[0]![i] = s ? 1 : 0;
      }
      for (let i = 1; i <= floats; i++) {
        const s = a.slot[16 + i]!;
        callee.floats[0]![i] = s ? this.expression.float(a.expression[s]!) : 0;
        callee.flags[1]![i] = s ? 1 : 0;
      }
      for (let i = 1; i <= strings; i++) {
        const s = a.slot[32 + i]!;
        callee.strings[0]![i] = s ? a.string[s]! : callee.strings[0]![i] === null ? null : '';
        callee.flags[2]![i] = s ? 1 : 0;
      }
    }
    const s = a.slot[0]!;
    let index = this.current.gosubLabel[this.position]!;
    if (index === 0) {
      const name = a.string[s]!;
      index = this.label(latin1(name));
      if (index < 0) throw new YurisError(0x1a694, [name]);
    }
    const label = this.project.labels.labels[index]!;
    const frame = task.frameAt(depth);
    frame.returnPosition = this.position + 1;
    frame.returnScript = task.script;
    frame.returnLine = this.line;
    frame.ifDepth = task.ifDepth;
    frame.loopDepth = task.loopDepth;
    task.gosubDepth++;
    this.enter(label.script, label.position);
    const command = this.current.script.instructions[label.position]?.command;
    if (command === Command.Str) this.foldStringSlice(frame.returnScript, label.position);
    else if (command === Command.Int) this.foldArrayRanges(frame.returnScript, label.position);
    return 0;
  }

  private foldStringSlice(caller: number, entry: number): void {
    const instructions = this.current.script.instructions;
    const first = instructions[entry];
    if (first?.command !== Command.Str) return;
    let slice = this.stringSlices.get(first);
    if (slice === undefined) {
      slice = scanStringSlice(instructions, entry, this.project.commands);
      this.stringSlices.set(first, slice);
    }
    const task = this.task;
    if (
      !slice ||
      task.ifDepth + 3 >= NESTING_LIMIT ||
      this.handlers[Command.Str] !== this.strHandler ||
      this.handlers[Command.Int] !== this.intHandler ||
      this.handlers[Command.If] !== this.ifHandler ||
      this.handlers[0x67] !== this.nativeVarInfo ||
      !this.canBatchLoop(caller, this.position, this.position) ||
      !this.canBatchLoop(task.script, entry, entry + 13)
    )
      return;

    const variables = this.variables.entries;
    const ints = variables[53],
      strings = variables[55];
    if (
      ints?.type !== YurisType.Int ||
      ints.dimensions.length !== 1 ||
      ints.dimensions[0]! < 4 ||
      strings?.type !== YurisType.String ||
      strings.dimensions.length !== 1 ||
      strings.dimensions[0]! < 2 ||
      !strings.has(1) ||
      !variables[slice.result] ||
      !variables[slice.start] ||
      !variables[slice.length] ||
      !variables[slice.count]
    )
      return;
    const start = this.system.int(53, 2, 0);
    const length = this.system.int(53, 3, 0);
    if (start <= 0n || length <= 0n) return;
    const count = BigInt(characterOffsets(this, this.system.string(55, 1, 0)).count);
    if (start > count) return;

    const {result, start: startId, length: lengthId, count: countId} = slice;
    for (const id of [result, startId, lengthId, countId]) {
      const variable = variables[id]!;
      if (variable.dimensions.length) variable.dimensions = [];
    }
    this.variables.allocateString(result, '');
    this.variables.allocateInt(startId, start);
    this.variables.allocateInt(lengthId, length);
    this.variables.allocateInt(countId, count);
    const outer = task.ifEntry(task.ifDepth++);
    outer.position = entry + 5;
    outer.loopDepth = task.loopDepth;
    outer.end = entry + 12;
    const inner = task.ifEntry(task.ifDepth++);
    inner.position = entry + 6;
    inner.loopDepth = task.loopDepth;
    inner.end = entry + 11;
    task.position = entry + 7;
  }

  private foldArrayRanges(caller: number, entry: number): void {
    const instructions = this.current.script.instructions;
    const first = instructions[entry]!;
    let ranges = this.arrayRanges.get(first);
    if (ranges === undefined) {
      ranges = scanArrayRanges(instructions, entry, this.project.commands);
      this.arrayRanges.set(first, ranges);
    }
    const task = this.task;
    if (
      !ranges ||
      task.ifDepth + 1 >= NESTING_LIMIT ||
      this.handlers[Command.Int] !== this.intHandler ||
      this.handlers[Command.If] !== this.ifHandler ||
      this.handlers[Command.IfEnd] !== this.ifEndHandler ||
      this.handlers[Command.IfBlend] !== this.ifBlendHandler ||
      this.handlers[Command.Else] !== this.elseHandler ||
      this.handlers[Command.Let] !== this.letHandler ||
      !this.canBatchLoop(caller, this.position, this.position) ||
      !this.canBatchLoop(task.script, entry, entry + 9)
    )
      return;

    const variables = this.variables.entries;
    const params = variables[53];
    if (
      params?.type !== YurisType.Int ||
      params.dimensions.length !== 1 ||
      params.dimensions[0]! < 3
    )
      return;
    const index = this.system.int(53, 1, 0);
    const value = this.system.int(53, 2, 0);
    const element = Number(index);
    if (element < 0 || element > 0x7fffffff) return;
    const [lo0, hi0, lo1, hi1] = ranges.arrays;
    const lo = variables[lo0],
      hi = variables[hi0],
      nextLo = variables[lo1],
      nextHi = variables[hi1];
    if (!lo || !hi || !nextLo || !nextHi) return;
    for (const array of [lo, hi, nextLo, nextHi])
      if (
        array.type !== YurisType.Int ||
        array.dimensions.length !== 1 ||
        array.dimensions[0]! <= element ||
        array.ints?.[element] === undefined
      )
        return;
    if (!variables[ranges.index] || !variables[ranges.value] || !variables[ranges.result]) return;

    const inside =
      (lo.ints![element]! <= value && value <= hi.ints![element]!) ||
      (nextLo.ints![element]! <= value && value <= nextHi.ints![element]!);
    for (const id of [ranges.index, ranges.value, ranges.result]) {
      const variable = variables[id]!;
      if (variable.dimensions.length) variable.dimensions = [];
    }
    this.variables.allocateInt(ranges.index, index);
    this.variables.allocateInt(ranges.value, value);
    this.variables.allocateInt(ranges.result, inside ? 1n : 0n);
    const branch = task.ifEntry(task.ifDepth);
    branch.position = entry + 3;
    branch.loopDepth = task.loopDepth;
    branch.end = 0;
    task.position = entry + 9;
  }

  /**
   * RETURN 0x44B7DC: stores RINT/RFLT/RSTR in the caller's frame and resumes it; at depth 0
   * the task ends (0x451AE8).
   */
  private return(): number {
    this.decode();
    const task = this.task,
      a = this.args,
      depth = task.gosubDepth;
    if (depth > 0) {
      const caller = task.frameAt(depth - 1);
      const extra = this.instruction.extra;
      const ints = (extra & 0xff) >> 3,
        floats = (((extra & 7) * 4 + (extra >> 14)) << 24) >> 24,
        strings = (extra >> 9) & 0x1f;
      caller.flags[3]![0] = ints;
      caller.flags[4]![0] = floats;
      caller.flags[5]![0] = strings;
      if (a.count !== 0) {
        for (let i = 1; i <= ints; i++) {
          const s = a.slot[i - 1]!;
          caller.ints[1]![i] = s ? a.value[s]! : 0n;
          caller.flags[3]![i] = s ? 1 : 0;
        }
        for (let i = 1; i <= floats; i++) {
          const s = a.slot[15 + i]!;
          caller.floats[1]![i] = s ? this.expression.float(a.expression[s]!) : 0;
          caller.flags[4]![i] = s ? 1 : 0;
        }
        for (let i = 1; i <= strings; i++) {
          const s = a.slot[31 + i]!;
          caller.strings[1]![i] = s ? a.string[s]! : caller.strings[1]![i] === null ? null : '';
          caller.flags[5]![i] = s ? 1 : 0;
        }
      }
      task.gosubDepth--;
      this.enter(caller.returnScript, caller.returnPosition);
      return 0;
    }
    if (task.noReturn) throw new YurisError(0x18bb4, ['RETURN', 'RETURN', 'GOSUB']);
    this.taskTree.remove(this.taskNode); // 0x451AE8
    return -1;
  }

  /** WAIT 0x45611C: FRAME frames, else TIME milliseconds. */
  private wait(): number {
    this.decode();
    const frames = this.args.has(0) ? this.args.int(0) : 0n;
    const time = this.args.has(1) ? this.args.int(1) : 0n;
    if (frames !== 0n) {
      this.task.waitFrames = Number(frames & 0xffffffffn) | 0;
      return -1;
    }
    if (time !== 0n) {
      this.task.waitUntil = this.host.now() + Number(time & 0xffffffffn);
      return -1;
    }
    return 0;
  }

  /** END 0x43DE08: the exit code is the optional argument's low byte. */
  private end(): number {
    this.decode();
    if (this.args.count > 0) this.exitCode = Number(this.args.value[1]! & 0xffn);
    this.quit = true;
    return 0;
  }

  /**
   * INT 0x4438FC, FLT 0x4415C0, STR 0x44FBC8: the target is evaluated in declaration mode,
   * which records its dimensions instead of reading it, then the variable is re-created with
   * every element set to the value.
   */
  private declare(type: YurisType): number {
    this.decode();
    const e = this.expression,
      [target, value] = this.instruction.args as [YurisArgument, YurisArgument | undefined];
    e.declaring = true;
    try {
      e.int(target.expression);
    } finally {
      e.declaring = false;
    }
    const id = e.lastId;
    const variable = this.variables.get(id);
    variable.dimensions = e.declaredDimensions;
    if (type === YurisType.Int)
      this.variables.allocateInt(id, value ? e.intOf(value.type, value.expression) : 0n);
    else if (type === YurisType.Float)
      this.variables.allocateFloat(id, value ? e.floatOf(value.type, value.expression) : 0);
    else
      this.variables.allocateString(
        id,
        value ? e.string(value.expression).slice(0, STRING_CAPACITY - 1) : '',
      );
    return 0;
  }

  /**
   * LET 0x443BCC: evaluates the target for its variable and element, then applies the
   * assignment operator. A whole-variable reference re-creates every element. System
   * variables accept the writable ids only (error 0x18B1E otherwise).
   */
  private let(): number {
    const e = this.expression,
      [target, source] = this.instruction.args as [YurisArgument, YurisArgument];
    const op = target.op;
    e.intOf(target.type, target.expression);
    const id = e.lastId,
      index = e.lastIndex,
      whole = e.wholeVariable;
    const variable = this.variables.get(id);
    if (id >= SYSTEM_VARIABLE_LIMIT) {
      switch (variable.type) {
        case YurisType.Int: {
          const value = e.intOf(source.type, source.expression);
          if (whole) this.variables.allocateInt(id, value);
          else assignInt(variable.ints!, variable.count, index, op, value);
          return 0;
        }
        case YurisType.Float: {
          const value = whole
            ? e.floatOf(source.type, source.expression)
            : e.floatAlways(source.expression);
          if (whole) this.variables.allocateFloat(id, value);
          else assignFloat(variable.floats!, variable.count, index, op, value);
          return 0;
        }
        case YurisType.String:
          return this.assignString(id, index, op, whole, source);
      }
      throw new YurisError(0x18b14);
    }
    if (whole) return 0;
    this.assignSystem(
      id,
      Number(index & 0xffffffffn),
      Number(BigInt.asIntN(32, index >> 32n)),
      op,
      source,
    );
    return 0;
  }

  private assignString(
    id: number,
    index: bigint,
    op: number,
    whole: boolean,
    source: YurisArgument,
  ): number {
    const e = this.expression;
    if (whole) {
      this.variables.allocateString(id, e.stringOf(source.type, source.expression));
      return 0;
    }
    if (op === 0) {
      this.setString(id, index, e.stringOf(source.type, source.expression));
      return 0;
    }
    if (op !== 1) throw new YurisError(0x18b14);
    const current = this.getString(id, index);
    // The bound counts the source expression's bytes, as 0x443BCC does.
    if (source.size + current.length < STRING_CAPACITY)
      this.setString(id, index, current + e.stringOf(source.type, source.expression));
    return 0;
  }

  /**
   * The element accessors 0x459854 (int), 0x4597DC (float) and 0x44D8AC (string). The index is
   * the low 32 bits, sign extended; outside the variable they read 0 / 0.0 / ''. System
   * variables read their computed value.
   */
  getInt(id: number, index: bigint): bigint {
    const variable = this.variables.get(id),
      i = Number(BigInt.asIntN(32, index));
    if (!variable.has(i)) return 0n;
    if (id < SYSTEM_VARIABLE_LIMIT) return this.system.int(id, i, i < 0 ? -1 : 0);
    return variable.ints?.[i] ?? 0n;
  }
  getFloat(id: number, index: bigint): number {
    const variable = this.variables.get(id),
      i = Number(BigInt.asIntN(32, index));
    if (!variable.has(i)) return 0;
    if (id < SYSTEM_VARIABLE_LIMIT) return this.system.float(id, i, i < 0 ? -1 : 0);
    return variable.floats?.[i] ?? 0;
  }
  getString(id: number, index: bigint): ByteString {
    const variable = this.variables.get(id),
      i = Number(BigInt.asIntN(32, index));
    if (!variable.has(i) || variable.type !== YurisType.String) return '';
    if (id < SYSTEM_VARIABLE_LIMIT) return this.system.string(id, i, i < 0 ? -1 : 0);
    return variable.strings![i]!;
  }

  /** 0x45BEE4: an int to an int or float element; other types are error 0x18B14. */
  setInt(id: number, index: bigint, value: bigint): void {
    const variable = this.variables.get(id),
      i = Number(BigInt.asIntN(32, index));
    if (!variable.has(i)) return;
    if (variable.type === YurisType.Int) variable.ints![i] = value;
    else if (variable.type === YurisType.Float) variable.floats![i] = Number(value);
    else throw new YurisError(0x18b14);
  }

  /** 0x4549F4: a float to a float element, or rounded to an int element. */
  setFloat(id: number, index: bigint, value: number): void {
    const variable = this.variables.get(id),
      i = Number(BigInt.asIntN(32, index));
    if (!variable.has(i)) return;
    if (variable.type === YurisType.Int) variable.ints![i] = fistp(value);
    else if (variable.type === YurisType.Float) variable.floats![i] = value;
    else throw new YurisError(0x18b14);
  }

  /** 0x45BDE4: out-of-range writes are ignored; other types are error 0x18B14. */
  setString(id: number, index: bigint, value: ByteString): void {
    const variable = this.variables.get(id),
      i = Number(BigInt.asIntN(32, index));
    if (!variable.has(i)) return;
    if (variable.type !== YurisType.String) throw new YurisError(0x18b14);
    variable.strings![i] = value;
  }

  /** The system-variable branches of LET 0x443BCC. */
  private assignSystem(
    id: number,
    index: number,
    indexHigh: number,
    op: number,
    source: YurisArgument,
  ): void {
    const e = this.expression,
      s = this.system,
      type = this.variables.get(id).type;
    if (type === YurisType.Int) {
      const value = e.intOf(source.type, source.expression);
      const low = Number(value & 0xffffffffn);
      if (id === 0x84) s.value84 = value;
      else if (id === 0xf) s.listLength = low >>> 0;
      else if (id >= 0x75 && id <= 0x78) s.bytes75[id - 0x75] = low & 0xff;
      else if (id === 0x91) s.lastKey = low | 0;
      else if (id === 0x92) s.lastButton = low | 0;
      else if (id === 0x90) {
        if (!(indexHigh < 0 || (indexHigh === 0 && index === 0))) s.setInput(index, value);
      } else if (id >= 0x93 && id <= 0x113) s.setInput(s.keys[id - 0x93]!, value);
      else if (id >= 0x114 && id <= 0x117) s.setInput(id + index * 0x24 + 0x6c, value);
      else if (id === 0x118) s.setInput(Math.trunc(index / 32) * 0x24 + 0x184, value);
      else if (id >= 0x119 && id <= 0x199) s.inputEdge[s.keys[id - 0x119]!] = value;
      else if (id >= 0x19a && id <= 0x19d) s.inputEdge[id + index * 0x24 - 0x9a] = value;
      else if (id === 0x19e) {
        const q = Math.trunc(index / 32);
        s.inputEdge[q * 0x24 + index - q * 32 + 0x104] = value;
      } else if (id === 0x32) {
        const target = this.variables.get(indexHigh);
        if (target.type !== YurisType.Int) throw new YurisError(0x1a6c6);
        assignInt(target.ints!, target.count, BigInt(index), op, value);
      } else if (id === 0x35) {
        const frame = this.task.frame;
        if (indexHigh === 0 && frame.writable(0, index))
          frame.ints[0]![index] = applyInt(frame.ints[0]![index]!, op, value);
      } else throw new YurisError(0x18b1e);
      return;
    }
    if (type === YurisType.Float) {
      const value = e.floatOf(source.type, source.expression);
      if (id === 0x33) {
        // 0x4549F4 assigns only, whatever the operator.
        this.setFloat(indexHigh, BigInt(index), value);
      } else if (id === 0x36) {
        const frame = this.task.frame;
        if (indexHigh === 0 && frame.writable(1, index) && op <= 4)
          frame.floats[0]![index] = applyFloatBasic(frame.floats[0]![index]!, op, value);
      }
      return;
    }
    if (type === YurisType.String) {
      const value = e.stringOf(source.type, source.expression);
      if (id === 0x80) s.names[0] = value;
      else if (id === 0x83) s.names[3] = value;
      else if (id === 0x7a) s.text = value;
      else if (id === 0x7b) s.textKinds = value;
      else if (id === 0x34) {
        const target = this.variables.get(indexHigh);
        if (target.type !== YurisType.String) throw new YurisError(0x1a6c6);
        this.setString(indexHigh, BigInt(index), value);
      } else throw new YurisError(0x18b1e);
    }
  }
}

/** Int assignment operators (table 0x872B04, 0x423098..0x42335C); out-of-range is ignored. */
function assignInt(
  values: BigInt64Array,
  count: number,
  index: bigint,
  op: number,
  value: bigint,
): void {
  const i = Number(index);
  if (i < 0 || i >= count) return;
  values[i] = op === 0 ? value : applyInt(values[i]!, op, value);
}

function applyInt(current: bigint, op: number, value: bigint): bigint {
  switch (op) {
    case 0:
      return value;
    case 1:
      return i64(current + value);
    case 2:
      return i64(current - value);
    case 3:
      return i64(current * value);
    case 4:
      return value === 0n ? current : i64(current / value);
    case 5:
      return value === 0n ? current : i64(current % value);
    case 6:
      return current & value;
    case 7:
      return current | value;
    case 8:
      return current ^ value;
  }
  return current;
}

/** Float assignment operators (table 0x872B28, 0x4233AC..0x423744). */
function assignFloat(
  values: Float64Array,
  count: number,
  index: bigint,
  op: number,
  value: number,
): void {
  const i = Number(index);
  if (i < 0 || i >= count) return;
  const current = values[i]!;
  switch (op) {
    case 0:
    case 1:
    case 2:
    case 3:
    case 4:
      if (op === 4 && value === 0) return;
      values[i] = applyFloatBasic(current, op, value);
      return;
    case 5:
      if (value === 0) return;
      values[i] = Number(i64(fistp(current) % (fistp(value) || 1n)));
      return;
    case 6:
      values[i] = Number(fistp(current) & fistp(value));
      return;
    case 7:
      values[i] = Number(fistp(current) | fistp(value));
      return;
    case 8:
      values[i] = Number(fistp(current) ^ fistp(value));
      return;
  }
}

function applyFloatBasic(current: number, op: number, value: number): number {
  switch (op) {
    case 0:
      return value;
    case 1:
      return current + value;
    case 2:
      return current - value;
    case 3:
      return current * value;
    case 4:
      return current / value;
  }
  return current;
}

function bytes(text: string): Uint8Array {
  return Uint8Array.from(text, (c) => c.charCodeAt(0));
}

/** A byte string as bytes. */
export function latin1(text: ByteString): Uint8Array {
  return Uint8Array.from(text, (c) => c.charCodeAt(0) & 0xff);
}

const sjis = new TextDecoder('shift_jis');
export function sjisText(value: Uint8Array | ByteString): string {
  return sjis.decode(typeof value === 'string' ? latin1(value) : value);
}

/** `%s`, `%d`, `%I64d` and `%%` of the MSVC `sprintf` the error reporter uses. */
function printf(template: string, args: readonly (number | bigint | string)[]): string {
  let next = 0;
  return template.replace(/%(%|s|d|I64d)/g, (_, spec: string) => {
    if (spec === '%') return '%';
    const value = args[next++];
    if (value === undefined) return '';
    return typeof value === 'string' ? sjisText(value) : String(value);
  });
}
