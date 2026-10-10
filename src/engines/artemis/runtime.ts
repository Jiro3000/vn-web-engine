import type {ArtemisLayerInfo} from './layer-info.js';
import type {AsbTag} from '../../formats/artemis/asb.js';
import {
  ArtemisSaveArchiveReader,
  ArtemisSaveArchiveWriter,
  packArtemisSaveFile,
} from '../../formats/artemis/save-file.js';
import type {CursorHost, PointerPositionHost} from '../../input/cursor-host.js';
import type {TextDialogHost} from '../../platform/text-dialog.js';
import type {WindowCaptionHost} from '../../platform/window-caption.js';
import type {WindowStateHost} from '../../platform/window-state.js';
import type {WindowsDynamicLibraryHost} from '../../platform/windows-dynamic-library.js';
import {windowsTextFileBytes} from '../../platform/windows-text-file.js';
import type {FullscreenMoviePlayer} from '../../video/fullscreen-movie.js';
import {ArtemisCaption} from './caption.js';
import {ArtemisClickGlyphs} from './click-glyph.js';
import {ArtemisDialog} from './dialog.js';
import {ArtemisEventCommands, type ArtemisCommandEvent} from './event-commands.js';
import {ArtemisExec} from './exec.js';
import {artemisExpressionBytes} from './expression.js';
import {artemisFontProperties} from './font-properties.js';
import {ArtemisFontStack} from './font-stack.js';
import {
  artemisDefaultFontAttributes,
  readArtemisFontFrame,
  writeArtemisFontFrame,
  type ArtemisFontAttributes,
} from './font-state.js';
import {ArtemisFullscreenVideo} from './fullscreen-video.js';
import {
  ArtemisReadHistory,
  writeArtemisGlobalArchive,
  writeArtemisSystemArchive,
} from './global-save.js';
import {ArtemisKeyBindings} from './key-bindings.js';
import type {ArtemisLayerEventSink, ArtemisLayerEventType} from './layer-events.js';
import type {ArtemisTweenRegistry} from './tween.js';
import {ArtemisLoad} from './load.js';
import {ArtemisLua} from './lua.js';
import {ArtemisMessageLayers, ArtemisMessageSelection} from './message-layers.js';
import {ArtemisModes} from './modes.js';
import {ArtemisMouse} from './mouse.js';
import {ArtemisMusic, type ArtemisMusicHost} from './music.js';
import {ArtemisNativeLibrary} from './native-library.js';
import {artemisInteger} from './numbers.js';
import {ArtemisPrint} from './print.js';
import {ArtemisRandom} from './random.js';
import {ArtemisReset} from './reset.js';
import {
  initializeArtemisGraphicsFeatureLevel,
  initializeArtemisResourcePaths,
  initializeArtemisVariables,
  initializeArtemisWindowsVersion,
} from './revision.js';
import {ArtemisRuby} from './ruby.js';
import {ArtemisSave} from './save.js';
import {ArtemisSaveData} from './save-data.js';
import {
  readArtemisScenarioArchive,
  writeArtemisScenarioArchive,
  type ArtemisLoadedCaret,
} from './scenario-archive.js';
import {applyArtemisScenario, captureArtemisScenario} from './scenario-state.js';
import {ArtemisSceneTweens} from './scene-tweens.js';
import {ArtemisScript} from './script.js';
import {createArtemisScriptEvents} from './script-events.js';
import {ArtemisScreenshots} from './screenshot.js';
import {ArtemisSePlay, type ArtemisSePlayHost} from './se-play.js';
import {ArtemisSeStop} from './se-stop.js';
import {ArtemisSoundFinish} from './sound-finish.js';
import {ArtemisStop} from './stop.js';
import {createArtemisTagDispatch, type ArtemisLayerTagOwner} from './tag-dispatch.js';
import {
  ArtemisTextBreakControls,
  artemisUtf8Prohibition,
  type ArtemisIndentation,
} from './text-break-controls.js';
import {ArtemisTextCommands} from './text-commands.js';
import {ArtemisTextControls} from './text-controls.js';
import {ArtemisTextDisplay} from './text-display.js';
import type {ArtemisTextInsertion} from './text-insertion.js';
import {ArtemisTimedWait, type ArtemisWaitFlags} from './wait.js';
import {ArtemisInput, type ArtemisInputSample} from './input.js';
import {ArtemisVariables} from './variables.js';

/** Font-stack frame: attribute overrides over the 0x140193720 defaults and the overflow
 * policy of the frame's `font` tag. */
export interface ArtemisRuntimeFont {
  readonly font: ReadonlyMap<string, unknown>;
  readonly overflow?: number;
}
/** A message layer resource (CLinkableTextLayer): its font and text-break settings. The
 * glyph owner keeps the inserted text per resource. */
export interface ArtemisMessageResource {
  readonly name: string;
  readonly serial: number;
  references: number;
  font: Map<string, unknown>;
  indentation?: ArtemisIndentation;
  wordParts?: Set<string>;
  prohibition?: {head: Set<string>; foot: Set<string>};
}

/** Installation files: the CArtemisPackFile namespace over the mounted archives. */
export interface ArtemisRuntimeFiles {
  read(path: string): Promise<Uint8Array | null>;
  /** Windows-text CFile read used by luaL_loadfile. */
  readPlain(path: string): Promise<Uint8Array | null>;
  resolvePath(path: string): string;
  setMagicPath(name: string, root: string): void;
  /** Every archive and loose file name ('/'-separated). */
  readonly paths: ReadonlySet<string>;
}
/** Save directory storage (SaveDataPath). */
export interface ArtemisRuntimeStorage {
  read(name: string): Promise<Uint8Array | null>;
  write(name: string, bytes: Uint8Array): void | Promise<void>;
  /** The stored names; without it the save directory appears empty to `isFileExists`
   * until files are written. */
  list?(): Promise<readonly string[]>;
}
/** Layer graphics owner: the layer tags plus the frame and scene services the runtime
 * drives. */
export interface ArtemisRuntimeLayers extends ArtemisLayerTagOwner {
  readonly tweenRegistry: ArtemisTweenRegistry;
  readonly transitionPending: boolean;
  readonly tweenSyncPending: boolean;
  /** Steps every registered tween and video layer to `now`. */
  tickTweens(now: number): void;
  /** Runs the pending transition tween from `start` to its end; returns the end tick. */
  finishTransition(start: number): number;
  /** Steps the pending transition tween to `now`. */
  tickTransition(now: number): void;
  videoPlaying(id: string): boolean;
  hasLayer(id: string): boolean;
  /** `var system=get_layer_info`: layer `id`'s actor fields, undefined without the layer. */
  layerInfo(id: string): ArtemisLayerInfo | undefined;
  attachMessageActor(
    name: string,
    message: ArtemisMessageResource,
    owner: {
      retain(message: ArtemisMessageResource): void;
      release(message: ArtemisMessageResource): void;
    },
  ): void;
  detachMessageActor(name: string): void;
  clickableLayers(): string[];
  hasLayerEvent(id: string, type: ArtemisLayerEventType): boolean;
  invokeLayerEvent(id: string, type: ArtemisLayerEventType, sink: ArtemisLayerEventSink): unknown;
  reset(): void;
  clearLayerCommands(): void;
  snapshotLayerCommands(): ReadonlyMap<string, readonly AsbTag[]>;
  restoreLayerCommands(snapshot: ReadonlyMap<string, readonly AsbTag[]>): void;
  close(): void;
}
/** Input delivered with one frame. */
export interface ArtemisFrameInput {
  /** The device sample of the frame's input update. */
  readonly sample: ArtemisInputSample;
  /** Layer events from pointer hit testing, in delivery order. */
  readonly layerEvents: readonly {readonly id: string; readonly type: ArtemisLayerEventType}[];
}
/** What the layer owner receives from the runtime. */
export interface ArtemisRuntimeLayerHost {
  /** Transition and sync-tween run modes: c6160 entry (c74 = c70, c70 = `mode`) and the
   * c6480 release (c70 = c74, then the deferred events). */
  enter(mode: number): void;
  release(): void;
  now(): number;
  emit(tag: AsbTag): void;
  stageSize(): {readonly width: number; readonly height: number};
  skipState(): {readonly allowed: boolean; readonly command: boolean; readonly control: boolean};
}
/** Text glyph owner: one text insertion per message resource. */
export interface ArtemisRuntimeGlyphs {
  get(resource: ArtemisMessageResource): ArtemisTextInsertion;
  copy(old: ArtemisMessageResource, resource: ArtemisMessageResource): void;
  release(resource: ArtemisMessageResource): void;
}
/** Asynchronous surface manager for the Lua surface functions. */
export interface ArtemisRuntimeSurfaces {
  load(name: string): Promise<{lease?: {release(): void}} | null>;
  bindSurfaceAsync(name: string): void;
  unbindSurface(name: string): void;
  clearSurfaceLoadQueue(): void;
  isLoadingSurface(name?: string): boolean;
  /** Slot +0x28: the cache forgets `name`. */
  evict(name: string): void;
}
/** The engine screenshot surface (+0x1c0) of `takess`/`savess`. */
export interface ArtemisRuntimeScreenshots {
  take(): void;
  /** Scaled RGBA rows, top row first; null before any `take`. */
  read(width: number, height: number): Uint8Array | null;
}
/** Effect and music voices (script +0x3d88/+0x3d60 managers). */
export type ArtemisRuntimeSound = Omit<
  ArtemisSePlayHost,
  | 'debugSkipActive'
  | 'commandSkipActive'
  | 'effectIndex'
  | 'setEffectIndex'
  | 'effectGainVariable'
  | 'replaceEffectHistory'
  | 'effectLoadFailed'
