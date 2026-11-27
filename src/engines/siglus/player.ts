import {IndexedDbStore} from '../../platform/store.js';
import {scheduleFrameDeadline} from '../../core/frame-deadline.js';
import {BlobSource, type ByteSource} from '../../core/source.js';
import {parseCgTable} from '../../formats/siglus/cgtable.js';
import {SiglusDbs} from '../../formats/siglus/dbs.js';
import {SiglusScenePack} from '../../formats/siglus/scene-pack.js';
import {BrowserFullscreenMoviePlayer} from '../../video/fullscreen-movie.js';
import {SiglusOmvPlayback} from '../../video/siglus-omv-playback.js';
import {
  MissingSiglusVoiceError,
  SiglusAudio,
  siglusVolumeGain,
  type SiglusAudioKind,
  type SiglusBgmCheckpoint,
  type SiglusPcmCheckpoint,
} from './audio.js';
import {readCaptureBmpFlags} from './capture.js';
import {measureSiglusFlick, siglusFlickScene} from './flick.js';
import {SiglusJoypad} from './joypad.js';
import {siglusCos, siglusSin, siglusTostrZen} from './math.js';
import {
  parseButtonSe,
  parseMwndAnimation,
  parseNoSaveObjectIds,
  type MwndAnimation,
} from './mwnd.js';
import {
  SiglusConfiguration,
  type SiglusFontSettings,
  type SiglusMoviePlayer,
  type SiglusScreenSettings,
} from './configuration.js';
import {
  SiglusDisplay,
  orderedObjects,
  serializeDrawObject,
  type DrawObject,
  type SerializedDrawObject,
  type SiglusBackground,
  type SiglusCaptureOptions,
  type SiglusCastPlacement,
  type SiglusFrameAction,
  type SiglusGanCheckpoint,
  type SiglusMovieEffectCheckpoint,
  type SiglusRectangleEffectCheckpoint,
  type SiglusHistoryEntry,
  type WipeSpec,
} from './display.js';
import {parseSelbtnArgs, selbtnPresentation} from './selbtn.js';
import {eventEasing, timetable} from './timing.js';
import {proceduralWipeMask, selectPcmEventIndex, wipeSoftness} from './wipe.js';
import {
  SiglusVm,
  type Argument,
  type SiglusCheckpoint,
  type SiglusCommand,
  type SiglusTag,
  type Value,
} from './vm.js';

const fadeTimes = [
  250, 100, 500, 1000, 1500, 2000, 2500, 3000, 4000, 5000, 6000, 7000, 8000, 9000, 10000, 12000,
  14000, 16000, 18000, 20000,
];
const spriteActor = (name: string): string => name.replace(/^bs\d_/i, '').slice(0, 2);
const isEmptyStageSlot = (name: string): boolean =>
  !name || name.startsWith('none') || name === 'nothing' || name.startsWith('nothing');
const emptyDrawObject = (): DrawObject => ({
  name: '',
  frames: [],
  x: 0,
  y: 0,
  pattern: 0,
  visible: false,
});
const systemFlags = new Set([6, 7, 133, 134, 223, 251, 258]);
// In 1.1.102.1, members 30/31 set the flag read by the script diagnostics panel at 0x573b42.
const scriptFlags = new Set([
  30, 31, 12, 13, 32, 33, 48, 51, 54, 55,
]);
const messageFrameWatchers = [
  {flag: 1010, slot: 2, command: '$msg_btn_watch01'},
  {flag: 1011, slot: 3, command: '$msg_btn_watch02'},
] as const;
// syscom's set, reset, and get opcodes for each configured volume.
const soundLevels: ReadonlyArray<[SiglusAudioKind | 'ALL' | 'MOV', number, number, number]> = [
  ['ALL', 39, 40, 41],
  ['BGM', 21, 24, 25],
  ['KOE', 26, 27, 28],
  ['PCM', 29, 30, 31],
  ['SE', 32, 33, 34],
  ['MOV', 263, 264, 265],
];
const soundSwitches: ReadonlyArray<[SiglusAudioKind | 'ALL' | 'MOV', number, number, number]> = [
  ['ALL', 60, 101, 61],
  ['BGM', 35, 102, 42],
  ['KOE', 36, 103, 43],
  ['PCM', 37, 104, 44],
  ['SE', 38, 105, 45],
  ['MOV', 266, 267, 268],
];
const systemOptions = [
  ['SLEEP_ONOFF', 110, 111, 112],
  ['NO_WIPE_ANIME_ONOFF', 113, 114, 115],
  ['NO_MWND_ANIME_ONOFF', 8, 109, 81],
  ['SKIP_WIPE_ANIME_ONOFF', 116, 117, 118],
  ['WHEEL_NEXT_MESSAGE_ONOFF', 119, 120, 121],
  ['KOE_DONT_STOP_ONOFF', 122, 123, 124],
  ['SKIP_UNREAD_MESSAGE_ONOFF', 125, 126, 127],
  ['PLAY_SILENT_SOUND_ONOFF', 250, 257, 243],
] as const;
type SystemOption = (typeof systemOptions)[number][0];

const playbackLimits = {
  messageSpeed: 255,
  autoCharacterWait: 500,
  autoMinimumWait: 10000,
  voiceDuckLevel: 255,
} as const;
const playbackSwitches = ['messageNowait', 'voiceDuckEnabled'] as const;
type PlaybackSettings = Record<keyof typeof playbackLimits, number> &
  Record<(typeof playbackSwitches)[number], boolean>;

interface RealCounter {
  start: number;
  from: number;
  pausedAt?: number;
  range?: {to: number; duration: number; loop?: boolean};
}

interface ActiveFrameAction {
  readonly path: readonly number[];
  readonly scene: string;
  readonly command: string;
  readonly args: readonly Argument[];
  readonly endTime: number;
  readonly realTime: boolean;
  readonly started: number;
  readonly modalFront: boolean;
}

interface ScriptFontOverride {
  name?: string;
  bold?: number;
  shadow?: number;
}

const filterCommands = [
  [82, 83, 84],
  [85, 88, 91],
  [86, 89, 92],
  [87, 90, 93],
] as const;

export interface SiglusGame {
  files: ReadonlyMap<string, ByteSource>;
  pack: SiglusScenePack;
  config: ReadonlyMap<string, string> & {readonly nameEntries?: readonly string[]};
  title: string;
  gameId?: string;
  saveKey: string;
  appendDir?: string;
  appendName?: string;
}

function parseSelectIniEntry(
  bytes: Uint8Array,
  preferredDir?: string,
): {appendDir: string; appendName: string} | undefined {
  const text =
    bytes.length >= 2 && bytes[0] === 0xff && bytes[1] === 0xfe
      ? new TextDecoder('utf-16le').decode(bytes.subarray(2))
      : new TextDecoder('shift_jis').decode(bytes);
  const rows: {appendDir: string; appendName: string}[] = [];
  for (const rawLine of text.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line) continue;
    const [dirCol = '', nameCol = ''] = line.split('\t');
    const appendDir = dirCol.trim();
    if (appendDir) rows.push({appendDir, appendName: nameCol.trim()});
  }
  if (!rows.length) return undefined;
  if (preferredDir) {
    const match = rows.find((r) => r.appendDir.toLowerCase() === preferredDir.toLowerCase());
    if (match) return match;
  }
  return rows[0];
}

export async function openSiglusGame(
  files: ReadonlyMap<string, ByteSource>,
  options?: {appendDir?: string; appendName?: string},
): Promise<SiglusGame> {
  const scenes = files.get('scene.pck');
  const configuration = files.get('gameexe.dat');
  if (!scenes || !configuration) throw new Error('Choose the Siglus game folder.');
  const sceneBytes = await scenes.read(0, scenes.size);
  const pack = new SiglusScenePack(sceneBytes);
  const config = pack.configuration(await configuration.read(0, configuration.size));
  const title = config.get('GAMENAME')?.split('"')[1]?.normalize('NFKC') ?? 'SiglusEngine';
  const gameId = config.get('GAMEID')?.split('"')[1];
  const selectSource = files.get('select.ini');
  const selectEntry = selectSource
    ? parseSelectIniEntry(await selectSource.read(0, selectSource.size), options?.appendDir)
    : undefined;
  const appendDir = options?.appendDir ?? selectEntry?.appendDir;
  const appendName = options?.appendName ?? selectEntry?.appendName;
  const hash = await crypto.subtle.digest('SHA-256', sceneBytes.slice().buffer);
  const saveKey =
    'siglus:' +
    Array.from(new Uint8Array(hash), (byte) => byte.toString(16).padStart(2, '0')).join('');
  return {files, pack, config, title, gameId, saveKey, appendDir, appendName};
}

type HistoryPoint = Omit<PlayerSave, 'history' | 'historyPoints'>;

interface PlayerSave {
  version: 1;
  vm: SiglusCheckpoint;
  stage: [string, Value][];
  message: ReturnType<SiglusDisplay['saveMessage']>;
  background?: string;
  bgm?: string;
  bgmPlayback?: SiglusBgmCheckpoint;
  bgmLevel?: number;
  pcmPlayback?: SiglusPcmCheckpoint[];
  voiceLevel?: number;
  seLevel?: number;
  cast: string[];
  castCostumes?: (string | null)[];
  gan?: SiglusGanCheckpoint;
  gans?: SiglusGanCheckpoint[];
  movieEffects?: SiglusMovieEffectCheckpoint[];
  rectangleEffects?: SiglusRectangleEffectCheckpoint[];
  sceneCovered?: boolean;
  speed: number;
  timestamp?: number;
  title?: string;
  comment?: string;
  thumbnail?: string;
  customValues?: number[];
  waitsForInput?: boolean;
  messagePause?: {
    readFlags: {scene: string; flag: number}[];
    voices: SiglusHistoryEntry['voices'];
  };
  history?: SiglusHistoryEntry[];
  historyPoints?: [number, HistoryPoint][];
  messageFaces?: [number, [number, SerializedDrawObject][]][];
  messageObjects?: [number, [number, SerializedDrawObject][]][];
  messageOpenAnimations?: [number, {type?: number; time?: number}][];
  messageCloseAnimations?: [number, {type?: number; time?: number}][];
  controls?: {
    systemMenu: boolean;
    messageButtons: boolean;
    returnMenu?: [enabled: boolean, visible: boolean];
    disabledButtons: number[];
    save: boolean;
    load: boolean;
    selectionReturnFlags?: [boolean, boolean];
    controlSkip: boolean;
    skipUnread?: boolean;
    messageAnimationsOff?: boolean;
    localExtraSwitches?: [number, number][];
    msgBackEnabled?: boolean;
    scriptMsgBackDisabled?: boolean;
    scriptHistoryRecordingDisabled?: boolean;
    scriptAutoSavePointDisabled?: boolean;
    shortcutDisabled?: boolean;
    hideMwndEnabled?: boolean;
    mwndBtnTouchEnabled?: boolean;
    endMsgByKeyDisabled?: boolean;
    scriptMessageNowait?: boolean;
    messageSpeedOverride?: number;
    joypadModeOverride?: number;
    scriptFlag96?: boolean;
    mouseCursorNo?: number;
    scriptFont?: ScriptFontOverride;
    backButtonGroups?: [number, boolean][];
    systemSkipDisabled?: boolean;
    quakeStopped?: boolean;
  };
  stageObjects?: [[number, SerializedDrawObject][], [number, SerializedDrawObject][]];
  stageEffects?: [string, [number, number][]][];
  usesWipeCopy?: boolean;
  excallFlags?: [number, number][];
  pcmEvents?: [
    number,
    {
      mode?: 'oneshot' | 'loop' | 'random';
      pcmchNo: number;
      entries: {file: string; minTime: number; maxTime: number; probability: number}[];
      options: {volumeType?: number; bgmFadeTarget?: boolean; character?: number};
    },
  ][];
  namaeValues?: [number, string][];
  namaeIds?: [string, number][];
  messageFilterFiles?: [number, string][];
  messageFrameFiles?: [number, string][];
  messageButtonOffsets?: [string, number[]][];
  objectMasks?: [number, {name?: string; x: number; y: number}][];
  messagePointerAction?: {channel: number; scene: string; command: string};
  appendDir?: string;
  appendName?: string;
}

export class SiglusPlayer {
  private readonly controller = new AbortController();
  private readonly display: SiglusDisplay;
  private readonly audio: SiglusAudio;
  private readonly objects = [new Map<number, DrawObject>(), new Map<number, DrawObject>()];
  private usesWipeCopy = false;
  private readonly messageObjects = new Map<number, Map<number, DrawObject>>();
  private readonly messageFaces = new Map<number, Map<number, DrawObject>>();
  private readonly messageButtonOffsets = new Map<string, number[]>();
  private readonly messageCloseAnimations = new Map<number, {type?: number; time?: number}>();
  private readonly messageOpenAnimations = new Map<number, {type?: number; time?: number}>();
  private readonly messageFilterFiles = new Map<number, string>();
  private readonly messageFrameFiles = new Map<number, string>();
  private readonly stageEffects = new Map<string, {props: Map<number, number>; events: Map<number, {endAt: number; target: number}>}>();
  private readonly maskEvents = new Map<string, {endAt: number; target: number}>();
  private messageObjectsDirty = false;
  private systemObjects?: Map<number, DrawObject>;
  private systemBackObjects?: Map<number, DrawObject>;
  private systemObjectsDirty = false;
  private systemObjectMoves?: Set<DrawObject>;
  private excallAllocated = false;
  private readonly excallFlags = new Map<number, number>();
  private readonly groupProps = new Map<string, number>();
  private readonly selectionSaves: PlayerSave[] = [];
  private stagedSelectionSave?: PlayerSave;
  private selectionReturnFlags: [boolean, boolean] = [true, true];
  private msgBackEnabled = true;
  private scriptMsgBackDisabled = false;
  private scriptHistoryRecordingDisabled = false;
  private scriptAutoSavePointDisabled = false;
  private shortcutDisabled = false;
  private hideMwndEnabled = true;
  private mwndBtnTouchEnabled = true;
  private endMsgByKeyDisabled = false;
  private scriptMessageNowait = false;
  private scriptMwndOpenAnimeForce = false;
  private keyWaitDisabled = false;
  private scriptFlag10 = false;
  private skipTriggerArmed = false;
  private skipTriggerFired = false;
  private msgAsyncMode = false;
  private msgAsyncModeOnce = false;
  private asyncReveal?: Promise<void>;
  private finishAsyncReveal?: () => void;
  private scriptAutoMode = false;
  private scriptAutoModeMojiWait = -1;
  private scriptAutoModeMinWait = -1;
  private captureBuffer?: Uint8Array;
  private captureSize?: readonly [number, number];
  private shareCapture?: Uint8Array;
  private autoSkipEnabled = false;
  private mouseMoveByKeyDisabled = false;
  private autoModeMojiCnt = 0;
  private pendingWipe?: Promise<void>;
  private systemFrontObjects?: Map<number, DrawObject>;
  private systemFrontObjectsDirty = false;
  private systemFont?: ScriptFontOverride;
  private scriptFont?: ScriptFontOverride;
  private messageHidden = false;
  private quakeStopped = false;
  private timeStopped = false;
  private readonly joypad = new SiglusJoypad();
  private joypadModeOverride = -1;
  private excallJoypadModeOverride = -1;
  private pendingSystemShortcut?: string;
  private scriptFlag96 = false;
  private mouseCursorNo = 0;
  private systemSkipDisabled = false;
  private systemCallDepth = 0;
  private get systemCallActive(): boolean {
    return this.systemCallDepth > 0;
  }
  private readSkipEnabled = false;
  private requestedFrameAction?: SiglusFrameAction;
  private readonly globalExtraSwitches = new Map<number, boolean>();
  private readonly localExtraSwitches = new Map<number, number>();
  private readonly pendingFrameWatchers = new Set<(typeof messageFrameWatchers)[number]>();
  private messagePointerAction?: {channel: number; scene: string; command: string};
  private messagePointerChanged = false;
  private skipUnreadOverride?: boolean;
  private scriptMessageAnimationsDisabled = false;
  private pageReadFlags: {scene: string; flag: number}[] = [];
  private readonly readFlags = new Map<string, Set<number>>();
  private pageAlreadyRead = false;
  private autoEnabled = false;
  private pageCharacters = 0;
  private voiceMode = 0;
  private readonly playbackDefaults: PlaybackSettings;
  private readonly playback: PlaybackSettings;
  private readonly options = new Map<SystemOption, boolean>();
  private messageFont: SiglusFontSettings;
  private readonly defaultMessageFont: SiglusFontSettings;
  private screenSettings: SiglusScreenSettings;
  private readonly defaultScreenSettings: SiglusScreenSettings;
  private moviePlayer: SiglusMoviePlayer = 'wmp';
  private readonly configuration: SiglusConfiguration;
  private readonly systemCounters = new Map<number, RealCounter>();
  private readonly sceneCounters = new Map<number, RealCounter>();
  private waitingForPage = false;
  private systemMenuEnabled = true;
  private userMessageHidden = false;
  private inputSampled = false;
  private lastInputSampleAt = -Infinity;
  private lastInputSampleScene: string | undefined;
  private readonly pointerFlicks = [undefined, undefined] as (ReturnType<typeof measureSiglusFlick> | undefined)[];
  private readonly pointerFlickPending = [false, false];
  private readonly pointerFlickActive = [false, false];

  private sampleJoypad(): void {
    const navigator = this.root.ownerDocument.defaultView?.navigator;
    let gamepad: Gamepad | undefined;
    try {
      gamepad = navigator?.getGamepads?.().find((pad): pad is Gamepad =>
        Boolean(pad?.connected && pad.mapping === 'standard'),
      );
    } catch {
      // Gamepad access may be disabled by the document's permissions policy.
    }
    this.joypad.sample(gamepad);
  }

  private joypadModeActive(): boolean {
    const config = this.game.config;
    const defaultMode = Number(config.get('JOYPAD.ALLOW_JOYPAD_MODE') ?? 0);
    const storyMode = this.joypadModeOverride;
    const excallMode = this.excallJoypadModeOverride;
    const historyMode = Number(config.get('JOYPAD.MSGBK_ALLOW_JOYPAD_MODE') ?? -1);
    // 1.1.141.3 0x62f510–0x62f574: both EXCALL and story mode fall back to ALLOW_JOYPAD_MODE when override is -1.
    const allowed = this.systemCallActive
      ? excallMode === 1 || (excallMode !== 0 && defaultMode !== 0)
      : this.historyOpen
        ? (historyMode === -1 ? defaultMode : historyMode) !== 0
        : storyMode === 1 || (storyMode !== 0 && defaultMode !== 0);
    return allowed && this.joypad.active;
  }

  private joypadDirectionState(direction: number, command: number): number | undefined {
    const config = this.game.config;
    const mode = (key: string): number => {
      const normal = Number(config.get(`JOYPAD.${key}`) ?? 1);
      const history = Number(config.get(`JOYPAD.MSGBK_${key}`) ?? -1);
      return this.historyOpen && !this.systemCallActive && history !== -1 ? history : normal;
    };
    // The virtual arrow group adds these inputs only in mode 1 (0x645be2–0x645d68).
    const dpad = mode('DPAD_CONTROL_MODE') === 1;
    const stick = mode('LEFT_STICK_CONTROL_MODE') === 1;
    if (!dpad && !stick) return undefined;
    const states = [dpad ? this.joypad.state(direction, command) : undefined,
      stick ? this.joypad.state(16 + direction, command) : undefined];
    return command === 7 ? Number(states.every((state) => state !== 0)) : Number(states.includes(1));
  }

  private sampleInputNow(): void {
    this.display.sampleInput();
    this.sampleJoypad();
    for (const button of [0, 1]) {
      this.pointerFlickActive[button] = this.pointerFlickPending[button]!;
      this.pointerFlickPending[button] = false;
    }
    this.lastInputSampleAt = performance.now();
    this.lastInputSampleScene = this.vm.currentPosition()?.scene;
  }
  private readonly filterDefaults: [number, number, number, number];
  private readonly filterColor: [number, number, number, number];
  private wait?: (value: number) => void;
  private readonly activeGroups = new Set<number>();
  private readonly cancelGroups = new Set<number>();
  private readonly backButtonGroups = new Map<number, boolean>();
  private readonly decisions = new Map<number, number>();
  private decisionReady?: () => void;
  private objectsDirty = false;
  private objectMoves?: Set<DrawObject>;
  private pages = 0;
  private pendingText = false;
  private pendingLoadSound = false;
  private printing = false;
  private revealWholePage = false;
  private speed = -1;
  private readonly startScene: string;
  private readonly movies: BrowserFullscreenMoviePlayer;
  private readonly objectMovies = new Set<SiglusOmvPlayback>();
  private vm!: SiglusVm;
  private saveEnabled = true;
  private messageButtonsEnabled = true;
  private returnMenuState?: [enabled: boolean, visible: boolean];
  private readonly disabledMessageButtons = new Set<number>();
  private loadEnabled = true;
  private saveStore?: IndexedDbStore;
  private readonly saves = new Map<number, PlayerSave>();
  private readonly quickSaves = new Map<number, PlayerSave>();
  private readonly endSaves = new Map<number, PlayerSave>();
  private readonly innerSaves = new Map<number, PlayerSave>();
  private readonly saveHistory: HistoryPoint[] = [];
  private lastSaveHistoryTime = -Infinity;
  private savePoint?: PlayerSave;
  private dayStage = false;
  private selectedSave?: PlayerSave;
  private lastSelectionMessage = '';
  private voiceSpeedSwitches: [boolean, boolean, boolean] = [false, false, false];
  private voiceSpeedRate = 100;
  private readonly system = new Map<number, number>();
  private readonly galleryFlags = new Map<number, number>();
  private readonly unhandledCommands = new Map<string, {count: number; scene: string; line: number}>();
  private readonly unhandledProperties = new Map<string, {count: number; scene: string; line: number}>();
  private movieError?: Error;
  private skip = false;
  private skipAllowed = true;
  private readonly stageProperties = new Map<string, Value>();
  private readonly castAnchors = new Map<string, Value>();
  private readonly usesLegacyIncludes: boolean;
  private readonly databases = new Map<number, Promise<SiglusDbs | undefined>>();
  private readonly g00Buffers = new Map<number, unknown>();
  private readonly bgmListened = new Set<string>();
  private readonly cgTable = new Map<string, number>();
  private readonly cgFlags = new Set<number>();
  private readonly cgFlagLimit: number;
  private cgTableLoaded = false;
  private readonly noSaveObjectIds: ReadonlySet<number>;
  private readonly namaeIds = new Map<string, number>();
  private readonly namaeValues = new Map<number, string>();
  private readonly namaeAliases = new Map<string, string>();
  private readonly frameActions = new Map<string, ActiveFrameAction>();
  private readonly frameActionCounters = new Map<string, RealCounter>();
  private readonly pendingButtonCalls: {scene: string; command: string}[] = [];
  private flushingButtonCalls = false;
  private mainFrameActionDepth?: number;
  private tickingFrameActions = false;
  private readonly pcmEvents = new Map<
    number,
    {
      cancel: () => void;
      config: {
        mode: 'oneshot' | 'loop' | 'random';
        pcmchNo: number;
        entries: {file: string; minTime: number; maxTime: number; probability: number}[];
        options: {volumeType?: number; bgmFadeTarget?: boolean; character?: number};
      };
    }
  >();
  private currentCast: string[] = [];
  private currentCastCostumes: (string | null)[] = [];
  private pendingBackground?: SiglusBackground;
  private stagedBackground?: SiglusBackground;

  private get skipping(): boolean {
    // 1.1.141.3 0x62f0a0 (tnm_is_skipping): ctrl_disable (+0x351) blocks all skipping,
    // Ctrl/ReadSkip bypass skip_disable (+0x350), and skip_trigger_fired (+0x1a5) only
    // triggers when the user actually pressed advance while 64.48 (+0x378) was armed.
    if (!this.skipAllowed) return false;
    if (this.skip || this.readSkipEnabled) return true;
    return !this.systemSkipDisabled && this.skipTriggerFired;
  }

  private get skipUnread(): boolean {
    return this.skipUnreadOverride ?? this.systemOption('SKIP_UNREAD_MESSAGE_ONOFF');
  }

  constructor(
    private readonly root: HTMLElement,
    private readonly game: SiglusGame,
    windowOptions: ConstructorParameters<typeof SiglusDisplay>[7],
    private readonly trace?: (tag: SiglusTag) => void,
  ) {
    const {files, config} = game;
    const [width, height] = (config.get('SCREEN_SIZE') ?? '1920,1080').split(',').map(Number);
    if (
      !width ||
      !height ||
      !Number.isInteger(width) ||
      !Number.isInteger(height) ||
      width < 1 ||
      height < 1 ||
      width * height > 16_777_216
    )
      throw new Error('Invalid Siglus screen size');
    this.startScene = config.get('START_SCENE')?.split('"')[1] ?? '_start';
    this.usesLegacyIncludes =
      game.pack.commandNames.includes('$bs_disp_in') &&
      game.pack.commandNames.includes('$check_file_exist');
    this.noSaveObjectIds = parseNoSaveObjectIds(config);
    for (const value of config.nameEntries ?? []) {
      const match = /^"([^"]*)"\s*,\s*"([^"]*)"/.exec(value);
      if (match) this.namaeAliases.set(match[1]!.toLowerCase(), match[2]!);
    }
    this.cgFlagLimit = Math.max(0, Number(config.get('CGTABLE_FLAG_CNT') ?? 10000) | 0);
    this.audio = new SiglusAudio(files, config, root, game.saveKey + ':audio');
    this.defaultMessageFont = {
      name: config.get('CONFIG.FONT.NAME')?.split('"')[1] ?? '',
      bold: config.get('CONFIG.FONT.FUTOKU') === '1',
      shadow: Math.min(3, Math.max(0, Number(config.get('CONFIG.FONT.SHADOW')) || 0)),
      showProportional: false,
    };
    this.messageFont = {...this.defaultMessageFont};
    this.defaultScreenSettings = {
      fullscreen: config.get('CONFIG.WINDOW_MODE') === '1',
      windowScale: 1,
      fullscreenLayout: 'fit',
      scaleX: 1,
      scaleY: 1,
      offsetX: 0,
      offsetY: 0,
      syncScale: true,
    };
    this.screenSettings = {...this.defaultScreenSettings};
    this.configuration = new SiglusConfiguration(
      root,
      files.get('siglusengine.exe'),
      this.controller.signal,
    );
    const color = config.get('CONFIG.FILTER_COLOR')?.split(',').map(Number) ?? [];
    this.filterDefaults = [color[0] ?? 0, color[1] ?? 0, color[2] ?? 0, color[3] ?? 255];
    this.filterColor = [...this.filterDefaults];
    const configuredSpeed = Number(config.get('CONFIG.MESSAGE_SPEED'));
    this.playbackDefaults = {
      messageSpeed:
        config.has('CONFIG.MESSAGE_SPEED') && Number.isFinite(configuredSpeed)
          ? Math.max(0, Math.min(playbackLimits.messageSpeed, Math.trunc(configuredSpeed)))
          : 30,
      messageNowait: config.has('CONFIG.MESSAGE_SPEED_NOWAIT.ONOFF')
        ? config.get('CONFIG.MESSAGE_SPEED_NOWAIT.ONOFF') === '1'
        : true,
      autoCharacterWait: 30,
      autoMinimumWait: 1000,
      voiceDuckLevel: Number(config.get('CONFIG.BGMFADE_VOLUME') ?? 255),
      voiceDuckEnabled: config.get('CONFIG.BGMFADE_ONOFF') === '1',
    };
    this.playback = {...this.playbackDefaults};
    const savedOptions = localStorage.getItem(game.saveKey + ':options');
    if (savedOptions) {
      try {
        const values = JSON.parse(savedOptions);
        this.joypad.settings = {
          swapAB: values?.joypad?.swapAB === true,
          swapXY: values?.joypad?.swapXY === true,
        };
        const playback = values?.playback;
        for (const key of Object.keys(playbackLimits) as (keyof typeof playbackLimits)[]) {
          const value = playback?.[key];
          if (Number.isInteger(value) && value >= 0 && value <= playbackLimits[key])
            this.playback[key] = value;
        }
        for (const key of playbackSwitches)
          if (typeof playback?.[key] === 'boolean') this.playback[key] = playback[key];
        if (
          Array.isArray(values?.filter) &&
          values.filter.length === 4 &&
          values.filter.every(
            (value: unknown) =>
              typeof value === 'number' && Number.isInteger(value) && value >= 0 && value <= 255,
          )
        )
          this.filterColor.splice(0, 4, ...(values.filter as number[]));
        for (const [option] of systemOptions)
          if (typeof values?.[option] === 'boolean') this.options.set(option, values[option]);
        for (const [slot, enabled] of Object.entries(values?.globalExtraSwitches ?? {}))
          if (typeof enabled === 'boolean' && /^\d+$/.test(slot))
            this.globalExtraSwitches.set(Number(slot), enabled);
        if (typeof values?.font === 'string') this.messageFont.name = values.font;
        if (typeof values?.fontBold === 'boolean') this.messageFont.bold = values.fontBold;
        if ([0, 1, 2, 3].includes(values?.fontShadow)) this.messageFont.shadow = values.fontShadow;
        if (typeof values?.fontShowProportional === 'boolean')
          this.messageFont.showProportional = values.fontShowProportional;
        if (typeof values?.fullscreen === 'boolean')
          this.screenSettings.fullscreen = values.fullscreen;
        const screen = values?.screen;
        if (screen) {
          if ([0.5, 0.75, 1, 1.5, 2].includes(screen.windowScale))
            this.screenSettings.windowScale = screen.windowScale;
          if (
            ['native', 'stretch', 'fit', 'height', 'width', 'custom'].includes(
              screen.fullscreenLayout,
            )
          )
            this.screenSettings.fullscreenLayout = screen.fullscreenLayout;
          for (const axis of ['scaleX', 'scaleY'] as const)
            if (typeof screen[axis] === 'number' && screen[axis] >= 0.5 && screen[axis] <= 3)
              this.screenSettings[axis] = screen[axis];
          for (const axis of ['offsetX', 'offsetY'] as const)
            if (typeof screen[axis] === 'number' && Math.abs(screen[axis]) <= 1)
              this.screenSettings[axis] = screen[axis];
          if (typeof screen.syncScale === 'boolean')
            this.screenSettings.syncScale = screen.syncScale;
        }
        if (values?.moviePlayer === 'mci' || values?.moviePlayer === 'wmp')
          this.moviePlayer = values.moviePlayer;
        if (
          Array.isArray(values?.voiceSpeedSwitches) &&
          values.voiceSpeedSwitches.length === 3 &&
          values.voiceSpeedSwitches.every((v: unknown) => typeof v === 'boolean')
        )
          this.voiceSpeedSwitches = [...values.voiceSpeedSwitches] as [boolean, boolean, boolean];
        if (
          typeof values?.voiceSpeedRate === 'number' &&
          Number.isInteger(values.voiceSpeedRate) &&
          values.voiceSpeedRate >= 100 &&
          values.voiceSpeedRate <= 300
        )
          this.voiceSpeedRate = values.voiceSpeedRate;
      } catch {
        // An unreadable settings record falls back to the installation defaults.
      }
    }
    this.applyVoiceDuck();
    this.display = new SiglusDisplay(
      root,
      files,
      config,
      width,
      height,
      this.controller.signal,
      () => {
        if (this.systemOption('SKIP_WIPE_ANIME_ONOFF') && this.display.finishWipe()) return;
        if (this.systemCallActive) return;
        if (this.userMessageHidden) {
          this.revealMessage();
          return;
        }
        if (this.printing) {
          // 1.1.141.3 0x67d3dc: script.set_key_disable (64.54, +0x353) blocks key/click reveal skip.
          if (this.endMsgByKeyDisabled) return;
          this.revealWholePage = true;
          this.finishAsyncReveal?.();
          this.wait?.(1);
          return;
        }
        // 1.1.141.3 0x630392..0x630575: user advance input while 64.48 (+0x378) is armed
        // sets skip_trigger_fired (+0x1a5) to fast-forward async animations before page wait.
        if (this.skipTriggerArmed && !this.waitingForPage) {
          this.skipTriggerFired = true;
        }
        this.wait?.(1);
      },
      windowOptions,
      (active) => {
        this.skip = active;
        if (active && this.skipping && this.pendingText) {
          this.revealWholePage = true;
          this.finishAsyncReveal?.();
          this.wait?.(1);
        }
      },
      () => {
        if (this.cancelGroups.size && (!this.waitingForPage || this.systemCallActive)) {
          let cancelled = false;
          for (const group of this.cancelGroups) {
            if (!this.systemCallActive || group >= 100_000) {
              this.choose({id: -1, group});
              cancelled = true;
            }
          }
          if (cancelled) return true;
        }
        if (!this.waitingForPage || !this.systemMenuEnabled || this.systemCallActive) return false;
        if (this.userMessageHidden) this.revealMessage();
        else this.wait?.(3);
        return true;
      },
      (seNo, kind) => {
        void this.playButtonSound(seNo, kind);
      },
      () => {
        // Native SiglusEngine 0x623b80: VK_SPACE (0x20) toggles hide_mwnd during message display
        // without advancing dialogue; pressing Space while hidden restores the message window.
        if (this.systemCallActive) return false;
        if (this.userMessageHidden) {
          this.revealMessage();
          return true;
        }
        if ((this.waitingForPage || this.printing) && this.hideMwndEnabled && !this.messageHidden) {
          this.setUserMessageHidden(true);
          return true;
        }
        return false;
      },
    );
    this.display.stage.addEventListener(
      'wheel',
      (event) => {
        if (
          event.deltaY < 0 &&
          this.waitingForPage &&
          !this.systemCallActive &&
          !this.userMessageHidden &&
          this.msgBackEnabled &&
          !this.scriptMsgBackDisabled &&
          this.backlog.length
        ) {
          event.preventDefault();
          this.wait?.(5);
          return;
        }
        if (
          event.deltaY <= 0 ||
          this.userMessageHidden ||
          (!this.waitingForPage && !this.printing && !this.skipTriggerArmed) ||
          this.systemCallActive ||
          !this.systemOption('WHEEL_NEXT_MESSAGE_ONOFF')
        )
          return;
        event.preventDefault();
        if (this.printing) {
          if (this.endMsgByKeyDisabled) return;
          this.revealWholePage = true;
          this.finishAsyncReveal?.();
        } else if (this.skipTriggerArmed && !this.waitingForPage) {
          this.skipTriggerFired = true;
        }
        this.wait?.(1);
      },
      {passive: false, signal: this.controller.signal},
    );
    const refreshFrameInput = () => {
      this.queueMessageFrameInput();
      if (
        this.waitingForPage &&
        (this.pendingFrameWatchers.size || this.messagePointerChanged || this.frameActions.size)
      )
        this.wait?.(6);
    };
    const frameInputOptions = {signal: this.controller.signal};
    for (const type of ['pointerenter', 'pointermove', 'pointerleave', 'pointerdown'] as const)
      this.display.stage.addEventListener(type, refreshFrameInput, frameInputOptions);
    for (const type of ['pointerdown', 'keydown'] as const)
      this.display.stage.addEventListener(type, () => (this.joypad.active = false), frameInputOptions);
    if (config.has('X_MENU_SCENE') || config.has('JOYPAD.SHORTCUT.CNT')) {
      const pollShortcuts = () => {
        if (this.controller.signal.aborted) return;
        if (this.waitingForPage && this.wait && !this.systemCallActive && !this.historyOpen) {
          this.sampleJoypad();
          if (this.systemMenuEnabled && !this.userMessageHidden && this.joypadModeActive()) {
            const shortcut = this.joypadShortcut();
            if (shortcut) {
              this.pendingSystemShortcut = shortcut;
              this.wait(7);
            }
          }
        }
        requestAnimationFrame(pollShortcuts);
      };
      requestAnimationFrame(pollShortcuts);
    }
    this.installFlickInput();
    const document = root.ownerDocument;
    for (const type of ['focus', 'blur'] as const)
      document.defaultView?.addEventListener(type, refreshFrameInput, frameInputOptions);
    document.addEventListener('visibilitychange', refreshFrameInput, frameInputOptions);
    this.movies = new BrowserFullscreenMoviePlayer({
      document: root.ownerDocument,
      container: this.display.stage,
      open: async (name) => {
        const base = 'mov/' + name.toLowerCase();
        return files.get(base) ?? files.get(base + '.wmv') ?? files.get(base + '.mp4') ?? null;
      },
      unsupported: (name, reason) => {
        this.movieError = new Error('Siglus movie ' + name + ': ' + reason);
      },
    });
    const read = localStorage.getItem(game.saveKey + ':read');
    if (read)
      for (const [scene, flags] of JSON.parse(read) as [string, number[]][])
        this.readFlags.set(scene, new Set(flags));
    const system = localStorage.getItem(game.saveKey + ':system');
    if (system)
      for (const [index, value] of JSON.parse(system) as [number, number][])
        this.system.set(index, value);
    const gallery = localStorage.getItem(game.saveKey + ':gallery');
    if (gallery)
      for (const [index, value] of JSON.parse(gallery) as [number, number][])
        this.galleryFlags.set(index, value);
    const bgmtable = localStorage.getItem(game.saveKey + ':bgmtable');
    if (bgmtable) {
      try {
        for (const name of JSON.parse(bgmtable) as string[])
          if (typeof name === 'string') this.bgmListened.add(name.toLowerCase());
      } catch {
        // Ignore malformed bgmtable record
      }
    }
    const cgtable = localStorage.getItem(game.saveKey + ':cgtable');
    if (cgtable) {
      try {
        for (const flag of JSON.parse(cgtable) as number[])
          if (Number.isInteger(flag) && flag >= 0) this.cgFlags.add(flag);
      } catch {
        // Ignore malformed cgtable record
      }
    }
    if (this.trace) {
      const win = root.ownerDocument.defaultView as
        | (Window & {__siglusDebug?: {snapshot: () => unknown}})
        | null;
      if (win) {
        win.__siglusDebug = {snapshot: () => this.debugSnapshot()};
      }
    }
  }

