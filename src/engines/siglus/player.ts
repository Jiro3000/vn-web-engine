import {IndexedDbStore} from '../../platform/store.js';
import type {ByteSource} from '../../core/source.js';
import {SiglusScenePack} from '../../formats/siglus/scene-pack.js';
import {BrowserFullscreenMoviePlayer} from '../../video/fullscreen-movie.js';
import {
  SiglusAudio,
  type SiglusAudioKind,
  type SiglusBgmCheckpoint,
  type SiglusPcmCheckpoint,
} from './audio.js';
import {
  SiglusConfiguration,
  type SiglusFontSettings,
  type SiglusMoviePlayer,
  type SiglusScreenSettings,
} from './configuration.js';
import {
  SiglusDisplay,
  orderedObjects,
  type DrawObject,
  type SiglusFrameAction,
  type SiglusHistoryEntry,
} from './display.js';
import {eventEasing, timetable} from './timing.js';
import type {FanWipe} from './wipe.js';
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
const systemFlags = new Set([6, 7, 133, 134, 223, 251, 258]);
const scriptFlags = new Set([
  30, 31, 12, 13, 14, 15, 25, 27, 32, 33, 34, 35, 38, 39, 48, 51, 54, 55,
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
  range?: {to: number; duration: number};
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
  config: ReadonlyMap<string, string>;
  title: string;
  saveKey: string;
}

export async function openSiglusGame(files: ReadonlyMap<string, ByteSource>): Promise<SiglusGame> {
  const scenes = files.get('scene.pck');
  const configuration = files.get('gameexe.dat');
  if (!scenes || !configuration) throw new Error('Choose the Siglus game folder.');
  const sceneBytes = await scenes.read(0, scenes.size);
  const pack = new SiglusScenePack(sceneBytes);
  const config = pack.configuration(await configuration.read(0, configuration.size));
  const title = config.get('GAMENAME')?.split('"')[1]?.normalize('NFKC') ?? 'SiglusEngine';
  const hash = await crypto.subtle.digest('SHA-256', sceneBytes.slice().buffer);
  const saveKey =
    'siglus:' +
    Array.from(new Uint8Array(hash), (byte) => byte.toString(16).padStart(2, '0')).join('');
  return {files, pack, config, title, saveKey};
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
  cast: string[];
  castCostumes?: (string | null)[];
  speed: number;
  timestamp?: number;
  title?: string;
  comment?: string;
  thumbnail?: string;
  waitsForInput?: boolean;
  messagePause?: {
    readFlags: {scene: string; flag: number}[];
    voices: SiglusHistoryEntry['voices'];
  };
  history?: SiglusHistoryEntry[];
  historyPoints?: [number, HistoryPoint][];
  controls?: {
    systemMenu: boolean;
    messageButtons: boolean;
    disabledButtons: number[];
    save: boolean;
    load: boolean;
    controlSkip: boolean;
    skipUnread?: boolean;
    messageAnimationsOff?: boolean;
  };
}

export class SiglusPlayer {
  private readonly controller = new AbortController();
  private readonly display: SiglusDisplay;
  private readonly audio: SiglusAudio;
  private readonly objects = [new Map<number, DrawObject>(), new Map<number, DrawObject>()];
  private readonly messageObjects = new Map<number, Map<number, DrawObject>>();
  private readonly messageButtonOffsets = new Map<string, number[]>();
  private messageObjectsDirty = false;
  private systemObjects?: Map<number, DrawObject>;
  private systemObjectsDirty = false;
  private systemFrontObjects?: Map<number, DrawObject>;
  private systemFrontObjectsDirty = false;
  private systemFont?: {name?: string; bold?: boolean; shadow?: number};
  private messageHidden = false;
  private quakeStopped = false;
  private timeStopped = false;
  private systemSkipDisabled = false;
  private systemCallActive = false;
  private readSkipEnabled = false;
  private requestedFrameAction?: SiglusFrameAction;
  private readonly globalExtraSwitches = new Map<number, boolean>();
  private readonly pendingFrameWatchers = new Set<(typeof messageFrameWatchers)[number]>();
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
  private readonly filterDefaults: [number, number, number, number];
  private readonly filterColor: [number, number, number, number];
  private wait?: (value: number) => void;
  private readonly activeGroups = new Set<number>();
  private readonly decisions = new Map<number, number>();
  private decisionReady?: () => void;
  private objectsDirty = false;
  private pages = 0;
  private pendingText = false;
  private printing = false;
  private revealWholePage = false;
  private speed = 0;
  private readonly startScene: string;
  private readonly movies: BrowserFullscreenMoviePlayer;
  private vm!: SiglusVm;
  private saveEnabled = true;
  private messageButtonsEnabled = true;
  private readonly disabledMessageButtons = new Set<number>();
  private loadEnabled = true;
  private saveStore?: IndexedDbStore;
  private readonly saves = new Map<number, PlayerSave>();
  private readonly quickSaves = new Map<number, PlayerSave>();
  private savePoint?: PlayerSave;
  private dayStage = false;
  private selectedSave?: PlayerSave;
  private readonly system = new Map<number, number>();
  private movieError?: Error;
  private skip = false;
  private skipAllowed = true;
  private readonly stageProperties = new Map<string, Value>();
  private readonly castAnchors = new Map<string, Value>();
  private currentCast: string[] = [];
  private currentCastCostumes: (string | null)[] = [];
  private pendingBackground?: {
    name: string;
    pan: NonNullable<Parameters<SiglusDisplay['setBackground']>[2]>;
  };
  private get skipping(): boolean {
    return this.skipAllowed && !this.systemSkipDisabled && (this.skip || this.readSkipEnabled);
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
    this.playbackDefaults = {
      messageSpeed: 30,
      messageNowait: true,
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
        if (this.userMessageHidden) this.revealMessage();
        else this.wait?.(1);
      },
      windowOptions,
      (active) => {
        this.skip = active;
        if (active && this.skipping && this.pendingText) this.wait?.(1);
      },
      () => {
        if (!this.waitingForPage || !this.systemMenuEnabled || this.systemCallActive) return false;
        if (this.userMessageHidden) this.revealMessage();
        else this.wait?.(3);
        return true;
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
          this.backlog.length
        ) {
          event.preventDefault();
          this.wait?.(5);
          return;
        }
        if (
          event.deltaY <= 0 ||
          this.userMessageHidden ||
          (!this.waitingForPage && !this.printing) ||
          this.systemCallActive ||
          !this.systemOption('WHEEL_NEXT_MESSAGE_ONOFF')
        )
          return;
        event.preventDefault();
        this.wait?.(1);
      },
      {passive: false, signal: this.controller.signal},
    );
    const pointerChanged = () => {
      for (const watcher of messageFrameWatchers)
        if (
          this.system.get(watcher.flag) === 0 &&
          this.game.pack.commandNames.includes(watcher.command)
        )
          this.pendingFrameWatchers.add(watcher);
      if (this.pendingFrameWatchers.size && this.waitingForPage) this.wait?.(6);
    };
    for (const type of ['pointermove', 'pointerleave'] as const)
      this.display.stage.addEventListener(type, pointerChanged, {signal: this.controller.signal});
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
        yieldDelay: () => (this.systemOption('SLEEP_ONOFF') ? 16 : 0),
        message: (tag) => {
          this.beginMessage();
          if (tag.tag === 'name') this.display.name(tag.value);
          else {
            if (tag.readFlag !== undefined && tag.readFlag >= 0) {
              this.pageReadFlags.push({scene: tag.scene, flag: tag.readFlag});
              if (!this.skipUnread && !this.readFlags.get(tag.scene)?.has(tag.readFlag))
                this.readSkipEnabled = false;
            }
            return this.print(tag.value);
          }
        },
      },
      this.controller.signal,
      {scene: menu!.split('"')[1] ?? '_titlemenu', entry: Number(entry ?? 0)},
    );
    await this.vm.run(this.startScene);
  }

  private async callSystemScene(key: string): Promise<void> {
    const [scene, label] = this.game.config.get(key)?.split(',') ?? [];
    const name = scene?.split('"')[1];
    if (!name) throw new Error(`Missing Siglus ${key}`);
    if (this.systemCallActive) throw new Error('Nested Siglus system scene');
    const previous = [
      this.timeStopped,
      this.systemSkipDisabled,
      this.messageHidden,
      this.quakeStopped,
    ] as const;
    this.systemCallActive = true;
    this.systemFrontObjects = new Map();
    this.inputSampled = false;
    this.display.setSystemInput(true);
    try {
      await this.vm.callScene(name, label?.split('"')[1] ?? Number(label ?? 0));
      if (this.objectsDirty) await this.renderObjects();
    } finally {
      this.systemCallActive = false;
      this.systemFrontObjects = undefined;
      this.systemFrontObjectsDirty = false;
      this.display.clearSystemFrontObjects();
      this.releaseSystemObjects();
      this.systemCounters.clear();
      this.systemFont = undefined;
      this.display.clearEdits();
      this.display.setSystemInput(false);
      [this.timeStopped, this.systemSkipDisabled, this.messageHidden, this.quakeStopped] = previous;
      this.display.setScenePaused(this.timeStopped);
      this.display.setMessageDisplayed(!this.messageHidden && !this.userMessageHidden);
    }
    const selected = this.selectedSave;
    this.selectedSave = undefined;
    if (selected) this.loadSave(selected);
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
        filter: this.filterColor,
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
    const {name, bold, shadow} = this.messageFont;
    this.display.setMessageFont(name, bold, shadow);
  }

  private applyScreenSettings(): void {
    this.windowDisplay.setPresentation(this.screenSettings);
    if (this.windowDisplay.isExpanded !== this.screenSettings.fullscreen)
      this.windowDisplay.setFullscreen(this.screenSettings.fullscreen);
  }

  private counter(
    counters: Map<number, RealCounter>,
    id: number,
    member: number,
    args: SiglusCommand['args'],
  ): Value | undefined {
    const counter = counters.get(id);
    const now = performance.now();
    const elapsed = counter ? now - counter.start : 0;
    switch (member) {
      case 1: {
        // get
        if (!counter) return 0;
        const {from, range} = counter;
        if (!range) return from + Math.trunc(elapsed);
        if (elapsed >= range.duration) return range.to;
        return from + Math.trunc(((range.to - from) * elapsed) / range.duration);
      }
      case 2: // reset
        counters.delete(id);
        return 0;
      case 9: // start_real
        counters.set(id, {start: now, from: 0});
        return 0;
      case 11: // start_frame_real
        counters.set(id, {
          start: now,
          from: Number(args[0]),
          range: {to: Number(args[1]), duration: Number(args[2])},
        });
        return 0;
      case 14: // check_active
        return Number(Boolean(counter && (!counter.range || elapsed < counter.range.duration)));
    }
  }

  private releaseSystemObjects(): void {
    this.systemObjects = undefined;
    this.systemObjectsDirty = false;
    this.display.clearSystemObjects();
  }

  private objectAddress(
    path: readonly number[],
  ): {page: Map<number, DrawObject>; index: number} | undefined {
    let page: Map<number, DrawObject>;
    let index: number;
    if (path[0] === 65 && path[1] === 1 && path[2] === 2 && this.systemObjects) {
      page = this.systemObjects;
      index = 3;
    } else if ((path[0] === 37 || path[0] === 38) && path[1] === 2) {
      page = path[0] === 37 ? this.objects[1]! : (this.systemFrontObjects ?? this.objects[0]!);
      index = 2;
    } else if (path[0] === 38 && path[1] === 3 && path[2] === -1 && path[4] === 30) {
      const window = path[3]!;
      page = this.messageObjects.get(window) ?? new Map();
      this.messageObjects.set(window, page);
      index = 5;
    } else return;
    while (path[index] === -1 && path[index + 2] === 93) {
      const object = page.get(path[index + 1]!);
      if (!object) return;
      page = object.children ??= new Map();
      index += 3;
    }
    return {page, index};
  }

  private markObjectsDirty([root, member]: readonly number[]): void {
    if (root === 38 && member === 3) this.messageObjectsDirty = true;
    else if (root === 38 && this.systemFrontObjects) this.systemFrontObjectsDirty = true;
    else if (root === 38) this.objectsDirty = true;
    if (root === 65) this.systemObjectsDirty = true;
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
    );
  }

  private object(path: readonly number[]): DrawObject | undefined {
    const address = this.objectAddress(path);
    return address?.page.get(path[address.index + 1]!);
  }

  private property(path: number[], value?: Value): Value | undefined {
    const [page, list, array] = path;
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
    if (page !== undefined && page >>> 24 === 127) {
      const name = this.game.pack.propertyNames[page & 0xffff];
      if (name && /^\$pos_(fl|l|hl|nl|c|nr|hr|r|fr|m)$/.test(name)) {
        if (value !== undefined) this.castAnchors.set(name, value);
        return this.castAnchors.get(name) ?? 0;
      }
      if (
        name &&
        /^\$(bg_(?:name|name_prev|wipe|set_ready|type|file_exist)|bs_(?:name|name_info|dress_info|wipe_set|exist_decide|size_info|posx_next|posy_next)|cha_dress)$/.test(
          name,
        )
      ) {
        const key = [name, ...path.slice(1)].join('.');
        if (value !== undefined) this.stageProperties.set(key, value);
        return this.stageProperties.get(key) ?? (name.includes('name') ? '' : 0);
      }
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
    const address = this.objectAddress(path);
    if (!address || path[address.index] !== -1) return;
    const property = path[address.index + 2];
    const id = path[address.index + 1]!;
    let object = address.page.get(id);
    if (!object) {
      if (value === undefined) return 0;
      object = {name: '', frames: [], x: 0, y: 0, pattern: 0, visible: false};
      address.page.set(id, object);
    }
    if (property === 0) {
      if (value !== undefined && object.visible !== Boolean(value)) {
        object.visible = Boolean(value);
        this.markObjectsDirty(path);
      }
      return Number(object.visible);
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
    if (!field) return;
    if (value !== undefined) {
      const next = field === 'blend' ? Math.min(4, Math.max(0, Number(value))) : Number(value);
      if (object[field] !== next) {
        object[field] = next;
        this.markObjectsDirty(path);
      }
    }
    return object[field] ?? (field === 'transparency' ? 255 : 0);
  }

  private delay(time?: number, skippable = false, skipImmediately = true): Promise<number> {
    const signal = this.controller.signal;
    signal.throwIfAborted();
    if (skipImmediately && skippable && this.skipping) return Promise.resolve(1);
    return new Promise((resolve, reject) => {
      let timer: ReturnType<typeof setTimeout> | undefined;
      const finish = (value: number): void => {
        clearTimeout(timer);
        signal.removeEventListener('abort', cancel);
        if (this.wait === finish) this.wait = undefined;
        resolve(value);
      };
      const cancel = (): void => {
        clearTimeout(timer);
        if (this.wait === finish) this.wait = undefined;
        reject(signal.reason);
      };
      signal.addEventListener('abort', cancel, {once: true});
      if (skippable) this.wait = finish;
      if (time !== undefined) timer = setTimeout(() => finish(0), Math.max(0, time));
    });
  }

  private async pageInput(continuesMessage = false): Promise<void> {
    if (!this.pendingText) return;
    this.revealWholePage = false;
    this.pageAlreadyRead =
      this.pageReadFlags.length > 0 &&
      this.pageReadFlags.every(({scene, flag}) => this.readFlags.get(scene)?.has(flag));
    if (!this.pageAlreadyRead && !this.skipUnread) this.readSkipEnabled = false;
    this.display.finishMessageSlide();
    if (continuesMessage) {
      this.root.dataset.page = String(++this.pages);
      this.tracePage();
      if (!this.skipping && this.saveEnabled) {
        this.savePoint = {
          ...this.captureSave(),
          messagePause: {readFlags: [...this.pageReadFlags], voices: this.pageVoices},
        };
      }
      await this.waitAtPage();
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
    if (changed)
      localStorage.setItem(
        this.game.saveKey + ':read',
        JSON.stringify(Array.from(this.readFlags, ([scene, flags]) => [scene, [...flags]])),
      );
    this.pageReadFlags = [];
    const history = {...this.display.saveMessage(), voices: this.pageVoices};
    this.addHistory(history);
    if (this.loadEnabled && this.saveEnabled)
      this.historyPoints.set(history, this.captureSave(true, false));
    this.pageVoices = [];
    this.root.dataset.page = String(++this.pages);
    this.tracePage();
    if (!this.skipping && this.saveEnabled) this.savePoint = this.captureSave();
    await this.waitAtPage();
    if (!this.systemOption('KOE_DONT_STOP_ONOFF')) this.audio.stop('voice');
    this.pendingText = false;
  }

  private beginMessage(): void {
    if (this.pendingText) return;
    this.pageReadFlags = [];
    this.display.clearText();
    this.pendingText = true;
    this.pageCharacters = 0;
    this.revealWholePage = false;
  }

  private print(value: string): void | Promise<void> {
    const characters = Array.from(value);
    this.pageCharacters += characters.length;
    const speed = this.speed || (this.playback.messageNowait ? 0 : this.playback.messageSpeed);
    if (speed <= 0 || !characters.length || this.skipping || this.revealWholePage) {
      this.display.append(value);
      return;
    }
    return this.revealRun(value, characters, speed);
  }

  private async revealRun(value: string, characters: string[], speed: number): Promise<void> {
    const run = this.display.appendRun('');
    const started = performance.now();
    let visible = 0;
    this.printing = true;
    try {
      while (visible < characters.length) {
        const next = run.ruby ? characters.length : visible + 1;
        const remaining = next * speed - (performance.now() - started);
        if (await this.delay(Math.max(remaining, 0), true)) {
          this.revealWholePage = true;
          run.reveal(value);
          return;
        }
        visible = Math.min(
          characters.length,
          Math.max(next, Math.floor((performance.now() - started) / speed)),
        );
        run.reveal(visible === characters.length ? value : characters.slice(0, visible).join(''));
      }
    } finally {
      this.printing = false;
    }
  }

  private revealMessage(): void {
    this.setUserMessageHidden(false);
    this.wait?.(4);
  }

  private tracePage(): void {
    if (!this.trace) return;
    this.root.dispatchEvent(new CustomEvent('siglus-page', {detail: {skipping: this.skipping}}));
  }

  private setUserMessageHidden(hidden: boolean): void {
    if (hidden) this.readSkipEnabled = false;
    this.userMessageHidden = hidden;
    this.display.setMessageDisplayed(!hidden && !this.messageHidden);
  }

  private frameActionState(
    {id, type, state, slot, call}: SiglusFrameAction,
    readSkipping: boolean,
  ): 'hidden' | 'disabled' | 'enabled' {
    if (type === 'auto_mode' && state !== Number(this.autoEnabled)) return 'hidden';
    if (type === 'read_skip' && state !== Number(this.readSkipEnabled)) return 'hidden';
    if (slot !== undefined && state !== Number(this.globalExtraSwitch(slot))) return 'hidden';
    if (this.disabledMessageButtons.has(id) || (readSkipping && type !== 'read_skip'))
      return 'disabled';
    let enabled: boolean;
    switch (type) {
      case 'auto_mode':
      case 'global_switch':
      case 'none':
        enabled = Boolean(call);
        break;
      case 'read_skip':
        enabled =
          Boolean(call) &&
          (this.readSkipEnabled || (this.skipAllowed && (this.pageAlreadyRead || this.skipUnread)));
        break;
      case 'config':
        enabled = this.game.config.has('CONFIG_SCENE');
        break;
      case 'msg_log':
        enabled = this.backlog.length > 0;
        break;
      case 'koe_play':
        enabled = Boolean(this.backlog.at(-1)?.voices.length);
        break;
      case 'close_mwnd':
        enabled = true;
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

  private async refreshMessageFrame(): Promise<void> {
    const queued = [...this.pendingFrameWatchers];
    this.pendingFrameWatchers.clear();
    for (const {command} of queued) await this.runOriginalCommand(command);
    if (queued.length) await this.renderMessageObjects();
  }

  private async runOriginalCommand(command: string, parameters: Argument[] = []): Promise<void> {
    const index = this.game.pack.commandNames.indexOf(command);
    const scene = this.game.pack.sceneNames[this.game.pack.commandScenes[index * 2]!];
    if (scene) await this.vm.callScene(scene, command, parameters);
  }

  private async waitAtPage(): Promise<void> {
    for (;;) {
      const readSkipping = this.skipping && this.readSkipEnabled && !this.skip;
      const showControls = this.messageButtonsEnabled && (!this.skipping || readSkipping);
      if (showControls) {
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
        const autoWait =
          this.autoEnabled && !this.userMessageHidden
            ? this.playback.autoMinimumWait + this.playback.autoCharacterWait * this.pageCharacters
            : undefined;
        const deadline = autoWait === undefined ? undefined : performance.now() + autoWait;
        do {
          this.waitingForPage = false;
          if (this.pendingFrameWatchers.size) await this.refreshMessageFrame();
          this.waitingForPage = true;
          if (this.requestedFrameAction) {
            result = 1;
            break;
          }
          // Give Read Skip a browser frame and keep its button between consecutive pages.
          result =
            readSkipping && showControls
              ? await this.delay(16, true, false)
              : await this.delay(
                  deadline === undefined ? undefined : deadline - performance.now(),
                  true,
                );
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
      if (result === 3) {
        await this.callSystemScene('CANCEL_SCENE');
        continue;
      }
      if (!menu) return;
      const {type, sound, call} = menu;
      await this.playSystemSound(sound);
      if (call) await this.callSystemScene(call);
      else if (type === 'msg_log') await this.openHistory();
      else if (type === 'close_mwnd') this.setUserMessageHidden(true);
      else if (type === 'koe_play')
        void this.replayHistoryVoice(this.backlog.at(-1)).catch((error) => {
          if (!this.controller.signal.aborted) console.error(error);
        });
      else if (type === 'save') await this.callSystemScene('SAVE_SCENE');
      else if (type === 'load') await this.callSystemScene('LOAD_SCENE');
      else if (type === 'config') await this.callSystemScene('CONFIG_SCENE');
    }
  }

  private captureSave(waitsForInput = true, includeHistory = true, commandResult = 0): PlayerSave {
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
      background,
      bgm: bgmPlayback?.name,
      bgmPlayback,
      bgmLevel: this.audio.channelLevel('bgm'),
      pcmPlayback: this.audio.pcmCheckpoint(),
      voiceLevel: this.audio.channelLevel('voice'),
      cast: [...this.currentCast],
      castCostumes: [...this.currentCastCostumes],
      speed: this.speed,
      title: this.saveTitle,
      waitsForInput,
      history,
      historyPoints: history ? historyPoints : undefined,
      controls: {
        systemMenu: this.systemMenuEnabled,
        messageButtons: this.messageButtonsEnabled,
        disabledButtons: [...this.disabledMessageButtons],
        save: this.saveEnabled,
        load: this.loadEnabled,
        controlSkip: this.skipAllowed,
        skipUnread: this.skipUnreadOverride,
        messageAnimationsOff: this.scriptMessageAnimationsDisabled || undefined,
      },
    };
  }

  private saveSlotAddress(number: number): [Map<number, PlayerSave>, number] {
    // The slot browser addresses quick saves directly after the ordinary save range.
    const count = Number(this.game.config.get('SAVE.CNT'));
    const quickCount = Number(this.game.config.get('QUICK_SAVE.CNT'));
    if (number >= count && number < count + quickCount) return [this.quickSaves, number - count];
    return [this.saves, number];
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
      const match = /^(saves|quick-saves):(\d+)$/.exec(key);
      if (!match) continue;
      const save: PlayerSave = JSON.parse(decoder.decode(value));
      if (save.version === 1)
        (match[1] === 'saves' ? this.saves : this.quickSaves).set(Number(match[2]), save);
    }
  }

  private writeSlot(slots: Map<number, PlayerSave>, slot: number, save: PlayerSave): Promise<void> {
    return this.updateSlots(slots, [[slot, save]]);
  }

  private async updateSlots(
    slots: Map<number, PlayerSave>,
    changes: [number, PlayerSave | undefined][],
  ): Promise<void> {
    const kind = slots === this.saves ? 'saves:' : 'quick-saves:';
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
    this.disabledMessageButtons.clear();
    for (const id of save.controls?.disabledButtons ?? []) this.disabledMessageButtons.add(id);
    this.saveEnabled = save.controls?.save ?? true;
    this.loadEnabled = save.controls?.load ?? true;
    this.skipAllowed = save.controls?.controlSkip ?? true;
    this.skipUnreadOverride = save.controls?.skipUnread;
    this.scriptMessageAnimationsDisabled = save.controls?.messageAnimationsOff ?? false;
    this.audio.resetPlayback();
    this.display.endEffect();
    this.display.cinema(0);
    this.stageProperties.clear();
    for (const [key, value] of save.stage) this.stageProperties.set(key, value);
    await this.restoreCastCostumes(save);
    this.pendingBackground = undefined;
    if (save.background) await this.display.setBackground(save.background, 0);
    await this.cast(save.cast, -1, save.castCostumes);
    const music = save.bgmPlayback ?? (save.bgm ? {name: save.bgm, loop: true} : undefined);
    await this.audio.restoreBgm(music, save.bgmLevel);
    this.audio.setChannelLevel('voice', save.voiceLevel ?? 255, 0);
    await this.audio.restorePcm(save.pcmPlayback ?? []);
    this.speed = save.speed;
    this.saveTitle = save.title ?? '';
    const waitsForInput = save.waitsForInput ?? true;
    if (waitsForInput) {
      const message = save.message;
      const faceCostume = message.face
        ? (message.faceCostume ?? (await this.spriteCostume(message.face, 0, 1)))
        : undefined;
      await this.display.loadMessage({...message, faceCostume});
      this.pageCharacters = save.message.text.reduce(
        (count, {text}) => count + Array.from(text.replaceAll('\n', '')).length,
        0,
      );
      this.pageAlreadyRead =
        !save.messagePause ||
        this.pageReadFlags.every(({scene, flag}) => this.readFlags.get(scene)?.has(flag));
    } else {
      this.display.closeMessage();
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
    await this.renderMessageObjects();
    this.savePoint = {...save, vm: this.vm.checkpoint()};
    this.root.dataset.loaded = 'true';
    if (waitsForInput) {
      this.root.dataset.page = String(++this.pages);
      this.tracePage();
      await this.waitAtPage();
    }
    this.pendingText = Boolean(save.messagePause);
  }

  private choose({id, group}: NonNullable<DrawObject['button']>): void {
    this.skip = false;
    this.decisions.set(group, id);
    this.decisionReady?.();
  }

  private groupCommand(group: number, command: number): Value | undefined {
    switch (command) {
      case 2: // start
      case 10: // start_cancel
        this.activeGroups.add(group);
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
        this.activeGroups.delete(group);
        this.decisions.delete(group);
        return 0;
      case 6: // get_hit_no
        return this.display.buttonState(group, false);
      case 7: // get_pushed_no
        return this.display.buttonState(group, true);
    }
    return undefined;
  }

  private async nextInput(): Promise<number> {
    if ((!this.systemCallActive && !this.activeGroups.size) || this.decisions.size) return 0;
    // The script polls group state, then calls input.next to yield between samples.
    // Wake on a decision or on the next frame so polling scripts can keep animating.
    const signal = this.controller.signal;
    signal.throwIfAborted();
    return new Promise((resolve, reject) => {
      const finish = (): void => {
        clearTimeout(timer);
        signal.removeEventListener('abort', abort);
        this.decisionReady = undefined;
        resolve(0);
      };
      const abort = (): void => {
        clearTimeout(timer);
        this.decisionReady = undefined;
        reject(signal.reason);
      };
      const timer = setTimeout(finish, 16);
      this.decisionReady = finish;
      signal.addEventListener('abort', abort, {once: true});
    });
  }

  private wipeDuration(ms: number): number {
    return this.skipping || this.systemOption('NO_WIPE_ANIME_ONOFF') ? 0 : ms;
  }

  private async wipe(ms: number, fan?: FanWipe): Promise<void> {
    const back = this.objects[1]!;
    this.display.closeMessage();
    this.pageVoices = [];
    this.currentCast = [];
    this.currentCastCostumes = [];
    await this.display.show(
      orderedObjects(back),
      this.wipeDuration(ms),
      (id) => this.choose(id),
      fan,
    );
    this.objects[0] = this.copyObjects(back);
    this.objectsDirty = false;
  }

  private beginDayObjects(): void {
    this.dayStage = true;
    this.objects[0]!.clear();
    this.objects[1]!.clear();
    this.objectsDirty = false;
  }

  private clearDayObjects(): void {
    if (!this.dayStage) return;
    this.beginDayObjects();
    this.dayStage = false;
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
      this.systemObjectsDirty = false;
      await this.display.showSystemObjects(orderedObjects(this.systemObjects), (button) =>
        this.choose(button),
      );
    }
    if (this.objectsDirty && !this.timeStopped) {
      this.objectsDirty = false;
      await this.display.refreshObjects(orderedObjects(this.objects[0]!), (button) =>
        this.choose(button),
      );
    }
  }

  private async renderMessageObjects(): Promise<void> {
    if (!this.messageObjectsDirty) return;
    this.messageObjectsDirty = false;
    const objects = this.messageObjects.get(this.display.messageWindow);
    await this.display.showMessageObjects(objects ? orderedObjects(objects) : []);
  }

  private copyObjects(objects: Map<number, DrawObject>): Map<number, DrawObject> {
    return new Map([...objects].map(([id, object]) => [id, this.copyObject(object)]));
  }

  private copyObject(object: DrawObject): DrawObject {
    return {
      ...object,
      text: object.text && {...object.text},
      clip: object.clip && [...object.clip],
      children: object.children && this.copyObjects(object.children),
    };
  }

  private backgroundName(name: string): string {
    const key = name.toLowerCase();
    return /^(?:b_)?bg\d\d$/.test(key) ? key + 'a' : key;
  }

  private async fade(name: string, transition: number): Promise<void> {
    this.clearDayObjects();
    this.pendingText = false;
    this.display.closeMessage();
    this.display.endEffect();
    this.stageProperties.set('$bg_name.-1.0', 'none');
    this.stageProperties.set('$bg_set_ready', 0);
    this.stageProperties.set('$bs_name.-1.0', 'none');
    this.pendingBackground = undefined;
    await this.display.setBackground(name, this.wipeDuration(fadeTimes[transition] ?? 0));
    await this.cast([], -1);
  }

  private async background(
    name: string,
    fade: number,
    pan?: Parameters<SiglusDisplay['setBackground']>[2],
  ): Promise<void> {
    this.clearDayObjects();
    this.pendingText = false;
    this.display.closeMessage();
    this.stageProperties.set('$bg_name.-1.0', name);
    this.stageProperties.set('$bg_name_prev.-1.0', name);
    await this.display.setBackground(
      this.backgroundName(name),
      this.wipeDuration(fadeTimes[fade] ?? 0),
      pan,
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
  ): Promise<void> {
    const resolved = names.map((name) =>
      /^[a-z]{2}$/i.test(name)
        ? (this.currentCast.find((previous) => spriteActor(previous) === name) ?? 'none')
        : name,
    );
    this.currentCast = resolved;
    this.currentCastCostumes = resolved.map(() => null);
    const positions = resolved.some((name) => name && !name.startsWith('none'))
      ? await this.castPositions(resolved)
      : undefined;
    const sprites = [];
    for (const [slot, name] of resolved.entries()) {
      if (!name || name.startsWith('none')) continue;
      const costume = costumes?.[slot] ?? (await this.spriteCostume(name, slot, 0));
      this.currentCastCostumes[slot] = costume;
      sprites.push({name, costume, position: positions?.[slot]});
    }
    await this.display.showCast(sprites, this.wipeDuration(fadeTimes[fade] ?? 0));
  }

  private async castPositions(names: readonly string[]): Promise<[number, number][] | undefined> {
    const exportIndex = this.game.pack.commandNames.indexOf('$bs_disp_in');
    const scene = this.game.pack.sceneNames[this.game.pack.commandScenes[exportIndex * 2]!];
    const command = '$$bs_wipe_ready01';
    if (
      !this.castAnchors.size ||
      !scene ||
      !this.game.pack.scene(scene).commandNames.includes(command)
    )
      return;
    for (let slot = 0; slot < 6; slot++) {
      const name = names[slot] || 'none';
      this.stageProperties.set('$bs_exist_decide.-1.' + slot, name.indexOf('none'));
      this.stageProperties.set('$bs_size_info.-1.' + slot, /^bs([123])_/.exec(name)?.[1] ?? '2');
    }
    await this.vm.callScene(scene, command);
    return names.map((_, slot) => [
      Number(this.stageProperties.get('$bs_posx_next.-1.' + slot) ?? 0),
      Number(this.stageProperties.get('$bs_posy_next.-1.' + slot) ?? 0),
    ]);
  }

  private async spriteCostume(name: string, slot: number, portrait: number): Promise<string> {
    this.stageProperties.set('$bs_name_info.-1.' + slot, spriteActor(name));
    await this.runOriginalCommand('$dress_control', [slot, portrait]);
    return String(this.stageProperties.get('$bs_dress_info.-1.' + slot) || '01');
  }

  private async movie(name: string, skippable: boolean): Promise<number> {
    this.skip = false;
    this.movieError = undefined;
    this.root.dataset.movie = name;
    this.display.pageControls();
    const volume = this.audio.volume('MOV');
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
        await this.background(s(0), n(1));
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
          if (!name.includes('none')) await this.background(name, 0, pan);
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
        );
        break;
      case '$$change_bs_only_face': {
        const names = [...this.currentCast];
        for (const [i, value] of args.entries()) {
          const face = String(value);
          if (face === 'none') break;
          const index = names.findIndex((name) => spriteActor(name) === spriteActor(face));
          const prefix = index < 0 ? undefined : /^bs\d_/.exec(names[index]!)?.[0];
          names[index < 0 ? i : index] = prefix && !face.startsWith('bs') ? prefix + face : face;
        }
        await this.cast(names, 0);
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
        this.display.recollect(true);
        break;
      case '$ef_end':
        this.display.endEffect();
        break;
      case '$sc_sepia':
        this.display.sepia(Boolean(n(0)));
        break;
      case '$fade':
        await this.fade(s(1), n(0));
        break;
      case '$sc_cinemascope':
        this.display.cinema(n(0), n(1));
        break;
      case '$sc_cinemascope_off':
        this.display.cinema(0);
        break;
      case '$screen_shake':
        if (!this.skipping) this.display.shake(n(0));
        if (n(2)) await this.delay(350, true);
        break;
      case '$ef_line_start1':
        await this.display.lineEffect(n(2));
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
  private pageVoices: SiglusHistoryEntry['voices'] = [];

  private addHistory(entry: SiglusHistoryEntry): void {
    if (!entry.text.length) return;
    this.backlog.push(entry);
    const limit = Number(this.game.config.get('MSGBK.HISTORY_CNT') ?? 1000);
    if (this.backlog.length > limit) this.backlog.splice(0, this.backlog.length - limit);
  }

  private replayGeneration = 0;

  private async replayHistoryVoice(entry?: SiglusHistoryEntry): Promise<void> {
    const generation = ++this.replayGeneration;
    for (const {id, character} of entry?.voices ?? []) {
      if (generation !== this.replayGeneration) break;
      await this.audio.voice(id, 'history-voice', character);
      await this.audio.waitForEnd('history-voice');
    }
  }

  private async openHistory(): Promise<void> {
    if (!this.backlog.length) return;
    this.readSkipEnabled = false;
    let focus: SiglusHistoryEntry | undefined;
    for (;;) {
      this.display.setScenePaused(true);
      let selected: SiglusHistoryEntry | undefined;
      try {
        selected = await this.display.showHistory(
          this.backlog,
          (entry, sound) => {
            void (async () => {
              if (sound !== undefined) await this.playSystemSound(sound);
              if (entry) await this.replayHistoryVoice(entry);
            })().catch((error) => {
              if (!this.controller.signal.aborted) console.error(error);
            });
          },
          (entry) => this.loadEnabled && this.historyPoints.has(entry),
          focus,
        );
      } finally {
        this.replayGeneration++;
        this.audio.stop('history-voice');
        this.display.setScenePaused(this.timeStopped);
      }
      if (!selected) return;
      const point = this.historyPoints.get(selected);
      if (!point) return;
      focus = selected;
      this.historyTarget = {
        ...point,
        history: this.backlog.slice(0, this.backlog.indexOf(selected) + 1),
      };
      try {
        await this.callSystemScene('MSGBK.LOAD_CALL');
      } finally {
        this.historyTarget = undefined;
      }
    }
  }

  private async playBgm(name: string, fade = 0, crossfade = 0): Promise<void> {
    if (this.root.dataset.bgm?.toLowerCase() === name.toLowerCase()) return;
    await this.audio.bgm(name, true, fade, crossfade);
  }

  private async command(command: SiglusCommand): Promise<Value | undefined> {
    if (command.name) return this.include(command);
    const {args, path} = command;
    const [root, member] = path;
    const n = (i: number) => Number(args[i] ?? 0);
    const s = (i: number) => String(args[i] ?? '');
    if (path.length === 1) {
      switch (root) {
        case 80: // capture
          if (!this.systemCallActive && command.scene !== '__sys_day_change') return undefined;
          if (this.savePoint && !this.systemCallActive) {
            this.savePoint.thumbnail = this.display.captureThumbnail();
          } else if (this.savePoint) {
            const bgmPlayback = this.audio.bgmCheckpoint();
            this.savePoint = {
              ...this.savePoint,
              thumbnail: this.display.captureThumbnail(),
              bgm: bgmPlayback?.name,
              bgmPlayback,
              bgmLevel: this.audio.channelLevel('bgm'),
              pcmPlayback: this.audio.pcmCheckpoint(),
              voiceLevel: this.audio.channelLevel('voice'),
            };
          }
          return 0;
        case 81: // capture_free
          if (this.systemCallActive || command.scene === '__sys_day_change') return 0;
          return undefined;
        case 6: // disp
        case 96: // frame
          await this.renderObjects();
          if (root === 6 && this.systemCallActive && !this.inputSampled) {
            await this.nextInput();
            this.display.sampleInput();
          }
          this.inputSampled = false;
          break;
        case 7:
          if (n(0) === 60 && Array.isArray(args[3])) {
            const [softness = 0, quadrant = 0, reverse = 0] = args[3];
            await this.wipe(n(1), {
              softness: softness < 0 || softness >= 8 ? 1 : 1 - 2 ** -softness,
              quadrant: quadrant >= 0 && quadrant < 4 ? quadrant : 0,
              reverse: Boolean(reverse),
            });
          } else await this.wipe(n(1));
          break;
        case 8:
          this.display.selectMessageWindow(n(0));
          this.messageObjectsDirty = true;
          await this.renderMessageObjects();
          break;
        case 10:
          this.display.closeMessage();
          this.pageVoices = [];
          this.pendingText = false;
          break;
        case 12:
          if (!this.pendingText) {
            this.pageCharacters = 0;
            this.revealWholePage = false;
          }
          this.pendingText = true;
          await this.print(s(0));
          break;
        case 13:
          await this.pageInput(true);
          break;
        case 15:
          this.display.newline();
          break;
        case 14:
          await this.pageInput();
          break;
        case 16:
          this.display.setTextSize(args.length ? n(0) : undefined);
          break;
        case 18:
          this.pageVoices = [
            ...this.pageVoices,
            {id: n(0), character: args.length > 1 ? n(1) : undefined},
          ];
          await this.audio.voice(n(0), 'voice', args.length > 1 ? n(1) : undefined);
          break;
        case 22:
          this.display.setMessageFrame(n(0));
          break;
        case 54:
          if (!this.skipping) await this.delay(n(0));
          break;
        case 55:
          return this.delay(n(0), true);
        case 61:
          if (s(0)) this.beginMessage();
          this.display.annotate(s(0));
          break;
        case 74:
          this.saveTitle = s(0);
          break;
        case 75:
          return this.saveTitle;
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
        case 110: // No selection point in the current story flow.
          return 0;
        case 111:
          break; // No selection checkpoint on a new session.
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
        case 118:
          this.backlog.length = 0;
          break;
        default:
          return undefined;
      }
      return 0;
    }
    if (root === 40 && member === -1 && path.length === 4) {
      const id = path[2]!;
      const operation = path[3]!;
      if (operation === 6 || operation === 8) {
        const elapsed = this.counter(this.sceneCounters, id, 1, []) ?? 0;
        return this.delay(n(0) - Number(elapsed), operation === 8);
      }
      return this.counter(this.sceneCounters, id, operation, args);
    }
    if ((root === 37 || root === 38) && member === 2) return this.objectCommand(command);
    if (root === 38 && member === 3) {
      if (path[4] === 30) return this.objectCommand(command);
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
        const font = (this.systemFont ??= {});
        switch (path[2]) {
          case 87:
          case 89:
            font.name = path[2] === 87 ? s(0) : undefined;
            return 0;
          case 90:
          case 91:
            font.bold = path[2] === 90 ? Boolean(n(0)) : undefined;
            return 0;
          case 93:
          case 94:
            font.shadow = path[2] === 93 ? n(0) : undefined;
            return 0;
        }
      }
      if (member === 6 && path.length === 5 && path[2] === -1)
        return this.counter(this.systemCounters, path[3]!, path[4]!, args);
      if (path.length === 3 && member === 1 && path[2] === 2) return undefined;
      if (member === 1 && path[2] === 2) return this.objectCommand(command);
      if (path.length === 2 && member === 8) return Number(Boolean(this.systemObjects));
      if (path.length === 2 && member === 4) {
        this.systemObjects ??= new Map();
        return 0;
      }
      if (path.length === 2 && member === 5) {
        this.releaseSystemObjects();
        return 0;
      }
    }
    if (root === 38 && member === 6 && path.length === 5 && path[2] === -1)
      return this.groupCommand(path[3]!, path[4]!);
    if (root === 63) {
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
      if (member === 1 || member === 2 || member === 3) {
        await this.callSystemScene(
          member === 1 ? 'SAVE_SCENE' : member === 2 ? 'LOAD_SCENE' : 'CONFIG_SCENE',
        );
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
      if (member === 69 || member === 169)
        return Number(Boolean(member === 69 ? this.saveSlot(n(0)) : this.quickSaves.get(n(0))));
      if (member === 79 || member === 170)
        return this.newestSlot(
          member === 79 ? this.saves : this.quickSaves,
          n(0),
          args.length ? n(1) : Infinity,
        );
      if (member === 252 || member === 255) return Number(this.saveEnabled);
      if (member === 259 || member === 262) return Number(this.loadEnabled);
      const slot = this.saveSlot(n(0));
      const quick = this.quickSaves.get(n(0));
      if (member === 78 || member === 179) return (member === 78 ? slot : quick)?.title ?? '';
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
        return message?.text.map(({text}) => text).join('') ?? '';
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
        const [slots, first] =
          member === 22 ? this.saveSlotAddress(n(0)) : ([this.quickSaves, n(0)] as const);
        const [other, second] =
          member === 22 ? this.saveSlotAddress(n(1)) : ([this.quickSaves, n(1)] as const);
        if (slots !== other) return undefined;
        const source = slots.get(first);
        const target = slots.get(second);
        if (!source && !target) return 0;
        await this.updateSlots(slots, [
          [first, target],
          [second, source],
        ]);
        return 1;
      }
      if (member === 67 || member === 128) {
        const slots = member === 67 ? this.saves : this.quickSaves;
        const save = slots.get(n(0));
        if (!save) return 0;
        await this.writeSlot(slots, n(1), save);
        return 1;
      }
      if (member === 249 || member === 18) {
        if (!this.saveEnabled || !this.savePoint) return 0;
        const slots = member === 249 ? this.saves : this.quickSaves;
        await this.writeSlot(slots, n(0), {
          ...this.savePoint,
          timestamp: Date.now(),
          comment: slots.get(n(0))?.comment,
        });
        this.root.dataset.savedPage = String(this.pages);
        return 1;
      }
      if (member === 256 || member === 20) {
        const save = member === 256 ? slot : quick;
        if (save && this.loadEnabled) {
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
      if (member === 200) {
        this.readSkipEnabled = Boolean(n(0));
        return 0;
      }
      if (member === 310 && this.historyTarget && this.systemCallActive) {
        this.selectedSave = this.historyTarget;
        this.vm.returnFromHostScene();
      }
      if (member === 192) {
        await this.openHistory();
        return 0;
      }
      if (member === 201) return Number(this.readSkipEnabled);
      if (member === 206)
        return Number(this.skipAllowed && (this.pageAlreadyRead || this.skipUnread));
      if (member === 213 || member === 234) return 0;
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
      if (member === 242) {
        void this.dispose();
        return 0;
      }
      if (member === 235 && args.every((arg) => arg === 0)) {
        this.display.closeMessage();
        this.pendingText = false;
        this.readSkipEnabled = this.autoEnabled = false;
        this.savePoint = undefined;
        this.sceneCounters.clear();
        this.clearDayObjects();
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
      if (systemFlags.has(member!)) {
        if (member === 6 || member === 7) this.systemMenuEnabled = member === 6;
        if (member === 251) this.saveEnabled = Boolean(n(0));
        if (member === 258) this.loadEnabled = Boolean(n(0));
        return 0;
      }
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
    if (root === 64 && member === 17) return Number(this.messageHidden);
    if (root === 64 && member === 8) {
      this.messageHidden = Boolean(n(0));
      this.display.setMessageDisplayed(!this.messageHidden && !this.userMessageHidden);
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
    if (root === 64 && member === 74) {
      this.skipUnreadOverride = Boolean(n(0));
      return 0;
    }
    if (root === 64 && member === 75) return Number(this.skipUnread);
    if (root === 64 && scriptFlags.has(member!)) {
      if (member === 25 || member === 27) this.speed = n(0);
      return 0;
    }
    if (root === 97 && member === -1 && path.length === 4)
      return this.display.editBox(path[2]!, path[3]!, n, s);
    if (root === 86 && member === 2) {
      this.display.clearInput();
      return 0;
    }
    if (root === 86 && member === 3) {
      await this.nextInput();
      this.display.sampleInput();
      this.inputSampled = true;
      return 0;
    }
    if (root === 86 && (member === 0 || member === 1) && path.length === 3)
      return this.display.inputState(member, path[2]!);
    if (root === 70 && member === 25 && path[2] === -1 && path[4] === 8) {
      this.display.endShake(n(0));
      return 0;
    }
    if (root === 53 && member === -1 && path.length === 4) {
      if (path[3] === 2) return 0;
      // Input events drive the frame watchers. The release player has no debug shortcuts.
      if (
        path[3] === 1 &&
        n(0) === -1 &&
        (messageFrameWatchers.some(({command}) => command === s(1)) ||
          s(1) === '$debug_key_shortcut')
      )
        return 0;
    }
    if (root === 92 && member === 0)
      return Number(!this.root.ownerDocument.hidden && this.root.ownerDocument.hasFocus());
    if (root === 46 && member !== undefined && member >= 0 && member <= 3)
      return this.display.pointerPosition(member % 2);
    if (root === 46 && member === 5) return this.display.inputWheel();
    if (root === 46 && (member === 6 || member === 7) && path.length === 3)
      return this.display.inputState(member === 6 ? 1 : 0, path[2]!);
    if (root === 46 && (member === 4 || member === 8)) return 0;
    if (root === 39 && member === 0)
      return n(0) + Math.floor(Math.random() * (Math.max(0, n(1) - n(0)) + 1));
    if (root === 39 && member === 1 && args.length === 1) return String(n(0));
    if (root === 39 && member === 2 && args.length >= 3) {
      const segments = args.slice(3);
      if (segments.every(Array.isArray)) return timetable(n(0) - n(1), n(2), segments);
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
    if (root === 39 && member === 10) return Math.min(Math.max(n(1), n(0)), n(2));
    if (root === 42) {
      const positional = args.length - command.named.length;
      const named = (id: number) => {
        const index = command.named.indexOf(id);
        return index < 0 ? undefined : args[positional + index];
      };
      if (member === 19) return this.audio.bgmName();
      if (member === 4 || member === 10) {
        if (member === 4) this.audio.stop('bgm', Math.max(0, n(0)));
        else this.audio.pauseBgm(Math.max(0, n(0)));
        return 0;
      }
      if (member === 11 && command.named.every((id) => id === 0)) {
        this.audio.resumeBgm(positional ? n(0) : 0, Number(named(0) ?? 0));
        return 0;
      }
      if (member === 0 && positional === 1 && !command.named.length) {
        await this.playBgm(s(0));
        return 0;
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
            await this.audio.bgm(name, loop, fadeIn, fadeOut, Number(named(6) ?? 0), start);
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
    if (root === 44 && member === -1 && path.length === 4) {
      const channel = path[2]!;
      const key = `pcm${channel}`;
      const opcode = path[3];
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
        command.named.every((id) => [0, 2, 3, 6, 7, 8].includes(id))
      ) {
        const positional = args.length - command.named.length;
        const namedNumber = (id: number): number | undefined => {
          const index = command.named.indexOf(id);
          return index < 0 ? undefined : n(positional + index);
        };
        const voice = namedNumber(8);
        const fileIndex = command.named.indexOf(7);
        const file = fileIndex < 0 ? args[0] : args[positional + fileIndex];
        const resource = voice ?? file;
        if (typeof resource === 'string' || typeof resource === 'number') {
          await this.audio.pcm(
            channel,
            {
              resource,
              loop: opcode === 2 || opcode === 16 || Boolean(namedNumber(0)),
              volumeType: namedNumber(3),
              character: namedNumber(6),
            },
            opcode === 11 || opcode === 16,
            Math.max(0, namedNumber(2) ?? (positional > 1 ? n(1) : 0)),
          );
          return 0;
        }
      }
    }
    if (root === 45 && member === 7) {
      this.audio.stop('se', n(0));
      return 0;
    }
    if (root === 45 && member === 0) {
      await this.playSystemSound(n(0));
      return 0;
    }
    if (root !== undefined && root >= 23 && root <= 28 && member === 10) return 0;
    return undefined;
  }

  private async playSystemSound(id: number): Promise<void> {
    const name = this.game.config.get(`SE.${String(id).padStart(3, '0')}`)?.split('"')[1];
    if (name) await this.audio.effect('se', name);
  }

  private async objectCommand({path, args, named}: SiglusCommand): Promise<Value | undefined> {
    const address = this.objectAddress(path);
    if (!address) return undefined;
    const {page, index} = address;
    const [array, id, command] = path.slice(index);
    if (array === 3 && id === undefined) return Math.max(0, ...page.keys()) + 1;
    if (array === 4 && id === undefined) {
      const length = Math.max(0, Number(args[0] ?? 0));
      for (const key of page.keys()) if (key >= length) page.delete(key);
      this.markObjectsDirty(path);
      return 0;
    }
    if (command === 174) return Number(page.has(id!));
    if (command !== 175 && command !== 63) this.markObjectsDirty(path);
    const n = (index: number) => Number(args[index] ?? 0);
    if (command === 35) {
      page.delete(id!);
      return 0;
    }
    if (command === 41) {
      const source = args[0];
      if (!Array.isArray(source)) throw new Error('Invalid Siglus source object reference');
      const object = this.object(source);
      if (object) page.set(id!, this.copyObject(object));
      else page.delete(id!);
      return 0;
    }
    if (command === 38) {
      const name = String(args[0]);
      const pattern = n(4);
      const frames = [];
      frames[pattern] = await this.display.objectGraphic(name, pattern);
      page.set(id!, {name, frames, x: n(2), y: n(3), visible: Boolean(n(1)), pattern});
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
    if (command === 39) {
      page.set(id!, {
        name: '',
        frames: [],
        x: n(2),
        y: n(3),
        visible: args.length === 1 || Boolean(n(1)),
        pattern: 0,
        text: {
          value: String(args[0]),
          font: this.systemFont?.name ?? this.messageFont.name,
          bold: this.systemFont?.bold ?? this.messageFont.bold,
          shadow: this.systemFont?.shadow ?? this.messageFont.shadow,
          size: 32,
        },
      });
      return 0;
    }
    if (command === 40) {
      page.set(id!, {
        name: '',
        frames: [this.display.rectangle(n(2), n(3), n(4), n(5), n(6), n(7))],
        x: n(0),
        y: n(1),
        visible: Boolean(n(8)),
        pattern: 0,
      });
      return 0;
    }
    let object = page.get(id!);
    if (!object && command === 48) {
      object = {name: '', frames: [], x: 0, y: 0, visible: false, pattern: 0};
      page.set(id!, object);
    }
    if (command === 24 || command === 25) {
      if (!object || object.pattern < 0) return 0;
      const frame =
        object.frames[object.pattern] ??
        (object.name
          ? ((object.frames[object.pattern] = await this.display.objectGraphic(
              object.name,
              object.pattern,
            )) ?? (await this.display.graphic(object.name)))
          : undefined);
      return (command === 24 ? frame?.width : frame?.height) ?? 0;
    }
    if (!object && (command === 175 || command === 63 || command === 72 || command === 113))
      return 0;
    if (!object) throw new Error(`Missing Siglus object ${id}`);
    if (command === 100) {
      const pattern = args.length >= 3 ? n(2) : object.pattern;
      const frame =
        object.frames[pattern] ??
        (object.name
          ? (object.frames[pattern] = await this.display.objectGraphic(object.name, pattern))
          : undefined);
      return frame ? this.display.graphicAlpha(frame, n(0), n(1)) : 0;
    }
    if (path[0] === 65 && command === 51 && path[index + 3] === 0 && args.length >= 4) {
      object.horizontalMotion = {
        from: args.length === 5 ? n(4) : object.x,
        duration: n(1),
        delay: n(2),
        easing: n(3),
        started: performance.now(),
      };
      object.x = n(0);
      return 0;
    }
    if (
      (command === 51 || command === 64) &&
      path.length === index + 4 &&
      path[index + 3] === 0 &&
      (args.length === 4 || (args.length === 5 && named[0] === 0))
    ) {
      const axis = command === 51 ? 'x' : 'y';
      object.positionEvents = {
        ...object.positionEvents,
        [axis]: {
          from: args.length === 5 ? n(4) : object[axis],
          started: performance.now(),
          time: {
            duration: n(1),
            delay: n(2),
            easing: eventEasing(n(3)),
            fill: 'backwards',
          },
        },
      };
      object[axis] = n(0);
      return 0;
    }
    if (command === 72 && path.length === index + 4) {
      const event = path[index + 3];
      if (event === 0 && (args.length === 4 || (args.length === 5 && named[0] === 0))) {
        object.opacity = [
          n(0),
          n(1),
          n(2),
          n(3),
          args.length === 5 ? n(4) : (object.transparency ?? 255),
        ];
        object.opacityStarted = performance.now();
        object.transparency = n(0);
        return 0;
      }
      if (event === 4 || event === 10) {
        await this.renderObjects();
        const animation = object.opacity;
        if (animation && object.opacityStarted !== undefined)
          await this.delay(
            animation[1] + animation[2] - (performance.now() - object.opacityStarted),
          );
        return 0;
      }
      return undefined;
    }
    if (command === 52 && path.at(-1) === 1 && args[1] === '$sys_change_mark') {
      object.patternCycle = {count: 11, duration: 1000, started: performance.now()};
    } else if (command === 104 && object.text) object.text.size = n(0);
    else if (command === 160) object.clip = [n(0), n(1), n(2), n(3), n(4)];
    else if (command === 42) object.button = {id: n(0), group: n(1)};
    else if (command === 175) object.alphaTest = Boolean(n(0));
    else if (command === 98) object.pushKeep = Boolean(n(0));
    else if (command === 161) object.sourceClip = n(0) ? [n(1), n(2), n(3), n(4)] : undefined;
    else if (command === 48) {
      object.x = n(0);
      object.y = n(1);
    } else if (command === 49) object.scale = [n(0), n(1)];
    else if (command === 97) object.disabled = true;
    else if (command === 63 && path.at(-1) === 2) return 0;
    else if (path.at(-1) === 0 && args.length === 5) {
      const animation: NonNullable<DrawObject['opacity']> = [n(0), n(1), n(2), n(3), n(4)];
      if (command === 72) object.opacity = animation;
      else object.movement = animation;
    } else if (path.at(-1) !== 2) return undefined;
    return 0;
  }

  async dispose(): Promise<void> {
    if (this.controller.signal.aborted) return;
    this.controller.abort();
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
}