> &
  Omit<ArtemisMusicHost, 'debugSkipActive' | 'musicLoadFailed'> & {
    setFinishCallback(index: number, callback: (() => void) | null): void;
    setMusicFinishCallback(index: number, callback: (() => void) | null): void;
    effectPlaying(index: number): boolean;
    /** Renders the voices up to `now`. */
    advanceToTick(now: number): void;
  };

export interface ArtemisRuntimeServices {
  readonly executableSha256: string;
  readonly files: ArtemisRuntimeFiles;
  readonly storage: ArtemisRuntimeStorage;
  /** Seconds since the Unix epoch that seed the script random generator. */
  readonly randomSeed: number;
  readonly createLayers: (host: ArtemisRuntimeLayerHost) => ArtemisRuntimeLayers;
  readonly glyphs: ArtemisRuntimeGlyphs;
  readonly surfaces: ArtemisRuntimeSurfaces;
  readonly sound: ArtemisRuntimeSound;
  /** `takess`/`savess` owner; without it the tags are refused. */
  readonly screenshots?: ArtemisRuntimeScreenshots;
  /** `lyshader` owner; without it the tag is refused. */
  readonly shaders?: {dispatch(tag: AsbTag): Promise<unknown>};
  readonly moviePlayer: FullscreenMoviePlayer;
  /** Reads the movie duration for a fullscreen movie request. */
  readonly dialogs: TextDialogHost;
  readonly window: WindowStateHost & {displayModeChanged(): void};
  readonly caption: WindowCaptionHost;
  readonly cursor: CursorHost;
  readonly pointer: PointerPositionHost;
  readonly dynamicLibraries: WindowsDynamicLibraryHost;
  /** The Windows version the host reports, or null when it reports none. */
  readonly windowsVersion: () => {readonly major: number; readonly minor: number} | null;
  /** The device feature level, when the host reports one. */
  readonly graphicsFeatureLevel?: () => number;
  /** Effective music and effect volumes after a reset. */
  readonly applyVolumes: (music: number, effect: number) => void;
  /** Layer +0x16c (the draggable byte, virtual +0xf0 0x1400a4970) of a glyph layer. */
  readonly setLayerByte16c: (name: string, value: boolean) => void;
  readonly setTouchLimit: (limit: number) => void;
  /** The touch device of Lua `getTouchCount`/`setUseTouchHold`; absent is a device with no
   * touch points that ignores the hold setting. */
  readonly touch?: {count(): number; setHold(enabled: boolean): void};
  /** Native include errors (0x14012d080 level 1); without it they fault. */
  readonly reportIncludeError?: (path: string, error: unknown) => void;
  /** Native callLua and unknown-tag reports (c84b0/c7260); without them they fault. */
  readonly reportLuaCallError?: ArtemisScriptReport<'reportLuaCallError'>;
  readonly reportUnknownTag?: ArtemisScriptReport<'reportUnknownTag'>;
  /** Engine method error reports (0x14012d490), Shift_JIS. */
  readonly reportError: (message: Uint8Array) => void;
  /** Diagnostic stream: tags, includes and owner effects. */
  readonly trace?: ArtemisRuntimeTrace;
}
type ArtemisScriptReport<K extends 'reportLuaCallError' | 'reportUnknownTag'> = NonNullable<
  ConstructorParameters<typeof ArtemisScript>[1][K]
>;
export interface ArtemisRuntimeTrace {
  tag?(tag: AsbTag): void;
  script?(entry: {
    origin: string;
    file: string;
    tagIndex: number;
    name: string;
    sourceLine: number;
    /** The Lua function of a `calllua` step. */
    function?: string;
  }): void;
  include?(path: string): void;
  effect?(effect: object): void;
}

const MEMORY_BUDGET = 64 * 1024 * 1024;
const emptyTag: AsbTag = {kind: 'tag', name: '', sourceLine: 0, args: new Map()};

/** The [WINDOWS] keys of system.ini the runtime reads. */
function readSystemIni(bytes: Uint8Array) {
  const ini = new TextDecoder('utf-8', {fatal: true}).decode(bytes);
  let section = '',
    width: number | undefined,
    height: number | undefined,
    savePath: string | undefined,
    savePathCsidl: string | undefined,
    bootPath = '';
  for (const sourceLine of ini.split(/\r?\n/)) {
    const line = sourceLine.split(';', 1)[0]!.trim();
    const header = /^\[([^\]]+)\]$/.exec(line);
    if (header) section = header[1]!.toUpperCase();
    if (section !== 'WINDOWS') continue;
    const setting = /^(SAVEPATH|SAVEPATH_CSIDL|BOOT)\s*=\s*(.*)$/.exec(line);
    if (setting?.[1] === 'BOOT') bootPath = setting[2]!;
    if (setting?.[1] === 'SAVEPATH') savePath = setting[2];
    if (setting?.[1] === 'SAVEPATH_CSIDL') savePathCsidl = setting[2];
    const entry = /^(WIDTH|HEIGHT)\s*=\s*(\d+)$/.exec(line);
    if (entry?.[1] === 'WIDTH') width = Number(entry[2]);
    if (entry?.[1] === 'HEIGHT') height = Number(entry[2]);
  }
  if (!width || !height) throw new Error('Artemis needs explicit WINDOWS WIDTH and HEIGHT');
  return {width, height, savePath, savePathCsidl, bootPath};
}

/** The engine object (script/stage/managers of 0x1400b9e80) over browser services: every
 * native tag owner, the Lua runtime and script, the tag dispatch and the frame-level
 * operations a host drives (resource completion, clock, input, waits, save and load). */