  private debugSnapshot(): Record<string, unknown> {
    const now = performance.now();
    return {
      gameId: this.game.gameId,
      vm: this.vm.checkpoint(),
      mwnd: this.display.messageWindow,
      bgm: this.audio.bgmName(),
      stageObjects: [
        [...this.objects[0]!].map(([id, obj]) => [id, serializeDrawObject(obj, now)]),
        [...this.objects[1]!].map(([id, obj]) => [id, serializeDrawObject(obj, now)]),
      ],
      stageEffects: [...this.stageEffects].map(([k, v]) => [k, [...v.props]]),
      excallFlags: [...this.excallFlags],
      namaeValues: [...this.namaeValues],
      messageFilterFiles: [...this.messageFilterFiles],
      messageFrameFiles: [...this.messageFrameFiles],
      messageButtonOffsets: [...this.messageButtonOffsets],
      pcmEvents: [...this.pcmEvents].map(([slot, ev]) => [slot, ev.config]),
      objectMasks: this.display.saveObjectMasks(),
      bgmListened: [...this.bgmListened],
      cgFlags: [...this.cgFlags],
      systemFlags: [...this.system],
      galleryFlags: [...this.galleryFlags],
      saveHistory: this.saveHistory.map(({vm}) => {
        const frame = vm.frames.at(-1);
        return frame && {scene: frame.scene, line: frame.line, pc: frame.pc};
      }),
      usesWipeCopy: this.usesWipeCopy,
      unhandledCommands: [...this.unhandledCommands],
      unhandledProperties: [...this.unhandledProperties],
    };
  }

  private normalizePathKey(path: readonly number[]): string {
    const out: string[] = [];
    for (let i = 0; i < path.length; i++) {
      out.push(i > 0 && path[i - 1] === -1 ? '*' : String(path[i]));
    }
    return out.join('.');
  }

  private recordUnhandled(
    bucket: Map<string, {count: number; scene: string; line: number}>,
    path: readonly number[],
    scene?: string,
    line?: number,
  ): void {
    const key = this.normalizePathKey(path);
    const existing = bucket.get(key);
    if (existing) {
      existing.count++;
      return;
    }
    if (bucket.size >= 256) return;
    const pos = this.vm?.currentPosition();
    bucket.set(key, {
      count: 1,
      scene: scene ?? pos?.scene ?? '',
      line: line ?? pos?.line ?? -1,
    });
  }

  private isBuiltinPropertyRoot(root: number | undefined): boolean {
    if (root === undefined || root < 0 || root >= 0x10000) return false;
    if (root >= 23 && root <= 35) return false;
    if (root === 83 || root === 106 || root === 107 || root === 108) return false;
    return true;
  }

  get windowDisplay(): SiglusDisplay['windowDisplay'] {
    return this.display.windowDisplay;
  }

  setTextMode(mode: 'native' | 'dom'): void {
    this.display.setTextMode(mode);
  }

  async start(): Promise<void> {
    await this.audio.resume();
    await this.openSaveStore();
    await this.display.prepare();
    this.applyMessageFont();
    this.applyScreenSettings();
    this.display.setMessageFilter(this.filterColor);
    const [menu, entry] = (this.game.config.get('MENU_SCENE') ?? '"_titlemenu", 0').split(',');
    this.vm = new SiglusVm(
      this.game.pack,
      {
        command: (command) => this.command(command),
        property: (path, value) => this.property(path, value),
        trace: this.trace ?? (() => {}),
        resetStageForMenu: () => this.resetStageForMenu(),
        yieldDelay: () => (this.systemOption('SLEEP_ONOFF') ? 16 : 0),
        message: (tag) => {
          this.beginMessage();
          if (tag.tag === 'name') {
            const name = this.namaeAliases.get(tag.value.toLowerCase()) ?? tag.value;
            this.display.name(this.expandNamae(name));
          } else {
            if (tag.readFlag !== undefined && tag.readFlag >= 0) {
              this.pageReadFlags.push({scene: tag.scene, flag: tag.readFlag});
              if (!this.skipUnread && !this.readFlags.get(tag.scene)?.has(tag.readFlag))
                this.readSkipEnabled = false;
            }
            return this.printMessage(tag.value);
          }
        },
      },
      this.controller.signal,
      {scene: menu!.split('"')[1] ?? '_titlemenu', entry: Number(entry ?? 0)},
    );
    await this.loadCgTable();
    await this.vm.run(this.startScene);
  }

  private async callSystemScene(key: string): Promise<void> {
    const [scene, label] = this.game.config.get(key)?.split(',') ?? [];
    const name = scene?.split('"')[1];
    if (!name) throw new Error(`Missing Siglus ${key}`);
    await this.runSystemScene(name, label?.split('"')[1] ?? Number(label ?? 0));
  }

  private joypadShortcut(): string | undefined {
    if (this.shortcutDisabled) return undefined;
    const config = this.game.config;
    // 1.1.141.3 at 0x632e24 selects a press or a completed click by condition.
    const count = Number(config.get('JOYPAD.SHORTCUT.CNT') ?? 0);
    for (let index = 0; index < Math.min(count, 256); index++) {
      const prefix = `JOYPAD.SHORTCUT.${String(index).padStart(3, '0')}`;
      const button = Number(config.get(`${prefix}.KEY`) ?? -1);
      const condition = Number(config.get(`${prefix}.COND`) ?? 0);
      const scene = `${prefix}.SCENE`;
      if ((condition === 0 || condition === 1) && config.has(scene) &&
          this.joypad.state(button, condition === 0 ? 1 : 5)) return scene;
    }
    // The standard X-button release calls the configured scene at 0x634037.
    if (config.has('X_MENU_SCENE') && this.joypad.state(6, 5)) return 'X_MENU_SCENE';
  }

  private installFlickInput(): void {
    const {stage} = this.display;
    const {signal} = this.controller;
    type Sample = {x: number; y: number; time: number};
    let pointerId: number | undefined;
    let buttonIndex: number | undefined;
    let timer: ReturnType<typeof setInterval> | undefined;
    let previous: Sample | undefined;
    let latest: Sample | undefined;
    let position: {x: number; y: number} | undefined;
    let suppressClick = false;
    const stop = () => {
      clearInterval(timer);
      timer = undefined;
      pointerId = undefined;
      buttonIndex = undefined;
      previous = undefined;
      latest = undefined;
      position = undefined;
    };
    const sample = () => {
      if (!position) return;
      previous = latest;
      latest = {...position, time: performance.now()};
    };
    stage.addEventListener('pointerdown', (event) => {
      if (!event.isPrimary || (event.button !== 0 && event.button !== 2)) return;
      stop();
      pointerId = event.pointerId;
      buttonIndex = event.button === 0 ? 0 : 1;
      this.pointerFlicks[buttonIndex] = undefined;
      position = {x: event.clientX, y: event.clientY};
      sample();
      timer = setInterval(sample, 10);
    }, {signal});
    stage.addEventListener('pointermove', (event) => {
      if (event.pointerId === pointerId) position = {x: event.clientX, y: event.clientY};
    }, {signal});
    stage.addEventListener('pointercancel', stop, {signal});
    stage.addEventListener('pointerleave', stop, {signal});
    stage.addEventListener('pointerup', (event) => {
      if (event.pointerId !== pointerId || buttonIndex === undefined) return;
      const origin = previous ?? latest;
      const measurement = origin && measureSiglusFlick(
        event.clientX - origin.x, event.clientY - origin.y, performance.now() - origin.time,
      );
      this.pointerFlicks[buttonIndex] = measurement;
      this.pointerFlickPending[buttonIndex] = (measurement?.millimetresPerSecond ?? 0) >= 180;
      const scene = buttonIndex === 0 && measurement && siglusFlickScene(this.game.config, measurement);
      stop();
      if (!scene || !this.waitingForPage || !this.wait || !this.systemMenuEnabled ||
          this.systemCallActive || this.userMessageHidden ||
          (event.target as Element).closest('button, input, textarea') ||
          stage.ownerDocument.getSelection()?.isCollapsed === false) return;
      suppressClick = true;
      setTimeout(() => (suppressClick = false), 0);
      this.pendingSystemShortcut = scene;
      this.wait(7);
    }, {signal});
    stage.addEventListener('click', (event) => {
      if (!suppressClick) return;
      suppressClick = false;
      event.stopImmediatePropagation();
      event.preventDefault();
    }, {capture: true, signal});
    signal.addEventListener('abort', stop, {once: true});
  }

  private async runSystemScene(
    scene: string,
    entry: number | string,
    parameters: Argument[] = [],
  ): Promise<void> {
    const outermost = this.systemCallDepth === 0;
    const previous = [
      this.timeStopped,
      this.systemSkipDisabled,
      this.messageHidden,
      this.quakeStopped,
    ] as const;
    const savedCursor = outermost ? this.display.stage.style.cursor : undefined;
    this.systemCallDepth++;
    if (outermost) {
      this.systemFrontObjects = new Map();
      this.inputSampled = false;
      this.lastInputSampleAt = -Infinity;
      this.lastInputSampleScene = undefined;
      this.display.setSystemInput(true);
      // Native 0x621ec0: mouse cursor is always visible while EXCALL is active.
      this.display.stage.style.cursor = '';
    }
    try {
      await this.vm.callScene(scene, entry, parameters);
    } finally {
      this.systemCallDepth--;
      if (outermost) {
        this.systemFrontObjects = undefined;
        this.systemFrontObjectsDirty = false;
        this.lastInputSampleAt = -Infinity;
        this.lastInputSampleScene = undefined;
        this.display.clearSystemFrontObjects();
        for (const [key, action] of [...this.frameActions])
          if (action.modalFront) {
            this.frameActions.delete(key);
            this.frameActionCounters.delete(key);
          }
        this.releaseSystemObjects();
        this.display.clearEdits();
        this.display.setSystemInput(false);
        this.display.stage.style.cursor = savedCursor ?? '';
      }
      [this.timeStopped, this.systemSkipDisabled, this.messageHidden, this.quakeStopped] = previous;
      this.display.setScenePaused(this.timeStopped);
      this.display.setMessageDisplayed(!this.messageHidden && !this.userMessageHidden);
    }
    if (outermost) {
      const selected = this.selectedSave;
      this.selectedSave = undefined;
      if (selected) this.loadSave(selected);
      if (this.objectsDirty && !this.timeStopped) await this.renderObjects();
    } else if (this.selectedSave) {
      this.vm.returnFromHostScene();
    }
  }

  private systemOption(option: SystemOption): boolean {
    return this.options.get(option) ?? this.game.config.get('CONFIG.' + option) === '1';
  }

  private setSystemOption(option: SystemOption, value?: boolean): void {
    if (value === undefined) this.options.delete(option);
    else this.options.set(option, value);
    this.persistOptions();
  }

  private persistOptions(): void {
    localStorage.setItem(
      this.game.saveKey + ':options',
      JSON.stringify({
        ...Object.fromEntries(this.options),
        globalExtraSwitches: Object.fromEntries(this.globalExtraSwitches),
        font: this.messageFont.name,
        fontBold: this.messageFont.bold,
        fontShadow: this.messageFont.shadow,
        fontShowProportional: this.messageFont.showProportional,
        fullscreen: this.screenSettings.fullscreen,
        screen: this.screenSettings,
        moviePlayer: this.moviePlayer,
        playback: this.playback,
        joypad: this.joypad.settings,
        filter: this.filterColor,
        voiceSpeedSwitches: this.voiceSpeedSwitches,
        voiceSpeedRate: this.voiceSpeedRate,
      }),
    );
  }

  private setPlaybackOption<K extends keyof PlaybackSettings>(
    key: K,
    value: PlaybackSettings[K],
  ): void {
    if (this.playback[key] === value) return;
    this.playback[key] = value;
    this.persistOptions();
  }

  private applyVoiceDuck(): void {
    this.audio.setVoiceDuck(this.playback.voiceDuckEnabled ? this.playback.voiceDuckLevel : 255);
  }

  private applyMessageFont(): void {
    const {name, bold, shadow} = this.storyFont();
    this.display.setMessageFont(name, bold, shadow);
  }

  private resolveFont(overrides?: ScriptFontOverride): SiglusFontSettings {
    if (!overrides) return this.messageFont;
    const {name, bold = -1, shadow = -1} = overrides;
    return {
      ...this.messageFont,
      name: name || this.messageFont.name,
      bold: bold >= 0 ? Boolean(bold) : this.messageFont.bold,
      shadow: shadow >= 0 ? shadow : this.messageFont.shadow,
    };
  }

  private storyFont(): SiglusFontSettings {
    return this.resolveFont(this.scriptFont);
  }

  private applyScreenSettings(): void {
    this.windowDisplay.setPresentation(this.screenSettings);
    if (this.windowDisplay.isExpanded !== this.screenSettings.fullscreen)
      this.windowDisplay.setFullscreen(this.screenSettings.fullscreen);
  }

  private counter<K>(
    counters: Map<K, RealCounter>,
    id: K,
    member: number,
    args: SiglusCommand['args'],
  ): Value | undefined {
    const counter = counters.get(id);
    const now = performance.now();
    const elapsed = counter ? (counter.pausedAt ?? now) - counter.start : 0;
    switch (member) {
      case 0: // set
        counters.set(id, {
          start: now,
          from: Number(args[0] ?? 0) | 0,
          ...(!counter || counter.pausedAt !== undefined ? {pausedAt: now} : {}),
        });
        return 0;
      case 1: {
        // get
        if (!counter) return 0;
        const {from, range} = counter;
        if (!range) return from + Math.trunc(elapsed);
        if (range.loop) {
          const duration = Math.max(1, range.duration);
          const pos = ((elapsed % duration) + duration) % duration;
          return from + Math.trunc(((range.to - from) * pos) / duration);
        }
        if (elapsed >= range.duration) return range.to;
        return from + Math.trunc(((range.to - from) * elapsed) / range.duration);
      }
      case 2: // reset
        counters.delete(id);
        return 0;
      case 3: // start
      case 9: // start_real
        counters.set(id, {start: now, from: 0});
        return 0;
      case 4: // 1.1.102.1 0x533b7b pauses the counter without resetting its value.
        if (counter) counter.pausedAt ??= now;
        return 0;
      case 5: // 1.1.102.1 0x533b8c resumes the counter at its retained value.
        if (!counter) counters.set(id, {start: now, from: 0});
        else if (counter.pausedAt !== undefined) {
          counter.start += now - counter.pausedAt;
          delete counter.pausedAt;
        }
        return 0;
      case 11: // start_frame_real
        counters.set(id, {
          start: now,
          from: Number(args[0]),
          range: {to: Number(args[1]), duration: Number(args[2])},
        });
        return 0;
      case 13: // start_frame_loop_real
        counters.set(id, {
          start: now,
          from: Number(args[0]),
          range: {to: Number(args[1]), duration: Math.max(1, Number(args[2])), loop: true},
        });
        return 0;
      case 14: // check_active
        return Number(
          Boolean(counter && counter.pausedAt === undefined &&
            (!counter.range || counter.range.loop || elapsed < counter.range.duration)),
        );
    }
  }

  private releaseSystemObjects(): void {
    this.excallAllocated = false;
    this.systemObjects = undefined;
    this.systemBackObjects = undefined;
    this.systemObjectsDirty = false;
    this.systemObjectMoves = undefined;
    this.excallFlags.clear();
    this.systemCounters.clear();
    this.systemFont = undefined;
    this.excallJoypadModeOverride = -1;
    for (const [key, action] of [...this.frameActions]) {
      if (action.path[0] === 65) {
        this.frameActions.delete(key);
        this.frameActionCounters.delete(key);
      }
    }
    for (const group of [...this.activeGroups]) {
      if (group >= 100_000) {
        this.activeGroups.delete(group);
        this.cancelGroups.delete(group);
        this.decisions.delete(group);
      }
    }
    for (const key of [...this.groupProps.keys()]) {
      if (key.startsWith('65.')) this.groupProps.delete(key);
    }
    this.display.clearSystemObjects();
    this.display.syncObjectButtonGroups(this.activeGroups);
    this.releaseUnusedObjectMovies();
  }

  private objectAddress(
    path: readonly number[],
  ): {
    page: Map<number, DrawObject>;
    index: number;
    parent?: DrawObject;
    missingParent?: boolean;
  } | undefined {
    let page: Map<number, DrawObject>;
    let index: number;
    if (path[0] === 65 && (path[1] === 1 || path[1] === 2) && path[2] === 2) {
      if (!this.excallAllocated && !this.systemCallActive && !this.systemObjects) return;
      if (path[1] === 1) page = this.systemObjects ??= new Map();
      else page = this.systemBackObjects ??= new Map();
      index = 3;
    } else if ((path[0] === 37 || path[0] === 38) && path[1] === 2) {
      page =
        path[0] === 37
          ? this.objects[1]!
          : (this.modalFrontObjects ?? this.objects[0]!);
      index = 2;
    } else if (
      path[0] === 38 &&
      path[1] === 3 &&
      path[2] === -1 &&
      (path[4] === 30 || path[4] === 53)
    ) {
      const window = path[3]!;
      const windows = path[4] === 30 ? this.messageObjects : this.messageFaces;
      page = windows.get(window) ?? new Map();
      windows.set(window, page);
      index = 5;
    } else return;
    let parent: DrawObject | undefined;
    while (path[index] === -1 && path[index + 2] === 93) {
      const id = path[index + 1]!;
      parent = page.get(id);
      if (!parent && path[index + 3] === 4 && path.length === index + 4) {
        parent = emptyDrawObject();
        page.set(id, parent);
      }
      if (!parent) return {page, index, missingParent: true};
      page = parent.children ??= new Map();
      index += 3;
    }
    return {page, index, parent};
  }

  private markObjectsDirty([root, member]: readonly number[], moved?: DrawObject): void {
    if (root === 38 && member === 3) this.messageObjectsDirty = true;
    else if (root === 38 && this.modalFrontObjects)
      this.systemFrontObjectsDirty = true;
    else if (root === 38) {
      if (!moved) this.objectMoves = undefined;
      else if (!this.objectsDirty) this.objectMoves = new Set([moved]);
      else this.objectMoves?.add(moved);
      this.objectsDirty = true;
    }
    if (root === 65 && member === 1) {
      if (!moved) this.systemObjectMoves = undefined;
      else if (!this.systemObjectsDirty) this.systemObjectMoves = new Set([moved]);
      else this.systemObjectMoves?.add(moved);
      this.systemObjectsDirty = true;
    }
  }

  private invalidateMainObjects(): void {
    this.objectMoves = undefined;
    this.objectsDirty = true;
  }

  private get modalFrontObjects(): Map<number, DrawObject> | undefined {
    if (!this.excallAllocated && this.mainFrameActionDepth !== this.systemCallDepth)
      return this.systemFrontObjects;
  }

  private messageButtonList(path: readonly number[]): number[] | undefined {
    const [root, windows, windowArray, window, buttons, buttonArray, button, axis] = path;
    if (
      root !== 38 ||
      windows !== 3 ||
      windowArray !== -1 ||
      buttons !== 32 ||
      buttonArray !== -1 ||
      (axis !== 54 && axis !== 63)
    )
      return;
    const key = `${window}.${button}.${axis}`;
    let list = this.messageButtonOffsets.get(key);
    if (!list) this.messageButtonOffsets.set(key, (list = []));
    return list;
  }

  private updateMessageButton(
    path: readonly number[],
    list: readonly number[],
    timing?: KeyframeAnimationOptions,
  ): void {
    this.display.offsetMessageButton(
      path[3]!,
      path[6]!,
      path[7] === 54 ? 'x' : 'y',
      list.reduce((sum, value) => sum + value, 0),
      timing,
      'rep',
    );
  }

  private object(path: readonly number[]): DrawObject | undefined {
    const address = this.objectAddress(path);
    if (!address || address.missingParent) return undefined;
    return address.page.get(path[address.index + 1]!);
  }

  private property(path: number[], value?: Value): Value | undefined {
    path = this.stagePath(path);
    const [page, list, array] = path;
    if (page === 108 && list !== undefined && path.length === 2) {
      if (value !== undefined) this.namaeValues.set(list, String(value));
      return this.namaeValues.get(list) ?? '';
    }
    // global.mask[].x (4) / .y (5) (0x55be20)
    if (
      page === 135 &&
      list === -1 &&
      path.length === 4 &&
      (path[3] === 4 || path[3] === 5)
    ) {
      const slot = path[2]!;
      const axis = path[3] === 4 ? 'x' : 'y';
      if (value !== undefined) {
        this.display.setObjectMaskOffset(slot, axis, Number(value));
        this.invalidateMainObjects();
      }
      return this.display.getObjectMaskOffset(slot, axis);
    }
    if (page === 65 && list === 7 && array === -1 && path.length === 4) {
      const slot = path[3]!;
      if (value !== undefined) this.excallFlags.set(slot, Number(value));
      return this.excallFlags.get(slot) ?? 0;
    }
    if (page === 32 && list === 3 && array === -1 && path.length === 4) {
      const bit = path[3]!;
      if (value !== undefined && this.setGalleryFlag(bit, Number(value)))
        this.persistGalleryFlags();
      return Number(Boolean((this.galleryFlags.get(bit >>> 5) ?? 0) & (1 << (bit & 31))));
    }
    if (page === 32 && list === -1 && array !== undefined && path.length === 3) {
      // Both G[] and the G bit view address the same list (1.1.141.3 at 0x54fe1f).
      if (value !== undefined && this.galleryFlags.get(array) !== Number(value)) {
        this.galleryFlags.set(array, Number(value) | 0);
        this.persistGalleryFlags();
      }
      return this.galleryFlags.get(array);
    }
    if (page === 31 && list === 3 && array === -1 && path[3] !== undefined && path[3] >= 0) {
      const bit = path[3];
      const index = Math.floor(bit / 32);
      const mask = 1 << (bit % 32);
      const previous = this.system.get(index) ?? 0;
      if (value !== undefined)
        this.property([31, -1, index], Number(value) & 1 ? previous | mask : previous & ~mask);
      return Number(Boolean((this.system.get(index) ?? 0) & mask));
    }
    if (page === 31 && list === -1 && array !== undefined) {
      if (value !== undefined && this.system.get(array) !== Number(value)) {
        this.system.set(array, Number(value));
        localStorage.setItem(this.game.saveKey + ':system', JSON.stringify([...this.system]));
      }
      return this.system.get(array) ?? 0;
    }
    if (this.usesLegacyIncludes && page !== undefined && page >>> 24 === 127) {
      const name = this.game.pack.propertyNames[page & 0xffff];
      if (name && /^\$pos_(fl|l|hl|nl|c|nr|hr|r|fr|m)$/.test(name)) {
        if (value !== undefined) this.castAnchors.set(name, value);
        return this.castAnchors.get(name) ?? 0;
      }
      if (
        name &&
        /^\$(bg_(?:name|name_prev|wipe|set_ready|type|file_exist)|bs_(?:name|name_info|dress_info|wipe_set|exist_decide|size_info|posx_next|posy_next|cha_num)|cha_dress|chara_layer_next)$/.test(
          name,
        )
      ) {
        const key = [name, ...path.slice(1)].join('.');
        if (value !== undefined) this.stageProperties.set(key, value);
        return this.stageProperties.get(key) ?? (name.includes('name') ? '' : 0);
      }
    }
    // 1.1.102.1 MWND member 32 uses object properties (0x528e74 -> 0x52d600).
    // The entries expose the object's display flag, image pattern, and position.
    if (
      path.length === 8 &&
      path[0] === 38 &&
      path[1] === 3 &&
      path[2] === -1 &&
      path[4] === 32 &&
      path[5] === -1 &&
      (path[7] === 0 || path[7] === 1 || path[7] === 3 || path[7] === 4)
    ) {
      return this.display.setMessageButtonProperty(
        path[3]!,
        path[6]!,
        path[7],
        value !== undefined ? Number(value) : undefined,
      );
    }
    if (path.length === 10 && path[8] === -1) {
      const offsets = this.messageButtonList(path);
      if (offsets) {
        const index = path[9]!;
        if (value !== undefined && index >= 0 && index < offsets.length) {
          offsets[index] = Number(value);
          this.updateMessageButton(path, offsets);
        }
        return offsets[index] ?? 0;
      }
    }
    if (
      ((path[0] === 37 || path[0] === 38) && path[1] === 4 && path[2] === -1 && path.length === 5) ||
      (path[0] === 70 && path[1] === 31 && path[2] === -1 && path.length === 5)
    ) {
      return this.effectProperty(`${path[0]}.${path[3]}`, path[4]!, value);
    }
    // objbtngroup properties (0x562970): 8=order, 13=layer (e.g. excall[i].front.objbtngroup[g].order/layer)
    if (
      (path[0] === 65 && path[1] === -1 && path[3] === 1 && path[4] === 6 && path[5] === -1 && path.length === 8) ||
      (path[0] === 65 && (path[1] === 1 || path[1] === 2) && path[2] === 6 && path[3] === -1 && path.length === 6) ||
      ((path[0] === 37 || path[0] === 38) && path[1] === 6 && path[2] === -1 && path.length === 5)
    ) {
      const key = path.join('.');
      if (value !== undefined) this.groupProps.set(key, Number(value) | 0);
      return this.groupProps.get(key) ?? 0;
    }
    const address = this.objectAddress(path);
    if (address?.missingParent) return value === undefined ? 0 : value;
    if (!address || path[address.index] !== -1) {
      if (this.isBuiltinPropertyRoot(page)) this.recordUnhandled(this.unhandledProperties, path);
      return;
    }
    const property = path[address.index + 2];
    const id = path[address.index + 1]!;
    let object = address.page.get(id);
    if (!object) {
      if (value === undefined) return 0;
      object = emptyDrawObject();
      address.page.set(id, object);
    }
    if (property === 0) {
      if (value !== undefined && object.visible !== Boolean(value)) {
        object.visible = Boolean(value);
        this.markObjectsDirty(path);
      }
      return Number(object.visible);
    }
    if (property === 56) {
      if (value !== undefined) {
        this.usesWipeCopy = true;
        object.wipeCopy = Boolean(value);
      }
      return Number(Boolean(object.wipeCopy));
    }
    if (property === 145) {
      const next = Number(value);
      if (value !== undefined && object.mask !== next) {
        object.mask = next;
        this.markObjectsDirty(path);
      }
      return object.mask ?? -1;
    }
    if (property === 111 && path[address.index + 3] === -1) {
      // object.f[] (0x5553c0): per-object intlist
      const idx = path[address.index + 4]!;
      const flags = (object.flags ??= []);
      if (value !== undefined && idx >= 0) flags[idx] = Number(value) | 0;
      return flags[idx] ?? 0;
    }
    if (property === 141 && path[address.index + 3] === -1) {
      // object.tr_rep[] (0x5553c0): per-object multiplicative transparency offsets (default 255)
      const idx = path[address.index + 4]!;
      const trs = (object.trOffsets ??= []);
      if (value !== undefined && idx >= 0) {
        while (trs.length <= idx) trs.push(255);
        const next = Number(value) | 0;
        if (trs[idx] !== next) {
          trs[idx] = next;
          this.markObjectsDirty(path);
        }
      }
      return trs[idx] ?? 255;
    }
    if (property === 12 || property === 13) {
      const cur = object.scale ?? [1000, 1000];
      if (value !== undefined) {
        const next = Number(value) | 0;
        if (cur[property === 12 ? 0 : 1] !== next) {
          object.scale = property === 12 ? [next, cur[1]] : [cur[0], next];
          this.markObjectsDirty(path);
        }
      }
      return (object.scale ?? [1000, 1000])[property === 12 ? 0 : 1];
    }
    if (property === 15 || property === 16 || property === 17) {
      const rk = property === 15 ? 'rotateX' : property === 16 ? 'rotateY' : 'rotateZ';
      if (value !== undefined && object[rk] !== (Number(value) | 0)) {
        object[rk] = Number(value) | 0;
        this.markObjectsDirty(path);
      }
      return object[rk] ?? 0;
    }
    if (property === 55) {
      if (value !== undefined && object.order !== (Number(value) | 0)) {
        object.order = Number(value) | 0;
        this.markObjectsDirty(path);
      }
      return object.order ?? 0;
    }
    if (property === 6 || property === 7) {
      // object.center_x (6) / center_y (7) (0x5553c0)
      const cur = object.center ?? [0, 0];
      if (value !== undefined) {
        const next = Number(value) | 0;
        if (cur[property === 6 ? 0 : 1] !== next) {
          object.center = property === 6 ? [next, cur[1]] : [cur[0], next];
          this.markObjectsDirty(path);
        }
      }
      return (object.center ?? [0, 0])[property === 6 ? 0 : 1];
    }
    if (property === 9 || property === 10) {
      // object.center_rep_x (9) / center_rep_y (10) (0x5553c0)
      const cur = object.centerRep ?? [0, 0];
      if (value !== undefined) {
        const next = Number(value) | 0;
        if (cur[property === 9 ? 0 : 1] !== next) {
          object.centerRep = property === 9 ? [next, cur[1]] : [cur[0], next];
          this.markObjectsDirty(path);
        }
      }
      return (object.centerRep ?? [0, 0])[property === 9 ? 0 : 1];
    }
    if (property === 23) {
      // object.color_rate (0x5553c0)
      const cp = (object.colorProps ??= {});
      if (value !== undefined && cp.colorRate !== (Number(value) | 0)) {
        cp.colorRate = Number(value) | 0;
        this.markObjectsDirty(path);
      }
      return cp.colorRate ?? 0;
    }
    if (property === 109) {
      // object.tonecurve_no (0x5553c0)
      if (value !== undefined && object.tonecurveNo !== (Number(value) | 0)) {
        object.tonecurveNo = Number(value) | 0;
        this.markObjectsDirty(path);
      }
      return object.tonecurveNo ?? -1;
    }
    if (property === 149) {
      if (value !== undefined && Boolean(object.sourceClipEnabled) !== Boolean(value)) {
        object.sourceClipEnabled = Boolean(value);
        this.markObjectsDirty(path);
      }
      return Number(Boolean(object.sourceClipEnabled));
    }
    if (property !== undefined && property >= 150 && property <= 153) {
      const bounds = (object.sourceClipBounds ??= [0, 0, 0, 0]);
      const idx = property - 150;
      if (value !== undefined && bounds[idx] !== (Number(value) | 0)) {
        bounds[idx] = Number(value) | 0;
        this.markObjectsDirty(path);
      }
      return bounds[idx];
    }
    if (property !== undefined && ((property >= 28 && property <= 34) || (property >= 57 && property <= 59))) {
      const cp = (object.colorProps ??= {});
      const map: Record<number, keyof NonNullable<DrawObject['colorProps']>> = {
        28: 'mono',
        29: 'reverse',
        30: 'bright',
        31: 'dark',
        32: 'colorR',
        33: 'colorG',
        34: 'colorB',
        57: 'addR',
        58: 'addG',
        59: 'addB',
      };
      const k = map[property];
      if (k) {
        if (value !== undefined) {
          const next = Number(value) | 0;
          if ((cp[k] ?? 0) !== next) {
            cp[k] = next;
            this.markObjectsDirty(path);
          }
        }
        return cp[k] ?? 0;
      }
    }
    if ((property === 54 || property === 63) && path[address.index + 3] === -1) {
      const axis = property === 54 ? 'x' : 'y';
      const index = path[address.index + 4]!;
      const offsets = object.positionOffsets?.[axis];
      if (value !== undefined && offsets && index >= 0 && index < offsets.length) {
        const next = Number(value);
        const hadEvent = Boolean(object.offsetEvents?.[axis]?.delete(index));
        if ((offsets[index] ?? 0) !== next || hadEvent) {
          offsets[index] = next;
          this.markObjectsDirty(path, object);
        }
      }
      return offsets?.[index] ?? 0;
    }
    if (property !== undefined && property >= 18 && property <= 22) {
      const clip = (object.clip ??= [0, 0, 0, 0, 0]);
      const index = property - 18;
      if (value !== undefined && clip[index] !== Number(value)) {
        clip[index] = Number(value);
        this.markObjectsDirty(path);
      }
      return clip[index];
    }
    const field =
      property === 1
        ? 'pattern'
        : property === 2
          ? 'layer'
          : property === 3
            ? 'x'
            : property === 4
              ? 'y'
              : property === 27
                ? 'transparency'
                : property === 46
                  ? 'blend'
                  : undefined;
    if (!field) {
      this.recordUnhandled(this.unhandledProperties, path);
      return;
    }
    if (value !== undefined) {
      const next = field === 'blend' ? Math.min(4, Math.max(0, Number(value))) : Number(value);
      if (object[field] !== next) {
        object[field] = next;
        this.markObjectsDirty(path, field === 'x' || field === 'y' ? object : undefined);
      }
    }
    return object[field] ?? (field === 'transparency' ? 255 : 0);
  }

  private setGalleryFlag(bit: number, value: number): boolean {
    if (bit < 0) return false;
    const index = bit >>> 5;
    const mask = 1 << (bit & 31);
    const previous = this.galleryFlags.get(index) ?? 0;
    const next = value & 1 ? previous | mask : previous & ~mask;
    if (previous === next) return false;
    this.galleryFlags.set(index, next);
    return true;
  }

  private persistGalleryFlags(): void {
    localStorage.setItem(this.game.saveKey + ':gallery', JSON.stringify([...this.galleryFlags]));
  }

  private readFlagsDirty = false;
  private readFlagsTimer?: ReturnType<typeof setTimeout>;

  private scheduleReadFlagsFlush(): void {
    this.readFlagsDirty = true;
    if (this.readFlagsTimer !== undefined) return;
    this.readFlagsTimer = setTimeout(() => {
      this.readFlagsTimer = undefined;
      this.flushReadFlags();
    }, 1500);
  }

  private flushReadFlags(): void {
    if (this.readFlagsTimer !== undefined) {
      clearTimeout(this.readFlagsTimer);
      this.readFlagsTimer = undefined;
    }
    if (!this.readFlagsDirty) return;
    this.readFlagsDirty = false;
    localStorage.setItem(
      this.game.saveKey + ':read',
      JSON.stringify(Array.from(this.readFlags, ([scene, flags]) => [scene, [...flags]])),
    );
  }

  private delay(time?: number, skippable = false, skipImmediately = true): Promise<number> {
    const signal = this.controller.signal;
    signal.throwIfAborted();
    if (skipImmediately && skippable && this.skipping) return Promise.resolve(1);
    return new Promise((resolve, reject) => {
      let cancelTimer: (() => void) | undefined;
      const finish = (value: number): void => {
        cancelTimer?.();
        signal.removeEventListener('abort', cancel);
        if (this.wait === finish) this.wait = undefined;
        resolve(value);
      };
      const cancel = (): void => {
        cancelTimer?.();
        if (this.wait === finish) this.wait = undefined;
        reject(signal.reason);
      };
      signal.addEventListener('abort', cancel, {once: true});
      if (skippable) this.wait = finish;
      if (time !== undefined) cancelTimer = scheduleFrameDeadline(time, () => finish(0));
    });
  }

  private async pageInput(continuesMessage = false): Promise<void> {
    // 0x67d6b7 disarms skip_trigger (+0x378); 0x650980/0x650bd0 always pause for key wait.
    this.skipTriggerArmed = false;
    if (this.asyncReveal) await this.asyncReveal;
    if (this.objectsDirty) await this.renderObjects();
    const messageWindow = this.display.messageWindow;
    const hadPendingText = this.pendingText;
    this.revealWholePage = false;
    this.pageAlreadyRead =
      this.pageReadFlags.length > 0 &&
      this.pageReadFlags.every(({scene, flag}) => this.readFlags.get(scene)?.has(flag));
    if (!this.pageAlreadyRead && !this.skipUnread) this.readSkipEnabled = false;
    if (hadPendingText) this.display.finishMessageSlide();
    if (continuesMessage) {
      this.root.dataset.page = String(++this.pages);
      this.tracePage();
      if (!this.skipping && this.saveEnabled && !this.scriptAutoSavePointDisabled) {
        this.savePoint = {
          ...this.captureSave(),
          messagePause: {readFlags: [...this.pageReadFlags], voices: this.pageVoices},
        };
      }
      if (!this.keyWaitDisabled) await this.waitAtPage();
      this.autoModeMojiCnt = 0;
      return;
    }
    let changed = false;
    for (const {scene, flag} of this.pageReadFlags) {
      let flags = this.readFlags.get(scene);
      if (!flags) this.readFlags.set(scene, (flags = new Set()));
      if (flags.has(flag)) continue;
      flags.add(flag);
      changed = true;
    }
    if (changed) this.scheduleReadFlagsFlush();
    this.pageReadFlags = [];
    const history = hadPendingText && !this.scriptHistoryRecordingDisabled
      ? {...this.display.saveMessage(), voices: this.pageVoices}
      : undefined;
    if (history) this.addHistory(history);
    const makeSavePoint = this.saveEnabled && !this.scriptAutoSavePointDisabled;
    const needHistoryPoint = makeSavePoint && this.loadEnabled;
    const needSavePoint = makeSavePoint && !this.skipping;
    const baseSnapshot = needHistoryPoint || needSavePoint ? this.captureSave(true, false) : undefined;
    if (needHistoryPoint && baseSnapshot) {
      const targetEntry = history ?? this.backlog.at(-1);
      if (targetEntry && !this.historyPoints.has(targetEntry)) {
        this.historyPoints.set(targetEntry, baseSnapshot);
      }
    }
    this.pageVoices = [];
    this.root.dataset.page = String(++this.pages);
    this.tracePage();
    if (needSavePoint && baseSnapshot) {
      this.savePoint = this.attachHistoryToSave(baseSnapshot);
      if (this.trace) this.recordSaveHistory(baseSnapshot);
    }
    // 1.1.141.3 0x65c105 / 0x67d650: 64.51 (async_msg_mode_once) only makes text reveal
    // non-blocking (0x65a79e); key-wait still runs unless 64.49 (+0x499) disabled it.
    if (!this.keyWaitDisabled) {
      await this.waitAtPage();
    }
    this.autoModeMojiCnt = 0;
    // 1.1.141.3 0x554270 (mwnd.clear): clear skip_trigger_fired (+0x1a5) and one-shot async mode.
    this.skipTriggerFired = false;
    if (this.msgAsyncModeOnce) {
      this.msgAsyncMode = false;
      this.msgAsyncModeOnce = false;
    }
    if (!this.systemOption('KOE_DONT_STOP_ONOFF')) {
      this.replayGeneration++;
      this.audio.stop('voice');
      this.audio.stop('history-voice');
    }
    // The next page can set its face before its first name or text command.
    this.messageFaces.delete(messageWindow);
    this.pendingText = false;
  }

  private messageAnimation(
    kind: 'open' | 'close',
    index = this.display.messageWindow,
  ): MwndAnimation {
    const forceOpen = kind === 'open' && this.scriptMwndOpenAnimeForce;
    if (
      this.skipping ||
      (!forceOpen &&
        (this.scriptMessageAnimationsDisabled || this.systemOption('NO_MWND_ANIME_ONOFF')))
    ) {
      return {type: 0, time: 0};
    }
    const override =
      kind === 'open'
        ? this.messageOpenAnimations.get(index)
        : this.messageCloseAnimations.get(index);
    return parseMwndAnimation(this.game.config, index, kind, override);
  }