export class ArtemisRuntime {
  readonly lua: ArtemisLua;
  readonly script: ArtemisScript;
  readonly variables: ArtemisVariables;
  readonly modes: ArtemisModes;
  readonly wait: ArtemisTimedWait;
  readonly dialog: ArtemisDialog;
  readonly keyBindings: ArtemisKeyBindings;
  readonly fullscreenVideo: ArtemisFullscreenVideo;
  readonly layers: ArtemisRuntimeLayers;
  readonly fontStack: ArtemisFontStack<ArtemisRuntimeFont>;
  readonly messageSelection: ArtemisMessageSelection<ArtemisMessageResource>;
  readonly save: ArtemisSave;
  readonly load: ArtemisLoad;
  readonly scriptEvents: ReturnType<typeof createArtemisScriptEvents>;
  readonly compiled: number;
  /** Native run mode c70 of the current caret: 0 script, 1 click wait, 2 transition, 3
   * stop, 4 wait, 7 video, 13 load. */
  private get mode(): number {
    return this.script?.runMode ?? 0;
  }
  /** CArtemisInput, updated once a frame. */
  readonly input = new ArtemisInput();
  /** The frame counter +0xf0. */
  frameNumber = 0;
  /** Pointer layer events for the next frame's window update. */
  private layerEventQueue: {readonly id: string; readonly type: ArtemisLayerEventType}[] = [];
  /** Milliseconds (uint32, timeGetTime) of the current frame. */
  now = 1;
  private pendingResource: Promise<unknown> | null = null;
  private resourceInFlight = false;
  private runModeHeld = false;
  private readonly saveWrites: Promise<void>[] = [];
  private readonly closers: (() => void)[] = [];
  private readonly currentTextDisplay: () => ArtemisTextDisplay<unknown>;
  private readonly displayProperties = new WeakMap<object, Map<string, number>>();
  /** Changes whenever a glyph or block display property changes. */
  textRevision = 0;
  private readonly writeScenario: (asLoaded: boolean) => Uint8Array;
  private readonly resetEngine: ArtemisReset;
  /** Called after the scenario loader, before `onLoad`. */
  scenarioLoaded: (() => void) | null = null;

  /** Reads system.ini and the Lua/script corpus, which the script reads synchronously. */
  static async open(services: ArtemisRuntimeServices): Promise<ArtemisRuntime> {
    const {files} = services;
    const iniBytes = await files.read('system.ini');
    if (iniBytes === null) throw new Error('Missing system.ini');
    const prepared = new Map<string, Uint8Array>(),
      plain = new Map<string, Uint8Array>();
    let bytes = 0;
    const budget = (length: number) => {
      bytes += length;
      if (bytes > MEMORY_BUDGET) throw new Error('Script corpus exceeds memory budget');
    };
    for (const path of files.paths)
      if (/\.(lua|ast|iet|ipt|asb|tbl|ini)$/.test(path)) {
        const data = await files.read(path);
        if (data === null) throw new Error(`Missing inventoried source ${path}`);
        budget(data.length);
        prepared.set(path, data);
        if (/\.(lua|ast)$/.test(path)) {
          const text = await files.readPlain(path);
          if (text !== null) {
            plain.set(path, text);
            budget(text.length);
          }
        }
      }
    const saveNames = new Set(await services.storage.list?.());
    return new ArtemisRuntime(services, readSystemIni(iniBytes), prepared, plain, bytes, saveNames);
  }

  private constructor(
    private readonly services: ArtemisRuntimeServices,
    ini: ReturnType<typeof readSystemIni>,
    readonly prepared: Map<string, Uint8Array>,
    plainFiles: ReadonlyMap<string, Uint8Array>,
    readonly preparedBytes: number,
    /** Names in the save directory storage. */
    private readonly saveNames: Set<string>,
  ) {
    const hash = services.executableSha256,
      {files, sound, glyphs} = services,
      {width, height} = ini;
    const trace = (effect: object) => services.trace?.effect?.(effect);
    // Installation-relative save directory; no Windows known-folder resolution.
    const saveDirectory = (this.saveDirectory =
      ini.savePath !== undefined && ini.savePathCsidl === undefined && /^[\w-]+$/.test(ini.savePath)
        ? ini.savePath
        : undefined);
    const readFile = (path: string) => {
      path = files.resolvePath(path);
      const bytes = prepared.get(path);
      if (bytes) return bytes;
      if (files.paths.has(path))
        throw new Error(`Resource is not prepared for synchronous Lua: ${path}`);
      return null;
    };
    const suspend = (operation: Promise<unknown>) => {
      if (this.pendingResource) throw Error('Artemis resource operation overlaps');
      this.pendingResource = operation;
    };
    let lua: ArtemisLua, script: ArtemisScript;
    let messageStage: ArtemisMessageLayers<ArtemisMessageResource>;
    const variables = (this.variables = new ArtemisVariables({
      stageSize: () => ({width, height}),
      windowDisplay: () => ({width, height, fullscreen: false}),
      applicationArguments: {readApplicationArguments: () => new Map()},
      messageLayerMeasure: () => glyphs.get(messageStage.currentLayer()).measure(),
      layerInfo: (id) => layers.layerInfo(id),
    }));
    // c37e0 static variables run inside the bf210 boot path, after the save-file loads.
    const initializeStaticVariables = () => {
      initializeArtemisVariables(variables, hash);
      if (services.graphicsFeatureLevel)
        initializeArtemisGraphicsFeatureLevel(variables, hash, services.graphicsFeatureLevel);
      if (saveDirectory !== undefined)
        initializeArtemisResourcePaths(variables, {dataPath: '', savePath: saveDirectory});
      initializeArtemisWindowsVersion(variables, services.windowsVersion);
    };
    // Effect id map (script +0x3d88) and the save object.
    const effectSlots = new Map<string, number>(),
      saveData = new ArtemisSaveData<ArtemisRuntimeFont>();
    const seStop = new ArtemisSeStop(hash, {
      effectIndex: (id) => effectSlots.get(id),
      stopEffect: (index, milliseconds) => sound.stopEffect(index, milliseconds),
      hasEffectHistory: (id) => saveData.hasEffect(id),
      deleteEffectHistory: (id) => saveData.deleteEffect(id),
    });
    const soundFinish = new ArtemisSoundFinish(hash, {
      currentFile: () => script.currentFile,
      musicIndex: () => music.currentIndex,
      effectIndex: (id) => effectSlots.get(id),
      setEffectFinish: (index, callback) => sound.setFinishCallback(index, callback),
      setMusicFinish: (index, callback) => sound.setMusicFinishCallback(index, callback),
      emit: (command) => {
        trace({soundFinishCommand: {name: command.name, args: Object.fromEntries(command.args)}});
        // f8050 at 0x1400dfe2b/0x1400dff1f: b73e0(script, mode 0, force 1, tag copy).
        scriptEvents.emit(command, 0, true);
      },
    });
    const modeEvent = (event: ArtemisCommandEvent) => {
      const command = eventCommands.command(event);
      if (command) scriptEvents.dispatch(command);
    };
    const modes = (this.modes = new ArtemisModes({
      writeStatus: (name, value) => (variables.write(name, value), trace({name, value})),
      // b7ba0/b7c70/b7810 end with c6730 of the registered in/out command.
      commandSkipChanged: (active) => {
        trace({commandSkip: active});
        modeEvent(active ? 'setoncommandskipin' : 'setoncommandskipout');
      },
      controlSkipChanged: (active) => {
        trace({controlSkip: active});
        modeEvent(active ? 'setoncontrolskipin' : 'setoncontrolskipout');
      },
      automodeChanged: (active, indicator) => {
        trace({automode: active});
        // On, a present indicator with a name; off, any name: layer virtual +0xf0.
        if (indicator.name && (!active || indicator.present))
          throw Error('Artemis automode indicator layer is not implemented');
        if (!active) wait.clearAutomodeDeadline();
        modeEvent(active ? 'setonautomodein' : 'setonautomodeout');
      },
      releaseScheduler: () => trace({releaseScheduler: true}),
      currentMessageLayer: () => messageSelection.currentMessageLayer(),
    }));
    const sePlay = new ArtemisSePlay(hash, {
      debugSkipActive: () => false,
      commandSkipActive: () => modes.skipAllowed && (modes.commandSkip || modes.controlSkip),
      effectIndex: (id) => effectSlots.get(id),
      ...sound,
      setEffectIndex: (id, index) => effectSlots.set(id, index),
      effectGainVariable: (id) => {
        const value = variables.lookup('s.segain.' + id);
        return value === undefined ? undefined : Number(new TextDecoder().decode(value));
      },
      replaceEffectHistory: (id, tag) => saveData.replaceEffect(id, tag),
      effectLoadFailed: () => {
        throw Error('Artemis sound load failed');
      },
    });
    this.closers.push(() => sePlay.close());
    // BGM manager script +0x3d60.
    const music = new ArtemisMusic(hash, {
      debugSkipActive: () => false,
      ...sound,
      musicLoadFailed: () => {
        throw Error('Artemis music load failed');
      },
    });
    const exec = new ArtemisExec(modes, {
      window: services.window,
      enterRunMode: () => {
        throw Error('Unsupported Artemis exec run mode owner');
      },
      now: () => this.now,
      setWaitStart: () => {
        throw Error('Unsupported Artemis exec wait timestamp owner');
      },
      softwareRenderer: () => false,
      displayModeChanged: () => services.window.displayModeChanged(),
    });
    const caption = new ArtemisCaption(services.caption);
    const mouse = new ArtemisMouse(services.cursor, () => this.now);
    const dialog = (this.dialog = new ArtemisDialog(services.dialogs, {
      blocked: () => false,
      beginWait: () => script.pause(),
      endWait: () => script.resume(),
      writeVariable: (name, value) => variables.write(name, value),
    }));
    const clickGlyphs = new ArtemisClickGlyphs({
      currentMessageLayer: () => messageSelection.currentMessageLayer(),
      setLayerByte16c: (name, value) => {
        if (layers.hasLayer(name)) services.setLayerByte16c(name, value);
      },
    });
    const readHistory = new ArtemisReadHistory();
    const save = (this.save = new ArtemisSave(variables, {
      beforeScenario: (file) => lua.events.emit('onSave', new Map([['file', file]])),
      reportEventError: (error) => trace({saveEventError: String(error)}),
      // Archives are written synchronously; compression and storage complete later.
      writeScenario: (file) => this.store(file, 'S', this.writeScenario(false)),
      writeGlobal: () =>
        this.store('saveg.dat', 'G', writeArtemisGlobalArchive(readHistory, variables)),
      writeSystem: () => this.store('system.dat', 'X', writeArtemisSystemArchive(variables)),
    }));
    // Text display owners per message resource. Glyph and block actors are property stores
    // that the presentation reads.
    const textDisplays = new Map<ArtemisMessageResource, ArtemisTextDisplay<unknown>>(),
      displayActors = new WeakMap<
        object,
        {property(p: string): number; setProperty(p: string, v: number): void}
      >();
    const displayActor = (key: object) => {
      let actor = displayActors.get(key);
      if (!actor) {
        const values = new Map([
          ['left', 0],
          ['top', 0],
          ['alpha', 1],
          ['xscale', 1],
          ['yscale', 1],
          ['rotate', 0],
        ]);
        actor = {
          property: (parameter) => values.get(parameter)!,
          setProperty: (parameter, value) => {
            if (values.get(parameter) === value) return;
            values.set(parameter, value);
            this.textRevision++;
          },
        };
        displayActors.set(key, actor);
        this.displayProperties.set(key, values);
      }
      return actor;
    };
    const textDisplayHost = (resource: ArtemisMessageResource) => ({
      lines: () => glyphs.get(resource).displayBlocks(),
      glyphIndex: (glyph: {glyphId: number}) => glyph.glyphId,
      glyphCount: () => glyphs.get(resource).glyphCount,
      glyphActor: displayActor,
      blockActor: displayActor,
    });
    const textDisplay = (resource: ArtemisMessageResource) => {
      let display = textDisplays.get(resource);
      if (!display) {
        display = new ArtemisTextDisplay(hash, layers.tweenRegistry, textDisplayHost(resource));
        textDisplays.set(resource, display);
      }
      return display;
    };
    const currentTextDisplay = (this.currentTextDisplay = () => {
      const resource = messageStage.currentLayer();
      if (!resource) throw Error('Artemis text display has no current text layer');
      return textDisplay(resource);
    });
    const startTextDisplay = (skip: boolean) => {
      const display = currentTextDisplay(),
        before = display.tweens.length;
      // The skip vector +0x3718 is zero-initialized and has no decoded writer.
      display.show(skip ? [] : sceneTweens.snapshot('in'), true);
      trace({
        textDisplay: messageSelection.currentMessageLayer(),
        skip,
        tweens: display.tweens.length - before,
        start: display.start,
        simulation: true,
      });
    };
    const wait = (this.wait = new ArtemisTimedWait(modes, save, {
      now: () => this.now,
      debugSkipActive: () => false,
      startTextDisplay,
      textDisplayComplete: () => currentTextDisplay().complete,
      finishTextDisplay: () => currentTextDisplay().finish(),
      writeClickSkip: () => variables.write('s.clickskip', '1'),
      // Run mode 1 waits for input, 4 for its deadline or condition; c6160(0) ends both.
      beginWait: (inputEnabled) => {
        trace({wait: {inputEnabled}});
        script.enterRunMode(inputEnabled ? 1 : 4);
        script.pause();
      },
      endWait: () => {
        trace({waitEnd: true});
        script.enterRunMode(0);
        script.resume();
      },
      clickWaitEvent: (kind) => {
        try {
          lua.events.emit(kind === 'in' ? 'onClickWaitIn' : 'onClickWaitOut');
        } catch (error) {
          trace({waitEventError: String(error)});
        }
      },
      resumeMessageState: () => trace({resumeMessageState: true}),
      effectIndex: (id) => effectSlots.get(id),
      effectPlaying: (index) => sound.effectPlaying(index),
      videoPlaying: (id) => layers.videoPlaying(id),
      automodeWait: () =>
        artemisInteger(new TextDecoder().decode(variables.read('s.automodewait'))),
    }));
    const stop = new ArtemisStop(modes, save, {
      debugSkipActive: () => false,
      startTextDisplay,
      enterStopMode: () => {
        script.enterRunMode(3);
        trace({runMode: 3, simulation: true});
        script.pause();
        return true;
      },
    });
    const fullscreenVideo = (this.fullscreenVideo = new ArtemisFullscreenVideo(hash, modes, {
      debugSkipActive: () => false,
      videoVolume: () => artemisInteger(new TextDecoder().decode(variables.read('s.videovol'))),
      player: services.moviePlayer,
      playbackFailed: (tag) => {
        throw Error('Artemis fullscreen video failed: ' + tag.args.get('file'));
      },
      enterVideoMode: () => {
        if (this.mode === 13) return;
        script.enterRunMode(7);
        trace({runMode: 7, simulation: true});
        if (this.resourceInFlight) this.runModeHeld = true;
        else script.pause();
      },
      releaseRunMode: () => {
        if (this.mode !== 7) return;
        script.releaseRunMode();
        services.moviePlayer.close();
        trace({runMode: this.mode, simulation: true});
        this.scriptEvents.releasePending();
        script.resume();
      },
      rolePushed: (role) => this.roleDecided(role),
      writeClickSkip: () => variables.write('s.clickskip', '1'),
    }));
    const messageHistory = new Set<string>(),
      messageFrames = new Map<string, ArtemisMessageResource>();
    let serial = 0;
    const resource = (name: string): ArtemisMessageResource => ({
      name,
      serial: ++serial,
      references: 1,
      font: new Map(),
    });
    const retainMessage = (layer: ArtemisMessageResource) => {
      layer.references++;
    };
    const releaseMessage = (layer: ArtemisMessageResource) => {
      if (--layer.references < 0) throw Error('Artemis message resource released twice');
      if (layer.references === 0) {
        glyphs.release(layer);
        textDisplays.delete(layer);
      }
    };
    messageStage = new ArtemisMessageLayers<ArtemisMessageResource>(hash, '', {
      createMessageLayer: (name) => {
        trace({messageCreate: name, simulation: true});
        return resource(name);
      },
      copyMessageLayer: (old) => {
        trace({messageCopy: old.name, simulation: true});
        const copy = resource(old.name);
        copy.font = new Map(old.font);
        if (old.indentation)
          copy.indentation = {...old.indentation, pairs: new Map(old.indentation.pairs)};
        if (old.wordParts) copy.wordParts = new Set(old.wordParts);
        if (old.prohibition)
          copy.prohibition = {
            head: new Set(old.prohibition.head),
            foot: new Set(old.prohibition.foot),
          };
        glyphs.copy(old, copy);
        const display = textDisplays.get(old);
        if (display) textDisplays.set(copy, display.copy(textDisplayHost(copy)));
        return copy;
      },
      retainMessageLayer: retainMessage,
      releaseMessageLayer: releaseMessage,
      attachMessageLayer: (name, layer) => {
        layers.attachMessageActor(name, layer, {retain: retainMessage, release: releaseMessage});
        messageFrames.set(name, layer);
        trace({messageAttach: name, simulation: true});
      },
      detachMessageLayer: (name) => {
        if (messageFrames.get(name)) {
          layers.detachMessageActor(name);
          messageFrames.delete(name);
        }
        trace({messageDetach: name, simulation: true});
      },
    });
    this.closers.push(() => messageStage.close());
    const messageSelection = (this.messageSelection = new ArtemisMessageSelection(messageStage, {
      nextMessageLayerId: () => {
        throw Error('Artemis unnamed message layer allocator not implemented');
      },
      ensureMessageHistory: (name) => {
        if (!messageHistory.has(name)) {
          messageHistory.add(name);
          fontStack.seedCurrentLayer();
          trace({messageHistorySeed: name, simulation: true});
        }
      },
      deleteMessageHistory: (name) => {
        messageHistory.delete(name);
        fontStack.deleteLayer(name);
        trace({messageHistoryDelete: name, simulation: true});
      },
      publishCurrentMessageLayer: (name) => variables.write('s.current_message_layer', name),
      selectionChanged: (_tag, name) => trace({messageSelected: name, simulation: true}),
      stackUnderflow: (_tag, name) => trace({messageStackUnderflow: name, simulation: true}),
      messageStateUpdated: () => trace({messageStateUpdated: true, simulation: true}),
    }));
    const recordText = (name: string, tag: AsbTag) => saveData.recordText(name, tag);
    const fontStack = (this.fontStack = new ArtemisFontStack<ArtemisRuntimeFont>({
      currentMessageLayer: () => messageSelection.currentMessageLayer(),
      snapshotCurrentFont: () => ({font: new Map(messageStage.currentLayer().font)}),
      createFontCommandSnapshot: (tag) => {
        const patch = artemisFontProperties(tag.args),
          font = new Map(messageStage.currentLayer().font);
        for (const [key, value] of Object.entries(patch))
          if (key !== 'overflow') font.set(key, value);
        trace({fontAttributeKeys: Object.keys(patch), simulation: true, fontRendering: false});
        return {font, overflow: patch.overflow ?? 2};
      },
      applyFontSnapshot: (snapshot) => {
        messageStage.currentLayer().font = new Map(snapshot.font);
      },
      releaseFontSnapshot: () => trace({fontSnapshotReleased: true, simulation: true}),
      // cd380/cd460/cd950 append the tag to the save object's per-layer +0x08 history.
      recordFontCommand: (name, tag) => {
        trace({fontCommand: tag.name, messageLayer: name, simulation: true});
        recordText(name, tag);
      },
      stackUnderflow: (name) => trace({fontStackUnderflow: name, simulation: true}),
    }));
    this.closers.push(() => fontStack.close());
    const sceneTweens = new ArtemisSceneTweens(hash, () => messageSelection.currentMessageLayer());
    const textBreakControls = new ArtemisTextBreakControls({
      currentMessageLayer: () => messageSelection.currentMessageLayer(),
      setIndentation: (value) => {
        messageStage.currentLayer().indentation = {...value, pairs: new Map(value.pairs)};
        trace({indentationConfigured: true, simulation: true, textLayout: false});
      },
      setProhibitedCharacters: (head, foot) => {
        messageStage.currentLayer().prohibition = artemisUtf8Prohibition(head, foot);
        trace({prohibitionConfigured: true, simulation: true, textLayout: false});
      },
      setWordParts: (parts) => {
        messageStage.currentLayer().wordParts = new Set(parts);
        trace({wordPartsConfigured: true, simulation: true, textLayout: false});
      },
      recordTextCommand: (layer, tag) => {
        trace({textCommand: tag.name, messageLayer: layer, simulation: true});
        recordText(layer, tag);
      },
      rememberTextCommand: (layer, slot, tag) => {
        trace({textReplaySlot: slot, messageLayer: layer, simulation: true});
        saveData.rememberText(layer, slot, tag);
      },
    });
    const textControls = new ArtemisTextControls({
      currentMessageLayer: () => messageSelection.currentMessageLayer(),
      messageLayerExists: (id) => messageStage.messageLayerExists(id),
      selectMessageLayer: (id) => {
        messageStage.selectMessageLayer(id, 0);
        trace({selectMessageLayer: id});
      },
      clearBacklog: () => {
        throw new Error('Artemis backlog collection storage is not implemented');
      },
    });
    const keyBindings = (this.keyBindings = new ArtemisKeyBindings(() => script.currentFile));
    const eventCommands = new ArtemisEventCommands(() => script.currentFile);
    const nativeLibrary = new ArtemisNativeLibrary(services.dynamicLibraries, (name, bytes) =>
      variables.write(name, bytes),
    );
    const layers = (this.layers = services.createLayers({
      // A rule trans enters its run mode after the asynchronous rule load; the resource
      // wait then becomes the run mode wait instead of resuming.
      enter: (mode) => {
        script.enterRunMode(mode);
        // b5be0 ends a sync tween with run mode 0.
        if (mode === 0) script.resume();
        else if (this.resourceInFlight) this.runModeHeld = true;
        else script.pause();
      },
      release: () => {
        script.releaseRunMode();
        this.scriptEvents.releasePending();
        if (this.mode === 0) script.resume();
      },
      now: () => this.now,
      emit: (tag) => scriptEvents.emit(tag, 0, true),
      stageSize: () => ({width, height}),
      skipState: () => ({
        allowed: modes.skipAllowed,
        command: modes.commandSkip,
        control: modes.controlSkip,
      }),
    }));
    this.closers.push(() => layers.close());
    const selectedResource = (name: string) => {
      if (name !== messageSelection.currentMessageLayer())
        throw Error('Artemis selected message resource changed');
      return messageStage.currentLayer();
    };
    const overflowPolicy = (name: string) => {
      const frame = fontStack.borrowFrames(name).at(-1);
      if (frame?.overflow === undefined)
        throw Error('Artemis cached fontinit overflow is unresolved');
      return frame.overflow;
    };
    const ruby = new ArtemisRuby(hash, {
      currentMessageLayer: () => messageSelection.currentMessageLayer(),
      insertRuby: (name, main, annotation) =>
        glyphs.get(selectedResource(name)).insertRuby(main, annotation),
      fontOverflowPolicy: overflowPolicy,
      writeOverflowed: (value) => variables.write('s.overflowed', String(value)),
      enqueue: (tag) => script.enqueue(tag),
      recordTextCommand: recordText,
      reportRubyError: (tag, kind) => trace({rubyError: kind, tag: tag.name}),
    });
    this.closers.push(() => ruby.close());
    const textCommands = new ArtemisTextCommands(hash, {
      currentMessageLayer: () => messageSelection.currentMessageLayer(),
      newline: (name, omit) => glyphs.get(selectedResource(name)).newline(omit),
      backlogAllowed: () => modes.writeBacklog,
      backlogIncludeFont: () => textControls.backlogIncludeFont,
      captureBacklog: () => {
        throw Error('Artemis backlog resource snapshot not implemented');
      },
      clearCommandHistory: (name) => saveData.clearText(name),
      saveCurrentFontHistory: (name) => saveData.saveFonts(name, fontStack.borrowFrames(name)),
      promoteRememberedTextCommands: (name) => saveData.promoteText(name),
      forceImmediateClear: () => modes.skipAllowed && (modes.commandSkip || modes.controlSkip),
      clearText: async (name, out) => {
        if (out && sceneTweens.snapshot('out', name).length)
          throw Error('Native outgoing text effects are not implemented');
        const resource = selectedResource(name);
        if (glyphs.get(resource).clearEmptyEffects()) textDisplays.get(resource)?.clear();
      },
      recordTextCommand: recordText,
    });
    this.closers.push(() => textCommands.close());
    const print = new ArtemisPrint(hash, {
      currentMessageLayer: () => messageSelection.currentMessageLayer(),
      rubyActive: () => ruby.active,
      debugSkipActive: () => false,
      print: (name, bytes) => glyphs.get(selectedResource(name)).insert(bytes),
      appendRubyBytes: (bytes) => ruby.appendRubyBytes(bytes),
      fontOverflowPolicy: overflowPolicy,
      writeOverflowed: (value) => variables.write('s.overflowed', String(value)),
      reportPrintError: (tag, kind) => trace({printError: kind, tag: tag.name}),
      enqueue: (tag) => script.enqueue(tag),
      recordPrintCommand: recordText,
    });
    const screenshots =
      services.screenshots &&
      new ArtemisScreenshots(hash, {
        stageSize: () => ({width, height}),
        take: () => services.screenshots!.take(),
        read: (w, h) => services.screenshots!.read(w, h),
        writeSaveFile: (name, bytes) => this.writeSaveFile(name, bytes),
        evictSurface: (name) => services.surfaces.evict(name),
        invalidSize: (tag) => {
          throw Error(`Artemis ${tag.name} size is invalid`);
        },
        missingScreenshot: (tag) => {
          throw Error(`Artemis ${tag.name} ran before takess`);
        },
      });
    // Reset and load are built after the Lua runtime that this dispatcher feeds.
    let dispatchTag: ReturnType<typeof createArtemisTagDispatch> | undefined;
    const createDispatch = () =>
      createArtemisTagDispatch(
        {
          print,
          ruby,
          textCommands,
          layers,
          fullscreenVideo,
          messageSelection,
          fontStack,
          sceneTweens,
          textBreakControls,
          dialog,
          keyBindings,
          eventCommands,
          nativeLibrary,
          textControls,
          modes,
          exec,
          variables,
          caption,
          seStop,
          soundFinish,
          mouse,
          wait,
          stop,
          ...(services.shaders ? {shaders: services.shaders} : {}),
          reset,
          save,
          load,
          clickGlyphs,
          music,
          sePlay,
          screenshots,
        },
        suspend,
      );
    // `recordHistory` false is the native replay flag (c5800 third argument) of the loader.
    const dispatch = (tag: AsbTag, recordHistory = true) => {
      services.trace?.tag?.(tag);
      dispatchTag ??= createDispatch();
      return dispatchTag(tag, recordHistory);
    };
    const random = new ArtemisRandom(hash, services.randomSeed);
    const surfaces = services.surfaces;
    lua = this.lua = new ArtemisLua({
      bindSurface: (name) => {
        // Foreground load; the returned lease is released at once (native 0x140134180).
        suspend(surfaces.load(name).then((image) => image?.lease?.release()));
        return 'suspended';
      },
      bindSurfaceAsync: (name) => surfaces.bindSurfaceAsync(name),
      unbindSurface: (name) => surfaces.unbindSurface(name),
      clearSurfaceLoadQueue: () => surfaces.clearSurfaceLoadQueue(),
      isLoadingSurface: (name) => surfaces.isLoadingSurface(name),
      suspendableTags: true,
      ...(services.reportIncludeError ? {reportIncludeError: services.reportIncludeError} : {}),
      readPlainFile: (path) => {
        services.trace?.include?.(path);
        return plainFiles.get(path.replaceAll('\\', '/')) ?? null;
      },
      readFile: (path) => {
        services.trace?.include?.(path);
        return readFile(path);
      },
      random: () => random.next(),
      // Lua receives the se/video ids (ba0/bc8) as strings.
      scriptWaitReason: () => {
        const {sound: soundId, video, ...reason} = wait.reason;
        const encoder = new TextEncoder();
        return {
          ...reason,
          ...(soundId === undefined ? {} : {sound: encoder.encode(soundId)}),
          ...(video === undefined ? {} : {video: encoder.encode(video)}),
        };
      },
      // Unprepared files are read asynchronously, then the Lua call repeats.
      readResource: (path) => {
        const resolved = files.resolvePath(path);
        const bytes = prepared.get(resolved);
        if (bytes) return bytes;
        if (!files.paths.has(resolved)) return null;
        suspend(
          files.read(path).then((data) => {
            if (data === null) throw Error('Artemis Lua resource disappeared: ' + path);
            prepared.set(resolved, data);
          }),
        );
        return 'suspended';
      },
      reportError: services.reportError,
      fileExists: (path) => {
        const name = this.saveFileName(path);
        return name === undefined
          ? files.paths.has(files.resolvePath(path))
          : this.saveNames.has(name);
      },
      setMagicPath: (name, root) => {
        files.setMagicPath(name, root);
        trace({magicPath: {name, root}});
      },
      setTouchLimit: services.setTouchLimit,
      pointerPosition: services.pointer,
      now: () => this.now,
      tag: (tag) => script.executeTag(tag),
      enqueueTag: (tag) => script.enqueue(tag),
      variable: (name) => variables.queryLiteral(name),
      scriptStack: () => script.stack(),
      input: this.input,
      scriptStatus: () => this.mode,
      setScriptStatus: (mode) => this.setScriptStatus(mode),
      frameNumber: () => this.frameNumber,
      touch: services.touch ?? {count: () => 0, setHold: () => {}},
    });
    this.closers.unshift(() => lua.close());
    let compiled = 0;
    for (const [path, bytes] of prepared)
      if (/\.(lua|ast)$/.test(path)) {
        const text = plainFiles.get(path);
        if (text !== undefined) lua.vm.compileFile(text, path, windowsTextFileBytes(text));
        else lua.vm.compile(bytes, `@${path}`);
        compiled++;
      }
    this.compiled = compiled;
    script = this.script = new ArtemisScript(lua, {
      pushLocal: () => variables.pushLocal(),
      popLocal: () => variables.popLocal(),
      readFile,
      dispatch,
      evaluateExpression: (expression) =>
        new TextDecoder().decode(artemisExpressionBytes(expression, variables)),
      trace: ({origin, file, tagIndex, tag}) =>
        services.trace?.script?.({
          origin,
          file,
          tagIndex,
          name: tag.name,
          sourceLine: tag.sourceLine,
          ...(tag.name === 'calllua' ? {function: tag.args.get('function') ?? ''} : {}),
        }),
      ...(services.reportLuaCallError ? {reportLuaCallError: services.reportLuaCallError} : {}),
      ...(services.reportUnknownTag ? {reportUnknownTag: services.reportUnknownTag} : {}),
      caretFields: {
        take: () => wait.take(),
        restore: (fields) => wait.restore(fields as ArtemisWaitFlags | undefined),
      },
    });
    const scriptEvents = (this.scriptEvents = createArtemisScriptEvents(hash, lua, script, {
      nativeMode: () => this.mode,
      disabled: () => false,
      latched: () => false,
      latch: () => {},
      report: (kind, command, error) =>
        trace({eventError: {kind, name: command.name, error: String(error)}}),
    }));
    const resetOwners = () => {
      exec.clearRequests();
      clickGlyphs.reset();
      scriptEvents.clear();
      messageSelection.reset();
      fontStack.reset(() => ({font: new Map()}));
      messageHistory.clear();
      messageHistory.add('').add('backlog');
      sceneTweens.reset();
      ruby.reset();
      textControls.reset();
      trace({cursorVisible: true, reset: true});
      keyBindings.resetPushHandlers();
      eventCommands.reset();
      // New music/effect managers: every effect voice stops and the id map empties.
      for (const index of new Set(effectSlots.values())) sound.stopEffect(index, 0);
      effectSlots.clear();
      sound.stopMusic(music.currentIndex, 0);
      sound.stopMusic(music.fadingIndex, 0);
      music.reset();
      lua.events.clear();
      wait.clear();
      layers.reset();
      messageStage.reset();
    };
    const reset = (this.resetEngine = new ArtemisReset(modes, save, variables, readHistory, {
      bootPath: () => ini.bootPath,
      updateMessageState: () => trace({messageStateUpdated: true, reset: true}),
      releaseScheduler: () => trace({releaseScheduler: true, reset: true}),
      resetOwners,
      applyVolumes: (musicVolume, effectVolume) => services.applyVolumes(musicVolume, effectVolume),
      resetSaveObject: () => {
        saveData.clear();
        music.clearHistory();
        layers.clearLayerCommands();
      },
      loadBoot: (path) => {
        trace({boot: path});
        script.reset(path);
      },
      readSaveFile: (name) => services.storage.read(name),
      initializeStaticVariables,
    }));
    // Font frames are attribute overrides over the 193720 defaults; the codec writes the
    // complete attributes and reads back the attributes that differ from the defaults.
    const fontCodec = {
      write: (archive: ArtemisSaveArchiveWriter, frame: ArtemisRuntimeFont) =>
        writeArtemisFontFrame(archive, {
          font: {
            ...artemisDefaultFontAttributes(hash),
            ...Object.fromEntries(frame.font),
          } as ArtemisFontAttributes,
          overflow: frame.overflow ?? 0,
        }),
      read: (archive: ArtemisSaveArchiveReader): ArtemisRuntimeFont => {
        const frame = readArtemisFontFrame(hash, archive),
          defaults: Record<string, unknown> = artemisDefaultFontAttributes(hash);
        const font = new Map(
          Object.entries(frame.font).filter(
            ([key, value]) => JSON.stringify(value) !== JSON.stringify(defaults[key]),
          ),
        );
        return {font, overflow: frame.overflow};
      },
    };
    // Script fields without an owner here: no macro stack, right-click script or debug
    // console; +0x3628 is the default font property.
    const scenarioScalars = {
      macroFiles: [] as string[],
      autosaveFlag: 0,
      autosaveValue: 0,
      debugMode: 0,
      debugLevel: 0,
      field35b8: '',
      field35d8: 0,
      field3880: 0,
      font: {font: new Map()} as ArtemisRuntimeFont,
    };
    const scenarioOwners = () => ({
      modes,
      script,
      keyBindings,
      eventCommands,
      messageLayers: messageStage,
      messageSelection,
      textControls,
      sceneTweens,
      clickGlyphs,
      events: lua.events,
      saveData,
      layerCommands: {
        snapshot: () => layers.snapshotLayerCommands(),
        restore: (snapshot: ReadonlyMap<string, readonly AsbTag[]>) =>
          layers.restoreLayerCommands(snapshot),
      },
      music,
      variables,
    });
    /** `asLoaded` writes the caret as the loader restores it: run mode 0, no wait flag. */
    this.writeScenario = (asLoaded) => {
      const record = captureArtemisScenario(
        scenarioOwners(),
        scenarioScalars,
        {asLoaded, waiting: wait.pending, frameWaiting: (fields) => fields !== undefined},
        null,
      );
      const writer = new ArtemisSaveArchiveWriter();
      writeArtemisScenarioArchive(writer, record, variables, fontCodec);
      return writer.finish();
    };
    // A tag dispatched inside another resource operation (loader replay, load tag trans)
    // completes its own suspension before the caller continues.
    const dispatchNested = async (tag: AsbTag, recordHistory: boolean) => {
      if (dispatch(tag, recordHistory) !== 'suspended') return;
      const operation = this.pendingResource;
      this.pendingResource = null;
      await operation;
    };
    let loadPrevious = 0;
    const scenarioLoadHost = {
      reset: () => reset.engineReset(),
      loadScalars: (scalars: Partial<typeof scenarioScalars>) => {
        for (const [name, value] of Object.entries(scalars))
          if (value !== undefined) Object.assign(scenarioScalars, {[name]: value});
      },
      loadBacklog: (backlog: unknown) => trace({backlogLoad: backlog ? 'empty' : null}),
      enterLoadMode: (caret: ArtemisLoadedCaret | undefined) => {
        loadPrevious = caret ? caret.runMode : this.mode;
        this.script.setRunMode(13);
        trace({runMode: 13, simulation: true});
      },
      frameState: () => undefined,
      refreshGlyphLayer: (name: string) => trace({glyphLayerRefresh: name, simulation: true}),
      finishLoad: () => {
        this.script.setRunMode(loadPrevious);
        trace({runMode: this.mode, loadFinished: true, simulation: true});
      },
      selectMessageLayer: (name: string, mode: -1 | 0 | 1) =>
        messageStage.selectMessageLayer(name, mode),
      currentMessageLayer: () => messageSelection.currentMessageLayer(),
      setCurrentMessageLayer: (name: string) => messageSelection.loadFields({current: name}),
      replaceFontFrames: (fonts: ReadonlyMap<string, readonly ArtemisRuntimeFont[]>) =>
        fontStack.replaceFrames(fonts),
      applyFontFrame: (_name: string, frame: ArtemisRuntimeFont) => {
        messageStage.currentLayer().font = new Map(frame.font);
      },
      dispatch: (tag: AsbTag) => dispatchNested(tag, false),
      applySceneTween: (out: boolean) =>
        trace({sceneTween: out ? 'out' : 'in', replay: true, simulation: true}),
      writeCurrentMessageLayerVariable: (name: string) =>
        variables.write('s.current_message_layer', name),
    };
    const load = (this.load = new ArtemisLoad(save, readHistory, variables, lua.events, {
      readSaveFile: (name) => services.storage.read(name),
      loadScenario: async (archive) => {
        await applyArtemisScenario(
          scenarioOwners(),
          readArtemisScenarioArchive(archive, fontCodec),
          scenarioLoadHost,
        );
        this.scenarioLoaded?.();
      },
      // Native loads the handler's resources synchronously inside the call; here each
      // suspension awaits its resource operation before the callback resumes.
      callEvent: async (name, args) => {
        const task = lua.createCall(name, args);
        try {
          for (;;) {
            const waiting = script.state === 'waiting';
            if (task.resume().status !== 'yielded') return;
            if (!this.pendingResource || script.pendingLuaCalls)
              throw Error('Artemis onLoad suspended without its own resource operation');
            const operation = this.pendingResource;
            this.pendingResource = null;
            await operation;
            if (!waiting && script.state === 'waiting') script.resume();
          }
        } finally {
          task.close();
        }
      },
      reportEventError: (handler, error) =>
        trace({loadEventError: {handler, error: String(error)}}),
      transition: (tag) => dispatchNested(tag, true),
    }));
  }