  private beginMessage(): void {
    if (this.pendingText) return;
    this.pageReadFlags = [];
    this.display.clearText();
    this.display.prepareOpenAnimation(this.messageAnimation('open'));
    this.pendingText = true;
    this.pageCharacters = 0;
    this.revealWholePage = false;
  }

  private queueMessageAction(action: () => void): void {
    const previous = this.asyncReveal;
    if (!previous) {
      action();
      return;
    }
    const task = previous.then(() => {
      action();
    });
    this.asyncReveal = task.finally(() => {
      if (this.asyncReveal === task) this.asyncReveal = undefined;
    });
  }

  private print(value: string): void | Promise<void> {
    const characters = Array.from(value);
    this.pageCharacters += characters.length;
    const speed = this.speed !== -1 ? this.speed : (this.playback.messageNowait ? 0 : this.playback.messageSpeed);
    if (this.scriptMessageNowait || speed <= 0 || !characters.length || this.skipping || this.revealWholePage) {
      this.queueMessageAction(() => this.display.append(value));
      return;
    }
    if (this.msgAsyncMode) {
      // 1.1.141.3 0x65a79e: async_msg_mode (+0x375) reveals text without blocking the VM.
      const previous = this.asyncReveal;
      const task = (previous ?? Promise.resolve()).then(() => this.revealRun(value, characters, speed, true));
      this.asyncReveal = task.finally(() => {
        if (this.asyncReveal === task) this.asyncReveal = undefined;
      });
      return;
    }
    return this.revealRun(value, characters, speed, false);
  }

  private async printMessage(value: string): Promise<void> {
    if (this.objectsDirty) await this.renderObjects();
    const faces = this.messageFaces.get(this.display.messageWindow);
    if (faces?.size) await this.display.showMessageFaces(orderedObjects(faces));
    await this.print(this.expandNamae(value));
  }

  private async revealRun(
    value: string,
    characters: string[],
    speed: number,
    asyncMode: boolean,
  ): Promise<void> {
    const first = characters.length > 0 && !this.display.hasPendingRuby ? characters[0]! : '';
    const run = this.display.appendRun(first);
    const started = performance.now();
    let visible = first && !run.ruby ? 1 : 0;
    this.printing = true;
    try {
      while (visible < characters.length) {
        if (this.skipping || this.revealWholePage) {
          this.revealWholePage = true;
          run.reveal(value);
          return;
        }
        const next = run.ruby ? characters.length : visible + 1;
        const remaining = Math.max((run.ruby ? 1 : visible) * speed - (performance.now() - started), 0);
        if (asyncMode) {
          const skipped = await new Promise<boolean>((resolve, reject) => {
            const signal = this.controller.signal;
            if (signal.aborted) {
              reject(signal.reason);
              return;
            }
            let cancelTimer: (() => void) | undefined;
            const done = (instant: boolean): void => {
              cancelTimer?.();
              signal.removeEventListener('abort', onAbort);
              if (this.finishAsyncReveal === wake) this.finishAsyncReveal = undefined;
              resolve(instant);
            };
            const wake = (): void => done(true);
            const onAbort = (): void => {
              cancelTimer?.();
              if (this.finishAsyncReveal === wake) this.finishAsyncReveal = undefined;
              reject(signal.reason);
            };
            signal.addEventListener('abort', onAbort, {once: true});
            this.finishAsyncReveal = wake;
            cancelTimer = scheduleFrameDeadline(remaining, () => done(false));
          });
          if (skipped) {
            this.revealWholePage = true;
            run.reveal(value);
            return;
          }
        } else if (await this.delay(remaining, true)) {
          this.revealWholePage = true;
          run.reveal(value);
          return;
        }
        visible = Math.min(
          characters.length,
          Math.max(next, 1 + Math.floor((performance.now() - started) / speed)),
        );
        run.reveal(visible === characters.length ? value : characters.slice(0, visible).join(''));
      }
    } finally {
      this.printing = false;
    }
  }

  private revealMessage(): void {
    this.setUserMessageHidden(false);
    if (this.waitingForPage) this.wait?.(4);
  }

  private tracePage(): void {
    if (!this.trace) return;
    this.root.dispatchEvent(new CustomEvent('siglus-page', {detail: {skipping: this.skipping}}));
  }

  private setUserMessageHidden(hidden: boolean): void {
    if (hidden && !this.hideMwndEnabled) return;
    if (hidden) this.readSkipEnabled = this.autoEnabled = false;
    this.userMessageHidden = hidden;
    this.display.setMessageDisplayed(!hidden && !this.messageHidden);
    if (hidden && this.waitingForPage) this.wait?.(4);
  }

  private frameActionState(
    {id, type, state, slot, call}: SiglusFrameAction,
    readSkipping: boolean,
  ): 'hidden' | 'disabled' | 'enabled' {
    if (type === 'auto_mode' && state !== Number(this.autoEnabled)) return 'hidden';
    if (type === 'read_skip' && state !== Number(this.readSkipEnabled)) return 'hidden';
    if (slot !== undefined && state !== Number(this.globalExtraSwitch(slot))) return 'hidden';
    if (
      !this.mwndBtnTouchEnabled ||
      this.disabledMessageButtons.has(id) ||
      (readSkipping && type !== 'read_skip')
    )
      return 'disabled';
    let enabled: boolean;
    switch (type) {
      case 'auto_mode':
        enabled = true;
        break;
      case 'global_switch':
      case 'none':
        enabled = Boolean(call);
        break;
      case 'read_skip':
        enabled =
          this.readSkipEnabled || (this.skipAllowed && (this.pageAlreadyRead || this.skipUnread));
        break;
      case 'config':
        enabled = this.game.config.has('CONFIG_SCENE');
        break;
      case 'msg_log':
        enabled = this.msgBackEnabled && !this.scriptMsgBackDisabled && this.backlog.length > 0;
        break;
      case 'koe_play':
        enabled = Boolean(this.backlog.at(-1)?.voices.length);
        break;
      case 'close_mwnd':
        enabled = this.hideMwndEnabled;
        break;
      case 'return_sel':
        enabled = this.selectionReturnFlags.every(Boolean) && this.selectionSaves.length > 0;
        break;
      case 'save':
      case 'qsave':
        enabled = this.saveEnabled && Boolean(this.savePoint);
        break;
      case 'load':
      case 'qload':
        enabled = this.loadEnabled && (type !== 'qload' || this.quickSaves.size > 0);
        break;
      default:
        enabled = false;
    }
    return enabled ? 'enabled' : 'disabled';
  }

  private globalExtraSwitch(slot: number): boolean {
    return (
      this.globalExtraSwitches.get(slot) ??
      this.game.config.get(`CONFIG.GLOBAL_EXTRA_SWITCH.${String(slot).padStart(3, '0')}.ONOFF`) ===
        '1'
    );
  }

  private queueMessageFrameInput(): void {
    this.messagePointerChanged = Boolean(this.messagePointerAction);
    for (const watcher of messageFrameWatchers)
      if (
        this.system.get(watcher.flag) === 0 &&
        this.game.pack.commandNames.includes(watcher.command)
      )
        this.pendingFrameWatchers.add(watcher);
  }

  private async refreshMessageFrame(): Promise<void> {
    const queued = [...this.pendingFrameWatchers];
    this.pendingFrameWatchers.clear();
    for (const {command} of queued) await this.runOriginalCommand(command);
    if (this.messagePointerChanged && this.messagePointerAction) {
      this.messagePointerChanged = false;
      const {channel, scene, command} = this.messagePointerAction;
      await this.vm.callScene(scene, command, [[53, -1, channel]]);
    }
    if (queued.length) await this.renderMessageObjects();
  }

  private async runOriginalCommand(command: string, parameters: Argument[] = []): Promise<void> {
    const index = this.game.pack.commandNames.indexOf(command);
    const scene = this.game.pack.sceneNames[this.game.pack.commandScenes[index * 2]!];
    if (scene) await this.vm.callScene(scene, command, parameters);
  }

  private async waitAtPage(): Promise<void> {
    this.lastInputSampleAt = -Infinity;
    this.lastInputSampleScene = undefined;
    if (!this.systemCallActive) {
      this.pruneDeadButtonGroups(true);
      if (!this.skipping) {
        for (const id of this.vm.peekUpcomingVoices?.(2) ?? []) this.audio.prefetchVoice(id);
      }
    }
    for (;;) {
      const readSkipping = this.skipping && this.readSkipEnabled && !this.skip;
      const showControls = this.messageButtonsEnabled && (!this.skipping || readSkipping);
      if (showControls) {
        this.queueMessageFrameInput();
        this.display.pageControls(
          (action) => {
            if (this.requestedFrameAction) return;
            this.requestedFrameAction = action;
            if (this.waitingForPage) this.wait?.(1);
          },
          (action) => this.frameActionState(action, readSkipping),
        );
      } else {
        this.display.pageControls();
      }
      let result = 1;
      try {
        const autoActive = (this.autoEnabled || this.scriptAutoMode) && !this.userMessageHidden;
        // 1.1.141.3 0x62f130 / 0x62f160: script auto mode overrides apply only while 64.0 (+0x355) is active.
        const autoCharWait = autoActive
          ? this.scriptAutoMode && this.scriptAutoModeMojiWait >= 0
            ? this.scriptAutoModeMojiWait
            : this.playback.autoCharacterWait
          : 0;
        const autoMinWait = autoActive
          ? this.scriptAutoMode && this.scriptAutoModeMinWait >= 0
            ? this.scriptAutoModeMinWait
            : this.playback.autoMinimumWait
          : 0;
        const autoChars = this.autoModeMojiCnt || this.pageCharacters;
        let waitingForVoice = autoActive && this.audio?.channelState?.('voice') === 1;
        let deadline =
          !autoActive || waitingForVoice
            ? undefined
            : performance.now() + autoMinWait + autoCharWait * autoChars;
        do {
          this.waitingForPage = false;
          if (this.frameActions.size && !this.skipping) {
            await this.tickFrameActions();
            await this.renderObjects();
          }
          while (this.pendingFrameWatchers.size || this.messagePointerChanged)
            await this.refreshMessageFrame();
          this.waitingForPage = true;
          if (this.requestedFrameAction) {
            result = 1;
            break;
          }
          // 1.1.141.3 0x67daa1..0x67daf2: auto mode waits for active voice playback to end
          // before starting the minimum wait timer.
          if (waitingForVoice && this.audio.channelState('voice') !== 1) {
            waitingForVoice = false;
            deadline = performance.now() + autoMinWait;
          }
          // Give Read Skip a browser frame and keep its button between consecutive pages.
          result =
            readSkipping && showControls
              ? await this.delay(16, true, false)
              : await this.delay(
                  waitingForVoice
                    ? 100
                    : deadline === undefined
                      ? undefined
                      : deadline - performance.now(),
                  true,
                );
          if (result === 0 && waitingForVoice) result = 6;
        } while (result === 6);
      } finally {
        this.waitingForPage = false;
        if (!readSkipping || result !== 0) this.display.pageControls();
      }
      const menu = this.requestedFrameAction;
      this.requestedFrameAction = undefined;
      if (result === 5) {
        await this.openHistory();
        continue;
      }
      if (result === 4) continue;
      if (result === 7) {
        const shortcut = this.pendingSystemShortcut;
        this.pendingSystemShortcut = undefined;
        this.readSkipEnabled = this.autoEnabled = false;
        if (shortcut) await this.callSystemScene(shortcut);
        continue;
      }
      if (result === 3) {
        this.readSkipEnabled = this.autoEnabled = false;
        await this.callSystemScene('CANCEL_SCENE');
        continue;
      }
      if (!menu) return;
      const {type, sound, call} = menu;
      await this.playButtonSound(sound, 'decide');
      if (call) await this.callSystemScene(call);
      else if (type === 'msg_log') await this.openHistory();
      else if (type === 'close_mwnd') this.setUserMessageHidden(true);
      else if (type === 'koe_play')
        void this.replayHistoryVoice(this.backlog.at(-1)).catch((error) => {
          if (!this.controller.signal.aborted) console.error(error);
        });
      else if (type === 'save') await this.callSystemScene('SAVE_SCENE');
      else if (type === 'load') await this.callSystemScene('LOAD_SCENE');
      else if (type === 'qsave') {
        if (this.saveEnabled && this.savePoint && this.saveStore) {
          const snapshot: PlayerSave = {
            ...this.attachHistoryToSave(this.savePoint),
            timestamp: Date.now(),
            thumbnail: this.display.captureThumbnail(),
          };
          await this.updateSlots(this.quickSaves, [[0, snapshot]]);
          await this.playSystemSound(4);
        }
      } else if (type === 'qload') {
        if (this.loadEnabled) {
          const slot = this.newestSlot(this.quickSaves);
          const target = slot >= 0 ? this.quickSaves.get(slot) : undefined;
          if (target) {
            this.pendingLoadSound = true;
            this.loadSave(target);
          }
        }
      } else if (type === 'config') await this.callSystemScene('CONFIG_SCENE');
      else if (type === 'auto_mode') this.autoEnabled = !this.autoEnabled;
      else if (type === 'read_skip') this.readSkipEnabled = !this.readSkipEnabled;
      else if (type === 'return_sel') {
        const target = this.selectionSaves.pop();
        if (target) {
          await this.playSystemSound(7);
          this.loadSave(target);
        }
      }
    }
  }

  private attachHistoryToSave(base: PlayerSave): PlayerSave {
    const history = this.backlog.slice(
      Math.max(
        0,
        this.backlog.length - Number(this.game.config.get('MESSAGE_BACK_SAVE.CNT') ?? 200),
      ),
    );
    const historyPoints: [number, HistoryPoint][] = [];
    for (const [index, entry] of history.entries()) {
      const point = this.historyPoints.get(entry);
      if (point) historyPoints.push([index, point]);
    }
    return {...base, history, historyPoints};
  }

  private captureSave(waitsForInput = true, includeHistory = true, commandResult = 0): PlayerSave {
    const now = performance.now();
    const {background} = this.root.dataset;
    const bgmPlayback = this.audio.bgmCheckpoint();
    const history = includeHistory
      ? this.backlog.slice(
          Math.max(
            0,
            this.backlog.length - Number(this.game.config.get('MESSAGE_BACK_SAVE.CNT') ?? 200),
          ),
        )
      : undefined;
    const historyPoints: [number, HistoryPoint][] = [];
    for (const [index, entry] of history?.entries() ?? []) {
      const point = this.historyPoints.get(entry);
      if (point) historyPoints.push([index, point]);
    }
    return {
      version: 1,
      vm: this.vm.checkpoint(commandResult),
      stage: [...this.stageProperties],
      message: this.display.saveMessage(),
      messageFaces: this.messageFaces?.size
        ? [...this.messageFaces].map(([window, faces]) => [
            window,
            [...faces].map(([id, face]) => [id, serializeDrawObject(face, now)]),
          ])
        : undefined,
      messageObjects: this.messageObjects?.size
        ? [...this.messageObjects].map(([window, objects]) => [
            window,
            [...objects].map(([id, obj]) => [id, serializeDrawObject(obj, now)]),
          ])
        : undefined,
      messageOpenAnimations: this.messageOpenAnimations?.size
        ? [...this.messageOpenAnimations].map(([k, v]) => [k, {...v}])
        : undefined,
      messageCloseAnimations: this.messageCloseAnimations?.size
        ? [...this.messageCloseAnimations].map(([k, v]) => [k, {...v}])
        : undefined,
      background,
      bgm: bgmPlayback?.name,
      bgmPlayback,
      bgmLevel: this.audio.channelLevel('bgm'),
      pcmPlayback: this.audio.pcmCheckpoint(),
      voiceLevel: this.audio.channelLevel('voice'),
      seLevel: this.audio.channelLevel('se'),
      cast: [...this.currentCast],
      castCostumes: [...this.currentCastCostumes],
      gans: this.display.saveGans(),
      movieEffects: this.display.saveMovieEffects(),
      rectangleEffects: this.display.saveRectangleEffects(),
      sceneCovered: this.display.sceneCovered || undefined,
      speed: this.speed === -1 ? 0 : this.speed,
      title: this.saveTitle,
      waitsForInput,
      history,
      historyPoints: history ? historyPoints : undefined,
      controls: {
        systemMenu: this.systemMenuEnabled,
        messageButtons: this.messageButtonsEnabled,
        returnMenu: this.returnMenuState && [...this.returnMenuState],
        disabledButtons: [...this.disabledMessageButtons],
        save: this.saveEnabled,
        load: this.loadEnabled,
        selectionReturnFlags: [...this.selectionReturnFlags],
        controlSkip: this.skipAllowed,
        skipUnread: this.skipUnreadOverride,
        messageAnimationsOff: this.scriptMessageAnimationsDisabled || undefined,
        localExtraSwitches: this.localExtraSwitches.size ? [...this.localExtraSwitches] : undefined,
        msgBackEnabled: this.msgBackEnabled,
        scriptMsgBackDisabled: this.scriptMsgBackDisabled || undefined,
        scriptHistoryRecordingDisabled: this.scriptHistoryRecordingDisabled || undefined,
        scriptAutoSavePointDisabled: this.scriptAutoSavePointDisabled || undefined,
        shortcutDisabled: this.shortcutDisabled || undefined,
        hideMwndEnabled: this.hideMwndEnabled,
        mwndBtnTouchEnabled: this.mwndBtnTouchEnabled,
        endMsgByKeyDisabled: this.endMsgByKeyDisabled || undefined,
        scriptMessageNowait: this.scriptMessageNowait || undefined,
        joypadModeOverride: this.joypadModeOverride === -1 ? undefined : this.joypadModeOverride,
        scriptFlag96: this.scriptFlag96 || undefined,
        mouseCursorNo: this.mouseCursorNo || undefined,
        scriptFont: this.scriptFont && {...this.scriptFont},
        backButtonGroups: this.backButtonGroups.size ? [...this.backButtonGroups] : undefined,
        messageSpeedOverride: this.speed !== -1 ? this.speed : undefined,
        systemSkipDisabled: this.systemSkipDisabled || undefined,
        quakeStopped: this.quakeStopped || undefined,
      },
      stageObjects:
        this.objects[0]!.size || this.objects[1]!.size
          ? [
              [...this.objects[0]!]
                .filter(([id]) => !this.noSaveObjectIds.has(id))
                .map(([id, obj]) => [id, serializeDrawObject(obj, now)]),
              [...this.objects[1]!]
                .filter(([id]) => !this.noSaveObjectIds.has(id))
                .map(([id, obj]) => [id, serializeDrawObject(obj, now)]),
            ]
          : undefined,
      stageEffects: this.stageEffects.size
        ? [...this.stageEffects].map(([k, v]) => [k, [...v.props]])
        : undefined,
      usesWipeCopy: this.usesWipeCopy || undefined,
      excallFlags: this.excallFlags.size ? [...this.excallFlags] : undefined,
      pcmEvents: this.pcmEvents.size
        ? [...this.pcmEvents].map(([slot, ev]) => [
            slot,
            {
              mode: ev.config.mode,
              pcmchNo: ev.config.pcmchNo,
              entries: ev.config.entries.map((e) => ({...e})),
              options: {...ev.config.options},
            },
          ])
        : undefined,
      namaeValues: this.namaeValues.size ? [...this.namaeValues] : undefined,
      namaeIds: this.namaeIds.size ? [...this.namaeIds] : undefined,
      messageFilterFiles: this.messageFilterFiles.size ? [...this.messageFilterFiles] : undefined,
      messageFrameFiles: this.messageFrameFiles.size ? [...this.messageFrameFiles] : undefined,
      messageButtonOffsets: this.messageButtonOffsets.size
        ? [...this.messageButtonOffsets].map(([k, v]) => [k, v.slice()])
        : undefined,
      objectMasks: (() => {
        const masks = this.display.saveObjectMasks();
        return masks.length ? masks : undefined;
      })(),
      messagePointerAction: this.messagePointerAction
        ? {...this.messagePointerAction}
        : undefined,
      appendDir: this.game.appendDir,
      appendName: this.game.appendName,
    };
  }

  private async deserializeDrawObject(saved: SerializedDrawObject): Promise<DrawObject> {
    const sourceClipBounds = saved.sourceClip ?? saved.sourceClipBounds;
    const offsetEvents: NonNullable<DrawObject['offsetEvents']> = {};
    if (saved.offsetEvents) {
      const now = performance.now();
      for (const axis of ['x', 'y'] as const) {
        const events = saved.offsetEvents[axis];
        if (events?.length) offsetEvents[axis] = new Map(events.map(([index, event]) => [index, {
          from: event.from,
          started: now - event.elapsed,
          time: {...event.time},
        }]));
      }
    }
    const object: DrawObject = {
      type: saved.type,
      name: saved.name,
      frames: [],
      x: saved.x,
      y: saved.y,
      visible: saved.visible,
      layer: saved.layer,
      order: saved.order,
      transparency: saved.transparency,
      opacity: saved.opacity ? [...saved.opacity.values] : undefined,
      opacityElapsed: saved.opacity?.elapsed,
      trOffsets: saved.trOffsets?.slice(),
      flags: saved.flags?.slice(),
      pattern: saved.pattern,
      scale: saved.scale ? [saved.scale[0], saved.scale[1]] : undefined,
      rotateX: saved.rotateX,
      rotateY: saved.rotateY,
      rotateZ: saved.rotateZ,
      center: saved.center ? [saved.center[0], saved.center[1]] : undefined,
      centerRep: saved.centerRep ? [saved.centerRep[0], saved.centerRep[1]] : undefined,
      colorProps: saved.colorProps ? {...saved.colorProps} : undefined,
      mask: saved.mask,
      blend: saved.blend,
      tonecurveNo: saved.tonecurveNo,
      wipeCopy: saved.wipeCopy,
      rect: saved.rect ? {...saved.rect} : undefined,
      positionOffsets: saved.positionOffsets
        ? {
            x: saved.positionOffsets.x?.slice(),
            y: saved.positionOffsets.y?.slice(),
          }
        : undefined,
      offsetEventCounts: saved.offsetEventCounts && {...saved.offsetEventCounts},
      offsetEvents: offsetEvents.x || offsetEvents.y ? offsetEvents : undefined,
      frameActionChannelCount: saved.frameActionChannelCount,
      button: saved.button ? {...saved.button} : undefined,
      buttonCall: saved.buttonCall ? {...saved.buttonCall} : undefined,
      childCount: saved.childCount,
      movieMeta: saved.movieMeta ? {...saved.movieMeta} : undefined,
      text: saved.text ? {...saved.text} : undefined,
      weather: saved.weather
        ? {mode: saved.weather.mode, params: {...saved.weather.params}, started: performance.now()}
        : undefined,
      gan: saved.gan ? {...saved.gan} : undefined,
      number: saved.number ? {...saved.number} : undefined,
      clip: saved.clip ? [...saved.clip] : undefined,
      sourceClipEnabled: saved.sourceClip ? true : saved.sourceClipEnabled,
      sourceClipBounds: sourceClipBounds ? [...sourceClipBounds] : undefined,
      pushKeep: saved.pushKeep,
      alphaTest: saved.alphaTest,
      disabled: saved.disabled,
      buttonState: saved.buttonState,
    };
    if (saved.rect) {
      const {left, top, right, bottom, r, g, b, a} = saved.rect;
      object.frames = [
        this.display.rectangle(
          Math.max(0, right - left),
          Math.max(0, bottom - top),
          r,
          g,
          b,
          a,
          left,
          top,
        ),
      ];
    } else if (saved.number && saved.name) {
      const frame = await this.display.numberGraphic(saved.name, saved.number);
      if (frame) object.frames = [frame];
    } else if (saved.movieMeta && saved.name) {
      const basename = 'mov/' + saved.name.toLowerCase();
      const source = this.game.files.get(basename + '.omv') ?? this.game.files.get(basename);
      if (source) {
        const movie = await SiglusOmvPlayback.open(
          source,
          this.controller.signal,
          saved.movieMeta.loop,
        );
        this.objectMovies.add(movie);
        object.movie = movie;
        if (!saved.movieMeta.readyOnly) movie.play();
      }
    } else if (saved.type === 11) {
      const frame = await this.localCaptureGraphic(saved.name);
      if (frame) object.frames = [frame];
    } else if (saved.name && !saved.weather && !saved.text) {
      const pat = Math.max(0, saved.pattern);
      object.frames[pat] = await this.display.objectGraphic(saved.name, pat);
    }
    if (saved.children?.length) {
      const children = new Map<number, DrawObject>();
      for (const [childId, childSaved] of saved.children) {
        children.set(childId, await this.deserializeDrawObject(childSaved));
      }
      object.children = children;
    }
    return object;
  }

  private saveSlotAddress(number: number): [Map<number, PlayerSave>, number] {
    // The slot browser addresses quick saves and end saves directly after ordinary saves.
    const count = Number(this.game.config.get('SAVE.CNT') ?? 0);
    const quickCount = Number(this.game.config.get('QUICK_SAVE.CNT') ?? 0);
    const endCount = Number(this.game.config.get('END_SAVE.CNT') ?? 0);
    if (number >= count && number < count + quickCount) return [this.quickSaves, number - count];
    if (number >= count + quickCount && number < count + quickCount + endCount)
      return [this.endSaves, number - count - quickCount];
    return [this.saves, number];
  }

  private rememberSelection(save: PlayerSave): void {
    // 1.1.141.3 evicts the oldest selection checkpoint at the configured limit (0x65caf5).
    const count = Number(this.game.config.get('SEL_SAVE.CNT') ?? 32);
    if (count <= 0) return;
    this.selectionSaves.push(save);
    this.selectionSaves.splice(0, Math.max(0, this.selectionSaves.length - count));
  }

  private recordSaveHistory(save: HistoryPoint): void {
    // 0x666309–0x6663ec records debug checkpoints at least three seconds apart.
    const capacity = Math.min(10_000, Number(this.game.config.get('SAVE_HISTORY.CNT') ?? 100));
    const now = performance.now();
    if (capacity < 1 || now - this.lastSaveHistoryTime < 3000) return;
    this.lastSaveHistoryTime = now;
    this.saveHistory.push(save);
    if (this.saveHistory.length > capacity) this.saveHistory.shift();
  }

  private saveSlot(number: number): PlayerSave | undefined {
    const [slots, slot] = this.saveSlotAddress(number);
    return slots.get(slot);
  }

  private async openSaveStore(): Promise<void> {
    const store = await IndexedDbStore.open([this.game.saveKey, 'slots']);
    if (this.controller.signal.aborted) {
      store.close();
      this.controller.signal.throwIfAborted();
    }
    this.saveStore = store;
    const {saveKey} = this.game;
    const regular = localStorage.getItem(saveKey + ':saves');
    const quick = localStorage.getItem(saveKey + ':quick-saves');
    const legacy = localStorage.getItem(saveKey + ':slot');
    const encoder = new TextEncoder();
    if (regular !== null || quick !== null || legacy !== null) {
      await store.update((records) => {
        if (records.has('migrated')) return;
        for (const [prefix, stored] of [
          ['saves', regular],
          ['quick-saves', quick],
        ] as const) {
          const slots: [number, PlayerSave][] = stored
            ? JSON.parse(stored)
            : prefix === 'saves' && regular === null && legacy
              ? [[0, JSON.parse(legacy)]]
              : [];
          for (const [index, save] of slots)
            if (save.version === 1)
              records.set(prefix + ':' + index, encoder.encode(JSON.stringify(save)));
        }
        records.set('migrated', new Uint8Array());
      });
      for (const suffix of [':saves', ':quick-saves', ':slot'])
        localStorage.removeItem(saveKey + suffix);
    }
    const decoder = new TextDecoder();
    for (const [key, value] of await store.snapshot()) {
      const match = /^(saves|quick-saves|end-saves):(\d+)$/.exec(key);
      if (!match) continue;
      const save: PlayerSave = JSON.parse(decoder.decode(value));
      if (save.version === 1) {
        const target =
          match[1] === 'saves'
            ? this.saves
            : match[1] === 'quick-saves'
              ? this.quickSaves
              : this.endSaves;
        target.set(Number(match[2]), save);
      }
    }
  }

  private writeSlot(slots: Map<number, PlayerSave>, slot: number, save: PlayerSave): Promise<void> {
    return this.updateSlots(slots, [[slot, save]]);
  }