  /** Native run mode (script +0xc70). */
  get runMode(): number {
    return this.mode;
  }
  /** Pointer layer events and pushed keys reach their handlers (run modes 1 and 3). */
  get acceptsInput(): boolean {
    return this.mode === 1 || this.mode === 3;
  }
  /** A tag or Lua call is suspended on a resource operation. */
  get resourcePending(): boolean {
    return this.pendingResource !== null;
  }
  /** The current message layer's text display has shown every glyph. */
  get textDisplayComplete(): boolean {
    return this.currentTextDisplay().complete;
  }

  /** Engine boot (bf210 with the boot script), then the first script slice. */
  async boot(): Promise<void> {
    await this.resetEngine.boot();
    this.script.run(1000);
  }
  /** Awaits the suspended resource operation and continues its tag or Lua caller.
   * 'held' means the operation entered a run mode (transition, video) that now holds the
   * script; 'resumed' means the script ran on. */
  async settleResource(): Promise<'held' | 'resumed'> {
    const operation = this.pendingResource;
    if (!operation) throw Error('No Artemis resource operation is pending');
    this.pendingResource = null;
    this.resourceInFlight = true;
    const script = this.script;
    const restored = script.restoredCarets;
    try {
      await operation;
    } finally {
      this.resourceInFlight = false;
    }
    // A load replaced the suspended caret and its Lua callers; the loaded caret runs.
    if (script.restoredCarets !== restored) {
      if (this.runModeHeld) {
        this.runModeHeld = false;
        if (script.state === 'ready') script.pause();
        return 'held';
      }
      if (script.state === 'ready') script.run(1000);
      return 'resumed';
    }
    if (this.runModeHeld) {
      this.runModeHeld = false;
      // The native tag returns at once: a Lua caller runs to its end, then the script
      // waits in the held run mode until its owner releases it.
      if (script.pendingLuaCalls) {
        script.resumeLua();
        if (this.pendingResource) throw Error('Artemis Lua resource work in a held run mode');
        if (script.state === 'ready') script.pause();
      }
      return 'held';
    }
    if (script.pendingLuaCalls) script.resumeLua();
    else script.resume();
    script.run(1000);
    return 'resumed';
  }
  /** Moves the frame clock to `now` and advances sound voices and layer tweens. */
  advanceTo(now: number): void {
    this.now = now;
    this.services.sound.advanceToTick(now);
    this.layers.tickTweens(now);
  }
  /** One real-time frame in the order of 0x1400c0560: the frame counter; the window
   * update delivers the pointer layer events of the previous frame's input (it precedes the
   * input update, and each event's script event is immediate or deferred by run mode); the
   * input update; the clock advances sound, tweens and video layers; Lua `onEnterFrame` runs (a
   * failing handler is cleared); then the run mode branch. Run mode 2 steps the transition,
   * which role 0 decided finishes; run mode 7 runs the fullscreen movie frame; run modes 1
   * and 3 deliver the push handlers (slot 0 on decide, slot 1 on
   * push), and a delivered handler ends the frame; the wait (run modes 1, 3 and 4) checks
   * the role 0 decision in run mode 1, its deadline or display completion; then a ready
   * script runs up to `steps` tags. While a resource load holds the script only the input
   * and clock advance; `settleResource` resumes it. */
  frame(now: number, input: ArtemisFrameInput, steps = 1000): void {
    this.frameNumber = (this.frameNumber + 1) >>> 0;
    if (!this.resourcePending) {
      const events = this.layerEventQueue;
      this.layerEventQueue = [];
      // The window update raises events from the current layers: an event of a layer
      // deleted or changed since the pointer input is not raised.
      for (const event of events)
        if (this.layers.hasLayerEvent(event.id, event.type)) this.layerEvent(event.id, event.type);
        else this.services.trace?.effect?.({layerEvent: {...event, dropped: true}});
    }
    this.layerEventQueue.push(...input.layerEvents);
    this.input.update(now, input.sample);
    this.advanceTo(now);
    if (this.resourcePending) return;
    try {
      this.lua.events.emit('onEnterFrame');
    } catch (error) {
      this.services.trace?.effect?.({enterFrameError: String(error)});
    }
    if (this.resourcePending) return;
    // Mode roles (0x1400c0560 before the run mode switch): a decided stop role ends
    // automode (role 10 with stopbyclick, else 11) or command skip (13) and the frame;
    // control skip follows role 14 held.
    const modes = this.modes;
    if (modes.automode && this.roleDecided(modes.stopAutoByClick ? 10 : 11)) {
      modes.setAutomode(false);
      return;
    }
    if (modes.commandSkip && this.roleDecided(13)) {
      modes.setCommandSkip(false);
      return;
    }
    const control = this.roleHeld(14);
    if (control !== modes.controlSkip) modes.setControlSkip(control);
    if (this.layers.transitionPending) {
      if (this.mode === 2 && this.roleDecided(0)) {
        this.layers.finishTransition(now || 1);
        this.variables.write('s.clickskip', '1');
      } else this.layers.tickTransition(now);
    }
    if (this.mode === 7) this.fullscreenVideo.frame();
    if (this.acceptsInput) {
      // A delivered push handler ends the frame before the wait sees the click.
      const delivered = this.keyBindings.deliverPushed(
        (key, slot) => this.input.query(slot === 0 ? 'decide' : 'push', key),
        (command) => this.scriptEvents.dispatch(command),
      );
      if (delivered) return;
      // Role 9 starts automode, role 12 command skip (unforced); either ends the frame.
      if (this.roleDecided(9)) {
        modes.setAutomode(true);
        return;
      }
      if (this.roleDecided(12)) {
        modes.setCommandSkip(true);
        return;
      }
    }
    const mode = this.mode;
    // Run mode 1 clicks on role 0 or while skipping (0x1400b5170).
    if (this.wait.pending && (mode === 1 || mode === 3 || mode === 4))
      this.wait.tick(now, mode === 1 && (this.roleDecided(0) || this.skipping), mode === 1);
    if (this.script.state === 'ready') this.script.run(steps);
  }
  /** 0x1400b5170: skip is allowed and command or control skip is on (debug skip has no
   * owner). */
  get skipping(): boolean {
    const modes = this.modes;
    return modes.skipAllowed && (modes.commandSkip || modes.controlSkip);
  }
  /** Role `role` held this frame (0x1400acec0 for role 14 over the input owner). */
  roleHeld(role: number): boolean {
    return this.keyBindings.roleActive(role, 'down', (kind, key) => this.input.query(kind, key));
  }
  /** Role `role` decided this frame (0x1400b5690 over the input owner). */
  roleDecided(role: number): boolean {
    return this.keyBindings.roleActive(role, 'decide', (kind, key) => this.input.query(kind, key));
  }
  /** Lua `setScriptStatus`: c74 = c70, c70 = `mode`. A nonzero mode holds a ready script; mode
   * 0 runs a waiting script, and the wait flags no longer apply. */
  private setScriptStatus(mode: number): void {
    const script = this.script;
    script.enterRunMode(mode);
    if (mode !== 0) {
      if (script.state === 'ready') script.pause();
    } else if (script.state === 'waiting' && !script.pendingLuaCalls) {
      this.wait.clear();
      script.resume();
    }
  }
  /** Display properties (left, top, alpha, xscale, yscale, rotate) of a glyph or block
   * that the text display has animated; undefined while it has the defaults. */
  textProperties(key: object): ReadonlyMap<string, number> | undefined {
    return this.displayProperties.get(key);
  }
  /** Delivers a layer event (`lyevent` callback) to the script. */
  layerEvent(id: string, type: ArtemisLayerEventType): void {
    const delivered = this.layers.invokeLayerEvent(id, type, this.scriptEvents);
    this.services.trace?.effect?.({layerEvent: {id, type, delivered, script: this.script.state}});
  }
  /** Delivers pushed key edges to the slot 0 `keypush` handlers in ascending key order;
   * true when a handler command was delivered, which ends the frame. */
  keyPush(keys: number | readonly number[]): boolean {
    const pushed = typeof keys === 'number' ? [keys] : keys;
    return this.keyBindings.deliverPushed(
      (candidate, slot) => slot === 0 && pushed.includes(candidate),
      (command) => this.scriptEvents.dispatch(command),
    );
  }
  /** The scenario archive of the current state. `asLoaded` writes the caret as the loader
   * restores it: run mode 0 with no wait flags. */
  scenarioArchive(asLoaded = false): Uint8Array {
    return this.writeScenario(asLoaded);
  }
  /** Settles the pending save-file writes. */
  async flushSaves(): Promise<void> {
    await Promise.all(this.saveWrites);
  }
  private store(name: string, kind: 'S' | 'G' | 'X', archive: Uint8Array): void {
    this.saveWrites.push(
      packArtemisSaveFile(kind, archive).then((bytes) => this.writeSaveFile(name, bytes)),
    );
  }
  private async writeSaveFile(name: string, bytes: Uint8Array): Promise<void> {
    await this.services.storage.write(name, bytes);
    this.saveNames.add(name);
  }
  /** The SaveDataPath directory (system.ini SAVEPATH), when it is installation-relative. */
  private readonly saveDirectory: string | undefined;
  /** The storage name of a path inside the save directory, otherwise undefined. */
  private saveFileName(path: string): string | undefined {
    const directory = this.saveDirectory;
    if (directory === undefined) return undefined;
    const normalized = path.replaceAll('\\', '/');
    const prefix = normalized.slice(0, directory.length + 1).toLowerCase();
    return prefix === `${directory.toLowerCase()}/`
      ? normalized.slice(directory.length + 1)
      : undefined;
  }
  /** A save directory file from save storage; undefined for paths outside it. */
  readSaveDirectoryFile(path: string): Promise<Uint8Array | null> | undefined {
    const name = this.saveFileName(path);
    return name === undefined ? undefined : this.services.storage.read(name);
  }
  close(): void {
    for (const close of this.closers) close();
  }
}