  private captureFileKey(name: string): string | undefined {
    const path = name.replaceAll('\\', '/').toLowerCase();
    if (/[<>:"|?*\u0000-\u001f]/.test(path) || path.split('/').some((part) => !part || part === '.' || part === '..'))
      return;
    return `capture:${path}`;
  }

  private async storeCapture(
    name: string,
    x: number,
    y: number,
    options?: SiglusCaptureOptions,
  ): Promise<Uint8Array | undefined> {
    const key = this.captureFileKey(name);
    const store = this.saveStore;
    if (!key || !store) return;
    if (this.objectsDirty) await this.renderObjects();
    const png = options ? await this.display.capturePng(x, y, options) : await this.display.capturePng(x, y);
    if (!png || this.controller.signal.aborted) return;
    await store.update((records) => { records.set(key, png); });
    return png;
  }

  private async localCaptureGraphic(name: string) {
    const key = this.captureFileKey(name);
    const png = key && (await this.saveStore?.snapshot())?.get(key);
    return png ? this.display.capturedGraphic(png) : undefined;
  }

  private async captureFileCommand(member: number, args: Argument[], named: readonly number[]): Promise<number> {
    const options = new Map(named.map((id, index) => [id, args[args.length - named.length + index]]));
    const format = String(args[1] ?? '').toLowerCase();
    if (format !== 'bmp' && format !== 'png') return 0;
    const bmp = format === 'bmp';
    const withDialog = Boolean(options.get(0));
    const caption = String(options.get(1) ?? '');
    const reference = options.get(2);
    const start = Number(options.get(3) ?? 0) | 0;
    const offset = Math.max(0, start);
    const requested = Number(options.get(4) ?? 0) | 0;
    const flagCapacityKey = Array.isArray(reference) && reference.length === 1
      ? reference[0] === 30 ? 'FLAG.CNT' : reference[0] === 31 ? 'GLOBAL_FLAG.CNT' : undefined
      : undefined;
    const capacity = flagCapacityKey ? Number.parseInt(this.game.config?.get(flagCapacityKey) ?? '', 10) : NaN;
    const limit = Number.isFinite(capacity) ? capacity : Infinity;
    const count = Math.max(0, Math.min(start + requested, limit) - offset);
    const name = String(args[0] || 'siglus-capture');
    const filename = name.toLowerCase().endsWith('.' + format) ? name : name + '.' + format;
    const key = this.captureFileKey(filename);
    if (member === 315) {
      // 1.1.102.1 0x636440 reads the integer trailer from a BMP into the referenced list.
      if (!bmp || !Array.isArray(reference) || !count) return 0;
      let source: ByteSource | undefined;
      if (withDialog) {
        const file = await this.configuration.pickCaptureBmp(caption);
        this.display.stage.focus({preventScroll: true});
        if (file) source = new BlobSource(file, 0);
      } else if (key) {
        const stored = (await this.saveStore?.snapshot())?.get(key);
        source = stored
          ? new BlobSource(new Blob([new Uint8Array(stored)]), 0)
          : this.game.files.get(filename.replaceAll('\\', '/').toLowerCase());
      }
      if (!source) return 0;
      const flags = await readCaptureBmpFlags(source, count, this.controller.signal);
      if (!flags.length) return 0;
      this.vm.writeIntList(reference as readonly number[], offset, flags);
      return 1;
    }
    const png = this.captureBuffer;
    if (!png || (!bmp && count)) return 0;
    const flags = bmp && Array.isArray(reference) && count
      ? this.vm.readIntList(reference as readonly number[], offset, count)
      : [];
    const bytes = bmp ? await this.display.captureBmp(png, flags) : png;
    if (withDialog) {
      const basename = filename.split(/[\\/]/).at(-1) || 'siglus-capture.' + format;
      const file = new File([new Uint8Array(bytes)], basename, {type: 'image/' + format});
      const exported = await this.configuration.shareCapture(png, undefined, file, caption);
      this.display.stage.focus({preventScroll: true});
      return Number(exported);
    }
    if (!key || !this.saveStore) return 0;
    await this.saveStore.update((records) => { records.set(key, bytes); });
    return 1;
  }

  private async updateSlots(
    slots: Map<number, PlayerSave>,
    changes: [number, PlayerSave | undefined][],
  ): Promise<void> {
    const kind =
      slots === this.saves
        ? 'saves:'
        : slots === this.quickSaves
          ? 'quick-saves:'
          : 'end-saves:';
    const encoder = new TextEncoder();
    const stored = changes.map(
      ([slot, save]) =>
        [kind + slot, save ? encoder.encode(JSON.stringify(save)) : undefined] as const,
    );
    await this.saveStore!.update((records) => {
      for (const [key, value] of stored) {
        if (value) records.set(key, value);
        else records.delete(key);
      }
    });
    for (const [slot, save] of changes) {
      if (save) slots.set(slot, save);
      else slots.delete(slot);
    }
  }

  private newestSlot(slots: Map<number, PlayerSave>, start = 0, count = Infinity): number {
    let newest = -1;
    let timestamp = -Infinity;
    for (const [slot, save] of slots) {
      if (slot < start || slot >= start + count || (save.timestamp ?? 0) < timestamp) continue;
      timestamp = save.timestamp ?? 0;
      newest = slot;
    }
    return newest;
  }

  private saveTitle = '';

  private loadSave(save: PlayerSave): never {
    return this.vm.requestLoad(save.vm, () => this.restoreSave(save));
  }

  private async restoreSave(save: PlayerSave): Promise<void> {
    this.skip = false;
    this.readSkipEnabled = false;
    this.autoEnabled = false;
    // Native 0x6321f0 -> 0x5bb740: game load/reset reinitializes G_excall and modal state.
    this.releaseSystemObjects();
    this.display.clearEdits?.();
    if (this.selectionSaves) this.selectionSaves.length = 0;
    this.stagedSelectionSave = undefined;
    this.activeGroups.clear();
    this.cancelGroups.clear();
    this.decisions.clear();
    this.display.syncObjectButtonGroups(this.activeGroups);
    this.timeStopped = false;
    this.userMessageHidden = false;
    this.messageHidden = false;
    this.systemSkipDisabled = save.controls?.systemSkipDisabled ?? false;
    this.quakeStopped = save.controls?.quakeStopped ?? false;
    this.display.setScenePaused(false);
    this.display.setMessageDisplayed(true);
    this.display.stage.style.cursor = '';
    this.savePoint = save;
    this.sceneCounters.clear();
    this.clearDayObjects();
    if (save.vm.frames.at(-1)?.scene === '__sys_day_change') this.beginDayObjects();
    this.backlog.splice(0, this.backlog.length, ...(save.history ?? []));
    for (const [index, point] of save.historyPoints ?? []) {
      const entry = this.backlog[index];
      if (entry) this.historyPoints.set(entry, point);
    }
    this.pageVoices = [...(save.messagePause?.voices ?? [])];
    this.pageReadFlags = [...(save.messagePause?.readFlags ?? [])];
    this.revealWholePage = false;
    this.systemMenuEnabled = save.controls?.systemMenu ?? true;
    this.messageButtonsEnabled = save.controls?.messageButtons ?? true;
    this.returnMenuState = save.controls?.returnMenu && [...save.controls.returnMenu];
    this.disabledMessageButtons.clear();
    for (const id of save.controls?.disabledButtons ?? []) this.disabledMessageButtons.add(id);
    this.saveEnabled = save.controls?.save ?? true;
    this.loadEnabled = save.controls?.load ?? true;
    this.selectionReturnFlags = [...(save.controls?.selectionReturnFlags ?? [true, true])];
    this.skipAllowed = save.controls?.controlSkip ?? true;
    this.skipUnreadOverride = save.controls?.skipUnread;
    this.joypadModeOverride = save.controls?.joypadModeOverride ?? -1;
    this.scriptFlag96 = save.controls?.scriptFlag96 ?? false;
    this.mouseCursorNo = save.controls?.mouseCursorNo ?? 0;
    if (this.scriptFont || save.controls?.scriptFont) {
      this.scriptFont = save.controls?.scriptFont && {...save.controls.scriptFont};
      this.applyMessageFont();
    }
    this.backButtonGroups.clear();
    for (const [group, cancel] of save.controls?.backButtonGroups ?? [])
      this.backButtonGroups.set(group, cancel);
    this.scriptMessageAnimationsDisabled = save.controls?.messageAnimationsOff ?? false;
    this.msgBackEnabled = save.controls?.msgBackEnabled ?? true;
    this.scriptMsgBackDisabled = save.controls?.scriptMsgBackDisabled ?? false;
    this.scriptHistoryRecordingDisabled = save.controls?.scriptHistoryRecordingDisabled ?? false;
    this.scriptAutoSavePointDisabled = save.controls?.scriptAutoSavePointDisabled ?? false;
    this.shortcutDisabled = save.controls?.shortcutDisabled ?? false;
    this.hideMwndEnabled = save.controls?.hideMwndEnabled ?? true;
    this.mwndBtnTouchEnabled = save.controls?.mwndBtnTouchEnabled ?? true;
    this.endMsgByKeyDisabled = save.controls?.endMsgByKeyDisabled ?? false;
    this.scriptMessageNowait = save.controls?.scriptMessageNowait ?? false;
    this.skipTriggerArmed = false;
    this.skipTriggerFired = false;
    this.msgAsyncMode = false;
    this.msgAsyncModeOnce = false;
    this.scriptAutoMode = false;
    this.scriptAutoModeMojiWait = -1;
    this.scriptAutoModeMinWait = -1;
    this.scriptMwndOpenAnimeForce = false;
    this.keyWaitDisabled = false;
    this.localExtraSwitches.clear();
    for (const [index, value] of save.controls?.localExtraSwitches ?? [])
      this.localExtraSwitches.set(index, value);
    this.excallFlags.clear();
    for (const [slot, val] of save.excallFlags ?? []) this.excallFlags.set(slot, val);
    this.usesWipeCopy = save.usesWipeCopy ?? false;
    this.namaeValues.clear();
    for (const [slot, val] of save.namaeValues ?? []) this.namaeValues.set(slot, val);
    if (save.namaeIds) {
      this.namaeIds.clear();
      for (const [key, id] of save.namaeIds) this.namaeIds.set(key, id);
    }
    this.messageFilterFiles.clear();
    this.display.clearMessageFilterFiles();
    for (const [mwIdx, file] of save.messageFilterFiles ?? []) {
      this.messageFilterFiles.set(mwIdx, file);
      await this.display.setMessageFilterFile(mwIdx, file);
    }
    this.messageFrameFiles.clear();
    this.display.clearMessageFrameFiles();
    for (const [mwIdx, file] of save.messageFrameFiles ?? []) {
      this.messageFrameFiles.set(mwIdx, file);
      await this.display.setMessageFrameFile(mwIdx, file);
    }
    const savedOffsets = new Map(save.messageButtonOffsets);
    const offsetKeys = new Set([...this.messageButtonOffsets.keys(), ...savedOffsets.keys()]);
    this.messageButtonOffsets.clear();
    for (const key of offsetKeys) {
      const offsets = savedOffsets.get(key);
      if (offsets) this.messageButtonOffsets.set(key, offsets.slice());
      const [mwStr, btnStr, axisStr] = key.split('.');
      const axis = Number(axisStr) === 54 ? 'x' : 'y';
      this.display.offsetMessageButton(
        Number(mwStr),
        Number(btnStr),
        axis,
        offsets?.reduce((sum, v) => sum + v, 0) ?? 0,
        undefined,
        'rep',
      );
    }
    await this.display.restoreObjectMasks(save.objectMasks);
    for (const active of this.pcmEvents.values()) active.cancel();
    this.pcmEvents.clear();
    this.frameActions.clear();
    this.frameActionCounters.clear();
    this.pendingButtonCalls.length = 0;
    this.messagePointerAction = save.messagePointerAction
      ? {...save.messagePointerAction}
      : undefined;
    this.messagePointerChanged = false;
    this.maskEvents.clear();
    this.stageEffects.clear();
    for (const [key, entries] of save.stageEffects ?? []) {
      const props = new Map(entries);
      this.stageEffects.set(key, {props, events: new Map()});
    }
    this.applyScreenEffects();
    this.display.finishWipe();
    this.pendingWipe = undefined;
    this.objects[0]!.clear();
    this.objects[1]!.clear();
    if (save.stageObjects) {
      for (const [id, savedObj] of save.stageObjects[0]) {
        this.objects[0]!.set(id, await this.deserializeDrawObject(savedObj));
      }
      for (const [id, savedObj] of save.stageObjects[1]) {
        this.objects[1]!.set(id, await this.deserializeDrawObject(savedObj));
      }
      this.invalidateMainObjects();
    }
    this.releaseUnusedObjectMovies?.();
    this.messageObjects?.clear();
    for (const [window, savedObjects] of save.messageObjects ?? []) {
      const objs = new Map<number, DrawObject>();
      for (const [id, obj] of savedObjects) objs.set(id, await this.deserializeDrawObject(obj));
      this.messageObjects?.set(window, objs);
    }
    this.messageOpenAnimations?.clear();
    for (const [window, cfg] of save.messageOpenAnimations ?? []) {
      this.messageOpenAnimations?.set(window, {...cfg});
    }
    this.messageCloseAnimations?.clear();
    for (const [window, cfg] of save.messageCloseAnimations ?? []) {
      this.messageCloseAnimations?.set(window, {...cfg});
    }
    this.audio.resetPlayback();
    if (this.pendingLoadSound) {
      this.pendingLoadSound = false;
      void this.playSystemSound(5);
    }
    this.display.endEffect();
    this.stageProperties.clear();
    for (const [key, value] of save.stage) this.stageProperties.set(key, value);
    await this.restoreCastCostumes(save);
    this.pendingBackground = undefined;
    this.stagedBackground = undefined;
    if (save.background) {
      await this.display.setBackground(save.background, 0, undefined, false, save.sceneCovered);
    } else {
      // A checkpoint can have an empty object page, even if the current scene does not.
      await this.display.show(orderedObjects(this.objects[0]!, true), 0, (button) => this.choose(button));
      this.objectsDirty = false;
      this.objectMoves = undefined;
    }
    await this.cast(save.cast, -1, save.castCostumes);
    await this.display.loadStageEffects(
      save.gans ?? (save.gan ? [save.gan] : []),
      save.movieEffects ?? [],
      save.rectangleEffects ?? [],
    );
    const music = save.bgmPlayback ?? (save.bgm ? {name: save.bgm, loop: true} : undefined);
    await this.audio.restoreBgm(music, save.bgmLevel);
    this.audio.setChannelLevel('voice', save.voiceLevel ?? 255, 0);
    this.audio.setChannelLevel('se', save.seLevel ?? 255, 0);
    await this.audio.restorePcm(save.pcmPlayback ?? []);
    for (const [slot, ev] of save.pcmEvents ?? []) {
      if (ev.mode === 'oneshot' || ev.mode === 'loop') {
        this.startPcmEventSequence(slot, ev.pcmchNo, ev.entries, ev.options, ev.mode === 'loop');
      } else {
        this.startPcmEventRandom(slot, ev.pcmchNo, ev.entries, ev.options);
      }
    }
    this.speed = save.controls?.messageSpeedOverride ?? (save.speed || -1);
    this.saveTitle = save.title ?? '';
    this.messageFaces.clear();
    for (const [window, savedFaces] of save.messageFaces ?? []) {
      const faces = new Map<number, DrawObject>();
      for (const [id, face] of savedFaces) faces.set(id, await this.deserializeDrawObject(face));
      this.messageFaces.set(window, faces);
    }
    const waitsForInput = save.waitsForInput ?? true;
    if (waitsForInput) {
      const message = save.message;
      const faceCostume = message.face
        ? (message.faceCostume ?? (await this.spriteCostume(message.face, 0, 1)))
        : undefined;
      await this.display.loadMessage({...message, faceCostume});
      const faces = this.messageFaces.get(message.index);
      if (faces?.size) await this.display.showMessageFaces(orderedObjects(faces));
      this.pageCharacters = save.message.text.reduce(
        (count, {text}) => count + Array.from(text.replaceAll('\n', '')).length,
        0,
      );
      this.pageAlreadyRead =
        !save.messagePause ||
        this.pageReadFlags.every(({scene, flag}) => this.readFlags.get(scene)?.has(flag));
    } else {
      this.display.closeMessage();
      this.display.restoreMessageTextColors(save.message.textColors);
      this.display.repPosition(...(save.message.position ?? [0, 0]));
      this.display.setMessageSlide(save.message.slideTime);
    }
    this.pendingText = waitsForInput;
    this.messageObjectsDirty = true;
    const loadAfter = this.game.config.get('LOAD_AFTER_CALL');
    if (loadAfter) {
      const [, scene, entry] = loadAfter.split('"');
      if (scene) {
        const label = entry?.replace(/^\s*,\s*/, '').trim();
        await this.vm.callScene(scene, Number(label || 0));
      }
    }
    await this.renderObjects();
    await this.renderMessageObjects();
    this.savePoint = {...save, vm: this.vm.checkpoint()};
    this.root.dataset.loaded = 'true';
    if (waitsForInput) {
      this.root.dataset.page = String(++this.pages);
      this.tracePage();
      await this.waitAtPage();
      if (!save.messagePause) this.messageFaces.delete(save.message.index);
    }
    this.pendingText = Boolean(save.messagePause);
  }

  private choose(target: NonNullable<DrawObject['button']>): void {
    const {id, group, seNo, buttonCall} = target;
    this.skip = false;
    if (seNo !== undefined && seNo >= 0) void this.playButtonSound(seNo, 'decide');
    this.decisions.set(group, id);
    if (buttonCall) this.pendingButtonCalls.push(buttonCall);
    this.decisionReady?.();
    if (this.waitingForPage && this.frameActions.size) this.wait?.(6);
  }

  private groupCommand(group: number, command: number): Value | undefined {
    switch (command) {
      case 2: // start
      case 10: // start_cancel
        this.activeGroups.add(group);
        if (command === 10) this.cancelGroups.add(group);
        this.display.syncObjectButtonGroups(this.activeGroups);
        return 0;
      case 3: {
        // get_decided_no
        if (!this.activeGroups.has(group)) return -2;
        const result = this.decisions.get(group) ?? -2;
        this.decisions.delete(group);
        return result;
      }
      case 4: // init
      case 5: // end
        // Native 1.1.102.1 (0x53a642) stops input for the group.
        this.activeGroups.delete(group);
        this.cancelGroups.delete(group);
        this.decisions.delete(group);
        this.display.syncObjectButtonGroups(this.activeGroups);
        return 0;
      case 6: // get_hit_no
        return this.display.buttonState(group, false);
      case 7: // get_pushed_no
        return this.display.buttonState(group, true);
    }
    return undefined;
  }

  private async selectGroup(group: number, cancel: boolean): Promise<number> {
    this.groupCommand(group, cancel ? 10 : 2);
    try {
      await this.renderObjects();
      for (;;) {
        const result = this.groupCommand(group, 3);
        if (typeof result === 'number' && result !== -2) return result;
        await this.nextInput();
      }
    } finally {
      this.groupCommand(group, 5);
    }
  }

  private async flushButtonCalls(): Promise<void> {
    if (this.flushingButtonCalls || !this.pendingButtonCalls.length) return;
    this.flushingButtonCalls = true;
    try {
      while (this.pendingButtonCalls.length) {
        const call = this.pendingButtonCalls.shift()!;
        await this.vm.callScene(call.scene, call.command, []);
      }
    } finally {
      this.flushingButtonCalls = false;
    }
  }

  private async nextInput(forceYield = false): Promise<number> {
    if (this.pendingButtonCalls.length) await this.flushButtonCalls();
    if (!forceYield && ((!this.systemCallActive && !this.activeGroups.size) || this.decisions.size))
      return 0;
    // The script polls group state, then calls input.next to yield between samples.
    // Wake on a decision or on the next frame so polling scripts can keep animating.
    const signal = this.controller.signal;
    signal.throwIfAborted();
    await new Promise<void>((resolve, reject) => {
      const finish = (): void => {
        cancelTimer();
        signal.removeEventListener('abort', abort);
        this.decisionReady = undefined;
        resolve();
      };
      const abort = (): void => {
        cancelTimer();
        this.decisionReady = undefined;
        reject(signal.reason);
      };
      const cancelTimer = scheduleFrameDeadline(16, finish);
      this.decisionReady = finish;
      signal.addEventListener('abort', abort, {once: true});
    });
    if (this.pendingButtonCalls.length) await this.flushButtonCalls();
    return 0;
  }

  private wipeDuration(ms: number): number {
    return this.skipping || this.systemOption('NO_WIPE_ANIME_ONOFF') ? 0 : ms;
  }

  private async runWipeCommand(
    duration: number,
    spec: WipeSpec | undefined,
    waitFlag: boolean,
    speedMode = 0,
  ): Promise<void> {
    const run = this.wipe(duration, spec, speedMode);
    this.pendingWipe = run;
    if (waitFlag) {
      await run;
      if (this.pendingWipe === run) this.pendingWipe = undefined;
      return;
    }
    void run
      .catch((error) => {
        if (!this.controller.signal.aborted) console.error(error);
      })
      .finally(() => {
        if (this.pendingWipe === run) this.pendingWipe = undefined;
      });
  }

  private reanchorObjectEvents(object: DrawObject, now: number): void {
    if (object.opacityStarted !== undefined) object.opacityStarted = now;
    if (object.movementStarted !== undefined) object.movementStarted = now;
    if (object.horizontalMotion) object.horizontalMotion.started = now;
    for (const ev of [
      object.positionEvents?.x,
      object.positionEvents?.y,
      object.scaleEvents?.x,
      object.scaleEvents?.y,
    ]) {
      if (ev) ev.started = now;
    }
    for (const map of [object.offsetEvents?.x, object.offsetEvents?.y]) {
      for (const ev of map?.values() ?? []) ev.started = now;
    }
    for (const ev of object.intEvents?.values() ?? []) {
      ev.started = now;
      if (ev.mode === 0) ev.endAt = now + ev.duration + ev.delay;
    }
    if (object.children) {
      for (const child of object.children.values()) this.reanchorObjectEvents(child, now);
    }
  }

  private async wipe(ms: number, fan?: WipeSpec, speedMode = 0): Promise<void> {
    this.lastInputSampleAt = -Infinity;
    this.lastInputSampleScene = undefined;
    const wipeNow = performance.now();
    if (this.excallAllocated && this.systemBackObjects) {
      // Native 0x6a7cd0 (C_tnm_wipe::start): when EXCALL is allocated (target=1),
      // wipe exclusively updates G_excall.m_stage_list (systemBackObjects -> systemObjects)
      // without touching the underlying main stage, cast, or message window.
      const back = this.systemBackObjects;
      const copiedIds = new Set<number>();
      if (this.usesWipeCopy && this.systemObjects) {
        for (const [id, object] of this.systemObjects) {
          if (object.wipeCopy && !back.has(id)) {
            back.set(id, this.copyObject(object));
            copiedIds.add(id);
          }
        }
      }
      this.systemObjects = this.copyObjects(back);
      for (const [id, obj] of this.systemObjects) {
        if (!copiedIds.has(id)) this.reanchorObjectEvents(obj, wipeNow);
      }
      if (this.usesWipeCopy) back.clear();
      this.systemObjectsDirty = false;
    this.systemObjectMoves = undefined;
      if (this.activeGroups.size || this.cancelGroups.size) {
        const liveGroups = new Set<number>();
        const collectGroups = (map?: ReadonlyMap<number, DrawObject>) => {
          if (!map) return;
          for (const obj of map.values()) {
            if (obj.button) liveGroups.add(obj.button.group);
            if (obj.children) collectGroups(obj.children);
          }
        };
        collectGroups(this.systemObjects);
        for (const group of [...this.activeGroups]) {
          if (group >= 100_000 && !liveGroups.has(group)) {
            this.activeGroups.delete(group);
            this.cancelGroups.delete(group);
            this.decisions.delete(group);
          }
        }
      }
      // Promote EXCALL back-stage object frame_actions (65.2.2.-1.<id>...) to front (65.1.2.-1.<id>...)
      if (this.frameActions.size) {
        const promoted: [string, ActiveFrameAction, RealCounter | undefined][] = [];
        for (const [key, action] of [...this.frameActions]) {
          if (action.path[0] === 65 && action.path[1] === 1 && action.path[2] === 2 && action.path[3] === -1) {
            const objId = action.path[4];
            if (objId !== undefined && !copiedIds.has(objId)) {
              this.frameActions.delete(key);
              this.frameActionCounters.delete(key);
            }
          } else if (action.path[0] === 65 && action.path[1] === 2 && action.path[2] === 2 && action.path[3] === -1) {
            this.frameActions.delete(key);
            const counter = this.frameActionCounters.get(key);
            this.frameActionCounters.delete(key);
            const frontPath = [65, 1, ...action.path.slice(2)];
            promoted.push([frontPath.join('.'), {...action, path: frontPath}, counter]);
          }
        }
        for (const [k, a, c] of promoted) {
          this.frameActions.set(k, a);
          if (c) this.frameActionCounters.set(k, c);
        }
      }
      await this.display.showSystemObjects(
        orderedObjects(this.systemObjects),
        (button) => this.choose(button),
        false,
        this.wipeDuration(ms),
        speedMode,
      );
      this.releaseUnusedObjectMovies();
      return;
    }
    this.display.finishWipe();
    const back = this.objects[1]!;
    const copiedIds = new Set<number>();
    if (this.usesWipeCopy)
      for (const [id, object] of this.objects[0]!)
        if (object.wipeCopy && !back.has(id)) {
          back.set(id, this.copyObject(object));
          copiedIds.add(id);
        }
    // Commit front/back swap and frame_action promotion atomically before yielding
    // so wait=0 wipes and subsequent restore/wipe calls never corrupt objects[0].
    const nextFront = this.copyObjects(back);
    for (const [id, obj] of nextFront) {
      if (!copiedIds.has(id)) this.reanchorObjectEvents(obj, wipeNow);
    }
    this.objects[0] = nextFront;
    if (this.usesWipeCopy) back.clear();
    this.objectsDirty = false;
    this.objectMoves = undefined;
    const pendingGroups = this.backButtonGroups.size;
    for (const [group, cancel] of this.backButtonGroups) {
      this.activeGroups.add(group);
      if (cancel) this.cancelGroups.add(group);
      else this.cancelGroups.delete(group);
      this.decisions.delete(group);
    }
    if (this.usesWipeCopy) this.backButtonGroups.clear();
    this.pruneDeadButtonGroups();
    if (pendingGroups) this.display.syncObjectButtonGroups(this.activeGroups);
    // Promote back-stage object frame_actions (37.2.-1.<id>...) to front-stage (38.2.-1.<id>...)
    // and drop overwritten front-stage object frame_actions unless preserved via wipeCopy.
    if (this.frameActions.size) {
      const promoted: [string, ActiveFrameAction, RealCounter | undefined][] = [];
      for (const [key, action] of [...this.frameActions]) {
        if (action.modalFront) continue;
        if (action.path[0] === 38 && action.path[1] === 2 && action.path[2] === -1) {
          const objId = action.path[3];
          if (objId !== undefined && !copiedIds.has(objId)) {
            this.frameActions.delete(key);
            this.frameActionCounters.delete(key);
          }
        } else if (action.path[0] === 37 && action.path[1] === 2 && action.path[2] === -1) {
          this.frameActions.delete(key);
          const counter = this.frameActionCounters.get(key);
          this.frameActionCounters.delete(key);
          const frontPath = [38, ...action.path.slice(1)];
          promoted.push([frontPath.join('.'), {...action, path: frontPath}, counter]);
        }
      }
      for (const [k, a, c] of promoted) {
        this.frameActions.set(k, a);
        if (c) this.frameActionCounters.set(k, c);
      }
    }
    this.display.closeMessage();
    this.pageVoices = [];
    this.currentCast = [];
    this.currentCastCostumes = [];
    if (this.systemBackObjects && this.systemBackObjects.size) {
      if (this.usesWipeCopy && this.systemObjects)
        for (const [id, object] of this.systemObjects)
          if (object.wipeCopy && !this.systemBackObjects.has(id))
            this.systemBackObjects.set(id, this.copyObject(object));
      this.systemObjects = this.copyObjects(this.systemBackObjects);
      if (this.usesWipeCopy) this.systemBackObjects.clear();
      this.systemObjectMoves = undefined;
      this.systemObjectsDirty = true;
      await this.renderObjects();
    }
    await this.display.show(
      orderedObjects(nextFront, true),
      this.wipeDuration(ms),
      (id) => this.choose(id),
      fan,
      speedMode,
    );
    this.releaseUnusedObjectMovies();
  }

  private pruneDeadButtonGroups(visibleOnly = false): void {
    if (!this.activeGroups.size && !this.cancelGroups.size) return;
    const liveGroups = new Set<number>();
    const collectGroups = (map?: ReadonlyMap<number, DrawObject>) => {
      if (!map) return;
      for (const obj of map.values()) {
        if (obj.button && (!visibleOnly || obj.visible)) liveGroups.add(obj.button.group);
        if (obj.children) collectGroups(obj.children);
      }
    };
    collectGroups(this.objects[0]);
    for (const group of [...this.activeGroups]) {
      if (group < 100_000 && !liveGroups.has(group)) {
        this.activeGroups.delete(group);
        this.cancelGroups.delete(group);
        this.decisions.delete(group);
      }
    }
  }

  private clearStageObjectPages(): void {
    this.objects[0]!.clear();
    this.objects[1]!.clear();
    this.backButtonGroups.clear();
    this.objectsDirty = false;
    this.objectMoves = undefined;
    this.pruneDeadButtonGroups();
  }

  private beginDayObjects(): void {
    this.dayStage = true;
    this.clearStageObjectPages();
  }

  private clearDayObjects(): void {
    if (!this.dayStage) return;
    this.clearStageObjectPages();
    this.dayStage = false;
  }

  private resetStageForMenu(): void {
    // Perfect Edition 0x65f5eb -> 0x6321a0 resets both native stage object lists
    // before the menu script builds the next page.
    this.display.finishWipe();
    this.display.clearEdits?.();
    this.clearStageObjectPages();
    this.messageObjects?.clear();
    this.messageFaces?.clear();
    this.messageOpenAnimations?.clear();
    this.messageCloseAnimations?.clear();
    if (this.selectionSaves) this.selectionSaves.length = 0;
    this.stagedSelectionSave = undefined;
    this.timeStopped = false;
    this.systemSkipDisabled = false;
    this.userMessageHidden = false;
    this.messageHidden = false;
    this.quakeStopped = false;
    this.display.setScenePaused?.(false);
    this.display.setMessageDisplayed?.(true);
    if (this.display.stage?.style) this.display.stage.style.cursor = '';
    this.dayStage = false;
    for (const [key, action] of this.frameActions) {
      if (action.path[0] === 37 || action.path[0] === 38) {
        this.frameActions.delete(key);
        this.frameActionCounters.delete(key);
      }
    }
    this.releaseUnusedObjectMovies();
  }

  private async renderObjects(): Promise<void> {
    await this.renderMessageObjects();
    if (this.systemFrontObjectsDirty && this.systemFrontObjects) {
      this.systemFrontObjectsDirty = false;
      await this.display.showSystemObjects(
        orderedObjects(this.systemFrontObjects),
        (button) => this.choose(button),
        true,
      );
    }
    if (this.systemObjectsDirty && this.systemObjects) {
      const moved = this.systemObjectMoves;
      this.systemObjectMoves = undefined;
      this.systemObjectsDirty = false;
      if (!moved || !this.display.updateSystemObjectPositions(moved))
        await this.display.showSystemObjects(orderedObjects(this.systemObjects), (button) =>
          this.choose(button),
        );
    }
    if (this.objectsDirty && !this.timeStopped) {
      const moved = this.objectMoves;
      this.objectMoves = undefined;
      this.objectsDirty = false;
      if (!moved || !this.display.updateStageObjectPositions(moved))
        await this.display.refreshObjects(orderedObjects(this.objects[0]!, true), (button) =>
          this.choose(button),
        );
    }
    this.releaseUnusedObjectMovies();
  }

  private releaseUnusedObjectMovies(): void {
    if (!this.objectMovies?.size) return;
    const used = new Set<SiglusOmvPlayback>();
    const visit = (page?: ReadonlyMap<number, DrawObject>) => {
      for (const object of page?.values() ?? []) {
        if (object.movie) used.add(object.movie);
        if (object.children) visit(object.children);
      }
    };
    for (const page of [
      ...this.objects,
      this.systemObjects,
      this.systemBackObjects,
      this.systemFrontObjects,
    ])
      visit(page);
    for (const movie of this.objectMovies) {
      if (used.has(movie)) continue;
      movie.close();
      this.objectMovies.delete(movie);
    }
  }

  private async renderMessageObjects(): Promise<void> {
    if (!this.messageObjectsDirty) return;
    this.messageObjectsDirty = false;
    const objects = this.messageObjects.get(this.display.messageWindow);
    await this.display.showMessageObjects(objects ? orderedObjects(objects) : []);
    const faces = this.messageFaces.get(this.display.messageWindow);
    await this.display.showMessageFaces(faces?.size ? orderedObjects(faces) : []);
  }

  private copyObjects(objects: Map<number, DrawObject>): Map<number, DrawObject> {
    return new Map([...objects].map(([id, object]) => [id, this.copyObject(object)]));
  }

  private copyObject(object: DrawObject): DrawObject {
    return {
      ...object,
      text: object.text && {...object.text},
      number: object.number && {...object.number},
      opacity: object.opacity && [...object.opacity],
      weather: object.weather && {...object.weather, params: {...object.weather.params}},
      gan: object.gan && {...object.gan},
      rect: object.rect && {...object.rect},
      movieMeta: object.movieMeta && {...object.movieMeta},
      button: object.button && {...object.button},
      buttonCall: object.buttonCall && {...object.buttonCall},
      flags: object.flags?.slice(),
      trOffsets: object.trOffsets?.slice(),
      scale: object.scale && ([...object.scale] as [number, number]),
      center: object.center && ([...object.center] as [number, number]),
      centerRep: object.centerRep && ([...object.centerRep] as [number, number]),
      sourceClipBounds: object.sourceClipBounds && ([...object.sourceClipBounds] as [number, number, number, number]),
      colorProps: object.colorProps && {...object.colorProps},
      intEvents: object.intEvents && new Map([...object.intEvents].map(([k, v]) => [k, {...v}])),
      clip: object.clip && [...object.clip],
      positionOffsets: object.positionOffsets && {
        x: object.positionOffsets.x?.slice(),
        y: object.positionOffsets.y?.slice(),
      },
      offsetEventCounts: object.offsetEventCounts && {...object.offsetEventCounts},
      positionEvents: object.positionEvents && {
        x: object.positionEvents.x && {...object.positionEvents.x, time: {...object.positionEvents.x.time}},
        y: object.positionEvents.y && {...object.positionEvents.y, time: {...object.positionEvents.y.time}},
      },
      scaleEvents: object.scaleEvents && {
        x: object.scaleEvents.x && {...object.scaleEvents.x, time: {...object.scaleEvents.x.time}},
        y: object.scaleEvents.y && {...object.scaleEvents.y, time: {...object.scaleEvents.y.time}},
      },
      horizontalMotion: object.horizontalMotion && {...object.horizontalMotion},
      movement: object.movement && ([...object.movement] as NonNullable<DrawObject['movement']>),
      offsetEvents: object.offsetEvents && {
        x: object.offsetEvents.x && new Map([...object.offsetEvents.x].map(([k, v]) => [k, {...v, time: {...v.time}}])),
        y: object.offsetEvents.y && new Map([...object.offsetEvents.y].map(([k, v]) => [k, {...v, time: {...v.time}}])),
      },
      children: object.children && this.copyObjects(object.children),
    };
  }

  private backgroundName(name: string): string {
    const key = name.toLowerCase();
    return /^(?:b_)?bg\d\d$/.test(key) ? key + 'a' : key;
  }

  private clearMainButtonGroups(): void {
    for (const group of [...this.activeGroups]) {
      if (group < 100_000) {
        this.activeGroups.delete(group);
        this.cancelGroups.delete(group);
        this.decisions.delete(group);
      }
    }
    this.display.syncObjectButtonGroups(this.activeGroups);
  }

  private async fade(name: string, transition: number): Promise<void> {
    this.clearDayObjects();
    this.clearMainButtonGroups();
    this.pendingText = false;
    this.display.closeMessage();
    this.display.fadeStageEffects();
    this.stageProperties.set('$bg_name.-1.0', 'none');
    this.stageProperties.set('$bg_set_ready', 0);
    this.stageProperties.set('$bs_name.-1.0', 'none');
    this.pendingBackground = undefined;
    this.stagedBackground = undefined;
    await this.display.setBackground(
      name,
      this.wipeDuration(fadeTimes[transition] ?? 0),
      undefined,
      true,
      true,
    );
    await this.cast([], -1);
  }

  private async background(
    name: string,
    fade: number,
    pan?: SiglusBackground['pan'],
    clearCast = false,
  ): Promise<void> {
    this.clearDayObjects();
    this.clearMainButtonGroups();
    this.pendingText = false;
    this.display.closeMessage();
    this.stageProperties.set('$bg_name.-1.0', name);
    this.stageProperties.set('$bg_name_prev.-1.0', name);
    this.stagedBackground = undefined;
    const resolvedName = this.backgroundName(name);
    this.recordCgSeen(name);
    this.recordCgSeen(resolvedName);
    await this.display.setBackground(
      resolvedName,
      this.wipeDuration(fadeTimes[fade] ?? 0),
      pan,
      clearCast,
    );
  }

  private async restoreCastCostumes(save: PlayerSave): Promise<void> {
    const dressId = this.game.pack.propertyNames.indexOf('$cha_dress');
    if (dressId < 0 || save.stage.some(([key]) => key.startsWith('$cha_dress.'))) return;
    // Older saves kept costume globals in the VM and did not run the costume initializer.
    await this.runOriginalCommand('$bs_dress_init');
    const prefix = (0x7f000000 | dressId) + '.';
    for (const [key, value] of save.vm.globals) {
      if (key.startsWith(prefix)) {
        this.stageProperties.set('$cha_dress.' + key.slice(prefix.length), value);
      }
    }
  }

  private async cast(
    names: string[],
    fade: number,
    costumes?: readonly (string | null)[],
    publish = false,
  ): Promise<void> {
    const resolved = names.map((name) =>
      /^[a-z][a-z0-9]$/i.test(name)
        ? (this.currentCast.find((previous) => spriteActor(previous) === name) ?? 'none')
        : name,
    );
    this.currentCast = resolved;
    this.currentCastCostumes = resolved.map(() => null);
    const placements = resolved.some((name) => !isEmptyStageSlot(name))
      ? await this.castPlacements(resolved)
      : undefined;
    const sprites = [];
    for (const [slot, name] of resolved.entries()) {
      if (isEmptyStageSlot(name)) continue;
      const costume = costumes?.[slot] ?? (await this.spriteCostume(name, slot, 0));
      this.currentCastCostumes[slot] = costume;
      sprites.push({name, costume, ...placements?.[slot]});
    }
    const backdrop = publish ? this.stagedBackground : undefined;
    if (backdrop) this.recordCgSeen(backdrop.name);
    await this.display.showCast(
      sprites,
      this.wipeDuration(fadeTimes[fade] ?? 0),
      publish,
      backdrop,
    );
    if (publish) this.stagedBackground = undefined;
  }

  private async castPlacements(
    names: readonly string[],
  ): Promise<SiglusCastPlacement[] | undefined> {
    const exportIndex = this.game.pack.commandNames.indexOf('$bs_disp_in');
    const scene = this.game.pack.sceneNames[this.game.pack.commandScenes[exportIndex * 2]!];
    if (!this.castAnchors.size || !scene) return;
    const commands = this.game.pack.scene(scene).commandNames;
    const formation = '$$bs_wipe_ready01';
    if (!commands.includes(formation)) return;
    const identifyCast = ['$$bs_far_decide', '$$bs_repeat_decide'];
    const hasLayerCommands = identifyCast.every((command) => commands.includes(command));
    for (let slot = 0; slot < 6; slot++) {
      const name = names[slot] || 'none';
      this.stageProperties.set('$bs_exist_decide.-1.' + slot, isEmptyStageSlot(name) ? 0 : -1);
      this.stageProperties.set('$bs_size_info.-1.' + slot, /^bs([123])_/.exec(name)?.[1] ?? '2');
    }
    if (hasLayerCommands) {
      // Loading and face-only updates can supply a resolved cast independently
      // of the scenario's pending slot names.
      const previous = new Map<string, Value | undefined>();
      for (let slot = 0; slot < 6; slot++) {
        const key = '$bs_name.-1.' + slot;
        previous.set(key, this.stageProperties.get(key));
        this.stageProperties.set(key, names[slot] || 'none');
      }
      try {
        for (const command of identifyCast) await this.vm.callScene(scene, command);
      } finally {
        for (const [key, name] of previous) {
          if (name === undefined) this.stageProperties.delete(key);
          else this.stageProperties.set(key, name);
        }
      }
    }
    await this.vm.callScene(scene, formation);
    return names.map((_, slot) => {
      const objectId = Number(this.stageProperties.get('$bs_cha_num.-1.' + slot) ?? 0);
      const layer = this.stageProperties.get('$chara_layer_next.-1.' + objectId);
      return {
        position: [
          Number(this.stageProperties.get('$bs_posx_next.-1.' + slot) ?? 0),
          Number(this.stageProperties.get('$bs_posy_next.-1.' + slot) ?? 0),
        ],
        drawOrder:
          hasLayerCommands && objectId && layer !== undefined
            ? [Number(layer), objectId]
            : undefined,
      };
    });
  }

  private async spriteCostume(name: string, slot: number, portrait: number): Promise<string> {
    this.stageProperties.set('$bs_name_info.-1.' + slot, spriteActor(name));
    const index = this.game.pack.commandNames.indexOf('$dress_control');
    const scene =
      index >= 0 ? this.game.pack.sceneNames[this.game.pack.commandScenes[index * 2]!] : undefined;
    const arity = scene ? this.vm.commandArity(scene, '$dress_control') : undefined;
    const all: Argument[] = [slot, portrait];
    const params = arity !== undefined && arity < all.length ? all.slice(0, arity) : all;
    await this.runOriginalCommand('$dress_control', params);
    return String(this.stageProperties.get('$bs_dress_info.-1.' + slot) || '01');
  }

  private async movie(name: string, skippable: boolean): Promise<number> {
    this.skip = false;
    this.readSkipEnabled = false;
    this.movieError = undefined;
    this.root.dataset.movie = name;
    this.display.pageControls();
    const volume = siglusVolumeGain(this.audio.volume('MOV'));
    const attenuation = volume > 0 ? 2000 * Math.log10(volume) : -10000;
    try {
      // The Windows modes share the browser's container-based player.
      if (!(await this.movies.play({path: name, attenuation, renderer: 0})))
        throw new Error('Missing Siglus movie ' + name);
      let progress: typeof this.movies.progress = null;
      while (this.movies.playing) {
        progress = this.movies.progress ?? progress;
        if (await this.delay(40, skippable)) return 1;
      }
      if (this.movieError) throw this.movieError;
      this.root.dispatchEvent(new CustomEvent('siglus-movie-ended', {detail: {name, ...progress}}));
      return 0;
    } finally {
      this.movies.close();
      delete this.root.dataset.movie;
    }
  }

  private async include(command: SiglusCommand): Promise<Value | undefined> {
    const args = command.args;
    const n = (i: number) => Number(args[i] ?? 0);
    const s = (i: number) => String(args[i] ?? '');
    switch (command.name) {
      case '$sys_set_gsd':
        await this.runOriginalCommand('$sys_set_gsd');
        // Earlier browser profiles may have an initialization flag without this setting.
        if (!this.system.has(1330)) this.property([31, -1, 1330], 1);
        for (const watcher of messageFrameWatchers) {
          const {flag, slot} = watcher;
          if (!this.system.has(flag)) this.property([31, -1, flag], 1);
          if (!this.globalExtraSwitches.has(slot))
            this.globalExtraSwitches.set(slot, Boolean(this.system.get(flag)));
          if (this.system.get(flag) === 0 && this.game.pack.commandNames.includes(watcher.command))
            this.pendingFrameWatchers.add(watcher);
        }
        return 0;
      case '$bg_disp_in':
        await this.background(s(0), n(1), undefined, !n(4));
        if (!n(4)) await this.cast([], -1);
        break;
      case '$bg_set':
        this.stageProperties.set('$bg_name.-1.0', s(0));
        this.pendingBackground = {
          name: s(0),
          pan: {from: [n(2), n(3)], to: [n(2), n(3)], time: 0, scale: [n(6), n(6)]},
        };
        this.stageProperties.set('$bg_set_ready', 1);
        break;
      case '$bg_disp_set':
        if (this.pendingBackground) {
          const {name, pan} = this.pendingBackground;
          // The script uses both "none" and names containing it (for example
          // "b_none" from the blur macro) as empty background slots.
          if (!name.includes('none') && !isEmptyStageSlot(name)) {
            if (this.display.hasStageEffectChanges) {
              this.stagedBackground = {name: this.backgroundName(name), pan};
              this.stageProperties.set('$bg_name_prev.-1.0', name);
            } else await this.background(name, 0, pan);
          }
          this.pendingBackground = undefined;
          this.stageProperties.set('$bg_set_ready', 0);
        }
        break;
      case '$bs_disp_in':
        await this.cast(
          Array.from({length: 6}, (_, i) =>
            String(this.stageProperties.get('$bs_name.-1.' + i) ?? 'none'),
          ),
          Number(this.stageProperties.get('$bs_wipe_set') ?? 0),
          undefined,
          true,
        );
        break;
      case '$$change_bs_only_face': {
        const names = [...this.currentCast];
        for (const [i, value] of args.entries()) {
          const face = String(value);
          if (isEmptyStageSlot(face)) break;
          const index = names.findIndex((name) => spriteActor(name) === spriteActor(face));
          const prefix = index < 0 ? undefined : /^bs\d_/.exec(names[index]!)?.[0];
          names[index < 0 ? i : index] = prefix && !face.startsWith('bs') ? prefix + face : face;
        }
        await this.cast(names, 0, undefined, true);
        break;
      }
      case '$bg_pan':
        await this.background(s(0), n(1), {
          from: [n(2), n(4)],
          to: [n(3), n(5)],
          time: n(8),
          scale: [n(6), n(7)],
        });
        await this.cast([], -1);
        break;
      case '$check_file_exist': {
        const exists = this.game.files.has('g00/' + s(0).toLowerCase() + '.g00');
        this.stageProperties.set('$bg_file_exist', Number(exists));
        this.stageProperties.set('$bg_type', exists ? 1 : 2);
        break;
      }
      case '$auto_save_disp':
        await this.display.autosaveNotice();
        break;
      case '$scene_fade':
        this.audio.stop('bgm', n(3));
        this.audio.stopEffects();
        await this.fade('bg_kuro', n(0));
        await this.delay(n(2), true);
        break;
      case '$bg_pan_ud':
      case '$bg_pan_du':
      case '$bg_pan_lr':
      case '$bg_pan_rl': {
        const positions: Record<string, [number, number]> = {
          $bg_pan_ud: [0, 270],
          $bg_pan_du: [0, -270],
          $bg_pan_lr: [480, n(4)],
          $bg_pan_rl: [-480, 0],
        };
        const from = positions[command.name]!;
        const to: [number, number] = [-from[0], command.name === '$bg_pan_lr' ? from[1] : -from[1]];
        await this.background(s(1), n(0), {from, to, time: n(2)});
        await this.cast([], -1);
        break;
      }
      case '$pcmch_play':
      case '$pcmch_play_loop':
        await this.audio.pcm(
          n(0),
          {resource: s(1), loop: command.name === '$pcmch_play_loop'},
          false,
          Math.max(0, n(2)),
        );
        break;
      case '$pcmch_stop':
        this.audio.stop(`pcm${n(0)}`, Math.max(0, n(1)));
        break;
      case '$bgm_play':
        await this.playBgm(s(0), Math.max(0, n(1)), Math.max(0, n(2)));
        break;
      case '$pcm_stop':
        this.audio.stop('pcm');
        break;
      case '$pcmch_stop_all':
        this.audio.stopPcmChannels();
        break;
      case '$bgm_stop':
        this.audio.stop('bgm', Math.max(0, n(0)));
        break;
      case '$ef_throb_start':
        this.display.throb(n(2));
        break;
      case '$set_face':
        if (!this.pendingText) {
          this.display.clearText();
          this.pageCharacters = 0;
          this.revealWholePage = false;
        }
        await this.display.face(s(0), await this.spriteCostume(s(0), 0, 1));
        this.pendingText = true;
        break;
      case '$sc_recollect':
        // _effect creates a looping child in the requested back-page slot,
        // with the 1024 × 512 frame scaled in thousandths by the scene.
        await this.display.stageMovieEffect({
          slot: n(1),
          name: s(0) === '白' ? 'ef_rec_white00' : 'ef_rec_black00',
          layer: 5000,
          loop: true,
          scale: [
            Math.trunc((this.display.width * 1000) / 1024),
            Math.trunc((this.display.height * 1000) / 512),
          ],
          elapsed: 0,
        });
        break;
      case '$ef_end':
        this.display.retireStageEffects(n(0), n(1));
        this.display.endLayerEffects();
        break;
      case '$sc_sepia':
        this.display.sepia(Boolean(n(0)));
        break;
      case '$fade':
        await this.fade(s(1), n(0));
        break;
      case '$sc_cinemascope': {
        const {width, height} = this.display;
        const thickness = n(0);
        const vertical = n(2) !== 0;
        this.display.stageRectangleEffect({
          slot: vertical ? 164 : 163,
          layer: vertical ? -20 : n(6),
          rectangles: vertical
            ? [[0, 0, thickness, height], [width - thickness, 0, thickness, height]]
            : [[0, 0, width, thickness], [0, height - thickness, width, thickness]],
          rgba: [n(3), n(4), n(5), n(1)],
        });
        break;
      }
      case '$sc_cinemascope_off':
        this.display.retireStageEffects(163, 2);
        break;
      case '$screen_shake':
        // Let the scene select the original parameters for translation quakes.
        if (!n(1) && [0, 1, 3, 4].includes(n(0))) return undefined;
        if (!this.skipping) this.display.shake(n(0));
        if (n(2)) await this.delay(350, true);
        break;
      case '$ef_line_start1':
        await this.display.stageGan({
          slot: n(1),
          name: n(2) ? 'ef_line02' : 'ef_line01',
          sequence: 0,
          loop: true,
          x: -64,
          y: -60,
          elapsed: 0,
        });
        break;
      case '$ef_dizzy_start':
        this.display.dizzy(n(1), n(2));
        break;
      case '$$auto_centering':
        this.display.centerText(Boolean(n(1)));
        break;
      case '$$add_msgback':
        this.addHistory({
          name: s(2),
          text: [{text: s(3)}],
          voices: n(0) < 0 ? [] : [{id: n(0), character: n(1)}],
        });
        break;
      case '$wait_bs_face_change_time':
        await this.delay(n(0), true);
        break;
      case '$wipe':
        if (n(0) === 121) await this.runOriginalCommand('$wipe', [...args]);
        else await this.wipe(fadeTimes[n(0)] ?? 0);
        break;
      default:
        return undefined;
    }
    return 0;
  }

  private readonly backlog: SiglusHistoryEntry[] = [];
  private readonly historyPoints = new WeakMap<SiglusHistoryEntry, HistoryPoint>();
  private historyTarget?: PlayerSave;
  private historyOpen = false;
  private pageVoices: SiglusHistoryEntry['voices'] = [];

  private addHistory(entry: SiglusHistoryEntry): void {
    if (!entry.text.length) return;
    this.backlog.push(entry);
    const limit = Number(this.game.config.get('MSGBK.HISTORY_CNT') ?? 1000);
    if (this.backlog.length > limit) this.backlog.splice(0, this.backlog.length - limit);
  }

  private replayGeneration = 0;

  private async playVoiceSafe(id: number, channel: string, character?: number): Promise<boolean> {
    try {
      await this.audio.voice(id, channel, character);
      return true;
    } catch (error) {
      if (error instanceof MissingSiglusVoiceError) return false;
      throw error;
    }
  }

  private async replayHistoryVoice(entry?: SiglusHistoryEntry): Promise<void> {
    const generation = ++this.replayGeneration;
    if (entry?.voices.length) this.audio.stop('voice');
    for (const {id, character} of entry?.voices ?? []) {
      if (generation !== this.replayGeneration) break;
      if (!(await this.playVoiceSafe(id, 'history-voice', character))) continue;
      await this.audio.waitForEnd('history-voice');
    }
  }

  private async openHistory(): Promise<void> {
    // Native 1.1.102.1 0x6348d4 tests the script's history access flag when opening the log.
    if (this.scriptMsgBackDisabled || !this.backlog.length) return;
    this.readSkipEnabled = false;
    this.autoEnabled = false;
    let focus: SiglusHistoryEntry | undefined;
    for (;;) {
      this.display.setScenePaused(true);
      const savedCursor = this.display.stage.style.cursor;
      // Native 0x621ec0: mouse cursor is always visible while backlog is open.
      this.display.stage.style.cursor = '';
      let selected: SiglusHistoryEntry | undefined;
      try {
        this.historyOpen = true;
        selected = await this.display.showHistory(
          this.backlog,
          (entry, sound) => {
            void (async () => {
              if (sound !== undefined) await this.playButtonSound(sound, 'decide');
              if (entry) await this.replayHistoryVoice(entry);
            })().catch((error) => {
              if (!this.controller.signal.aborted) console.error(error);
            });
          },
          (entry) => this.loadEnabled && this.historyPoints.has(entry),
          focus,
        );
      } finally {
        this.historyOpen = false;
        this.replayGeneration++;
        this.audio.stop('history-voice');
        this.display.stage.style.cursor = savedCursor;
        this.display.setScenePaused(this.timeStopped);
      }
      if (!selected) return;
      const point = this.historyPoints.get(selected);
      if (!point) return;
      focus = selected;
      const slicedHistory = this.backlog.slice(0, this.backlog.indexOf(selected) + 1);
      const slicedPoints: [number, HistoryPoint][] = [];
      for (const [index, entry] of slicedHistory.entries()) {
        const entryPoint = this.historyPoints.get(entry);
        if (entryPoint) slicedPoints.push([index, entryPoint]);
      }
      this.historyTarget = {
        ...point,
        history: slicedHistory,
        historyPoints: slicedPoints,
      };
      try {
        await this.callSystemScene('MSGBK.LOAD_CALL');
      } finally {
        this.historyTarget = undefined;
      }
    }
  }

  private recordBgmListened(name: string): void {
    const key = name.toLowerCase();
    if (!key || this.bgmListened.has(key)) return;
    this.bgmListened.add(key);
    localStorage.setItem(this.game.saveKey + ':bgmtable', JSON.stringify([...this.bgmListened]));
  }

  private async loadCgTable(): Promise<void> {
    if (this.cgTableLoaded) return;
    this.cgTableLoaded = true;
    const raw = this.game.config.get('CGTABLE_FILE')?.split('"')[1];
    if (!raw) return;
    const lower = raw.toLowerCase();
    const file = this.game.files.get(`dat/${lower}`) ?? this.game.files.get(lower);
    if (!file) return;
    const parsed = parseCgTable(new Uint8Array(await file.read(0, file.size)));
    for (const [name, flagNo] of parsed.byName) {
      if (flagNo >= 0 && (!this.cgFlagLimit || flagNo < this.cgFlagLimit)) {
        this.cgTable.set(name, flagNo);
      }
    }
  }

  private recordCgSeen(name: string): void {
    if (!name || !this.cgTable.size) return;
    let changed = false;
    const mark = (candidate: string) => {
      const flagNo = this.cgTable.get(candidate.toLowerCase());
      if (flagNo !== undefined && !this.cgFlags.has(flagNo)) {
        this.cgFlags.add(flagNo);
        changed = true;
      }
    };
    mark(name);
    if (name.includes('|')) {
      for (const segment of name.split('|')) {
        const trimmed = segment.trim();
        if (!trimmed) continue;
        const comma = trimmed.indexOf(',');
        const partName = comma >= 0 ? trimmed.slice(0, comma).trim() : trimmed;
        if (partName && !partName.startsWith('(')) mark(partName);
      }
    }
    if (changed) {
      localStorage.setItem(this.game.saveKey + ':cgtable', JSON.stringify([...this.cgFlags]));
    }
  }

  private async playBgm(name: string, fade = 0, crossfade = 0): Promise<void> {
    this.recordBgmListened(name);
    if (this.audio.isLoopingBgm(name)) return;
    this.audio.bgmStart(name, true, fade, crossfade);
  }

  private async waitAudio(channel: string, skippable: boolean): Promise<number> {
    while (this.audio.channelState(channel) === 1) {
      const remaining = this.audio.channelRemainingMs(channel);
      if (remaining <= 0) {
        if (!this.audio.isPending(channel)) break;
        if (await this.delay(16, skippable)) return 1;
        continue;
      }
      if (await this.delay(Math.min(200, Math.max(16, remaining)), skippable)) return 1;
    }
    return 0;
  }

  private async loadDatabase(index: number): Promise<SiglusDbs | undefined> {
    let pending = this.databases.get(index);
    if (!pending) {
      pending = (async () => {
        const entry = this.game.config.get(`DATABASE.${String(index).padStart(3, '0')}`);
        const name = entry?.split('"')[1];
        if (!name) return undefined;
        const lower = name.toLowerCase();
        const file =
          this.game.files.get(`dat/${lower}.dbs`) ??
          this.game.files.get(`dat/${lower}`) ??
          this.game.files.get(`${lower}.dbs`);
        if (!file) return undefined;
        return new SiglusDbs(new Uint8Array(await file.read(0, file.size)));
      })();
      this.databases.set(index, pending);
    }
    return pending;
  }

  private resolveNamae(key: string): number[] {
    const folded = key.toLowerCase();
    let id = this.namaeIds.get(folded);
    if (id === undefined) {
      id = this.namaeIds.size;
      this.namaeIds.set(folded, id);
      // Legacy saves stored the values in registration order without the keys.
      if (!this.namaeValues.has(id)) this.namaeValues.set(id, this.namaeAliases.get(folded) ?? key);
    }
    return [108, id];
  }

  private expandNamae(text: string): string {
    // Siglus 1.1.102.1 0x622d70 reads the full-width name references parsed at 0x595eb0.
    return text.replace(/[％＊][Ａ-Ｚ]{1,2}/giu, (token) => {
      const id = this.namaeIds.get(token.toLowerCase());
      if (id !== undefined) return this.namaeValues.get(id) ?? token;
      const next = this.namaeIds.get(token.slice(0, 2).toLowerCase());
      if (next === undefined) return token;
      return (this.namaeValues.get(next) ?? token.slice(0, 2)) + token.slice(2);
    });
  }

  private startFrameAction(
    faPath: readonly number[],
    scene: string,
    endTime: number,
    command: string,
    extraArgs: readonly Argument[],
    realTime: boolean,
  ): void {
    const key = this.frameActionKey(faPath);
    const now = performance.now();
    // 1.1.137.0 (0x6990f0) looks up the normalized name in the global table first.
    const name = command.toLowerCase();
    const pack = this.game.pack;
    const exported = pack.commandNames.indexOf(name);
    const callbackScene = exported >= 0 ? pack.sceneNames[pack.commandScenes[exported * 2]!] : scene;
    this.frameActions.set(key, {
      path: [...faPath],
      scene: callbackScene ?? scene,
      command: name,
      args: [...extraArgs],
      endTime,
      realTime,
      started: now,
      modalFront: key.startsWith('modal:'),
    });
    this.frameActionCounters.set(key, {start: now, from: 0});
  }

  private endFrameAction(faPath: readonly number[]): void {
    const key = this.frameActionKey(faPath);
    this.frameActions.delete(key);
    this.frameActionCounters.delete(key);
  }

  private frameActionKey(path: readonly number[]): string {
    const modal = (path[0] === 38 || path[0] === 53 || path[0] === 79) && this.modalFrontObjects;
    return (modal ? 'modal:' : '') + path.join('.');
  }

  private effectSlot(key: string): {
    props: Map<number, number>;
    events: Map<number, {endAt: number; target: number}>;
  } {
    let slot = this.stageEffects.get(key);
    if (!slot) {
      slot = {props: new Map(), events: new Map()};
      this.stageEffects.set(key, slot);
    }
    return slot;
  }

  private effectProperty(key: string, prop: number, value?: Value): number {
    const slot = this.effectSlot(key);
    if (value !== undefined) {
      slot.props.set(prop, Number(value) | 0);
      this.applyScreenEffects();
    }
    return slot.props.get(prop) ?? 0;
  }

  private async effectCommand(
    key: string,
    tail: readonly number[],
    args: readonly Argument[],
  ): Promise<number | undefined> {
    const slot = this.effectSlot(key);
    if (tail.length === 1 && tail[0] === 30) {
      slot.props.clear();
      slot.events.clear();
      this.applyScreenEffects();
      return 0;
    }
    if (tail.length === 2) {
      const channel = tail[0]!;
      const op = tail[1]!;
      // Map intevent channel 17..27 to property 3..13 (0x54a980)
      const prop = channel >= 17 && channel <= 27 ? channel - 14 : -1;
      if (prop < 0) return undefined;
      if (op === 0 || op === 7) {
        const target = Number(args[0] ?? 0) | 0;
        const duration = Math.max(0, Number(args[1] ?? 0));
        const waitDelay = Math.max(0, Number(args[2] ?? 0));
        slot.props.set(prop, target);
        if (duration + waitDelay > 0 && !this.skipping) {
          slot.events.set(channel, {endAt: performance.now() + duration + waitDelay, target});
        } else {
          slot.events.delete(channel);
        }
        this.applyScreenEffects();
        return 0;
      }
      if (op === 3) {
        const ev = slot.events.get(channel);
        if (ev) slot.props.set(prop, ev.target);
        slot.events.delete(channel);
        this.applyScreenEffects();
        return 0;
      }
      if (op === 4 || op === 10) {
        const ev = slot.events.get(channel);
        if (ev && !this.skipping) {
          const remaining = Math.ceil(ev.endAt - performance.now());
          if (remaining > 0) await this.delay(remaining, op === 10);
        }
        slot.events.delete(channel);
        return 0;
      }
      if (op === 5) {
        const ev = slot.events.get(channel);
        if (!ev) return 0;
        if (performance.now() >= ev.endAt) {
          slot.events.delete(channel);
          return 0;
        }
        return 1;
      }
    }
    return undefined;
  }

  private applyScreenEffects(): void {
    const agg = {
      mono: 0,
      reverse: 0,
      bright: 0,
      dark: 0,
      colorR: 0,
      colorG: 0,
      colorB: 0,
      colorRate: 0,
      addR: 0,
      addG: 0,
      addB: 0,
    };
    for (const [key, {props}] of this.stageEffects) {
      // Only front (38.*) and screen (70.*) effects affect the visible stage
      if (!key.startsWith('38.') && !key.startsWith('70.')) continue;
      agg.mono = Math.max(agg.mono, props.get(3) ?? 0);
      agg.reverse = Math.max(agg.reverse, props.get(4) ?? 0);
      agg.bright = Math.max(agg.bright, props.get(5) ?? 0);
      agg.dark = Math.max(agg.dark, props.get(6) ?? 0);
      const rate = props.get(10) ?? 0;
      if (rate > agg.colorRate) {
        agg.colorRate = rate;
        agg.colorR = props.get(7) ?? 0;
        agg.colorG = props.get(8) ?? 0;
        agg.colorB = props.get(9) ?? 0;
      }
      agg.addR = Math.max(agg.addR, props.get(11) ?? 0);
      agg.addG = Math.max(agg.addG, props.get(12) ?? 0);
      agg.addB = Math.max(agg.addB, props.get(13) ?? 0);
    }
    this.display.setScreenEffect(agg);
  }

  private frameActionCounter(
    faPath: readonly number[],
    member: number,
    args: SiglusCommand['args'] = [],
  ): Value | undefined {
    const key = this.frameActionKey(faPath);
    const value = this.counter(this.frameActionCounters, key, member, args);
    if (member === 14) return Number(Boolean(this.frameActions.get(key)) && Boolean(value));
    return value;
  }

  private async tickFrameActions(): Promise<void> {
    if (this.pendingButtonCalls.length) await this.flushButtonCalls();
    if (this.tickingFrameActions || !this.frameActions.size) return;
    this.tickingFrameActions = true;
    const previousDepth = this.mainFrameActionDepth;
    try {
      const now = performance.now();
      for (const [key, action] of [...this.frameActions]) {
        if (this.frameActions.get(key) !== action) continue;
        const isExcallAction = action.path[0] === 65;
        // Native 0x622e70 / 0x625c10: time_stop freezes normal-stage frame_actions,
        // while G_excall.is_ready (excallAllocated) frame_actions continue ticking.
        if (isExcallAction ? !this.excallAllocated : this.timeStopped) continue;
        if (action.endTime >= 0 && now - action.started >= action.endTime) {
          this.frameActions.delete(key);
          this.frameActionCounters.delete(key);
          continue;
        }
        const canRun =
          this.game.pack.commandNames.includes(action.command) ||
          this.game.pack.scene(action.scene).commandNames.includes(action.command);
        if (!canRun) continue;
        // Native Siglus passes (frame_action_ref, owner_object_ref, ...extra_args)
        // for object.frame_action (52) and object.frame_action_ch (115.-1.<ch>),
        // and (frame_action_ref, ...extra_args) for global frame_action (79 / 53.-1.<ch>).
        const p = action.path;
        const ownerPath =
          p.length >= 2 && p.at(-1) === 52
            ? p.slice(0, -1)
            : p.length >= 4 && p.at(-3) === 115 && p.at(-2) === -1
              ? p.slice(0, -3)
              : undefined;
        const params: Argument[] = ownerPath
          ? [action.path, ownerPath, ...action.args]
          : [action.path, ...action.args];
        // Native 0x5c8080 -> 0x598300 runs the callback on its owning object page.
        this.mainFrameActionDepth = !isExcallAction && !action.modalFront ? this.systemCallDepth : undefined;
        await this.vm.callScene(action.scene, action.command, params);
      }
    } finally {
      this.mainFrameActionDepth = previousDepth;
      this.tickingFrameActions = false;
    }
  }

  private stopPcmEvent(slot: number): void {
    const active = this.pcmEvents.get(slot);
    if (active) {
      active.cancel();
      this.pcmEvents.delete(slot);
    }
  }

  private startPcmEventRandom(
    slot: number,
    pcmchNo: number,
    entries: readonly {file: string; minTime: number; maxTime: number; probability: number}[],
    options: {volumeType?: number; bgmFadeTarget?: boolean; character?: number},
  ): void {
    this.stopPcmEvent(slot);
    if (!entries.length) return;
    let cancelled = false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    let previousIndex = -1;
    const cancel = (): void => {
      cancelled = true;
      if (timer !== undefined) clearTimeout(timer);
      if (pcmchNo >= 0) this.audio.stop(`pcm${pcmchNo}`);
    };
    this.pcmEvents.set(slot, {
      cancel,
      config: {
        mode: 'random',
        pcmchNo,
        entries: entries.map((e) => ({...e})),
        options: {...options},
      },
    });

    const step = async (): Promise<void> => {
      if (cancelled || this.controller.signal.aborted) return;
      const idx = selectPcmEventIndex(
        entries.map((e) => e.probability),
        previousIndex,
      );
      if (idx < 0) return;
      previousIndex = idx;
      const chosen = entries[idx]!;
      try {
        if (pcmchNo >= 0) {
          await this.audio.pcm(
            pcmchNo,
            {
              resource: chosen.file,
              loop: false,
              volumeType: options.volumeType,
              character: options.character,
              bgmFadeTarget: options.bgmFadeTarget,
            },
            false,
            0,
          );
        } else {
          await this.audio.effect('se', chosen.file);
        }
      } catch {
        // Missing optional BGV clip should not crash background ambient loop.
      }
      if (cancelled || this.controller.signal.aborted) return;
      const lo = Math.max(0, chosen.minTime);
      const hi = Math.max(lo, chosen.maxTime);
      const gap = hi > lo ? lo + Math.floor(Math.random() * (hi - lo)) : lo;
      const clipMs = await this.audio.effectDurationMs(chosen.file);
      if (cancelled || this.controller.signal.aborted) return;
      timer = setTimeout(() => void step(), Math.max(16, clipMs + gap));
    };
    void step();
  }

  private startPcmEventSequence(
    slot: number,
    pcmchNo: number,
    entries: readonly {file: string; minTime: number; maxTime: number}[],
    options: {volumeType?: number; bgmFadeTarget?: boolean; character?: number},
    loop: boolean,
  ): void {
    // Native 0x55fe50 modes 0 (start_oneshot) and 1 (start_loop)
    this.stopPcmEvent(slot);
    if (!entries.length) return;
    let cancelled = false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    let index = 0;
    const cancel = (): void => {
      cancelled = true;
      if (timer !== undefined) clearTimeout(timer);
      if (pcmchNo >= 0) this.audio.stop(`pcm${pcmchNo}`);
    };
    const entry = {
      cancel,
      config: {
        mode: (loop ? 'loop' : 'oneshot') as 'loop' | 'oneshot',
        pcmchNo,
        entries: entries.map((e) => ({...e, probability: 1})),
        options: {...options},
      },
    };
    this.pcmEvents.set(slot, entry);

    const step = async (): Promise<void> => {
      if (cancelled || this.controller.signal.aborted) return;
      if (index >= entries.length) {
        if (!loop) {
          if (this.pcmEvents.get(slot) === entry) this.pcmEvents.delete(slot);
          return;
        }
        index = 0;
      }
      const chosen = entries[index++]!;
      try {
        if (pcmchNo >= 0) {
          await this.audio.pcm(
            pcmchNo,
            {
              resource: chosen.file,
              loop: false,
              volumeType: options.volumeType,
              character: options.character,
              bgmFadeTarget: options.bgmFadeTarget,
            },
            false,
            0,
          );
        } else {
          await this.audio.effect('se', chosen.file);
        }
      } catch {
        // Ignore missing optional clip
      }
      if (cancelled || this.controller.signal.aborted) return;
      const lo = Math.max(0, chosen.minTime);
      const hi = Math.max(lo, chosen.maxTime);
      const gap = hi > lo ? lo + Math.floor(Math.random() * (hi - lo)) : lo;
      const clipMs = await this.audio.effectDurationMs(chosen.file);
      if (cancelled || this.controller.signal.aborted) return;
      if (!loop && index >= entries.length) {
        timer = setTimeout(() => {
          if (this.pcmEvents.get(slot) === entry) this.pcmEvents.delete(slot);
        }, Math.max(16, clipMs + gap));
        return;
      }
      timer = setTimeout(() => void step(), Math.max(16, clipMs + gap));
    };
    void step();
  }

  private async runSelbtn(command: SiglusCommand, cancelable: boolean): Promise<number> {
    await this.renderObjects();
    const rawCall = parseSelbtnArgs(command.args, command.named);
    const call = {
      ...rawCall,
      items: rawCall.items.map((item) => ({...item, text: this.expandNamae(item.text)})),
    };
    const hasEnabled = call.items.some((item) => selbtnPresentation(item.dispFlag) === 'enabled');
    const hasVisible = call.items.some((item) => selbtnPresentation(item.dispFlag) !== 'hidden');
    if (!hasVisible || (!hasEnabled && !cancelable)) return -1;
    const signal = this.controller.signal;
    signal.throwIfAborted();
    this.skip = false;
    const animate =
      !this.scriptMessageAnimationsDisabled && !this.systemOption('NO_MWND_ANIME_ONOFF');
    const chosen = await new Promise<number>((resolve, reject) => {
      let settled = false;
      const cleanup = (): void => {
        settled = true;
        signal.removeEventListener('abort', abort);
        window.removeEventListener('keydown', onKey);
        this.display.stage.removeEventListener('contextmenu', onContextMenu, true);
      };
      const finish = (index: number): void => {
        if (settled) return;
        cleanup();
        resolve(index);
      };
      const fail = (error: unknown): void => {
        if (settled) return;
        cleanup();
        this.display.clearSelectionButtons();
        reject(error);
      };
      const abort = (): void => fail(signal.reason);
      const onKey = (event: KeyboardEvent): void => {
        if (cancelable && (event.key === 'Escape' || event.key === 'Backspace')) {
          event.preventDefault();
          finish(-1);
        }
      };
      const onContextMenu = (event: MouseEvent): void => {
        if (!cancelable) return;
        event.preventDefault();
        event.stopImmediatePropagation();
        finish(-1);
      };
      signal.addEventListener('abort', abort, {once: true});
      window.addEventListener('keydown', onKey);
      this.display.stage.addEventListener('contextmenu', onContextMenu, true);
      void this.display
        .showSelectionButtons(
          call,
          (index) => finish(index),
          () => void this.playSystemSound(0),
          animate,
        )
        .catch(fail);
    });
    await this.display.finishSelectionButtons(chosen, animate && !this.skipping);
    if (command.readFlag !== undefined && command.readFlag >= 0) {
      let flags = this.readFlags.get(command.scene);
      if (!flags) this.readFlags.set(command.scene, (flags = new Set()));
      if (!flags.has(command.readFlag)) {
        flags.add(command.readFlag);
        localStorage.setItem(
          this.game.saveKey + ':read',
          JSON.stringify([...this.readFlags].map(([scene, set]) => [scene, [...set]])),
        );
      }
    }
    this.lastSelectionMessage = chosen >= 0 ? (call.items[chosen]?.text ?? '') : '';
    return chosen;
  }

  private async command(command: SiglusCommand): Promise<Argument | undefined> {
    if (command.name) return this.usesLegacyIncludes ? this.include(command) : undefined;
    const {args} = command;
    const path = this.stagePath(command.path);
    const [root, member] = path;
    const n = (i: number) => Number(args[i] ?? 0);
    const s = (i: number) => String(args[i] ?? '');
    if (
      path.length >= 3 &&
      path.at(-2) === 0 &&
      (path.at(-3) === 79 ||
        path.at(-3) === 52 ||
        (path.length >= 5 &&
          (path.at(-5) === 53 || path.at(-5) === 115) &&
          path.at(-4) === -1))
    ) {
      return this.frameActionCounter(path.slice(0, -2), path.at(-1)!, args);
    }
    if (root === 32 && member === 3 && path.length === 3 && path[2] === 8) {
      const first = n(0);
      const last = n(1);
      const value = n(2);
      if (first < 0 || last < first || last - first > 1_000_000)
        throw new Error('Invalid Siglus gallery flag range');
      let changed = false;
      for (let bit = first; bit <= last; bit++)
        changed = this.setGalleryFlag(bit, value) || changed;
      if (changed) this.persistGalleryFlags();
      return 0;
    }
    if (path.length === 1) {
      switch (root) {
        case 57: // The 1.1.141.3 MWND receiver closes the active message (0x5540df).
          this.display.closeMessage();
          this.messageFaces.delete(this.display.messageWindow);
          this.pendingText = false;
          this.pageVoices = [];
          return 0;
        case 60: // Native 1.1.141.3 dispatches directly to the success return at 0x551e30.
          return 0;
        case 1: // global.selpoint (0x54cdbc)
          if (this.saveEnabled) this.rememberSelection(this.captureSave());
          break;
        case 149: // 1.1.141.3 at 0x550ec3 copies the current checkpoint to a temporary slot.
          this.stagedSelectionSave = this.savePoint;
          break;
        case 150: // Commit the staged checkpoint to the selection history, then empty it.
          if (this.stagedSelectionSave) this.rememberSelection(this.stagedSelectionSave);
          this.stagedSelectionSave = undefined;
          break;
        case 80: // capture
          if (this.savePoint && !this.systemCallActive) {
            this.savePoint.thumbnail = this.display.captureThumbnail();
          } else if (this.savePoint) {
            const bgmPlayback = this.audio.bgmCheckpoint();
            this.savePoint = {
              ...this.savePoint,
              thumbnail: this.display.captureThumbnail(),
              gans: this.display.saveGans(),
              movieEffects: this.display.saveMovieEffects(),
              rectangleEffects: this.display.saveRectangleEffects(),
              sceneCovered: this.display.sceneCovered || undefined,
              bgm: bgmPlayback?.name,
              bgmPlayback,
              bgmLevel: this.audio.channelLevel('bgm'),
              pcmPlayback: this.audio.pcmCheckpoint(),
              voiceLevel: this.audio.channelLevel('voice'),
            };
          }
          return 0;
        case 81: // capture_free
          return 0;
        case 6: // disp
        case 96: // frame
          await this.tickFrameActions();
          await this.renderObjects();
          if (root === 6 && !this.inputSampled && (this.systemCallActive || this.activeGroups.size)) {
            await this.nextInput();
            this.sampleInputNow();
          }
          this.inputSampled = false;
          break;
        case 7:
        case 23: {
          // global.wipe (7) / global.wipe_all (23) (0x6a7cd0):
          // named IDs: 0=type, 1=time, 2=speed_mode, 3=option[], 4=start_order, 5=end_order,
          // 6=start_layer, 7=end_layer, 8=wait (default 1)
          const positional = args.length - command.named.length;
          const parameter = (id: number) => {
            const index = command.named.indexOf(id);
            return index >= 0 ? args[positional + index] : id < positional ? args[id] : undefined;
          };
          const wipeType = Number(parameter(0) ?? 0);
          const duration = wipeType === 1 ? 0 : Number(parameter(1) ?? 0);
          const speedMode = Number(parameter(2) ?? 0);
          const rawOptions = parameter(3);
          const options = Array.isArray(rawOptions) ? rawOptions.map((v) => Number(v)) : [];
          const waitFlag = parameter(8) === undefined ? true : Boolean(Number(parameter(8)));
          let spec: Parameters<SiglusPlayer['wipe']>[1];
          if (wipeType === 60 && options.length > 0) {
            const softness = Number(options[0] ?? 0);
            const quadrant = Number(options[1] ?? 0);
            const reverse = Boolean(options[2] ?? 0);
            spec = {
              softness: softness < 0 || softness >= 8 ? 1 : 1 - 2 ** -softness,
              quadrant: quadrant >= 0 && quadrant < 4 ? quadrant : 0,
              reverse,
            };
          } else if (wipeType !== 0 && wipeType !== 1) {
            spec = proceduralWipeMask(wipeType, 256, 144, options);
          }
          await this.runWipeCommand(duration, spec, waitFlag, speedMode);
          break;
        }
        case 8:
          this.display.selectMessageWindow(n(0));
          this.messageObjectsDirty = true;
          await this.renderMessageObjects();
          break;
        case 10: {
          const anime = this.messageAnimation('close');
          if (anime.type > 0 && anime.time > 0) {
            await this.display.closeMessageWithAnimation(anime);
          } else this.display.closeMessage();
          this.messageFaces.delete(this.display.messageWindow);
          this.pageVoices = [];
          this.pendingText = false;
          break;
        }
        case 11: // clear
          this.display.clearText();
          this.messageFaces.delete(this.display.messageWindow);
          this.pageVoices = [];
          this.pendingText = false;
          break;
        case 12:
          this.beginMessage();
          if (command.readFlag !== undefined && command.readFlag >= 0) {
            if (!this.readFlags.get(command.scene)?.has(command.readFlag) && !this.skipUnread)
              this.readSkipEnabled = false;
            this.pageReadFlags.push({scene: command.scene, flag: command.readFlag});
          }
          await this.printMessage(s(0));
          break;
        case 13:
        case 115: // global.pp / mwnd 0x36 (0x54b340 -> 0x54f140 -> 0x650bd0)
          await this.pageInput(true);
          break;
        case 15:
        case 62:
          this.queueMessageAction(() => this.display.newline());
          break;
        case 14:
          await this.pageInput();
          break;
        case 16: {
          const textSize = args.length ? n(0) : undefined;
          this.queueMessageAction(() => this.display.setTextSize(textSize));
          break;
        }
        case 17: {
          // Native 1.1.141.3 at 0x554d7a/0x554dcc stores the per-window glyph color override.
          const color = args.length ? n(0) : -1;
          this.queueMessageAction(() => this.display.setMessageTextColor(color));
          break;
        }
        case 18:
          this.pageVoices = [
            ...this.pageVoices,
            {id: n(0), character: args.length > 1 ? n(1) : undefined},
          ];
          if (!this.skipping)
            this.audio.voiceStart(n(0), 'voice', args.length > 1 ? n(1) : undefined);
          break;
        case 2: // global.owari: end script cleanly and return to title menu
          return this.vm.returnToMenu();
        case 138: // 1.1.141.3 at 0x551aed removes entries from the end of message history.
          if (n(0) > 0) this.backlog.length = Math.max(0, this.backlog.length - (n(0) | 0));
          return 0;
        case 139:
          return this.backlog.length + 1;
        case 140: {
          const count = n(0) | 0;
          if (count >= 1 && count <= this.backlog.length) this.backlog.length = count - 1;
          return 0;
        }
        case 141: // 0x551ae1 invokes the same receiver with the initial count of one.
          this.backlog.length = 0;
          return 0;
        case 22:
          this.display.setMessageFrame(n(0));
          break;
        case 33: // global.wipe_end (0x6a7ff0)
          this.display.finishWipe();
          if (this.pendingWipe) {
            await this.pendingWipe;
            this.pendingWipe = undefined;
          }
          break;
        case 50: // global.mask_wipe_all (0x56aba0 -> 0x6a7e50)
        case 51: {
          // global.mask_wipe(mask_name, wipe_type, duration, start_time?, options?...)
          const positional = args.length - command.named.length;
          const waitIndex = command.named.indexOf(8);
          const waitFlag =
            waitIndex >= 0 ? Boolean(Number(args[positional + waitIndex])) : true;
          const maskName = s(0);
          const duration = n(2);
          const options = args.find(Array.isArray);
          const softness = Array.isArray(options) ? wipeSoftness(Number(options[0] ?? 0)) : 0;
          const reverse = Array.isArray(options) && Boolean(options[1] ?? 0);
          const mask = maskName ? await this.display.loadMaskWipe(maskName, softness, reverse) : undefined;
          await this.runWipeCommand(duration, mask, waitFlag);
          break;
        }
        case 54:
          if (this.objectsDirty) await this.renderObjects();
          if (!this.skipping) await this.delay(n(0));
          break;
        case 55:
          if (this.objectsDirty) await this.renderObjects();
          return this.delay(n(0), true);
        case 61: {
          const ruby = s(0);
          if (ruby) this.beginMessage();
          this.queueMessageAction(() => this.display.annotate(ruby));
          break;
        }
        case 76:
        case 77:
          return this.runSelbtn(command, root === 77);
        case 90:
          if (command.readFlag !== undefined && command.readFlag >= 0) {
            if (!this.readFlags.get(command.scene)?.has(command.readFlag) && !this.skipUnread)
              this.readSkipEnabled = false;
            this.pageReadFlags.push({scene: command.scene, flag: command.readFlag});
          }
          this.pageVoices = [
            ...this.pageVoices,
            {id: n(0), character: args.length > 1 ? n(1) : undefined},
          ];
          if (this.skipping) return 0;
          if (!(await this.playVoiceSafe(n(0), 'voice', args.length > 1 ? n(1) : undefined)))
            return 0;
          await this.waitAudio('voice', false);
          return 0;
        case 91:
          if (command.readFlag !== undefined && command.readFlag >= 0) {
            if (!this.readFlags.get(command.scene)?.has(command.readFlag) && !this.skipUnread)
              this.readSkipEnabled = false;
            this.pageReadFlags.push({scene: command.scene, flag: command.readFlag});
          }
          this.pageVoices = [
            ...this.pageVoices,
            {id: n(0), character: args.length > 1 ? n(1) : undefined},
          ];
          if (this.skipping) return 0;
          if (!(await this.playVoiceSafe(n(0), 'voice', args.length > 1 ? n(1) : undefined)))
            return 0;
          return this.waitAudio('voice', true);
        case 93: // global.next_msg (0x5da150: multi-message sub-block advance)
          break;
        case 108: // global.namae (0x5bee20 -> 0x6791b0, ret=strref(23))
          return this.resolveNamae(s(0));
        case 158: // global.get_line_no (0x54cd14)
          return command.line;
        case 41: {
          const [slot, name] = typeof args[0] === 'number' ? [n(0), s(1)] : [0, s(0)];
          const window = this.display.messageWindow;
          let faces = this.messageFaces.get(window);
          if (!faces) this.messageFaces.set(window, (faces = new Map()));
          const object = emptyDrawObject();
          object.name = name;
          object.visible = Boolean(name);
          if (name) object.frames[0] = await this.display.objectGraphic(name, 0);
          faces.set(slot, object);
          await this.display.showMessageFaces?.(orderedObjects(faces));
          return 0;
        }
        case 68: // global.koe_stop (0x54d7c4)
          this.audio.stop('voice');
          break;
        case 69: // global.koe_check
          return this.audio.channelState('voice');
        case 85: // global.koe_wait
          await this.waitAudio('voice', false);
          return 0;
        case 99: // global.koe_wait_key
          return this.waitAudio('voice', true);
        case 87: // global.exkoe_play(koe_no, chara_no?, sample_flag?)
          if (!this.skipping)
            this.audio.voiceStart(n(0), 'voice', args.length > 1 ? n(1) : undefined);
          return 0;
        case 88: // global.exkoe_play_wait(koe_no, chara_no?)
          if (this.skipping) return 0;
          if (!(await this.playVoiceSafe(n(0), 'voice', args.length > 1 ? n(1) : undefined)))
            return 0;
          await this.waitAudio('voice', false);
          return 0;
        case 89: // global.exkoe_play_wait_key(koe_no, chara_no?)
          if (this.skipping) return 0;
          if (!(await this.playVoiceSafe(n(0), 'voice', args.length > 1 ? n(1) : undefined)))
            return 0;
          return this.waitAudio('voice', true);
        case 72:
          this.messageFaces.delete(this.display.messageWindow);
          this.display.clearFace();
          break;
        case 74:
          this.saveTitle = s(0);
          break;
        case 75:
          return this.saveTitle;
        case 103: // global.wait_wipe
          if (this.pendingWipe) {
            await this.pendingWipe;
            this.pendingWipe = undefined;
          }
          return 0;
        case 131:
          return command.scene;
        case 84:
          break; // Message-block boundaries delimit CD_NAME / CD_TEXT.
        case 95:
          break; // Subsequent message blocks share the active message window.
        case 120:
          this.display.setMessageSlide(
            this.scriptMessageAnimationsDisabled || this.systemOption('NO_MWND_ANIME_ONOFF')
              ? 0
              : n(0),
          );
          break;
        case 122:
          this.display.setMessageSlide();
          break;
        case 151:
          this.display.repPosition(n(0), n(1));
          break;
        case 152:
        case 153:
        case 154:
          this.audio.setChannelLevel(
            'voice',
            root === 152 ? n(0) : root === 153 ? 255 : 0,
            n(root === 152 ? 1 : 0),
          );
          break;
        case 155:
          return this.audio.channelLevel('voice');
        case 110: // global.check_selpoint (0x54cdd9)
          return Number(this.selectionSaves.length > 0);
        case 111: // global.clear_selpoint (0x54cdcf)
          this.selectionSaves.length = 0;
          this.stagedSelectionSave = undefined;
          break;
        case 144: {
          // 1.1.102.1 (0x52579b -> 0x635c10 -> 0x5e7ca0) renders through the
          // specified order/layer pair and writes a PNG named for its Unix timestamp.
          const named = command.named ?? [];
          const positional = args.length - named.length;
          const limit = [0, 1].map((id) => {
            const index = named.indexOf(id);
            return index < 0 ? 0x7fffffff : n(positional + index) | 0;
          }) as [number, number];
          const timestamp = Math.floor(Date.now() / 1000);
          return (await this.storeCapture(`${timestamp}.png`, 0, 0, {limit})) ? timestamp | 0 : 0;
        }
        case 113:
          this.savePoint = undefined;
          break;
        case 116:
          return this.display.messageWindow;
        case 36:
          if (command.scene === '__sys_day_change') this.beginDayObjects();
          this.savePoint = this.captureSave(false, true, 1);
          return 0;
        case 112:
          return Number(Boolean(this.savePoint));
        case 0: // global.message_box (host-only Windows MessageBoxW fallback)
          break;
        case 114: // global.insert_msgbk_img (0x54cf60): (filename, x)
          this.backlog.push({name: '', text: [{text: `[image:${s(0)}]`}], voices: []});
          break;
        case 164: // 1.1.102.1 mode 5 (0x635b00 -> 0x5ec770) includes the configured overlay.
          if (this.objectsDirty) await this.renderObjects();
          this.shareCapture = await this.display.capturePng(0, 0, {
            overlay: this.game.config.get('TWITTER.OVERLAP_IMAGE')?.split('"')[1],
          });
          break;
        case 165: // 1.1.102.1 (0x635b30) frees the separate mode-5 capture.
          this.shareCapture = undefined;
          break;
        case 118:
          this.backlog.length = 0;
          break;
        case 162:
          return this.lastSelectionMessage;
        default:
          return undefined;
      }
      return 0;
    }
    if (root === 40 && member === -1 && path.length === 4) {
      const id = path[2]!;
      const operation = path[3]!;
      if (operation === 6 || operation === 8) {
        // 1.1.102.1 (0x533c17 -> 0x64b4f0) yields to the frame loop while waiting.
        // A newly enabled object, such as the staff roll, must be drawn first.
        await this.renderObjects();
        const elapsed = this.counter(this.sceneCounters, id, 1, []) ?? 0;
        return this.delay(n(0) - Number(elapsed), operation === 8);
      }
      return this.counter(this.sceneCounters, id, operation, args);
    }
    if ((root === 37 || root === 38) && member === 2) return this.objectCommand({...command, path});
    if (root === 38 && member === 3) {
      if (path[2] === -1 && path.length === 5 && path[4] === 8) {
        this.display.setMessageTextColor(args.length ? n(0) : -1, path[3]);
        return 0;
      }
      if (path[2] === -1 && path.length === 5 && path[4] === 1) {
        if (path[3] === this.display.messageWindow)
          this.display.openMessage(this.messageAnimation('open', path[3]!));
        return 0;
      }
      if (path[2] === -1 && path.length === 5 && path[4] === 2) {
        this.messageFaces.delete(path[3]!);
        if (path[3] !== this.display.messageWindow) return 0;
        const anime = this.messageAnimation('close', path[3]!);
        if (anime.type > 0 && anime.time > 0) {
          await this.display.closeMessageWithAnimation(anime);
        } else this.display.closeMessage();
        this.pageVoices = [];
        this.pendingText = false;
        return 0;
      }
      if (path[2] === -1 && path.length === 5 && (path[4] === 33 || path[4] === 39)) {
        // 1.1.102.1 0x529122 and 0x529164 read the configured timings before script overrides.
        return parseMwndAnimation(this.game.config, path[3]!, path[4] === 33 ? 'open' : 'close').time;
      }
      if (path[2] === -1 && path.length === 5 && (path[4] === 34 || path[4] === 42)) {
        const index = path[3]!;
        const settings = this.messageOpenAnimations.get(index) ?? {};
        if (path[4] === 34) settings.time = n(0);
        if (path[4] === 42) delete settings.time;
        if (settings.type === undefined && settings.time === undefined)
          this.messageOpenAnimations.delete(index);
        else this.messageOpenAnimations.set(index, settings);
        return 0;
      }
      if (path[2] === -1 && path.length === 5 && (path[4] === 81 || path[4] === 82)) {
        // 1.1.141.3 routes member 82 through the configured filter reset at 0x5f41d0.
        const file = path[4] === 81 ? s(0) : '';
        if (file) this.messageFilterFiles.set(path[3]!, file);
        else this.messageFilterFiles.delete(path[3]!);
        await this.display.setMessageFilterFile(path[3]!, file);
        return 0;
      }
      if (path[2] === -1 && path.length === 5 && path[4] === 78) {
        const file = s(0);
        if (file) this.messageFrameFiles.set(path[3]!, file);
        else this.messageFrameFiles.delete(path[3]!);
        await this.display.setMessageFrameFile(path[3]!, file);
        return 0;
      }
      if (path[2] === -1 && path.length === 5 && [35, 43, 44, 45].includes(path[4]!)) {
        const index = path[3]!;
        const settings = this.messageCloseAnimations.get(index) ?? {};
        if (path[4] === 35) settings.time = n(0);
        if (path[4] === 44) delete settings.time;
        if (path[4] === 45) settings.type = n(0);
        if (path[4] === 43) delete settings.type;
        if (settings.type === undefined && settings.time === undefined)
          this.messageCloseAnimations.delete(index);
        else this.messageCloseAnimations.set(index, settings);
        return 0;
      }
      if (path[4] === 30 || path[4] === 53) return this.objectCommand(command);
      if (path.length === 6 && path[2] === -1 && path[4] === 32 && path[5] === 3) {
        // 1.1.141.3 0x555122 -> 0x559200 @ 0x559315 returns the configured button count for this MWND.
        return this.display.messageButtonCount(path[3]!);
      }
      if (path.length === 8 && path[2] === -1 && path[4] === 32 && path[5] === -1 && path[7] === 124) {
        return this.display.messageButtonPointerState(path[3]!, path[6]!);
      }
      if (path.length === 9 && path[2] === -1 && path[4] === 32 && path[5] === -1 &&
          (path[7] === 51 || path[7] === 64)) {
        // The MWND button receiver delegates X/Y to object integer events (0x555122).
        const window = path[3]!;
        const button = path[6]!;
        const axis = path[7] === 51 ? 'x' : 'y';
        if (path[8] === 5) return Number(this.display.messageButtonPositionEventActive(window, button, axis));
        if (path[8] === 0 || path[8] === 7) {
          this.display.offsetMessageButton(window, button, axis, n(0), {
            duration: Math.max(0, n(1)),
            delay: Math.max(0, n(2)),
            easing: eventEasing(n(3)),
            fill: 'backwards',
          });
          return 0;
        }
      }
      if (path.length === 9 && path[8] === 2) {
        const offsets = this.messageButtonList(path);
        if (offsets) {
          offsets.length = Math.max(0, n(0));
          this.updateMessageButton(path, offsets);
          return 0;
        }
      }
      if (
        path.length === 11 &&
        path[8] === -1 &&
        path[10] === 0 &&
        (path[7] === 112 || path[7] === 113)
      ) {
        const offsetPath = [...path.slice(0, 7), path[7] === 112 ? 54 : 63];
        const offsets = this.messageButtonList(offsetPath);
        if (offsets) {
          offsets[path[9]!] = n(0);
          const duration = Math.max(0, n(1));
          this.updateMessageButton(
            offsetPath,
            offsets,
            duration > 0
              ? {
                  duration,
                  delay: n(2),
                  easing: eventEasing(n(3)),
                  fill: 'backwards',
                }
              : undefined,
          );
          return 0;
        }
      }
    }
    if (root === 65) {
      if (member === 13 && path.length === 3) {
        const operation = path[2];
        if (operation === 98 || operation === 99) {
          // The EXCALL override belongs to its own native context (0x54d31e–0x54d348).
          this.excallJoypadModeOverride = operation === 98 ? n(0) | 0 : -1;
          return 0;
        }
        if (operation === 100) return this.excallJoypadModeOverride;
        // Native 1.1.141.3 0x54d24e (jump table 0x54d42c, excall.script font overrides):
        // 0x57=set_font_name, 0x58=get_font_name, 0x59=init_font_name,
        // 0x5a=set_font_futoku, 0x5b=init_font_futoku, 0x5c=get_font_futoku,
        // 0x5d=set_font_shadow, 0x5e=init_font_shadow, 0x5f=get_font_shadow
        const font = (this.systemFont ??= {});
        switch (path[2]) {
          case 87:
            font.name = s(0);
            return 0;
          case 88:
            return font.name ?? '';
          case 89:
            font.name = undefined;
            return 0;
          case 90:
            font.bold = n(0) | 0;
            return 0;
          case 91:
            font.bold = undefined;
            return 0;
          case 92:
            return font.bold ?? -1;
          case 93:
            font.shadow = n(0) | 0;
            return 0;
          case 94:
            font.shadow = undefined;
            return 0;
          case 95:
            return font.shadow ?? -1;
        }
      }
      if (member === 6 && path.length === 5 && path[2] === -1) {
        const id = path[3]!;
        const operation = path[4]!;
        if (operation === 6 || operation === 8) {
          await this.renderObjects();
          const elapsed = this.counter(this.systemCounters, id, 1, []) ?? 0;
          return this.delay(n(0) - Number(elapsed), operation === 8);
        }
        return this.counter(this.systemCounters, id, operation, args);
      }
      if ((member === 1 || member === 2) && path[2] === 6 && path.length === 6 && path[3] === -1) {
        const group = 100_000 + path[4]!;
        if (path[5] === 0 || path[5] === 1) return this.selectGroup(group, path[5] === 1);
        return this.groupCommand(group, path[5]!);
      }
      if (path.length === 3 && (member === 1 || member === 2) && path[2] === 2) return undefined;
      if ((member === 1 || member === 2) && path[2] === 2)
        return this.objectCommand({...command, path});
      if (path.length === 2 && member === 8) return Number(this.excallAllocated);
      if (path.length === 2 && member === 12) {
        // 1.1.102.1 (0x522300): the system-call flag differs from EXCALL allocation.
        return Number(this.systemCallActive);
      }
      if (path.length === 2 && member === 4) {
        this.excallAllocated = true;
        this.systemObjects = new Map();
        this.systemBackObjects = new Map();
        this.excallFlags.clear();
        return 0;
      }
      if (path.length === 2 && member === 5) {
        this.releaseSystemObjects();
        this.systemFont = undefined;
        return 0;
      }
    }
    if (root === 38 && member === 6 && path.length === 5 && path[2] === -1) {
      if (path[4] === 0 || path[4] === 1) return this.selectGroup(path[3]!, path[4] === 1);
      return this.groupCommand(path[3]!, path[4]!);
    }
    if (root === 37 && member === 6 && path.length === 5 && path[2] === -1) {
      // Both pages use 0x566580 and 0x5668e0. The back page has independent groups.
      const group = path[3]!;
      const operation = path[4];
      if (operation === 2 || operation === 10) {
        this.backButtonGroups.set(group, operation === 10);
        return 0;
      }
      if (operation === 4 || operation === 5) {
        this.backButtonGroups.delete(group);
        return 0;
      }
      if (operation === 3) return -2;
      if (operation === 6 || operation === 7) return -1;
    }
    if (root === 63) {
      // 1.1.141.3 reads the configured normal and quick slot counts directly.
      if (member === 68) return Number(this.game.config.get('SAVE.CNT') ?? 0);
      if (member === 168) return Number(this.game.config.get('QUICK_SAVE.CNT') ?? 0);
      if (member === 208) return Number(this.autoSkipEnabled);
      // Getter for the message-window hide permission set by syscom 223 (0x56a40a).
      if (member === 224) return Number(this.hideMwndEnabled);
      if (member !== undefined && member >= 237 && member <= 241) {
        // Menu presence and availability are independent native flags (0x56a7fe–0x56a87d).
        const [visible = '1', enabled = '1'] = this.game.config.get('SYSCOMMENU.RETURN_MENU')?.split(',') ?? [];
        const flags = (this.returnMenuState ??= [Number(enabled) !== 0, Number(visible) !== 0]);
        if (member === 241) return Number(flags[0] && flags[1]);
        const index = member < 239 ? 0 : 1;
        if (member === 238 || member === 240) return Number(flags[index]);
        flags[index] = Boolean(n(0));
        return 0;
      }
      if (member === 329) return Number(this.historyOpen);
      // Native 0x62f510 tests the input mode in the current context.
      if (member === 333) return Number(this.joypadModeActive());
      if (member === 334) {
        // 1.1.141.3 opens cfg_wnd_solo_joypad, resource 302 (0x56c1da, 0x54c760).
        await this.configuration.joypad(this.joypad.settings, (settings) => {
          this.joypad.settings = settings;
          this.persistOptions();
        });
        this.display.stage.focus({preventScroll: true});
        return 0;
      }
      if (member === 300) {
        this.localExtraSwitches.set(n(0), Number(Boolean(n(1))));
        return 0;
      }
      if (member === 301) return this.localExtraSwitches.get(n(0)) ?? 0;
      if (member === 14 || member === 15 || member === 17) {
        const slot = n(0);
        if (member === 17) return Number(this.globalExtraSwitch(slot));
        if (member === 15) this.globalExtraSwitches.delete(slot);
        else this.globalExtraSwitches.set(slot, Boolean(n(1)));
        this.persistOptions();
        for (const watcher of messageFrameWatchers)
          if (watcher.slot === slot && this.game.pack.commandNames.includes(watcher.command))
            this.pendingFrameWatchers.add(watcher);
        return 0;
      }
      const sceneKeys = ['CANCEL_SCENE', 'SAVE_SCENE', 'LOAD_SCENE', 'CONFIG_SCENE'] as const;
      const sceneKey = member === undefined ? undefined : sceneKeys[member];
      if (sceneKey && (member !== 0 || this.game.config.has(sceneKey))) {
        // 1.1.141.3 system-menu dispatch reads CANCEL_SCENE at 0x66b719.
        await this.callSystemScene(sceneKey);
        return 0;
      }
      if (member === 4 || member === 99) {
        this.screenSettings.fullscreen =
          member === 4 ? Boolean(n(0)) : this.defaultScreenSettings.fullscreen;
        this.screenSettings.fullscreenLayout = this.windowDisplay.fullscreenLayout;
        this.applyScreenSettings();
        this.persistOptions();
        return 0;
      }
      if (member === 9) return Number(this.windowDisplay.isExpanded);
      if (member === 138) {
        await this.configuration.screen(
          {
            ...this.screenSettings,
            fullscreen: this.windowDisplay.isExpanded,
            fullscreenLayout: this.windowDisplay.fullscreenLayout,
          },
          this.defaultScreenSettings,
          (settings) => {
            this.screenSettings = settings;
            this.applyScreenSettings();
            this.persistOptions();
          },
        );
        this.display.stage.focus({preventScroll: true});
        return 0;
      }
      if (member === 140) {
        // 1.1.102.1 (0x540cf6): Ccfg_wnd_solo_automode opens dialog resource 115.
        await this.configuration.autoMode(this.playback, this.playbackDefaults, playbackLimits, (settings) => {
          this.playback.autoCharacterWait = settings.autoCharacterWait;
          this.playback.autoMinimumWait = settings.autoMinimumWait;
          this.persistOptions();
        });
        this.display.stage.focus({preventScroll: true});
        return 0;
      }
      if (member === 142) {
        await this.configuration.font(
          this.messageFont,
          this.defaultMessageFont,
          this.display.fontChoices,
          (settings) => {
            this.messageFont = settings;
            this.applyMessageFont();
            this.persistOptions();
          },
        );
        this.display.stage.focus({preventScroll: true});
        return 0;
      }
      if (member === 167) {
        this.moviePlayer = await this.configuration.moviePlayer(this.moviePlayer);
        this.persistOptions();
        this.display.stage.focus({preventScroll: true});
        return 0;
      }
      if (member === 283) {
        this.messageFont.name = s(0);
        this.applyMessageFont();
        this.persistOptions();
        return 0;
      }
      if (member === 284) return this.messageFont.name;
      if (member === 298) {
        this.messageFont.bold = this.defaultMessageFont.bold;
        this.applyMessageFont();
        this.persistOptions();
        return 0;
      }
      if (member === 299) {
        this.messageFont.shadow = this.defaultMessageFont.shadow;
        this.applyMessageFont();
        this.persistOptions();
        return 0;
      }
      if (member === 69 || member === 169)
        return Number(Boolean(member === 69 ? this.saveSlot(n(0)) : this.quickSaves.get(n(0))));
      if (member === 79 || member === 170)
        return this.newestSlot(
          member === 79 ? this.saves : this.quickSaves,
          n(0),
          args.length > 1 ? n(1) : Infinity,
        );
      if (member === 252) return Number(this.saveEnabled);
      // Siglus 1.1.102.1 0x634b90 also requires an available save checkpoint.
      if (member === 255) return Number(this.saveEnabled && Boolean(this.savePoint));
      if (member === 259 || member === 262) return Number(this.loadEnabled);
      const slot = this.saveSlot(n(0));
      const quick = this.quickSaves.get(n(0));
      if (member === 78 || member === 179) return (member === 78 ? slot : quick)?.title ?? '';
      if (member === 320) return slot ? (slot.appendDir ?? this.game.appendDir ?? '') : '';
      if (member === 321) return slot ? (slot.appendName ?? this.game.appendName ?? '') : '';
      if (member === 180 || member === 181) {
        const save = member === 180 ? slot : quick;
        if (save) {
          const [slots, index] =
            member === 180 ? this.saveSlotAddress(n(0)) : ([this.quickSaves, n(0)] as const);
          await this.writeSlot(slots, index, {...save, comment: s(1)});
        }
        return 0;
      }
      if (member === 131 || member === 132) return (member === 131 ? slot : quick)?.comment ?? '';
      if (member === 129 || member === 130 || member === 324 || member === 325) {
        const message = (member === 129 || member === 324 ? slot : quick)?.message;
        return (message?.text.map(({text}) => text).join('') ?? '').replace(/[\r\n]+/g, '');
      }
      if (
        member !== undefined &&
        ((member >= 70 && member <= 77) || (member >= 171 && member <= 178))
      ) {
        const save = member <= 77 ? slot : quick;
        if (save?.timestamp === undefined) return 0;
        const date = new Date(save.timestamp);
        return [
          date.getFullYear(),
          date.getMonth() + 1,
          date.getDate(),
          date.getDay(),
          date.getHours(),
          date.getMinutes(),
          date.getSeconds(),
          date.getMilliseconds(),
        ][member - (member <= 77 ? 70 : 171)]!;
      }
      if (member === 19 || member === 65) {
        const [slots, index] =
          member === 19 ? this.saveSlotAddress(n(0)) : ([this.quickSaves, n(0)] as const);
        if (!slots.has(index)) return 0;
        await this.updateSlots(slots, [[index, undefined]]);
        return 1;
      }
      if (member === 22 || member === 66) {
        // 1.1.141.3 0x56be3f -> 0x662780 swaps any two distinct indices in the unified slot space.
        const [slots, first] =
          member === 22 ? this.saveSlotAddress(n(0)) : ([this.quickSaves, n(0)] as const);
        const [other, second] =
          member === 22 ? this.saveSlotAddress(n(1)) : ([this.quickSaves, n(1)] as const);
        if (slots === other && first === second) return 0;
        const source = slots.get(first);
        const target = other.get(second);
        if (!source && !target) return 0;
        if (slots === other) {
          await this.updateSlots(slots, [
            [first, target],
            [second, source],
          ]);
        } else {
          await this.updateSlots(slots, [[first, target]]);
          await this.updateSlots(other, [[second, source]]);
        }
        return 1;
      }
      if (member === 67 || member === 128) {
        // 1.1.141.3 0x56be21/0x56be75 -> 0x6624f0 copies across the unified slot space.
        const [srcSlots, srcIndex] =
          member === 67 ? this.saveSlotAddress(n(0)) : ([this.quickSaves, n(0)] as const);
        const [dstSlots, dstIndex] =
          member === 67 ? this.saveSlotAddress(n(1)) : ([this.quickSaves, n(1)] as const);
        if (srcSlots === dstSlots && srcIndex === dstIndex) return 0;
        const save = srcSlots.get(srcIndex);
        if (!save) return 0;
        await this.writeSlot(dstSlots, dstIndex, save);
        return 1;
      }
      if (member === 249 || member === 18) {
        if (!this.saveEnabled || !this.savePoint) return 0;
        // In 1.1.102.1 the absolute save index can also address quick slots
        // (0x633260); the quick-save command adds the regular slot count (0x633360).
        const [slots, index] =
          member === 249 ? this.saveSlotAddress(n(0)) : ([this.quickSaves, n(0)] as const);
        await this.writeSlot(slots, index, {
          ...this.savePoint,
          timestamp: Date.now(),
          comment: slots.get(index)?.comment,
        });
        this.root.dataset.savedPage = String(this.pages);
        // Both save commands play SE.004 when the sound flag is set.
        if (n(2)) await this.playSystemSound(4);
        return 1;
      }
      if (member === 256 || member === 20) {
        const save = member === 256 ? slot : quick;
        if (save && this.loadEnabled) {
          // Native tnm_syscom_load (0x661c20 @ 0x661cc4) & tnm_syscom_quick_load (0x661e70 @ 0x661f1a):
          // when args[2] (se_flag) is non-zero, play SE.005 (_sys005_load) after playback reset.
          this.pendingLoadSound = Boolean(n(2));
          if (this.systemCallActive) {
            this.selectedSave = save;
            this.vm.returnFromHostScene();
          } else this.loadSave(save);
        }
        return 0;
      }
      for (const [index, [set, reset, get]] of filterCommands.entries()) {
        if (member === get) return this.filterColor[index]!;
        if (member === set || member === reset) {
          const value =
            member === set ? Math.max(0, Math.min(255, n(0))) : this.filterDefaults[index]!;
          if (value !== this.filterColor[index]) {
            this.filterColor[index] = value;
            this.display.setMessageFilter(this.filterColor);
            this.persistOptions();
          }
          return 0;
        }
      }
      for (const [option, set, reset, get] of systemOptions) {
        if (member === get) return Number(this.systemOption(option));
        if (member === set || member === reset) {
          this.setSystemOption(option, member === set ? Boolean(n(0)) : undefined);
          return 0;
        }
      }
      if (member === 48) return this.playback.messageSpeed;
      if (member === 50) return Number(this.playback.messageNowait);
      if (member === 46 || member === 47) {
        this.setPlaybackOption(
          'messageSpeed',
          member === 46
            ? Math.max(0, Math.min(playbackLimits.messageSpeed, n(0)))
            : this.playbackDefaults.messageSpeed,
        );
        return 0;
      }
      if (member === 49 || member === 107) {
        this.setPlaybackOption(
          'messageNowait',
          member === 49 ? Boolean(n(0)) : this.playbackDefaults.messageNowait,
        );
        return 0;
      }
      for (const [kind, set, reset, get] of soundLevels) {
        if (member === get) return this.audio.level(kind);
        if (member === set || member === reset) {
          this.audio.setLevel(kind, member === set ? n(0) : undefined);
          return 0;
        }
      }
      for (const [kind, set, reset, get] of soundSwitches) {
        if (member === get) return Number(this.audio.enabled(kind));
        if (member === set || member === reset) {
          this.audio.setEnabled(kind, member === reset || Boolean(n(0)));
          return 0;
        }
      }
      if (member === 182 || member === 185) {
        // Native 0x568857 offsets quick slots into the shared range used at 0x652bb0.
        const firstQuick = Number(this.game.config.get('SAVE.CNT') ?? 0);
        const [slots, slotIndex] = this.saveSlotAddress(n(0) + (member === 185 ? firstQuick : 0));
        const listRef = args[1];
        const ofs = Math.max(0, n(2));
        const cnt = Math.max(0, Math.min(256, n(3)));
        const existing = slots.get(slotIndex);
        if (existing && Array.isArray(listRef)) {
          const values = this.vm.readIntList(listRef as readonly number[], ofs, cnt);
          const custom = [...(existing.customValues ?? [])];
          for (let i = 0; i < values.length; i++) custom[i] = values[i]!;
          await this.writeSlot(slots, slotIndex, {...existing, customValues: custom});
        }
        return 0;
      }
      if (member === 183) {
        // Native 0x567f2e leaves the destination alone if the slot header could not be read.
        const listRef = args[1];
        const ofs = Math.max(0, n(2));
        const cnt = Math.max(0, Math.min(256, n(3)));
        if (slot && Array.isArray(listRef)) {
          const custom = slot.customValues ?? [];
          const out = Array.from({length: cnt}, (_, i) => custom[i] ?? 0);
          this.vm.writeIntList(listRef as readonly number[], ofs, out);
        }
        return 0;
      }
      if (member === 194) {
        this.msgBackEnabled = Boolean(n(0));
        return 0;
      }
      if (member === 198) {
        // syscom.check_msg_back_enable (0x661640)
        return Number(
          this.msgBackEnabled &&
            !this.scriptMsgBackDisabled &&
            this.backlog.length > 0 &&
            !this.systemCallActive,
        );
      }
      if (member === 207) {
        this.autoSkipEnabled = Boolean(n(0));
        return 0;
      }
      if (member === 228) {
        // syscom.return_to_sel(warning_flag, se_flag, fade_flag) (0x662410)
        const target = this.selectionSaves.pop();
        if (!target) return 0;
        if (n(1)) await this.playSystemSound(7);
        if (this.systemCallActive) {
          this.selectedSave = target;
          this.vm.returnFromHostScene();
        } else {
          this.loadSave(target);
        }
        return 0;
      }
      if (member === 200) {
        this.readSkipEnabled = Boolean(n(0));
        return 0;
      }
      if (member === 310) {
        // 1.1.137.0 (0x5677fc -> 0x661cc0) plays SE.005 after restoration when se_flag is set.
        if (this.historyTarget) {
          this.pendingLoadSound = Boolean(n(1));
          if (this.systemCallActive) {
            this.selectedSave = this.historyTarget;
            this.vm.returnFromHostScene();
          } else {
            this.loadSave(this.historyTarget);
          }
          return 1;
        }
        return 0;
      }
      if (member === 192) {
        await this.openHistory();
        return 0;
      }
      if (member === 201) return Number(this.readSkipEnabled);
      if (member === 206)
        return Number(this.skipAllowed && (this.pageAlreadyRead || this.skipUnread));
      if (member === 236) {
        // Native 0x649e80 resolves the scene name and starts a system call
        // at entry zero or the supplied index, with only int/string arguments.
        const scene = this.game.pack.sceneNames.find((name) => name.toLowerCase() === s(0).toLowerCase());
        if (!scene) return 0;
        const values = args[2];
        const parameters = Array.isArray(values)
          ? values.filter((value) => typeof value === 'number' || typeof value === 'string')
          : [];
        await this.runSystemScene(scene, n(1), parameters);
        return 1;
      }
      if (member === 230 || member === 232) {
        this.selectionReturnFlags[member === 230 ? 0 : 1] = Boolean(n(0));
        return 0;
      }
      if (member === 231 || member === 233)
        return Number(this.selectionReturnFlags[member === 231 ? 0 : 1]);
      // 1.1.102.1 (0x6356f0) tests both flags and the saved selection stack.
      if (member === 234)
        return Number(this.selectionReturnFlags.every(Boolean) && this.selectionSaves.length > 0);
      if (member === 213) return 0;
      if (member === 220 || member === 227) return 1;
      if (member === 221) {
        this.setUserMessageHidden(Boolean(n(0)));
        return 0;
      }
      if (member === 222) return Number(this.userMessageHidden);
      if (member === 148 || member === 149) {
        this.voiceMode = member === 148 ? n(0) : 0;
        return 0;
      }
      if (member === 150) return this.voiceMode;
      if (member === 277 || member === 278) {
        this.audio.setSoundLevel(n(0), member === 277 ? n(1) : undefined);
        return 0;
      }
      if (member === 279) return this.audio.soundLevel(n(0));
      if (member === 145) return Number(this.audio.characterEnabled(n(0)));
      if (member === 188) return this.audio.characterLevel(n(0));
      if (member === 143 || member === 144) {
        this.audio.setCharacterEnabled(n(0), member === 144 || Boolean(n(1)));
        return 0;
      }
      if (member === 186 || member === 187) {
        this.audio.setCharacterLevel(n(0), member === 186 ? n(1) : undefined);
        return 0;
      }
      if (member === 96) return this.playback.voiceDuckLevel;
      if (member === 98) return Number(this.playback.voiceDuckEnabled);
      if (member === 94 || member === 95) {
        this.setPlaybackOption(
          'voiceDuckLevel',
          member === 94
            ? Math.max(0, Math.min(playbackLimits.voiceDuckLevel, n(0)))
            : this.playbackDefaults.voiceDuckLevel,
        );
        this.applyVoiceDuck();
        return 0;
      }
      if (member === 97 || member === 106) {
        this.setPlaybackOption(
          'voiceDuckEnabled',
          member === 97 ? Boolean(n(0)) : this.playbackDefaults.voiceDuckEnabled,
        );
        this.applyVoiceDuck();
        return 0;
      }
      if (member === 214) {
        this.autoEnabled = Boolean(n(0));
        return 0;
      }
      if (member === 215) return Number(this.autoEnabled);
      if (member === 53) return this.playback.autoCharacterWait;
      if (member === 56) return this.playback.autoMinimumWait;
      if (member === 51 || member === 52) {
        this.setPlaybackOption(
          'autoCharacterWait',
          member === 51
            ? Math.max(0, Math.min(playbackLimits.autoCharacterWait, n(0)))
            : this.playbackDefaults.autoCharacterWait,
        );
        return 0;
      }
      if (member === 54 || member === 55) {
        this.setPlaybackOption(
          'autoMinimumWait',
          member === 54
            ? Math.max(0, Math.min(playbackLimits.autoMinimumWait, n(0)))
            : this.playbackDefaults.autoMinimumWait,
        );
        return 0;
      }
      if (member === 152 || member === 162) {
        this.voiceSpeedRate = member === 152 ? Math.max(100, Math.min(300, n(0) | 0)) : 100;
        this.persistOptions();
        return 0;
      }
      if (member === 163) return this.voiceSpeedRate;
      if (member !== undefined && member >= 153 && member <= 161) {
        const index = Math.trunc((member - 153) / 3);
        const op = (member - 153) % 3;
        if (op === 2) return Number(this.voiceSpeedSwitches[index]);
        this.voiceSpeedSwitches[index] = op === 0 ? Boolean(n(0)) : false;
        this.persistOptions();
        return 0;
      }
      if (member === 269) {
        const endCount = Number(this.game.config.get('END_SAVE.CNT') ?? 0);
        const endSave = endCount > 0 ? this.endSaves.get(0) : undefined;
        if (!endSave || !this.loadEnabled) return 0;
        // End-load takes warning, sound, and transition flags (1.1.141.3 at 0x66c480).
        this.pendingLoadSound = Boolean(n(1));
        if (this.systemCallActive) {
          this.selectedSave = endSave;
          this.vm.returnFromHostScene();
        } else this.loadSave(endSave);
        return 0;
      }
      if (member === 270) {
        const endCount = Number(this.game.config.get('END_SAVE.CNT') ?? 0);
        const index = n(0) | 0;
        return Number(index >= 0 && index < endCount && this.endSaves.has(index));
      }
      if (member === 271) {
        const endCount = Number(this.game.config.get('END_SAVE.CNT') ?? 0);
        if (endCount <= 0 || !this.saveEnabled || !this.savePoint) return 0;
        await this.writeSlot(this.endSaves, 0, {...this.savePoint, timestamp: Date.now()});
        if (n(1)) await this.playSystemSound(4);
        return 1;
      }
      if (member !== undefined && member >= 272 && member <= 276) {
        // The inner-save receiver uses a separate, in-memory array (0x56aeaf–0x56b08b).
        const count = Number(this.game.config.get('INNER_SAVE.CNT') ?? 0);
        const index = n(0) | 0;
        const valid = index >= 0 && index < count;
        const save = valid ? this.innerSaves.get(index) : undefined;
        if (member === 272) {
          if (valid && this.savePoint) this.innerSaves.set(index, {...this.savePoint});
          return 1;
        }
        if (member === 273) {
          if (!save || !this.loadEnabled) return 0;
          this.pendingLoadSound = Boolean(n(2));
          if (this.systemCallActive) {
            this.selectedSave = save;
            this.vm.returnFromHostScene();
          } else this.loadSave(save);
          return 1;
        }
        if (member === 274) {
          const destination = n(1) | 0;
          if (valid && destination >= 0 && destination < count) {
            if (save) this.innerSaves.set(destination, save);
            else this.innerSaves.delete(destination);
          }
          return 1;
        }
        if (member === 275) return Number(Boolean(save));
        if (valid) this.innerSaves.delete(index);
        return 1;
      }
      if (member === 242) {
        void this.dispose();
        return 0;
      }
      if (member === 235) {
        // 1.1.102.1 plays SE.006 for Return to Title (0x63579d).
        if (n(1)) await this.playSystemSound(6);
        for (const active of this.pcmEvents.values()) active.cancel();
        this.pcmEvents.clear();
        this.frameActions.clear();
        this.frameActionCounters.clear();
        this.pendingButtonCalls.length = 0;
        this.lastSelectionMessage = '';
        // Native 0x6321f0 -> 0x5bb740: reinit G_excall and modal state on return_to_menu.
        this.releaseSystemObjects();
        this.activeGroups.clear();
        this.cancelGroups.clear();
        this.backButtonGroups.clear();
        this.decisions.clear();
        this.display.syncObjectButtonGroups(this.activeGroups);
        this.timeStopped = false;
        this.userMessageHidden = false;
        this.messageHidden = false;
        this.mwndBtnTouchEnabled = true;
        this.mouseCursorNo = 0;
        this.display.setScenePaused(false);
        this.display.setMessageDisplayed(true);
        this.display.stage.style.cursor = '';
        this.messageFilterFiles.clear();
        this.display.clearMessageFilterFiles();
        this.messageFrameFiles.clear();
        this.display.clearMessageFrameFiles();
        this.display.closeMessage();
        this.pendingText = false;
        this.readSkipEnabled = this.autoEnabled = false;
        this.scriptHistoryRecordingDisabled = this.scriptAutoSavePointDisabled = false;
        this.savePoint = undefined;
        this.sceneCounters.clear();
        this.vm.returnToMenu();
      }
      if (member === 11 || member === 12) {
        if (!args.length) {
          this.messageButtonsEnabled = member === 11;
          if (member === 11) this.disabledMessageButtons.clear();
        } else if (member === 11) this.disabledMessageButtons.delete(n(0));
        else this.disabledMessageButtons.add(n(0));
        return 0;
      }
      if (member === 286) {
        // 1.1.102.1 (0x5eddb0) allocates the mode-4 targets at the requested dimensions.
        const width = n(0) | 0;
        const height = n(1) | 0;
        this.captureSize = width > 0 && height > 0 && width * height <= 16_777_216 ? [width, height] : undefined;
        this.captureBuffer = undefined;
        return 0;
      }
      if (member === 287) {
        this.captureSize = undefined;
        this.captureBuffer = undefined;
        return 0;
      }
      if (member === 316) {
        if (this.objectsDirty) await this.renderObjects();
        this.captureBuffer = await this.display.capturePng(n(0) | 0, n(1) | 0, {size: this.captureSize});
        return 0;
      }
      if (member === 290) {
        // 1.1.102.1 (0x635c50 -> 0x5e7ca0) writes a translated stage PNG
        // to the capture folder. The browser owns that folder in game storage.
        const capture = await this.storeCapture(`${s(2)}.png`, n(0) | 0, n(1) | 0,
          this.captureSize ? {size: this.captureSize} : undefined);
        if (capture) this.captureBuffer = capture;
        return 0;
      }
      if (member === 327) {
        // 1.1.102.1 (0x63cd20) opens the host's picture-sharing dialog for this capture.
        if (this.shareCapture) {
          await this.configuration.shareCapture(
            this.shareCapture, this.game.config.get('TWITTER.INITIAL_TWEET_TEXT')?.split('"')[1] ?? '',
          );
          this.display.stage.focus({preventScroll: true});
        }
        return 0;
      }
      if (member === 314 || member === 315)
        return this.captureFileCommand(member, args, command.named ?? []);
      if (systemFlags.has(member!)) {
        if (member === 6 || member === 7) this.systemMenuEnabled = member === 6;
        if (member === 133 || member === 134) this.mwndBtnTouchEnabled = member === 133;
        if (member === 223) this.hideMwndEnabled = Boolean(n(0));
        if (member === 251) this.saveEnabled = Boolean(n(0));
        if (member === 258) this.loadEnabled = Boolean(n(0));
        return 0;
      }
    }
    if (root === 64 && (member === 0 || member === 1)) {
      // 1.1.141.3 0x563365/0x563376 & 0x62f100: script auto mode (+0x355) is independent of user autoEnabled (+0x141).
      this.scriptAutoMode = member === 0;
      return 0;
    }
    if (root === 64 && member !== undefined && member >= 60 && member <= 65) {
      // 1.1.141.3 0x563387..0x5633fd & 0x62f130/0x62f160: script auto_mode_moji_wait (+0x358) & min_wait (+0x35c).
      if (member === 60) this.scriptAutoModeMojiWait = n(0) | 0;
      else if (member === 62) this.scriptAutoModeMojiWait = -1;
      else if (member === 64) return this.scriptAutoModeMojiWait;
      else if (member === 61) this.scriptAutoModeMinWait = n(0) | 0;
      else if (member === 63) this.scriptAutoModeMinWait = -1;
      else if (member === 65) return this.scriptAutoModeMinWait;
      return 0;
    }
    if (root === 64 && (member === 4 || member === 16)) {
      // 1.1.141.3 0x563692/0x5636ac & 0x5e9d8f: force MWND open animation (+0x37d).
      if (member === 4) this.scriptMwndOpenAnimeForce = Boolean(n(0));
      else return Number(this.scriptMwndOpenAnimeForce);
      return 0;
    }
    if (root === 64 && (member === 10 || member === 24)) {
      // 1.1.141.3 0x56380e/0x563828: script flag at +0x49a.
      if (member === 10) this.scriptFlag10 = Boolean(n(0));
      else return Number(this.scriptFlag10);
      return 0;
    }
    if (root === 64 && (member === 49 || member === 50)) {
      // 1.1.141.3 0x563853/0x563864 & 0x65c105: key-wait disable flag (+0x499).
      this.keyWaitDisabled = member === 49;
      return 0;
    }
    if (root === 64 && (member === 21 || member === 22)) {
      // 1.1.141.3 0x563511/0x563537: start/end persistent async_msg_mode (+0x375/+0x376).
      this.msgAsyncMode = member === 21;
      this.msgAsyncModeOnce = false;
      return 0;
    }
    if (root === 64 && member === 18) {
      // 1.1.141.3 0x5632db -> 0x62f000: is_skipping excluding read_skip.
      if (!this.skipAllowed) return 0;
      if (this.skip) return 1;
      return Number(!this.systemSkipDisabled && this.skipTriggerFired);
    }
    if (root === 64 && member !== undefined && member >= 83 && member <= 86) {
      // 1.1.141.3 0x563251..0x5632c8: get/set skip_disable (+0x350) and ctrl_disable (+0x351).
      if (member === 83) return Number(this.systemSkipDisabled);
      if (member === 84) return Number(!this.skipAllowed);
      if (member === 85) this.systemSkipDisabled = Boolean(n(0));
      if (member === 86) this.skipAllowed = !Boolean(n(0));
      return 0;
    }
    if (root === 64 && (member === 34 || member === 35)) {
      // 1.1.102.1 0x6235d4 suppresses recording while still displaying the message.
      this.scriptHistoryRecordingDisabled = member === 34;
      return 0;
    }
    if (root === 64 && (member === 38 || member === 39)) {
      // 1.1.102.1 0x622bf5 gates the automatic page save point; the explicit command still works.
      this.scriptAutoSavePointDisabled = member === 38;
      return 0;
    }
    if (root === 64 && (member === 6 || member === 7)) {
      this.skipAllowed = member === 7;
      return 0;
    }
    if (root === 64 && member === 66) {
      this.timeStopped = Boolean(n(0));
      this.display.setScenePaused(this.timeStopped);
      return 0;
    }
    if (root === 64 && member === 67) return Number(this.timeStopped);
    if (root === 64 && member !== undefined && member >= 87 && member <= 95) {
      // These values belong to the story script. EXCALL resolves its own
      // overrides against configured defaults in the native font resolver.
      const font = (this.scriptFont ??= {});
      switch (member) {
        case 87: // 0x563971
          font.name = s(0);
          break;
        case 88:
          return font.name ?? '';
        case 89:
          font.name = undefined;
          break;
        case 90:
          font.bold = n(0) | 0;
          break;
        case 91:
          font.bold = undefined;
          break;
        case 92:
          return font.bold ?? -1;
        case 93:
          font.shadow = n(0) | 0;
          break;
        case 94:
          font.shadow = undefined;
          break;
        case 95:
          return font.shadow ?? -1;
      }
      this.applyMessageFont();
      return 0;
    }
    if (root === 64 && member === 96) {
      // Native 0x5637c7 stores a boolean that member 97 reads at 0x5637d9.
      this.scriptFlag96 = Boolean(n(0));
      return 0;
    }
    if (root === 64 && member === 97) return Number(this.scriptFlag96);
    if (root === 64 && (member === 98 || member === 99)) {
      // 1.1.141.3 stores the override at 0x563a42 and resets it at 0x563a4f.
      // The joypad mode resolver at 0x62f510 uses -1 to defer to Gameexe.dat.
      this.joypadModeOverride = member === 98 ? n(0) | 0 : -1;
      return 0;
    }
    if (root === 64 && member === 100) return this.joypadModeOverride;
    if (root === 64 && member === 17) return Number(this.messageHidden);
    if (root === 64 && member === 8) {
      this.messageHidden = Boolean(n(0));
      this.display.setMessageDisplayed(!this.messageHidden && !this.userMessageHidden);
      return 0;
    }
    if (root === 64 && (member === 14 || member === 15)) {
      this.display.stage.style.cursor = member === 14 ? 'none' : '';
      return 0;
    }
    if (root === 64 && (member === 36 || member === 37)) {
      this.audio.setVoiceDuck(
        member === 36 && this.playback.voiceDuckEnabled ? this.playback.voiceDuckLevel : 255,
      );
      return 0;
    }
    if (root === 64 && member === 23) return Number(this.quakeStopped);
    if (root === 64 && member === 11) {
      this.quakeStopped = Boolean(n(0));
      return 0;
    }
    if (root === 64 && (member === 2 || member === 5)) {
      this.systemSkipDisabled = member === 2;
      return 0;
    }
    if (root === 64 && member === 3) {
      this.scriptMessageAnimationsDisabled = Boolean(n(0));
      return 0;
    }
    if (root === 20 && (member === 2 || member === 3)) return this.movie(s(0), member === 3);
    if (root === 64 && member === 19) {
      this.mouseMoveByKeyDisabled = true;
      return 0;
    }
    if (root === 64 && member === 76) {
      this.autoModeMojiCnt = n(0);
      return 0;
    }
    if (root === 64 && member === 74) {
      this.skipUnreadOverride = Boolean(n(0));
      return 0;
    }
    if (root === 64 && member === 75) return Number(this.skipUnread);
    if (root === 64 && (member === 25 || member === 27)) {
      // 1.1.102.1 (0x537091/0x5370a7) uses -1 to defer to the user's interval.
      this.speed = member === 25 ? n(0) | 0 : -1;
      return 0;
    }
    if (root === 64 && member === 26) return this.speed;
    if (root === 64 && member === 28) {
      // 1.1.102.1 (0x5370d1 -> 0x5f5df0) overrides the message reveal interval with zero.
      this.scriptMessageNowait = Boolean(n(0));
      return 0;
    }
    if (root === 64 && member === 29) return Number(this.scriptMessageNowait);
    if (root === 64 && (member === 40 || member === 41)) {
      // 1.1.102.1 writes the per-key suppression table at 0x537229/0x537255.
      // The input helper reads it only for calls that honor shortcut suppression.
      this.display.setShortcutKeyDisabled(n(0), member === 40);
      return 0;
    }
    if (root === 64 && member === 52) {
      // 1.1.141.3 0x563875 stores script.cursor_no read by 0x68cf29.
      this.mouseCursorNo = n(0) | 0;
      return 0;
    }
    if (root === 64 && member === 53) return this.mouseCursorNo;
    if (root === 64 && scriptFlags.has(member!)) {
      if (member === 12 || member === 13) this.scriptMsgBackDisabled = member === 12;
      if (member === 32 || member === 33) this.shortcutDisabled = member === 32;
      if (member === 48) {
        // 1.1.141.3 0x563842: arms skip_trigger (+0x378); only user advance input fires it.
        this.skipTriggerArmed = true;
      }
      if (member === 51) {
        // 1.1.141.3 0x563524: sets async_msg_mode (+0x375) and async_msg_mode_once (+0x376).
        this.msgAsyncMode = true;
        this.msgAsyncModeOnce = true;
      }
      if (member === 54 || member === 55) this.endMsgByKeyDisabled = member === 54;
      return 0;
    }
    if (root === 97 && member === -1 && path.length === 4)
      return this.display.editBox(path[2]!, path[3]!, n, s);
    if (root === 24) {
      // keylist (0x54efb0 -> 0x54f1c0)
      if (member === -1 && path.length === 4) {
        const key = path[2]!;
        const operation = path[3]!;
        if (key >= 0x402 && key <= 0x405) {
          const direction = key - 0x402;
          const keyboard = this.display.virtualKeyState([38, 40, 37, 39][direction]!, operation);
          const controller = this.joypadDirectionState(direction, operation);
          return controller === undefined ? keyboard : operation === 7 ? keyboard & controller : keyboard | controller;
        }
        return this.display.virtualKeyState(key, operation);
      }
      if (member === 0) {
        await this.waitAtPage();
        return 0;
      }
    }
    if (root === 145) {
      // msgbk (0x551590): 1=insert_msg, 2=go_next_msg, 3=add_msg, 4=add_koe, 5=add_namae
      const ensureLast = (): {
        name: string;
        text: {text: string; ruby?: string}[];
        voices: {id: number; character?: number}[];
      } => {
        const last = this.backlog.at(-1);
        if (last) {
          const mutable = {name: last.name, text: [...last.text], voices: [...last.voices]};
          const point = this.historyPoints.get(last);
          if (point) this.historyPoints.set(mutable, point);
          this.backlog[this.backlog.length - 1] = mutable;
          return mutable;
        }
        const created = {name: '', text: [] as {text: string; ruby?: string}[], voices: [] as {id: number; character?: number}[]};
        this.backlog.push(created);
        return created;
      };
      if (member === 1) {
        this.backlog.push({name: '', text: [{text: s(0)}], voices: []});
        return 0;
      }
      if (member === 2) {
        this.backlog.push({name: '', text: [], voices: []});
        return 0;
      }
      if (member === 3) {
        ensureLast().text.push({text: s(0)});
        return 0;
      }
      if (member === 4) {
        ensureLast().voices.push({id: n(0), character: args.length > 1 ? n(1) : undefined});
        return 0;
      }
      if (member === 5) {
        ensureLast().name = s(0);
        return 0;
      }
    }
    if (root === 86 && member === 2) {
      this.display.clearInput();
      return 0;
    }
    if (root === 86 && member === 3) {
      await this.nextInput(true);
      this.sampleInputNow();
      this.inputSampled = true;
      return 0;
    }
    if (root === 86 && (member === 0 || member === 1) && path.length === 3)
      return this.display.inputState(member, path[2]!);
    if (
      ((root === 37 || root === 38) && member === 4 && path[2] === -1 && path.length >= 5) ||
      (root === 70 && member === 31 && path[2] === -1 && path.length >= 5)
    ) {
      return this.effectCommand(`${root}.${path[3]}`, path.slice(4), args);
    }
    if (root === 70 && member === 9) {
      const idx = n(0) | 0;
      const raw = this.game.config.get(`SHAKE.${String(idx).padStart(3, '0')}`) ?? '';
      const steps: [number, number, number][] = [];
      for (const m of raw.matchAll(/\(\s*(-?\d+)\s*,\s*(-?\d+)\s*,\s*(\d+)\s*\)/g)) {
        steps.push([Number(m[1]), Number(m[2]), Number(m[3])]);
      }
      if (steps.length && !this.skipping && !this.quakeStopped) {
        const dur = this.display.startShakeSteps(-1, steps);
        if (dur > 0) await this.delay(dur, false);
      }
      return 0;
    }
    if (root === 70 && member === 25 && path[2] === -1 && path.length === 5) {
      // 1.1.102.1 screen.quake[] dispatches through 0x523ad0 to 0x5d3160/0x5d32c0/0x5d3420.
      const slot = path[3]!;
      const operation = path[4]!;
      if (operation === 8) {
        this.display.endShake(slot, n(0));
        return 0;
      }
      if (operation === 9) return Number(this.display.isQuakeActive(slot));
      if (operation === 10 || operation === 11) {
        const remaining = this.display.quakeRemainingMs(slot);
        if (remaining > 0 && !this.skipping) await this.delay(remaining, operation === 11);
        return 0;
      }
      if (operation >= 0 && operation <= 7) {
        const parameters = args.at(-1);
        if (!Array.isArray(parameters)) return undefined;
        const type = n(0);
        const period = n(1);
        const cycles = n(2);
        const decayCycles = args.length >= 5 ? n(3) : 0;
        if (this.skipping || this.quakeStopped) return 0;
        let duration = 0;
        if (type === 0) {
          // 0x5fcd00 start_vec: [power, vec_deg]
          const power = Number(parameters[0] ?? 0);
          const angle = (Number(parameters[1] ?? 0) * Math.PI) / 180;
          duration = this.display.startQuake(slot, period, cycles, decayCycles, power, [
            Math.cos(angle),
            Math.sin(angle),
          ]);
        } else if (type === 1) {
          // 0x5fce30 start_dir: [power, dir_idx]
          const directions = [
            [0, -1],
            [1, -1],
            [1, 0],
            [1, 1],
            [0, 1],
            [-1, 1],
            [-1, 0],
            [-1, -1],
          ] as const;
          const direction = directions[Number(parameters[1] ?? 0) & 7]!;
          duration = this.display.startQuake(
            slot,
            period,
            cycles,
            decayCycles,
            Number(parameters[0] ?? 0),
            direction,
          );
        } else if (type === 2) {
          // 0x5fcf60 start_zoom: [power, center_x, center_y]
          duration = this.display.startZoomQuake(
            slot,
            period,
            cycles,
            decayCycles,
            Number(parameters[0] ?? 0),
            Number(parameters[1] ?? 0),
            Number(parameters[2] ?? 0),
          );
        } else {
          return undefined;
        }
        const waitFlag = operation === 1 || operation === 2 || operation === 5 || operation === 6;
        const keyFlag = operation === 2 || operation === 6;
        if (waitFlag && duration > 0) await this.delay(duration, keyFlag);
        return 0;
      }
    }
    if (root === 79 && path.length === 2) {
      if (member === 2) {
        this.endFrameAction([79]);
        return 0;
      }
      if (member === 1 || member === 3) {
        this.startFrameAction([79], command.scene, n(0), s(1), args.slice(2), member === 3);
        return 0;
      }
    }
    if (root === 53 && member === -1 && path.length === 4) {
      const faPath = path.slice(0, 3);
      if (path[3] === 2) {
        this.endFrameAction(faPath);
        if (path[2] === this.messagePointerAction?.channel) {
          this.messagePointerAction = undefined;
          this.messagePointerChanged = false;
        }
        return 0;
      }
      if (
        path[3] === 1 &&
        n(0) === -1 &&
        s(1).toLowerCase() === 't_mwnd_btn_check' &&
        this.game.pack.scene(command.scene).commandNames.includes('t_mwnd_btn_check')
      ) {
        this.messagePointerAction = {
          channel: path[2]!,
          scene: command.scene,
          command: 't_mwnd_btn_check',
        };
        this.messagePointerChanged = true;
        return 0;
      }
      // Input events drive the frame watchers. The release player has no debug shortcuts.
      if (
        path[3] === 1 &&
        n(0) === -1 &&
        (messageFrameWatchers.some(({command}) => command === s(1)) ||
          s(1) === '$debug_key_shortcut')
      )
        return 0;
      if (path[3] === 1 || path[3] === 3) {
        this.startFrameAction(faPath, command.scene, n(0), s(1), args.slice(2), path[3] === 3);
        return 0;
      }
    }
    if (root === 92 && member === 0)
      return Number(!this.root.ownerDocument.hidden && this.root.ownerDocument.hasFocus());
    if (root === 92 && member === 6)
      return Number(
        this.game.files.has(
          s(0)
            .replace(/[\\/]+/g, '/')
            .toLowerCase(),
        ),
      );
    if (root === 92 && member === 12) {
      // 0x53e312 checks for a regular file relative to the capture folder.
      const key = this.captureFileKey(s(0));
      return key && this.saveStore ? Number((await this.saveStore.snapshot()).has(key)) : 0;
    }
    if (root === 92 && (member === 7 || member === 11 || member === 13 || member === 2)) return 0;
    if (root === 92 && member === 14 && args.length >= 8) {
      // Native 0x565925 GetLocalTime SYSTEMTIME order: (year, month, day, dayOfWeek, hour, min, sec, ms)
      const now = new Date();
      const values = [
        now.getFullYear(),
        now.getMonth() + 1,
        now.getDate(),
        now.getDay(),
        now.getHours(),
        now.getMinutes(),
        now.getSeconds(),
        now.getMilliseconds(),
      ];
      for (let i = 0; i < 8; i++) {
        const ref = args[i];
        if (Array.isArray(ref)) this.vm.assign(ref as readonly number[], values[i]!);
      }
      return 0;
    }
    // 1.1.141.3 converts FILETIME to Unix seconds at 0x763c74 and returns the low word.
    if (root === 92 && member === 15) return Math.floor(Date.now() / 1000) | 0;
    if (root === 105 && member === -1 && path.length === 4) {
      const db = await this.loadDatabase(path[2]!);
      if (path[3] === 0) return db ? db.getNum(n(0), n(1)) : 0;
      if (path[3] === 1) return db ? db.getStr(n(0), n(1)) : '';
      if (path[3] === 2) return db ? Number(db.hasRow(n(0))) : 0;
      if (path[3] === 3) return db ? db.checkColumn(n(0)) : 0;
    }
    if (root === 78) {
      // cgtable (CGTABLE / CGTABLE2, native 0x559a80)
      await this.loadCgTable();
      if (member === 1) {
        return this.cgTable.get(s(0).toLowerCase()) ?? -1;
      }
      if (member === 2) {
        const flagNo = this.cgTable.get(s(0).toLowerCase());
        if (flagNo === undefined) return -1;
        return Number(this.cgFlags.has(flagNo));
      }
      if (member === 3) {
        // cgtable.set_flag_value_by_name (0x67e980)
        const flagNo = this.cgTable.get(s(0).toLowerCase());
        if (flagNo !== undefined) {
          if (n(1)) this.cgFlags.add(flagNo);
          else this.cgFlags.delete(flagNo);
          localStorage.setItem(this.game.saveKey + ':cgtable', JSON.stringify([...this.cgFlags]));
        }
        return 0;
      }
      if (member === 4) return new Set(this.cgTable.values()).size;
      if (member === 5) return this.cgFlags.size;
      if (member === 6) {
        const total = new Set(this.cgTable.values()).size;
        const look = this.cgFlags.size;
        if (!total || !look) return 0;
        return Math.min(100, Math.max(1, Math.trunc((look * 100) / total)));
      }
      if (member === 7 || member === 8) return 0;
      if (member === 9) {
        if (n(0)) {
          for (const flagNo of this.cgTable.values()) this.cgFlags.add(flagNo);
        } else {
          this.cgFlags.clear();
        }
        localStorage.setItem(this.game.saveKey + ':cgtable', JSON.stringify([...this.cgFlags]));
        return 0;
      }
    }
    if (root === 123) {
      if (member === 0) {
        let count = 0;
        for (const key of this.game.config.keys()) if (/^BGM\.\d+$/.test(key)) count++;
        return count;
      }
      if (member === 1) {
        return Number(this.bgmListened.has(s(0).toLowerCase()));
      }
      if (member === 2) {
        const key = s(0).toLowerCase();
        if (n(1)) this.bgmListened.add(key);
        else this.bgmListened.delete(key);
        localStorage.setItem(this.game.saveKey + ':bgmtable', JSON.stringify([...this.bgmListened]));
        return 0;
      }
      if (member === 4) {
        // 1.1.141.3 at 0x5501e6 applies the listened flag to all declared tracks.
        const listened = Boolean(n(0));
        for (const [key, value] of this.game.config) {
          if (!/^BGM\.\d+$/.test(key)) continue;
          const track = value.split('"')[1]?.toLowerCase();
          if (!track) continue;
          if (listened) this.bgmListened.add(track);
          else this.bgmListened.delete(track);
        }
        localStorage.setItem(this.game.saveKey + ':bgmtable', JSON.stringify([...this.bgmListened]));
        return 0;
      }
    }
    if (root === 124) {
      if (path.length === 2 && member === 0) {
        this.g00Buffers.clear();
        return 0;
      }
      if (path.length === 2 && member === 2) {
        return Number(this.game.config.get('G00BUF.CNT') ?? 0);
      }
      if (member === -1 && path.length === 4) {
        const slot = path[2]!;
        if (path[3] === 0) {
          this.g00Buffers.set(slot, await this.display.objectGraphic(s(0), 0));
          return 0;
        }
        if (path[3] === 1) {
          this.g00Buffers.delete(slot);
          return 0;
        }
      }
    }
    if (root === 52 && member === -1 && path.length === 4) {
      // pcmevent[slot] (native 0x55fe50)
      const slot = path[2]!;
      const op = path[3];
      if (op === 3) {
        this.stopPcmEvent(slot);
        return 0;
      }
      if (op === 5) return Number(this.pcmEvents.has(slot));
      if (op === 4 || op === 6) {
        while (!this.skipping) {
          const active = this.pcmEvents.get(slot);
          if (!active || active.config.mode !== 'oneshot') break;
          if (await this.delay(32, op === 6)) return 1;
        }
        return 0;
      }
      if (op === 0 || op === 1 || op === 2) {
        const positional = args.length - command.named.length;
        const namedNumber = (id: number): number | undefined => {
          const idx = command.named.indexOf(id);
          return idx < 0 ? undefined : n(positional + idx);
        };
        const hasChannel = positional > 0 && typeof args[0] === 'number';
        const pcmchNo = hasChannel ? n(0) : -1;
        const startIdx = hasChannel ? 1 : 0;
        const opts = {
          volumeType: namedNumber(3),
          bgmFadeTarget: Boolean(namedNumber(5)),
          character: namedNumber(6),
        };
        if (op === 2) {
          const entries: {file: string; minTime: number; maxTime: number; probability: number}[] =
            [];
          for (let i = startIdx; i < positional; i++) {
            const entry = args[i];
            if (Array.isArray(entry) && typeof entry[0] === 'string') {
              entries.push({
                file: entry[0],
                minTime: Number(entry[1] ?? 0),
                maxTime: Number(entry[2] ?? 0),
                probability: Number(entry[3] ?? 1),
              });
            }
          }
          this.startPcmEventRandom(slot, pcmchNo, entries, opts);
        } else {
          const entries: {file: string; minTime: number; maxTime: number}[] = [];
          for (let i = startIdx; i < positional; i++) {
            const entry = args[i];
            if (Array.isArray(entry) && typeof entry[0] === 'string') {
              const minTime = entry.length >= 2 ? Number(entry[1] ?? 0) : 0;
              const maxTime = entry.length >= 3 ? Number(entry[2] ?? minTime) : minTime;
              entries.push({file: entry[0], minTime, maxTime});
            }
          }
          this.startPcmEventSequence(slot, pcmchNo, entries, opts, op === 1);
        }
        return 0;
      }
    }
    if (root === 135 && member === -1 && path.length === 4 && (path[3] === 0 || path[3] === 1)) {
      const slot = path[2]!;
      await this.display.setObjectMask(slot, path[3] === 0 ? s(0) : undefined);
      if (path[3] === 1) {
        this.maskEvents.delete(`${slot}.x`);
        this.maskEvents.delete(`${slot}.y`);
      }
      this.invalidateMainObjects();
      return 0;
    }
    // global.mask[].x_eve (2) / y_eve (3) intevent commands (0x55be20 -> 0x5590e0)
    if (
      root === 135 &&
      member === -1 &&
      path.length === 5 &&
      (path[3] === 2 || path[3] === 3)
    ) {
      const slot = path[2]!;
      const axis = path[3] === 2 ? 'x' : 'y';
      const op = path[4]!;
      const evKey = `${slot}.${axis}`;
      if (op === 0 || op === 7) {
        const target = n(0) | 0;
        const duration = Math.max(0, n(1));
        const waitDelay = Math.max(0, n(2));
        this.display.setObjectMaskOffset(slot, axis, target);
        this.maskEvents.set(evKey, {endAt: performance.now() + duration + waitDelay, target});
        this.invalidateMainObjects();
        return 0;
      }
      if (op === 1 || op === 8 || op === 2 || op === 9) {
        const target = n(1) | 0;
        this.display.setObjectMaskOffset(slot, axis, target);
        this.maskEvents.set(evKey, {endAt: Infinity, target});
        this.invalidateMainObjects();
        return 0;
      }
      if (op === 3) {
        const ev = this.maskEvents.get(evKey);
        if (ev) this.display.setObjectMaskOffset(slot, axis, ev.target);
        this.maskEvents.delete(evKey);
        this.invalidateMainObjects();
        return 0;
      }
      if (op === 4 || op === 10) {
        if (this.objectsDirty) await this.renderObjects();
        const ev = this.maskEvents.get(evKey);
        if (ev && !this.skipping) {
          const rem = Math.ceil(ev.endAt - performance.now());
          if (rem > 0) {
            const skipped = await this.delay(rem, op === 10);
            this.maskEvents.delete(evKey);
            return op === 10 ? Number(skipped) : 0;
          }
        }
        this.maskEvents.delete(evKey);
        return 0;
      }
      if (op === 5) {
        const ev = this.maskEvents.get(evKey);
        if (!ev) return 0;
        if (performance.now() >= ev.endAt) {
          this.maskEvents.delete(evKey);
          return 0;
        }
        return 1;
      }
    }
    if (root === 46 && member !== undefined && member >= 0 && member <= 3)
      return this.display.pointerPosition(member % 2);
    if (root === 46 && member === 5) return this.display.inputWheel();
    if (root === 46 && member === 9) {
      // 1.1.102.1 (0x527576) writes the same stage coordinates as mouse.x/y.
      for (const axis of [0, 1]) {
        const ref = args[axis];
        if (Array.isArray(ref)) this.vm.assign(ref as readonly number[], this.display.pointerPosition(axis));
      }
      return 0;
    }
    if (root === 46 && (member === 6 || member === 7) && path.length === 3) {
      const button = member === 6 ? 1 : 0;
      const operation = path[2];
      // 0x553389–0x5533fb exposes the sampled release gesture without consuming it.
      const flick = this.pointerFlicks?.[button];
      if (operation === 10) return Number(this.pointerFlickActive?.[button] ?? false);
      if (operation === 0) return Math.trunc((1 - (flick?.angle ?? 0) / Math.fround(Math.PI)) * 10);
      if (operation === 14) return Math.trunc(flick?.pixelsPerSecond ?? 0);
      if (operation === 15) return Math.trunc(flick?.millimetresPerSecond ?? 0);
      return this.display.inputState(button, operation!);
    }
    if (root === 46 && (member === 4 || member === 8)) return 0;
    if (root === 46 && member === 10) {
      // 1.1.141.3 converts the requested logical coordinates to the native window's cursor position.
      this.display.movePointer(n(0), n(1));
      return 0;
    }
    if (root === 188 && member === 0 && path.length === 5 && path[2] === -1)
      return this.joypad.state(path[3]!, path[4]!);
    if (root === 39 && member === 0)
      return n(0) + Math.floor(Math.random() * (Math.max(0, n(1) - n(0)) + 1));
    if (root === 39 && member === 1 && args.length === 1) return String(n(0));
    if (root === 39 && member === 3) return Math.max(n(0) | 0, n(1) | 0); // 1.1.102.1 0x532986
    if (root === 39 && member === 4) return Math.min(n(0) | 0, n(1) | 0); // 1.1.141.3 at 0x55ef40
    if (root === 39 && member === 5) return Math.abs(n(0)) | 0;
    if (root === 39 && member === 2 && args.length >= 3) {
      const segments = args.slice(3);
      if (segments.every(Array.isArray))
        return timetable(n(0) - n(1), n(2), segments as readonly (readonly number[])[]);
    }
    if (root === 39 && member === 9)
      return n(3) === n(1)
        ? n(2)
        : Math.trunc(n(2) + ((n(0) - n(1)) * (n(4) - n(2))) / (n(3) - n(1)));
    if (root === 39 && member === 11) {
      const value = n(0);
      const sign = value < 0 ? '-' : '';
      return sign + String(Math.abs(value)).padStart(Math.min(1024, n(1)) - sign.length, '0');
    }
    if (root === 39 && member === 6) return siglusSin(n(0), n(1));
    if (root === 39 && member === 7) return siglusCos(n(0), n(1));
    if (root === 39 && member === 12) return siglusTostrZen(n(0), args.length > 1 ? n(1) : 0);
    if (root === 39 && member === 15) {
      // 1.1.141.3 math dispatch at 0x55f26a squares signed int32 deltas before sqrt.
      const dx = (n(2) - n(0)) | 0;
      const dy = (n(3) - n(1)) | 0;
      const squared = (Math.imul(dx, dx) + Math.imul(dy, dy)) | 0;
      return squared < 0 ? -0x80000000 : Math.trunc(Math.sqrt(squared));
    }
    if (root === 39 && member === 10) return Math.min(Math.max(n(1), n(0)), n(2));
    if (root === 42) {
      const positional = args.length - command.named.length;
      const named = (id: number) => {
        const index = command.named.indexOf(id);
        return index < 0 ? undefined : args[positional + index];
      };
      if (member === 13) return this.audio.bgmPlayPosition();
      if (member === 19) return this.audio.bgmName();
      if (member === 18) return this.audio.channelState('bgm');
      if (member === 3 || member === 14) return this.waitAudio('bgm', member === 14);
      if (member === 5 || member === 15)
        return this.delay(this.audio.fadeRemaining('bgm'), member === 15);
      if (member === 4 || member === 10) {
        // 1.1.102.1 (0x537d00/0x537d32) defaults both operations to a 100 ms fade.
        const fade = positional ? Math.max(0, n(0)) : 100;
        if (member === 4) this.audio.stop('bgm', fade);
        else this.audio.pauseBgm(fade);
        return 0;
      }
      if (member === 11 && command.named.every((id) => id === 0)) {
        const name = this.audio.bgmName?.();
        if (name) this.recordBgmListened(name);
        this.audio.resumeBgm(positional ? n(0) : 0, Number(named(0) ?? 0));
        return 0;
      }
      if (member === 12 && !command.named.length) {
        const name = this.audio.bgmName?.();
        if (name) this.recordBgmListened(name);
        this.audio.resumeBgm(positional ? Math.max(0, n(0)) : 0);
        return this.waitAudio('bgm', false);
      }
      if (member === 0 && positional === 1 && !command.named.length) {
        await this.playBgm(s(0));
        return 0;
      }
      if (member === 2 && positional >= 1 && !command.named.length) {
        const name = s(0);
        const fadeIn = positional > 1 ? Math.max(0, n(1)) : 0;
        const fadeOut = positional > 2 ? Math.max(0, n(2)) : 0;
        this.recordBgmListened(name);
        this.audio.bgmStart(name, false, fadeIn, fadeOut);
        return this.waitAudio('bgm', false);
      }
      if (member === 0 || member === 1 || member === 16 || member === 17) {
        const ready = member === 16 || member === 17;
        if (command.named.every((id) => [0, 1, 3, 5, ...(ready ? [] : [4, 6])].includes(id))) {
          const name = String(named(0) ?? s(0));
          const loop = Boolean(named(1) ?? (member === 0 || member === 16));
          const start = Number(named(3) ?? -1);
          const fadeOut = Math.max(
            0,
            Number(named(5) ?? (ready && positional > 1 ? n(1) : positional > 2 ? n(2) : 0)),
          );
          if (ready) await this.audio.readyBgm(name, loop, fadeOut, start);
          else {
            const fadeIn = Math.max(0, Number(named(4) ?? (positional > 1 ? n(1) : 0)));
            this.recordBgmListened(name);
            this.audio.bgmStart(name, loop, fadeIn, fadeOut, Number(named(6) ?? 0), start);
          }
          return 0;
        }
      }
      if (member === 9) return this.audio.channelLevel('bgm');
      if (member === 6 || member === 7 || member === 8) {
        this.audio.setChannelLevel(
          'bgm',
          member === 6 ? n(0) : member === 7 ? 255 : 0,
          n(member === 6 ? 1 : 0),
        );
        return 0;
      }
    }
    if (root === 43) {
      if (member === 0) {
        this.audio.effectStart('pcm', s(0));
        return 0;
      }
      if (member === 1) {
        this.audio.stop('pcm', 100);
        return 0;
      }
    }
    if (root === 44 && member === -1 && path.length === 4) {
      const channel = path[2]!;
      const key = `pcm${channel}`;
      const opcode = path[3];
      if (opcode === 3 || opcode === 6) return this.waitAudio(key, opcode === 6);
      if (opcode === 4) return this.audio.channelState(key);
      if (opcode === 7 || opcode === 8)
        return this.delay(this.audio.fadeRemaining(key), opcode === 7);
      if (opcode === 5) {
        this.audio.stop(key, Math.max(0, n(0)));
        return 0;
      }
      if (opcode === 9 && command.named.every((id) => id === 0)) {
        const positional = args.length - command.named.length;
        const delayed = command.named.includes(0);
        this.audio.resumePcm(
          channel,
          positional ? Math.max(0, n(0)) : 0,
          delayed ? n(positional) : 0,
        );
        return 0;
      }
      if (opcode === 1 && !command.named.length) {
        const fade = args.length > 1 ? Math.max(0, n(1)) : 0;
        this.audio.pcmStart(channel, {resource: s(0), loop: false}, false, fade);
        return this.waitAudio(key, false);
      }
      if (opcode === 17 && !command.named.length) {
        this.audio.resumePcm(channel, args.length ? Math.max(0, n(0)) : 0);
        return this.waitAudio(key, false);
      }
      if (opcode === 12) return this.audio.channelLevel(key);
      if (opcode === 13 || opcode === 14 || opcode === 15) {
        this.audio.setChannelLevel(
          key,
          opcode === 13 ? n(0) : opcode === 14 ? 255 : 0,
          n(opcode === 13 ? 1 : 0),
        );
        return 0;
      }
      if (
        (opcode === 0 || opcode === 2 || opcode === 11 || opcode === 16) &&
        command.named.every((id) => [0, 2, 3, 4, 6, 7, 8, 10, 11].includes(id))
      ) {
        const positional = args.length - command.named.length;
        const namedNumber = (id: number): number | undefined => {
          const index = command.named.indexOf(id);
          return index < 0 ? undefined : n(positional + index);
        };
        const namedValue = (id: number): Argument | undefined => {
          const index = command.named.indexOf(id);
          return index < 0 ? undefined : args[positional + index];
        };
        const voice = namedNumber(8);
        const bgmNameVal = namedValue(10);
        const bgmName = typeof bgmNameVal === 'string' ? bgmNameVal : undefined;
        const fileIndex = command.named.indexOf(7);
        const file = fileIndex < 0 ? args[0] : args[positional + fileIndex];
        const resource = bgmName ?? voice ?? file;
        if (typeof resource === 'string' || typeof resource === 'number') {
          const isReady = opcode === 11 || opcode === 16;
          const pcmSource = {
            resource,
            bgmName,
            loop: opcode === 2 || opcode === 16 || Boolean(namedNumber(0)),
            volumeType: namedNumber(3),
            character: namedNumber(6),
            bgmFadeTarget: Boolean(namedNumber(4)),
            bgmFadeSource: Boolean(namedNumber(11)),
          };
          const fade = Math.max(0, namedNumber(2) ?? (positional > 1 ? n(1) : 0));
          if (bgmName && !isReady) this.recordBgmListened(bgmName);
          if (isReady) await this.audio.pcm(channel, pcmSource, true, fade);
          else this.audio.pcmStart(channel, pcmSource, false, fade);
          return 0;
        }
      }
    }
    if (root === 45) {
      if (member === 0 || member === 9) {
        await this.playSystemSound(n(0));
        return 0;
      }
      if (member === 1 || member === 2 || member === 3) {
        this.audio.setChannelLevel(
          'se',
          member === 1 ? n(0) : member === 2 ? 255 : 0,
          n(member === 1 ? 1 : 0),
        );
        return 0;
      }
      if (member === 4) return this.audio.channelLevel('se');
      if (member === 5) {
        this.audio.effectStart('se', s(0));
        return 0;
      }
      if (member === 6) {
        this.audio.voiceStart(n(0), 'se');
        return 0;
      }
      if (member === 7) {
        // The parameterless overload of SE stop uses a 100 ms fade (0x538e2a).
        this.audio.stop('se', args.length ? Math.max(0, n(0)) : 100);
        return 0;
      }
      if (member === 8 || member === 10) return this.waitAudio('se', member === 10);
      if (member === 11) return this.audio.channelState('se');
    }
    if (root === 31 && member === 10) {
      if (this.system.size) {
        this.system.clear();
        localStorage.setItem(this.game.saveKey + ':system', '[]');
      }
      return 0;
    }
    if (root !== undefined && root >= 23 && root <= 28 && member === 10) return 0;
    this.recordUnhandled(this.unhandledCommands, path, command.scene, command.line);
    return undefined;
  }

  private async playSystemSound(id: number): Promise<void> {
    if (id < 0) return;
    const name = this.game.config.get(`SE.${String(id).padStart(3, '0')}`)?.split('"')[1];
    if (name) this.audio.effectStart('se', name);
  }

  private async playButtonSound(seNo: number, kind: 'hit' | 'push' | 'decide'): Promise<void> {
    const resolved = parseButtonSe(this.game.config, seNo)[kind];
    if (resolved >= 0) await this.playSystemSound(resolved);
  }

  private stagePath(path: number[]): number[] {
    if (path[0] === 65) {
      if (path[1] === -1) {
        const index = path[2]!;
        const rest = path.slice(3);
        if (index === 0) {
          if (rest[0] === 0 && rest[1] === -1) {
            if (rest[2] === 0) return [37, ...rest.slice(3)];
            if (rest[2] === 1) return [38, ...rest.slice(3)];
          }
          if (rest[0] === 1) return [38, ...rest.slice(1)];
          if (rest[0] === 2) return [37, ...rest.slice(1)];
          // 1.1.141.3 0x54d0cc & 0x54d102: excall[0] routes f[] (7) and counter[] (6) to story state.
          if (rest[0] === 6) return [40, ...rest.slice(1)];
          if (rest[0] === 7) return [29, ...rest.slice(1)];
          return [65, ...rest];
        }
        return this.stagePath([65, ...rest]);
      }
      if (path[1] === 0 && path[2] === -1) {
        if (path[3] === 0) return [65, 2, ...path.slice(4)];
        if (path[3] === 1) return [65, 1, ...path.slice(4)];
      }
      return path;
    }
    if (path[0] !== 49 || path[1] !== -1) return path;
    if (path[2] === 0) return [37, ...path.slice(3)];
    if (path[2] === 1) return [38, ...path.slice(3)];
    return path;
  }

  private async objectCommand({path, args, named, scene}: SiglusCommand): Promise<Value | undefined> {
    const address = this.objectAddress(path);
    if (address?.missingParent) {
      // Native 1.1.80.8 0x641df0 / 0x641fb0: child access on an unallocated/freed parent
      // returns "" for get_file_name (62), 0 for queries, and no-ops safely.
      return path.at(-1) === 62 ? '' : 0;
    }
    if (!address) return path.at(-2) === 93 && path.at(-1) === 3 ? 0 : undefined;
    const {page, index, parent} = address;
    const [array, id, command] = path.slice(index);
    if (array === 3 && id === undefined) {
      // 1.1.102.1 0x5dd431 allocates the stage vector to OBJECT.CNT (default 256).
      if (index === 2) {
        const count = Number.parseInt(this.game.config.get('OBJECT.CNT') ?? '', 10);
        return Number.isFinite(count) ? count : 256;
      }
      return parent?.childCount ?? Math.max(-1, ...page.keys()) + 1;
    }
    if (array === 4 && id === undefined) {
      const length = Math.max(0, Number(args[0] ?? 0));
      if (parent) parent.childCount = length;
      for (const key of page.keys()) if (key >= length) page.delete(key);
      this.markObjectsDirty(path);
      return 0;
    }
    if (command === 174) {
      // Siglus 1.1.134.0 tests the type field with SETNZ at 0x557448.
      const existing = page.get(id!);
      if (!existing) return 0;
      if (existing.type !== undefined) return Number(existing.type !== 0);
      // Some browser save records omit the type field.
      const drawable =
        existing.text || existing.number || existing.movie || existing.frames.length || existing.name;
      return drawable ? 1 : 0;
    }
    if (command === 123) {
      // 1.1.141.3: 0x55c529 -> 0x689020 returns 0 (normal), 1 (hit/hover), or 2 (push/pressed).
      const existing = page.get(id!);
      const btn = existing?.button;
      if (
        !existing?.visible ||
        !btn ||
        btn.group < 0 ||
        existing.disabled ||
        !this.activeGroups.has(btn.group)
      ) {
        return 0;
      }
      if (this.display.buttonState(btn.group, true) === btn.id) return 2;
      if (this.display.buttonState(btn.group, false) === btn.id) return 1;
      return 0;
    }
    if (command === 188) {
      // 1.1.141.3: 0x55c45b reads the base button number set by 0x602460.
      return page.get(id!)?.button?.id ?? 0;
    }
    const isReadOnlyObjectCommand =
      command === 24 ||
      command === 25 ||
      command === 52 ||
      command === 62 ||
      command === 100 ||
      command === 101 ||
      command === 102 ||
      command === 103 ||
      command === 111 ||
      command === 115 ||
      command === 118 ||
      command === 124 ||
      command === 127 ||
      command === 133 ||
      command === 134 ||
      command === 138 ||
      command === 169 ||
      (command === 91 && (path[index + 3] === 1 || path[index + 3] === 2)) ||
      ((command === 51 ||
        command === 64 ||
        command === 72 ||
        (command !== undefined && command >= 67 && command <= 90) ||
        (command !== undefined && command >= 105 && command <= 108) ||
        (command !== undefined && command >= 154 && command <= 157)) &&
        (path[index + 3] === 4 || path[index + 3] === 5 || path[index + 3] === 10)) ||
      ((command === 112 || command === 113 || command === 140) &&
        path[index + 3] === -1 &&
        (path[index + 5] === 4 || path[index + 5] === 5 || path[index + 5] === 10));
    if (command !== 175 && command !== 63 && command !== 48 && !isReadOnlyObjectCommand)
      this.markObjectsDirty(path);
    const n = (index: number) => Number(args[index] ?? 0);
    if (command === 35 || command === 36) {
      page.delete(id!);
      const prefix = this.frameActionKey(path.slice(0, index + 2)) + '.';
      for (const key of [...this.frameActions.keys()]) {
        if (key.startsWith(prefix)) {
          this.frameActions.delete(key);
          this.frameActionCounters.delete(key);
        }
      }
      return 0;
    }
    if (command === 41) {
      const source = args[0];
      if (!Array.isArray(source)) throw new Error('Invalid Siglus source object reference');
      const object = this.object(this.stagePath([...source]));
      if (object) page.set(id!, this.copyObject(object));
      else page.delete(id!);
      return 0;
    }
    if (command === 38) {
      const name = String(args[0]);
      this.recordCgSeen(name);
      const pattern = n(4);
      const frames = [];
      frames[pattern] = await this.display.objectGraphic(name, pattern);
      page.set(id!, {
        type: 2,
        name,
        frames,
        x: n(2),
        y: n(3),
        visible: args.length >= 2 ? Boolean(n(1)) : false,
        pattern,
      });
      return 0;
    }
    if (command === 120 || command === 121 || command === 122 || command === 143) {
      const name = String(args[0]);
      const basename = 'mov/' + name.toLowerCase();
      const source = this.game.files.get(basename + '.omv') ?? this.game.files.get(basename);
      if (!source) throw new Error('Missing Siglus OMV ' + name);
      const movie = await SiglusOmvPlayback.open(source, this.controller.signal, command === 121);
      this.objectMovies.add(movie);
      const positional = args.length - named.length;
      const autoFreeIdx = named.indexOf(0);
      const readyIdx = named.indexOf(2);
      const autoFree = autoFreeIdx >= 0 ? Boolean(n(positional + autoFreeIdx)) : false;
      const readyOnly = readyIdx >= 0 ? Boolean(n(positional + readyIdx)) : false;
      const object: DrawObject = {
        ...emptyDrawObject(),
        type: 5,
        name,
        visible: positional === 1 || Boolean(n(1)),
        x: positional >= 4 ? n(2) : 0,
        y: positional >= 4 ? n(3) : 0,
        movie,
        movieMeta: {loop: command === 121, autoFree, readyOnly},
      };
      page.set(id!, object);
      if (!readyOnly) movie.play();
      if (command === 122 || command === 143) {
        const result = await this.waitObjectMovie(movie, command === 143);
        if (autoFree && page.get(id!) === object) {
          page.delete(id!);
          this.markObjectsDirty(path);
          this.releaseUnusedObjectMovies();
        }
        return result;
      }
      return 0;
    }
    if (command === 116) {
      const save = this.saveSlot(n(0));
      const thumbnail = save?.thumbnail;
      const frames = thumbnail ? [await this.display.savedThumbnail(thumbnail)] : [];
      page.set(id!, {
        name: '',
        frames,
        x: n(2),
        y: n(3),
        visible: frames.length > 0 && (args.length === 1 || Boolean(n(1))),
        pattern: 0,
      });
      return 0;
    }
    if (command === 170) {
      // 1.1.102.1 (0x52f2f9 -> 0x5fd190) loads the numbered local capture.
      const name = `${String(n(0) | 0).padStart(10, '0')}.png`;
      const frame = await this.localCaptureGraphic(name);
      page.set(id!, {
        type: 11,
        name,
        frames: frame ? [frame] : [],
        x: n(2),
        y: n(3),
        visible: args.length >= 2 && Boolean(n(1)),
        pattern: 0,
      });
      return 0;
    }
    if (command === 39) {
      const inExcall = this.systemCallActive || path[0] === 65;
      const resolved = inExcall ? this.resolveFont(this.systemFont) : this.storyFont();
      page.set(id!, {
        name: '',
        frames: [],
        x: n(2),
        y: n(3),
        visible: args.length === 1 || Boolean(n(1)),
        pattern: 0,
        text: {
          value: String(args[0]),
          font: resolved.name,
          bold: resolved.bold,
          shadow: resolved.shadow,
          size: 32,
        },
      });
      return 0;
    }
    if (command === 129) {
      // object.create_weather (0x5f7ad0): type=4 weather particle object
      const name = String(args[0] ?? '');
      page.set(id!, {
        type: 4,
        name,
        frames: [],
        x: 0,
        y: 0,
        visible: args.length === 1 || Boolean(n(1)),
        pattern: 0,
        weather: {mode: 0, params: {}, started: performance.now()},
      });
      return 0;
    }
    if (command === 132) {
      // object.create_number (0x5ebff0): bitmap-digit sprite sheet object
      const name = String(args[0]);
      const spec = {
        value: 0,
        ketaMax: 0,
        dispZero: 0,
        dispSign: 0,
        tumeruSign: 0,
        spaceMod: 0,
        space: 0,
      };
      const frame = await this.display.numberGraphic(name, spec);
      page.set(id!, {
        name,
        frames: frame ? [frame] : [],
        x: n(2),
        y: n(3),
        visible: args.length === 1 || Boolean(n(1)),
        pattern: 0,
        number: spec,
      });
      return 0;
    }
    if (command === 40) {
      // object.create_rect (0x556c90): al=0 (l,t,r,b,R,G,B,A), al=1 (+disp), al=2 (+disp,x,y)
      const left = n(0);
      const top = n(1);
      const right = n(2);
      const bottom = n(3);
      const r = n(4);
      const g = n(5);
      const b = n(6);
      const a = n(7);
      const width = Math.max(0, right - left);
      const height = Math.max(0, bottom - top);
      const visible = args.length >= 9 ? Boolean(n(8)) : false;
      const x = args.length >= 11 ? n(9) : 0;
      const y = args.length >= 11 ? n(10) : 0;
      page.set(id!, {
        type: 1,
        name: '',
        frames: [this.display.rectangle(width, height, r, g, b, a, left, top)],
        rect: {left, top, right, bottom, r, g, b, a},
        x,
        y,
        visible,
        pattern: 0,
      });
      return 0;
    }
    let object = page.get(id!);
    if (command === 62) return object?.name ?? '';
    if (
      !object &&
      (command === 26 ||
        command === 42 ||
        command === 48 ||
        command === 49 ||
        command === 99 ||
        command === 111 ||
        command === 130 ||
        command === 131 ||
        command === 133 ||
        command === 134 ||
        command === 141 ||
        command === 158 ||
        command === 159 ||
        command === 0x1000000 ||
        command === 0x1000001)
    ) {
      object = emptyDrawObject();
      page.set(id!, object);
    }
    if (command === 24 || command === 25) {
      if (!object) return 0;
      // 1.1.102.1 0x52ebbf/0x52ebf5 query cel zero unless the caller supplies an index.
      const pattern = n(0) | 0;
      if (pattern < 0) return 0;
      if (object.movie) return command === 24 ? object.movie.width : object.movie.height;
      const frame =
        object.frames[pattern] ??
        (object.type === 2 && object.name
          ? (object.frames[pattern] = await this.display.objectGraphic(object.name, pattern))
          : undefined);
      return (command === 24 ? frame?.width : frame?.height) ?? 0;
    }
    if (
      !object &&
      (command === 51 ||
        command === 52 ||
        command === 54 ||
        command === 63 ||
        command === 64 ||
        command === 66 ||
        command === 67 ||
        command === 68 ||
        (command !== undefined && command >= 69 && command <= 90) ||
        command === 91 ||
        command === 95 ||
        command === 96 ||
        command === 97 ||
        command === 98 ||
        (command !== undefined && command >= 100 && command <= 103) ||
        (command !== undefined && command >= 105 && command <= 108) ||
        command === 112 ||
        command === 113 ||
        command === 115 ||
        command === 124 ||
        command === 127 ||
        command === 140 ||
        (command !== undefined && command >= 154 && command <= 157) ||
        command === 160 ||
        command === 161 ||
        command === 172 ||
        command === 175)
    )
      return 0;
    if (command === 169) {
      // 1.1.102.1 0x52eb8e returns the number of cels in a loaded G00 object.
      return object?.type === 2 ? this.display.graphicCutCount(object.name) : 0;
    }
    if (command === 118) {
      // 1.1.141.3 reads the script-set button state at 0x55c519.
      if (object?.disabled || object?.buttonState === 'disable') return 4;
      return object?.buttonState === 'select' ? 3 : 0;
    }
    if (!object) throw new Error(`Missing Siglus object ${id}`);
    if (command === 26) {
      const cmdName = String(args[0] ?? '');
      object.buttonCall = cmdName ? {scene, command: cmdName} : undefined;
      return 0;
    }
    if (command === 124) {
      // 1.1.141.3 0x55c570 -> 0x602670: returns 0 if group < 0, 3/4 for select/disable,
      // then gates live hit/push (1/2) on mwndBtnTouchEnabled (0x602815) and active group.
      const btn = object.button;
      if (!btn || btn.group < 0) return 0;
      if (object.buttonState === 'select') return 3;
      if (object.disabled || object.buttonState === 'disable') return 4;
      if (!this.mwndBtnTouchEnabled || !object.visible || !this.activeGroups.has(btn.group)) return 0;
      if (this.display.buttonState(btn.group, true) === btn.id) return 2;
      if (this.display.buttonState(btn.group, false) === btn.id) return 1;
      return 0;
    }
    if (command === 172) {
      (object.movieMeta ??= {loop: false, autoFree: false, readyOnly: false}).autoFree = Boolean(
        n(0),
      );
      return 0;
    }
    if (command === 130 || command === 131) {
      // object.set_weather_param_type_a (130, 0x5f7b60) / type_b (131, 0x5f7c20)
      const weather =
        object.weather ?? (object.weather = {mode: 0, params: {}, started: performance.now()});
      weather.mode = command === 130 ? 1 : 2;
      const positional = args.length - named.length;
      for (let i = 0; i < named.length; i++) {
        weather.params[named[i]!] = Number(args[positional + i] ?? 0) | 0;
      }
      return 0;
    }
    if (command === 0x1000000) {
      // object.load_gan (0x557cbd)
      object.gan = {file: String(args[0] ?? '')};
      return 0;
    }
    if (command === 0x1000001) {
      // object.start_gan (0x557d45): (sequence, loop)
      object.gan = {
        file: object.gan?.file || object.name,
        sequence: n(0),
        loop: Boolean(n(1)),
        started: performance.now(),
      };
      return 0;
    }
    if (command === 133 || command === 134) {
      // object.set_number (133) / object.set_number_param (134) (0x5f5b60)
      const hadSpec = Boolean(object.number);
      const spec =
        object.number ??
        (object.number = {
          value: 0,
          ketaMax: 0,
          dispZero: 0,
          dispSign: 0,
          tumeruSign: 0,
          spaceMod: 0,
          space: 0,
        });
      let changed = !hadSpec || !object.frames.length || object.pattern !== 0;
      if (command === 133) {
        const nextVal = n(0) | 0;
        if (spec.value !== nextVal) {
          spec.value = nextVal;
          changed = true;
        }
      } else {
        const nextKeta = n(0) | 0;
        const nextZero = n(1) | 0;
        const nextSign = n(2) | 0;
        const nextTumeru = n(3) | 0;
        const nextMod = n(4) | 0;
        const nextSpace = n(5) | 0;
        if (
          spec.ketaMax !== nextKeta ||
          spec.dispZero !== nextZero ||
          spec.dispSign !== nextSign ||
          spec.tumeruSign !== nextTumeru ||
          spec.spaceMod !== nextMod ||
          spec.space !== nextSpace
        ) {
          spec.ketaMax = nextKeta;
          spec.dispZero = nextZero;
          spec.dispSign = nextSign;
          spec.tumeruSign = nextTumeru;
          spec.spaceMod = nextMod;
          spec.space = nextSpace;
          changed = true;
        }
      }
      if (changed) {
        const frame = await this.display.numberGraphic(object.name, spec);
        object.frames = frame ? [frame] : [];
        object.pattern = 0;
        this.markObjectsDirty(path);
      }
      return 0;
    }
    if (command === 127) return Number(object.movie?.active ?? false);
    if (object.movie) {
      if (command === 138) return Math.trunc(object.movie.elapsed);
      if (command === 128 || command === 142) {
        const result = await this.waitObjectMovie(object.movie, command === 142);
        if (object.movieMeta?.autoFree && page.get(id!) === object) {
          page.delete(id!);
          this.markObjectsDirty(path);
          this.releaseUnusedObjectMovies();
        }
        return result;
      }
      if (command === 125 || command === 126 || command === 137 || command === 171) {
        if (command === 125) object.movie.pause();
        if (command === 126) object.movie.play();
        if (command === 137) object.movie.seek(n(0));
        if (command === 171) object.movie.endLoop();
        return 0;
      }
    }
    if (command === 111 && path[index + 3] === 2) {
      // object.f.resize(n) (0x558910)
      const flags = (object.flags ??= []);
      const size = Math.max(0, n(0));
      while (flags.length < size) flags.push(0);
      flags.length = size;
      return 0;
    }
    if (command === 111 && path[index + 3] === 9) {
      return (object.flags ?? []).length;
    }
    if (command === 141 && path[index + 3] === 2) {
      // object.tr_rep.resize(n) (0x558910)
      const trs = (object.trOffsets ??= []);
      const size = Math.max(0, n(0));
      while (trs.length < size) trs.push(255);
      trs.length = size;
      return 0;
    }
    if (command === 91 && path.length === index + 4) {
      // object.all_eve: 0=end, 1=wait, 2=check (1.1.141.3 at 0x55a85f).
      const op = path[index + 3];
      if (op === 0) {
        object.positionEvents = undefined;
        object.scaleEvents = undefined;
        object.offsetEvents = undefined;
        object.horizontalMotion = undefined;
        object.opacity = undefined;
        object.opacityStarted = undefined;
        object.opacityElapsed = undefined;
        object.intEvents?.clear();
        return 0;
      }
      if (op === 1 || op === 2) {
        if (op === 1) await this.renderObjects();
        const now = performance.now();
        let maxRem = 0;
        const consider = (rem: number) => {
          if (rem > maxRem) maxRem = rem;
        };
        if (object.opacity && object.opacityStarted !== undefined) {
          consider(object.opacity[1] + object.opacity[2] - (now - object.opacityStarted));
        }
        if (object.horizontalMotion) {
          consider(
            object.horizontalMotion.duration +
              object.horizontalMotion.delay -
              (now - object.horizontalMotion.started),
          );
        }
        for (const ev of [
          object.positionEvents?.x,
          object.positionEvents?.y,
          object.scaleEvents?.x,
          object.scaleEvents?.y,
        ]) {
          if (ev)
            consider(Number(ev.time.duration ?? 0) + Number(ev.time.delay ?? 0) - (now - ev.started));
        }
        for (const map of [object.offsetEvents?.x, object.offsetEvents?.y]) {
          for (const ev of map?.values() ?? []) {
            consider(Number(ev.time.duration ?? 0) + Number(ev.time.delay ?? 0) - (now - ev.started));
          }
        }
        for (const ev of object.intEvents?.values() ?? []) {
          if (ev.mode === 0) consider(ev.endAt - now);
          else if (op === 2) return 1;
        }
        if (op === 2) return Number(maxRem > 0);
        if (maxRem > 0 && !this.skipping) await this.delay(maxRem, false);
        return 0;
      }
      return undefined;
    }
    if (command === 99) {
      // object.set_string (0x5575be -> 0x5f69d0)
      if (object.text) object.text.value = String(args[0] ?? '');
      return 0;
    }
    if (command === 158 || command === 159) {
      // 1.1.102.1 0x52dbf8 and 0x52dcde write the same pairs as properties 6/7 and 9/10.
      const center: [number, number] = [n(0) | 0, n(1) | 0];
      if (command === 158) object.center = center;
      else object.centerRep = center;
      return 0;
    }
    if (command !== undefined && command >= 154 && command <= 157 && path.length === index + 4) {
      // 0x52e84d–0x52e8c4 dispatch integer events to the four source-clip edges.
      const edge = command - 154;
      const bounds = (object.sourceClipBounds ??= [0, 0, 0, 0]);
      return this.runObjectIntEvent(
        object,
        `sourceClip:${edge}`,
        path[index + 3]!,
        args,
        () => bounds[edge]!,
        (value) => { bounds[edge] = value; },
      );
    }
    if (command !== undefined && command >= 105 && command <= 108 && path.length === index + 4) {
      // 0x52ff18 105..108 dispatch dst_clip_left/top/right/bottom_eve to object.clip[1..4].
      const edge = command - 105;
      const clip = (object.clip ??= [0, 0, 0, 0, 0]);
      return this.runObjectIntEvent(
        object,
        `dstClip:${edge}`,
        path[index + 3]!,
        args,
        () => clip[edge + 1]!,
        (value) => {
          clip[edge + 1] = value;
        },
      );
    }
    if (command === 140 && path[index + 3] === 1 && path.length === index + 4) {
      // 1.1.141.3 resizes the transparency event vector at 0x561640.
      const count = Math.max(0, n(0) | 0);
      (object.offsetEventCounts ??= {}).tr = count;
      for (const key of object.intEvents?.keys() ?? []) {
        if (key.startsWith('tr_rep:') && Number(key.slice(7)) >= count)
          object.intEvents?.delete(key);
      }
      return 0;
    }
    if (command === 140 && path[index + 3] === -1 && path.length === index + 6) {
      // object.tr_rep_eve[slot].<op> (0x5590e0)
      const slot = path[index + 4]!;
      if (slot < 0 || slot >= (object.offsetEventCounts?.tr ?? Infinity)) return 0;
      const op = path[index + 5]!;
      const trs = (object.trOffsets ??= []);
      while (trs.length <= slot) trs.push(255);
      return this.runObjectIntEvent(
        object,
        `tr_rep:${slot}`,
        op,
        args,
        () => trs[slot] ?? 255,
        (v) => {
          trs[slot] = v;
        },
      );
    }
    if (
      (command === 51 ||
        command === 64 ||
        command === 67 ||
        command === 68 ||
        command === 69 ||
        command === 70 ||
        command === 71 ||
        command === 73 ||
        command === 74 ||
        command === 75 ||
        command === 76 ||
        command === 77 ||
        command === 78 ||
        command === 80 ||
        command === 81 ||
        command === 83 ||
        command === 84 ||
        command === 85 ||
        command === 86 ||
        command === 87 ||
        command === 88 ||
        command === 89 ||
        command === 90) &&
      path.length === index + 4
    ) {
      const op = path[index + 3]!;
      // Preserve specialized animated DOM events for 51/64/67/68 op=0 (set) and op=7 (set_real)
      if (
        (command === 51 || command === 64 || command === 67 || command === 68) &&
        (op === 0 || op === 7) &&
        (args.length === 4 || (args.length === 5 && (named.length === 0 || named[0] === 0)))
      ) {
        const started = performance.now();
        const duration = Math.max(0, n(1));
        const waitDelay = Math.max(0, n(2));
        if (path[0] === 65 && command === 51 && args.length >= 4) {
          const from = args.length === 5 ? n(4) : object.x;
          object.horizontalMotion = {
            from,
            duration,
            delay: waitDelay,
            easing: n(3),
            started,
          };
          object.x = n(0);
          (object.intEvents ??= new Map()).set(`ch:${command}`, {
            mode: 0,
            from,
            target: n(0),
            duration,
            delay: waitDelay,
            easing: n(3),
            started,
            endAt: started + duration + waitDelay,
          });
          return 0;
        }
        const axis = command === 51 || command === 67 ? 'x' : 'y';
        const scale = command === 67 || command === 68;
        const axisIdx = axis === 'x' ? 0 : 1;
        const previousScale = object.scale ?? ([1000, 1000] as const);
        const event = {
          from: args.length === 5 ? n(4) : scale ? previousScale[axisIdx] : object[axis],
          started,
          time: {
            duration,
            delay: waitDelay,
            easing: eventEasing(n(3)),
            fill: 'backwards' as const,
          },
        };
        if (scale) {
          object.scaleEvents = {...object.scaleEvents, [axis]: event};
          object.scale = axisIdx === 0 ? [n(0), previousScale[1]] : [previousScale[0], n(0)];
        } else {
          object.positionEvents = {...object.positionEvents, [axis]: event};
          object[axis] = n(0);
        }
        (object.intEvents ??= new Map()).set(`ch:${command}`, {
          mode: 0,
          from: event.from,
          target: n(0),
          duration,
          delay: waitDelay,
          easing: n(3),
          started,
          endAt: started + duration + waitDelay,
        });
        return 0;
      }
      if (op === 3) {
        if (command === 51) {
          object.horizontalMotion = undefined;
          if (object.positionEvents) delete object.positionEvents.x;
        } else if (command === 64 && object.positionEvents) delete object.positionEvents.y;
        else if (command === 67 && object.scaleEvents) delete object.scaleEvents.x;
        else if (command === 68 && object.scaleEvents) delete object.scaleEvents.y;
      }
      const getVal = (): number => {
        if (command === 51) return object.x;
        if (command === 64) return object.y;
        if (command === 67) return (object.scale ?? [1000, 1000])[0];
        if (command === 68) return (object.scale ?? [1000, 1000])[1];
        if (command === 69) return object.rotateX ?? 0;
        if (command === 70) return object.rotateY ?? 0;
        if (command === 71) return object.rotateZ ?? 0;
        if (command === 73) return object.colorProps?.mono ?? 0;
        if (command === 74) return object.colorProps?.reverse ?? 0;
        if (command === 75) return object.colorProps?.bright ?? 0;
        if (command === 76) return object.colorProps?.dark ?? 0;
        if (command === 77) return (object.center ?? [0, 0])[0];
        if (command === 78) return (object.center ?? [0, 0])[1];
        if (command === 80) return (object.centerRep ?? [0, 0])[0];
        if (command === 81) return (object.centerRep ?? [0, 0])[1];
        if (command === 83) return object.colorProps?.colorRate ?? 0;
        if (command === 84) return object.colorProps?.addR ?? 0;
        if (command === 85) return object.colorProps?.addG ?? 0;
        if (command === 86) return object.colorProps?.addB ?? 0;
        if (command === 87) return object.colorProps?.colorR ?? 0;
        if (command === 88) return object.colorProps?.colorG ?? 0;
        if (command === 89) return object.colorProps?.colorB ?? 0;
        if (command === 90) return object.pattern;
        return 0;
      };
      const setVal = (v: number): void => {
        if (command === 51) object.x = v;
        else if (command === 64) object.y = v;
        else if (command === 67) object.scale = [v, (object.scale ?? [1000, 1000])[1]];
        else if (command === 68) object.scale = [(object.scale ?? [1000, 1000])[0], v];
        else if (command === 69) object.rotateX = v;
        else if (command === 70) object.rotateY = v;
        else if (command === 71) object.rotateZ = v;
        else if (command === 73) (object.colorProps ??= {}).mono = v;
        else if (command === 74) (object.colorProps ??= {}).reverse = v;
        else if (command === 75) (object.colorProps ??= {}).bright = v;
        else if (command === 76) (object.colorProps ??= {}).dark = v;
        else if (command === 77) object.center = [v, (object.center ?? [0, 0])[1]];
        else if (command === 78) object.center = [(object.center ?? [0, 0])[0], v];
        else if (command === 80) object.centerRep = [v, (object.centerRep ?? [0, 0])[1]];
        else if (command === 81) object.centerRep = [(object.centerRep ?? [0, 0])[0], v];
        else if (command === 83) (object.colorProps ??= {}).colorRate = v;
        else if (command === 84) (object.colorProps ??= {}).addR = v;
        else if (command === 85) (object.colorProps ??= {}).addG = v;
        else if (command === 86) (object.colorProps ??= {}).addB = v;
        else if (command === 87) (object.colorProps ??= {}).colorR = v;
        else if (command === 88) (object.colorProps ??= {}).colorG = v;
        else if (command === 89) (object.colorProps ??= {}).colorB = v;
        else if (command === 90) object.pattern = v;
      };
      return this.runObjectIntEvent(object, `ch:${command}`, op, args, getVal, setVal);
    }
    if ((command === 54 || command === 63) && path[index + 3] === 2) {
      const axis = command === 54 ? 'x' : 'y';
      const offsets = ((object.positionOffsets ??= {})[axis] ??= []);
      offsets.length = Math.max(0, n(0));
      const events = object.offsetEvents?.[axis];
      for (const index of events?.keys() ?? []) if (index >= offsets.length) events?.delete(index);
      return 0;
    }
    if (command === 112 || command === 113) {
      const axis = command === 112 ? 'x' : 'y';
      const member = path[index + 3];
      if (member === 1) {
        // 1.1.102.1 0x531a80 -> 0x535600 resizes the event list independently
        // of the position offsets that the events animate.
        const count = Math.max(0, n(0) | 0);
        (object.offsetEventCounts ??= {})[axis] = count;
        const events = object.offsetEvents?.[axis];
        for (const index of events?.keys() ?? []) if (index >= count) events?.delete(index);
        return 0;
      }
      if (member !== -1) return undefined;
      const indexInList = path[index + 4]!;
      if (indexInList < 0 || indexInList >= (object.offsetEventCounts?.[axis] ?? Infinity)) return 0;
      const operation = path[index + 5];
      const event = object.offsetEvents?.[axis]?.get(indexInList);
      const remaining = event
        ? Number(event.time.duration ?? 0) + Number(event.time.delay ?? 0) -
          (performance.now() - event.started)
        : 0;
      if (operation === 3) {
        object.offsetEvents?.[axis]?.delete(indexInList);
        return 0;
      }
      if (operation === 5) return Number(remaining > 0);
      if (operation === 4 || operation === 10) {
        await this.renderObjects();
        return remaining > 0 ? this.delay(remaining, operation === 10) : 0;
      }
      // 1.1.141.3 dispatches indexed set and set_real through the same event receiver.
      if (operation !== 0 && operation !== 7) return undefined;
      const offsets = ((object.positionOffsets ??= {})[axis] ??= []);
      const events = ((object.offsetEvents ??= {})[axis] ??= new Map());
      events.set(indexInList, {
        from: args.length === 5 ? n(4) : (offsets[indexInList] ?? 0),
        started: performance.now(),
        time: {duration: n(1), delay: n(2), easing: eventEasing(n(3)), fill: 'backwards'},
      });
      offsets[indexInList] = n(0);
      return 0;
    }
    if (command !== undefined && command >= 100 && command <= 103) {
      const pattern = args.length >= 3 ? n(2) : object.pattern;
      const frame =
        object.frames[pattern] ??
        (object.name
          ? (object.frames[pattern] = await this.display.objectGraphic(object.name, pattern))
          : undefined);
      const channel = (command === 100 ? 3 : command - 101) as 0 | 1 | 2 | 3;
      return frame ? this.display.graphicPixelChannel(frame, n(0), n(1), channel) : 0;
    }
    if (command === 72 && path.length === index + 4) {
      const event = path[index + 3];
      if ((event === 0 || event === 7) &&
          (args.length === 4 || (args.length === 5 && (named.length === 0 || named[0] === 0)))) {
        const started = performance.now();
        const duration = Math.max(0, n(1));
        const waitDelay = Math.max(0, n(2));
        const from = args.length === 5 ? n(4) : (object.transparency ?? 255);
        object.opacity = [n(0), duration, waitDelay, n(3), from];
        object.opacityStarted = started;
        object.opacityElapsed = undefined;
        object.transparency = n(0);
        (object.intEvents ??= new Map()).set('ch:72', {
          mode: 0,
          from,
          target: n(0),
          duration,
          delay: waitDelay,
          easing: n(3),
          started,
          endAt: started + duration + waitDelay,
        });
        return 0;
      }
      if (event === 3) {
        object.opacity = undefined;
        object.opacityStarted = undefined;
        object.opacityElapsed = undefined;
      }
      if (event === 4 || event === 10) {
        await this.renderObjects();
        const animation = object.opacity;
        if (animation && object.opacityStarted !== undefined) {
          const skipped = await this.delay(
            animation[1] + animation[2] - (performance.now() - object.opacityStarted),
            event === 10,
          );
          return event === 10 ? Number(Boolean(skipped)) : 0;
        }
        return 0;
      }
      return this.runObjectIntEvent(
        object,
        'ch:72',
        event!,
        args,
        () => object.transparency ?? 255,
        (v) => {
          object.transparency = v;
        },
      );
    }
    if (command === 53) {
      // object.change_file (0x556c2a -> 0x5ec520): reload graphic preserving transform/children
      const name = String(args[0]);
      this.recordCgSeen(name);
      object.name = name;
      object.frames = [];
      const pattern = Math.max(0, object.pattern);
      object.frames[pattern] = await this.display.objectGraphic(name, pattern);
      return 0;
    }
    if (command === 115) {
      // object.frame_action_ch (0x55b6d0): resize(1) or channel start(1)/end(2)/start_real(3)
      if (path.length === index + 4 && path[index + 3] === 1) {
        const size = Math.max(0, n(0) | 0);
        object.frameActionChannelCount = size;
        const prefix = this.frameActionKey(path.slice(0, index + 3)) + '.-1.';
        for (const key of new Set([...this.frameActions.keys(), ...this.frameActionCounters.keys()])) {
          if (!key.startsWith(prefix)) continue;
          const ch = Number(key.slice(prefix.length));
          if (ch >= size) {
            this.frameActions.delete(key);
            this.frameActionCounters.delete(key);
          }
        }
        return 0;
      }
      if (path.length === index + 4 && path[index + 3] === 2) {
        // 1.1.141.3 reports allocated channels even when they have no running action (0x56051f).
        return object.frameActionChannelCount ?? 0;
      }
      if (path.length === index + 6 && path[index + 3] === -1) {
        const channel = path[index + 4]!;
        if (channel < 0 || channel >= (object.frameActionChannelCount ?? Infinity)) return 0;
        const faPath = path.slice(0, index + 5);
        const op = path[index + 5];
        if (op === 2) {
          this.endFrameAction(faPath);
          return 0;
        }
        if (op === 1 || op === 3) {
          this.startFrameAction(faPath, scene, n(0), String(args[1] ?? ''), args.slice(2), op === 3);
          return 0;
        }
      }
      return undefined;
    }
    if (command === 52 && path.length === index + 4) {
      const faPath = path.slice(0, index + 3);
      const op = path[index + 3];
      if (op === 1 && args[1] === '$sys_change_mark') {
        object.patternCycle = {count: 11, duration: 1000, started: performance.now()};
        this.markObjectsDirty(path);
        return 0;
      }
      if (op === 2) {
        this.endFrameAction(faPath);
        return 0;
      }
      if (op === 1 || op === 3) {
        this.startFrameAction(faPath, scene, n(0), String(args[1] ?? ''), args.slice(2), op === 3);
        return 0;
      }
      return undefined;
    }
    if (command === 104 && object.text) {
      // object.set_string_param (0x5f6a90): (size, spaceX, spaceY, maxChars, color, shadowColor, outlineColor[, shadowMode])
      object.text.size = n(0);
      if (args.length >= 2) object.text.spaceX = n(1);
      if (args.length >= 3) object.text.spaceY = n(2);
      if (args.length >= 4) object.text.maxChars = n(3);
      if (args.length >= 5) object.text.color = n(4);
      if (args.length >= 6) object.text.shadowColor = n(5);
      if (args.length >= 7) object.text.outlineColor = n(6);
      if (args.length >= 8) object.text.shadowMode = n(7);
    } else if (command === 61) {
      // Siglus 1.1.102.1 0x52fba4 -> 0x5ca740 resets the button fields on a live sprite.
      object.button = undefined;
      object.buttonCall = undefined;
      object.buttonState = undefined;
      object.disabled = undefined;
      object.pushKeep = undefined;
      object.alphaTest = undefined;
    } else if (command === 160) object.clip = [n(0), n(1), n(2), n(3), n(4)];
    else if (command === 42)
      object.button = {
        id: n(0),
        group: (path[0] === 65 ? 100_000 : 0) + n(1),
        actionNo: args.length >= 3 ? n(2) : undefined,
        seNo: args.length >= 4 ? n(3) : undefined,
      };
    else if (command === 175) object.alphaTest = Boolean(n(0));
    else if (command === 98) object.pushKeep = Boolean(n(0));
    else if (command === 161) {
      // Native 0x555d2a writes the same enable flag and LTRB bounds as properties 149–153.
      object.sourceClipEnabled = Boolean(n(0));
      object.sourceClipBounds = [n(1), n(2), n(3), n(4)];
    } else if (command === 48) {
      const nextX = n(0);
      const nextY = n(1);
      if (object.x !== nextX || object.y !== nextY) {
        object.x = nextX;
        object.y = nextY;
        this.markObjectsDirty(path, object);
      }
    } else if (command === 49) object.scale = [n(0), n(1)];
    else if (command === 97) {
      object.disabled = true;
      object.buttonState = 'disable';
    } else if (command === 96) {
      object.disabled = false;
      object.buttonState = 'select';
    } else if (command === 95) {
      object.disabled = false;
      object.buttonState = 'normal';
    } else if (path.at(-1) === 0 && args.length === 5) {
      const animation: NonNullable<DrawObject['opacity']> = [n(0), n(1), n(2), n(3), n(4)];
      if (command === 72) {
        object.opacity = animation;
        object.opacityStarted = performance.now();
        object.opacityElapsed = undefined;
      } else {
        object.movement = animation;
        object.movementStarted = performance.now();
      }
    } else return undefined;
    return 0;
  }

  private async runObjectIntEvent(
    object: DrawObject,
    key: string,
    op: number,
    args: readonly Argument[],
    getVal: () => number,
    setVal: (value: number) => void,
  ): Promise<number | undefined> {
    const n = (i: number) => Number(args[i] ?? 0);
    const events = (object.intEvents ??= new Map());
    if (op === 0 || op === 7) {
      // intevent.set / set_real (0x5590e0): (target, time, delay, type[, start])
      const target = n(0) | 0;
      const duration = Math.max(0, n(1));
      const waitDelay = Math.max(0, n(2));
      const easing = n(3);
      const from = args.length >= 5 ? n(4) | 0 : getVal();
      const now = performance.now();
      setVal(target);
      events.set(key, {
        mode: 0,
        from,
        target,
        duration,
        delay: waitDelay,
        easing,
        started: now,
        endAt: now + duration + waitDelay,
      });
      return 0;
    }
    if (op === 1 || op === 8 || op === 2 || op === 9) {
      // intevent.loop / loop_real (0x5c2d00, mode=1) & turn / turn_real (0x5c2d40, mode=2):
      // (start, end, time, delay, type)
      const from = n(0) | 0;
      const target = n(1) | 0;
      const duration = Math.max(0, n(2));
      const waitDelay = Math.max(0, n(3));
      const easing = n(4);
      const now = performance.now();
      setVal(target);
      events.set(key, {
        mode: op === 1 || op === 8 ? 1 : 2,
        from,
        target,
        duration,
        delay: waitDelay,
        easing,
        started: now,
        endAt: Infinity,
      });
      return 0;
    }
    if (op === 3) {
      // intevent.end (0x5590e0): snap to target and mark inactive
      const ev = events.get(key);
      if (ev) setVal(ev.target);
      events.delete(key);
      return 0;
    }
    if (op === 4 || op === 10) {
      // intevent.wait (4) / wait_key (10) (0x677bc0)
      await this.renderObjects();
      const ev = events.get(key);
      if (ev && ev.mode === 0 && !this.skipping) {
        const rem = Math.ceil(ev.endAt - performance.now());
        if (rem > 0) {
          const skipped = await this.delay(rem, op === 10);
          events.delete(key);
          return op === 10 ? Number(skipped) : 0;
        }
      }
      events.delete(key);
      return 0;
    }
    if (op === 5) {
      // intevent.check (0x5590e0)
      const ev = events.get(key);
      if (!ev) return 0;
      if (ev.mode === 0 && performance.now() >= ev.endAt) {
        events.delete(key);
        return 0;
      }
      return 1;
    }
    return undefined;
  }

  async dispose(): Promise<void> {
    if (this.controller.signal.aborted) return;
    this.flushReadFlags();
    this.controller.abort();
    for (const active of this.pcmEvents.values()) active.cancel();
    this.pcmEvents.clear();
    this.frameActions.clear();
    this.frameActionCounters.clear();
    this.pendingButtonCalls.length = 0;
    this.g00Buffers.clear();
    this.movies.close();
    this.saveStore?.close();
    this.display.dispose();
    for (const key of [
      'phase',
      'audioState',
      'voice',
      'voiceDuration',
      'page',
      'background',
      'bgm',
      'sprite',
    ])
      delete this.root.dataset[key];
    await this.audio.dispose();
  }

  private async waitObjectMovie(movie: SiglusOmvPlayback, skippable: boolean): Promise<number> {
    await this.renderObjects();
    while (movie.playing) {
      if (await this.delay(16, skippable)) {
        movie.pause();
        return 1;
      }
    }
    return 0;
  }
}
