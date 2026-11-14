import {IndexedDbStore} from '../../platform/store.js';
import type {ByteSource} from '../../core/source.js';
import {SiglusScenePack} from '../../formats/siglus/scene-pack.js';
import {BrowserFullscreenMoviePlayer} from '../../video/fullscreen-movie.js';
import {SiglusAudio, type SiglusAudioKind} from './audio.js';
import {SiglusConfiguration, type SiglusMoviePlayer} from './configuration.js';
import {
  SiglusDisplay,
  orderedObjects,
  type DrawObject,
  type SiglusHistoryEntry,
} from './display.js';
import {
  SiglusVm,
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
  cast: string[];
  speed: number;
  timestamp?: number;
  title?: string;
  comment?: string;
  thumbnail?: string;
  waitsForInput?: boolean;
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
  };
}

export class SiglusPlayer {
  private readonly controller = new AbortController();
  private readonly display: SiglusDisplay;
  private readonly audio: SiglusAudio;
  private readonly objects = [new Map<number, DrawObject>(), new Map<number, DrawObject>()];
  private systemObjects?: Map<number, DrawObject>;
  private systemObjectsDirty = false;
  private systemFont?: {name?: string; bold?: boolean; shadow?: number};
  private messageHidden = false;
  private quakeStopped = false;
  private timeStopped = false;
  private systemSkipDisabled = false;
  private systemCallActive = false;
  private readSkipEnabled = false;
  private skipUnreadOverride?: boolean;
  private pageReadFlags: {scene: string; flag: number}[] = [];
  private readonly readFlags = new Map<string, Set<number>>();
  private pageAlreadyRead = false;
  private autoEnabled = false;
  private autoCharacterWait = 30;
  private autoMinimumWait = 1000;
  private pageCharacters = 0;
  private messageSpeed = 30;
  private messageNowait = true;
  private voiceMode = 0;
  private voiceDuckLevel: number;
  private voiceDuckEnabled: boolean;
  private readonly options = new Map<SystemOption, boolean>();
  private messageFont: string;
  private windowMode: boolean;
  private moviePlayer: SiglusMoviePlayer = 'wmp';
  private readonly configuration: SiglusConfiguration;
  private readonly systemCounters = new Map<number, RealCounter>();
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
  private selectedSave?: PlayerSave;
  private readonly system = new Map<number, number>();
  private bgmName?: string;
  private movieError?: Error;
  private skip = false;
  private skipAllowed = true;
  private readonly stageProperties = new Map<string, Value>();
  private currentCast: string[] = [];
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
    this.messageFont = config.get('CONFIG.FONT.NAME')?.split('"')[1] ?? '';
    this.windowMode = config.get('CONFIG.WINDOW_MODE') === '1';
    this.configuration = new SiglusConfiguration(
      root,
      files.get('siglusengine.exe'),
      this.controller.signal,
    );
    const savedOptions = localStorage.getItem(game.saveKey + ':options');
    if (savedOptions) {
      try {
        const values = JSON.parse(savedOptions);
        for (const [option] of systemOptions)
          if (typeof values?.[option] === 'boolean') this.options.set(option, values[option]);
        if (typeof values?.font === 'string') this.messageFont = values.font;
        if (typeof values?.fullscreen === 'boolean') this.windowMode = values.fullscreen;
        if (values?.moviePlayer === 'mci' || values?.moviePlayer === 'wmp')
          this.moviePlayer = values.moviePlayer;
      } catch {
        // An unreadable settings record falls back to the installation defaults.
      }
    }
    const color = config.get('CONFIG.FILTER_COLOR')?.split(',').map(Number) ?? [];
    this.filterDefaults = [color[0] ?? 0, color[1] ?? 0, color[2] ?? 0, color[3] ?? 255];
    this.filterColor = [...this.filterDefaults];
    this.voiceDuckLevel = Number(config.get('CONFIG.BGMFADE_VOLUME') ?? 255);
    this.voiceDuckEnabled = config.get('CONFIG.BGMFADE_ONOFF') === '1';
    this.audio.setVoiceDuck(this.voiceDuckEnabled ? this.voiceDuckLevel : 255);
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
        if (this.skipping && this.pendingText) this.wait?.(1);
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
          !this.waitingForPage ||
          this.systemCallActive ||
          !this.systemOption('WHEEL_NEXT_MESSAGE_ONOFF')
        )
          return;
        event.preventDefault();
        this.wait?.(1);
      },
      {passive: false, signal: this.controller.signal},
    );
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
    this.display.setMessageFont(this.messageFont);
    if (this.windowMode) this.windowDisplay.setFullscreen(true);
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
          if (!this.pendingText) {
            this.pageReadFlags = [];
            this.display.clearText();
            this.pendingText = true;
            this.pageCharacters = 0;
          }
          if (tag.tag === 'name') this.display.name(tag.value);
          else {
            if (tag.readFlag !== undefined && tag.readFlag >= 0) {
              this.pageReadFlags.push({scene: tag.scene, flag: tag.readFlag});
              if (!this.skipUnread && !this.readFlags.get(tag.scene)?.has(tag.readFlag))
                this.readSkipEnabled = false;
            }
            this.display.append(tag.value);
            this.pageCharacters += [...tag.value].length;
          }
        },
      },
      this.controller.signal,
      {scene: menu!.split('"')[1] ?? '_titlemenu', entry: Number(entry ?? 0)},
    );
    await this.vm.run(this.startScene);
  }

  private async callSystemScene(
    key: string,
    capture = key === 'SAVE_SCENE' || key === 'CANCEL_SCENE',
  ): Promise<void> {
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
    if (capture && this.savePoint) this.savePoint.thumbnail = this.display.captureThumbnail();
    this.systemCallActive = true;
    this.inputSampled = false;
    this.display.setSystemInput(true);
    try {
      await this.vm.callScene(name, label?.split('"')[1] ?? Number(label ?? 0));
    } finally {
      this.systemCallActive = false;
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
    if (selected) await this.loadSave(selected);
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
        font: this.messageFont,
        fullscreen: this.windowMode,
        moviePlayer: this.moviePlayer,
      }),
    );
  }

  private systemCounter(
    id: number,
    member: number,
    args: SiglusCommand['args'],
  ): Value | undefined {
    const counter = this.systemCounters.get(id);
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
        this.systemCounters.delete(id);
        return 0;
      case 9: // start_real
        this.systemCounters.set(id, {start: now, from: 0});
        return 0;
      case 11: // start_frame_real
        this.systemCounters.set(id, {
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
      page = this.objects[path[0] === 37 ? 1 : 0]!;
      index = 2;
    } else return;
    while (path[index] === -1 && path[index + 2] === 93) {
      const object = page.get(path[index + 1]!);
      if (!object) return;
      page = object.children ??= new Map();
      index += 3;
    }
    return {page, index};
  }

  private markObjectsDirty(root: number): void {
    if (root === 38) this.objectsDirty = true;
    if (root === 65) this.systemObjectsDirty = true;
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
      if (
        name &&
        /^\$(bg_(?:name|name_prev|wipe|set_ready|type|file_exist)|bs_(?:name|wipe_set))$/.test(name)
      ) {
        const key = [name, ...path.slice(1)].join('.');
        if (value !== undefined) this.stageProperties.set(key, value);
        return this.stageProperties.get(key) ?? (name.includes('name') ? '' : 0);
      }
    }
    const address = this.objectAddress(path);
    if (!address || path[address.index] !== -1) return;
    const property = path[address.index + 2];
    const id = path[address.index + 1]!;
    let object = address.page.get(id);
    if (!object) {
      if (value === undefined || page !== 65) return 0;
      object = {name: '', frames: [], x: 0, y: 0, pattern: 0, visible: false};
      address.page.set(id, object);
    }
    if (property === 0) {
      if (value !== undefined && object.visible !== Boolean(value)) {
        object.visible = Boolean(value);
        this.markObjectsDirty(page!);
      }
      return Number(object.visible);
    }
    if (property !== undefined && property >= 18 && property <= 22) {
      const clip = (object.clip ??= [0, 0, 0, 0, 0]);
      const index = property - 18;
      if (value !== undefined && clip[index] !== Number(value)) {
        clip[index] = Number(value);
        this.markObjectsDirty(page!);
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
                : undefined;
    if (!field) return;
    if (value !== undefined && object[field] !== Number(value)) {
      object[field] = Number(value);
      this.markObjectsDirty(page!);
    }
    return object[field] ?? (field === 'transparency' ? 255 : 0);
  }

  private delay(time?: number, skippable = false): Promise<number> {
    const signal = this.controller.signal;
    signal.throwIfAborted();
    if (this.skipping && skippable) return Promise.resolve(1);
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

  private async pageInput(): Promise<void> {
    if (!this.pendingText) return;
    const speed = this.speed || (this.messageNowait ? 0 : this.messageSpeed);
    if (speed > 0) await this.delay(speed, true);
    this.pageAlreadyRead =
      this.pageReadFlags.length > 0 &&
      this.pageReadFlags.every(({scene, flag}) => this.readFlags.get(scene)?.has(flag));
    if (!this.pageAlreadyRead && !this.skipUnread) this.readSkipEnabled = false;
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

  private async waitAtPage(): Promise<void> {
    for (;;) {
      let menu: {type: string; sound: number; id: number} | undefined;
      if (!this.skipping && this.messageButtonsEnabled) {
        this.display.pageControls(
          (type, sound, id) => {
            menu = {type, sound, id};
            this.wait?.(1);
          },
          (type, id) => {
            if (this.disabledMessageButtons.has(id)) return false;
            if (type === 'msg_log') return this.backlog.length > 0;
            if (type === 'koe_play') return Boolean(this.backlog.at(-1)?.voices.length);
            if (type === 'close_mwnd') return true;
            return type.endsWith('save')
              ? this.saveEnabled && Boolean(this.savePoint)
              : this.loadEnabled && (type !== 'qload' || this.quickSaves.size > 0);
          },
        );
      }
      let result: number;
      try {
        const autoWait =
          this.autoEnabled && !this.userMessageHidden
            ? this.autoMinimumWait + this.autoCharacterWait * this.pageCharacters
            : undefined;
        this.waitingForPage = true;
        result = await this.delay(autoWait, true);
      } finally {
        this.waitingForPage = false;
        this.display.pageControls();
      }
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
      const {type, sound, id} = menu;
      await this.playSystemSound(sound);
      if (type === 'msg_log') await this.openHistory();
      else if (type === 'close_mwnd') this.setUserMessageHidden(true);
      else if (type === 'koe_play')
        void this.replayHistoryVoice(this.backlog.at(-1)).catch((error) => {
          if (!this.controller.signal.aborted) console.error(error);
        });
      else if (type === 'qsave' || type === 'qload')
        await this.callSystemScene(
          `WAKU.000.BTN.${String(id).padStart(3, '0')}.CALL`,
          type === 'qsave',
        );
      else await this.callSystemScene(type === 'save' ? 'SAVE_SCENE' : 'LOAD_SCENE');
    }
  }

  private captureSave(waitsForInput = true, includeHistory = true): PlayerSave {
    const {background, bgm} = this.root.dataset;
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
      vm: this.vm.checkpoint(0),
      stage: [...this.stageProperties],
      message: this.display.saveMessage(),
      background,
      bgm,
      cast: [...this.currentCast],
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

  private async loadSave(save: PlayerSave): Promise<void> {
    this.skip = false;
    this.readSkipEnabled = false;
    this.savePoint = save;
    this.backlog.splice(0, this.backlog.length, ...(save.history ?? []));
    for (const [index, point] of save.historyPoints ?? []) {
      const entry = this.backlog[index];
      if (entry) this.historyPoints.set(entry, point);
    }
    this.pageVoices = [];
    this.systemMenuEnabled = save.controls?.systemMenu ?? true;
    this.messageButtonsEnabled = save.controls?.messageButtons ?? true;
    this.disabledMessageButtons.clear();
    for (const id of save.controls?.disabledButtons ?? []) this.disabledMessageButtons.add(id);
    this.saveEnabled = save.controls?.save ?? true;
    this.loadEnabled = save.controls?.load ?? true;
    this.skipAllowed = save.controls?.controlSkip ?? true;
    this.skipUnreadOverride = save.controls?.skipUnread;
    this.audio.stop('voice');
    this.audio.stopEffects();
    this.audio.stop('bgm');
    this.display.endEffect();
    this.display.cinema(0);
    this.stageProperties.clear();
    for (const [key, value] of save.stage) this.stageProperties.set(key, value);
    this.pendingBackground = undefined;
    if (save.background) await this.display.setBackground(save.background, 0);
    await this.cast(save.cast, -1);
    if (save.bgm) await this.audio.bgm(save.bgm);
    this.speed = save.speed;
    this.saveTitle = save.title ?? '';
    const waitsForInput = save.waitsForInput ?? true;
    if (waitsForInput) await this.display.loadMessage(save.message);
    else this.display.closeMessage();
    this.pendingText = waitsForInput;
    this.root.dataset.loaded = 'true';
    if (waitsForInput) {
      this.root.dataset.page = String(++this.pages);
      this.tracePage();
      this.waitingForPage = true;
      try {
        await this.delay(undefined, true);
      } finally {
        this.waitingForPage = false;
      }
    }
    this.pendingText = false;
    this.vm.requestLoad(save.vm);
    throw save.vm;
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

  private async wipe(ms: number): Promise<void> {
    const back = this.objects[1]!;
    this.display.closeMessage();
    this.pageVoices = [];
    this.currentCast = [];
    await this.display.show(orderedObjects(back), this.wipeDuration(ms), (id) => this.choose(id));
    this.objects[0] = this.copyObjects(back);
    this.objectsDirty = false;
  }

  private async renderObjects(): Promise<void> {
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

  private async cast(names: string[], fade: number): Promise<void> {
    const resolved = names.map((name) =>
      /^[a-z]{2}$/i.test(name)
        ? (this.currentCast.find((previous) => spriteActor(previous) === name) ?? 'none')
        : name,
    );
    this.currentCast = resolved;
    await this.display.showCast(resolved, this.wipeDuration(fadeTimes[fade] ?? 0));
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
      // The browser initializes empty scene properties and owns the display and sound state.
      case '$sys_set_gsd':
        for (let i = 0; i < 6; i++) this.stageProperties.set('$bs_name.-1.' + i, 'none');
        // Earlier browser profiles may have an initialization flag without this setting.
        if (!this.system.has(1330)) this.property([31, -1, 1330], 1);
        if (!this.property([31, -1, 1001])) {
          // __sys_scdata_init enables the authored confirmation flags on first launch.
          for (let flag = 1316; flag < 1324; flag++) this.system.set(flag, 1);
          this.property([31, -1, 1001], 1);
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
      case '$change_days': {
        await this.background(s(1), 3, {from: [-360, -360], to: [0, -360], time: 15000});
        await this.display.dayCard(n(0));
        await this.delay(2000, true);
        await this.delay(4000, true);
        if (this.saveEnabled && this.system.get(1330)) {
          this.savePoint = this.captureSave(false);
          this.savePoint.thumbnail = this.display.captureThumbnail();
          await this.vm.callScene('__sys_system_call', '$sys_day_save');
          await this.display.autosaveNotice();
        }
        this.display.removeDayCard();
        break;
      }
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
        await this.audio.effect(`pcm${n(0)}`, s(1));
        break;
      case '$pcmch_play_loop':
        await this.audio.effect(`pcm${n(0)}`, s(1), true);
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
        if (!this.pendingText) this.display.clearText();
        await this.display.face(s(0));
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
        await this.wipe(fadeTimes[n(0)] ?? (n(0) === 121 ? 1000 : 0));
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
    if (this.bgmName === name && this.root.dataset.bgm === name) return;
    await this.audio.bgm(name, true, fade, crossfade);
    this.bgmName = name;
  }

  private async command(command: SiglusCommand): Promise<Value | undefined> {
    if (command.name) return this.include(command);
    const {args, path} = command;
    const [root, member] = path;
    const n = (i: number) => Number(args[i] ?? 0);
    const s = (i: number) => String(args[i] ?? '');
    if (path.length === 1) {
      switch (root) {
        case 80: // capture: the system layer composites above the retained scene.
        case 81: // capture_free
          if (this.systemCallActive) return 0;
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
          await this.wipe(n(1));
          break;
        case 8:
          this.display.selectMessageWindow(n(0));
          break;
        case 10:
          this.display.closeMessage();
          this.pageVoices = [];
          this.pendingText = false;
          break;
        case 12:
          this.display.append(s(0));
          this.pageCharacters = (this.pendingText ? this.pageCharacters : 0) + [...s(0)].length;
          this.pendingText = true;
          break;
        case 13:
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
        case 54:
          if (!this.skipping) await this.delay(n(0));
          break;
        case 55:
          return this.delay(n(0), true);
        case 61:
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
          this.display.slideMessage(this.systemOption('NO_MWND_ANIME_ONOFF') ? 0 : n(0));
          break;
        case 122:
          this.display.slideMessage(0);
          break;
        case 151:
          this.display.repPosition(n(0), n(1));
          break;
        case 110: // No selection point in the current story flow.
          return 0;
        case 111:
          break; // No selection checkpoint on a new session.
        case 113:
          this.savePoint = undefined;
          break;
        case 36:
          this.savePoint = this.captureSave(false);
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
    if ((root === 37 || root === 38) && member === 2) return this.objectCommand(command);
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
        return this.systemCounter(path[3]!, path[4]!, args);
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
      if (member === 1 || member === 2 || member === 3) {
        await this.callSystemScene(
          member === 1 ? 'SAVE_SCENE' : member === 2 ? 'LOAD_SCENE' : 'CONFIG_SCENE',
        );
        return 0;
      }
      if (member === 4 || member === 99) {
        this.windowMode =
          member === 4 ? Boolean(n(0)) : this.game.config.get('CONFIG.WINDOW_MODE') === '1';
        this.windowDisplay.setFullscreen(this.windowMode);
        this.persistOptions();
        return 0;
      }
      if (member === 9) return Number(this.windowDisplay.isExpanded);
      if (member === 167) {
        this.moviePlayer = await this.configuration.moviePlayer(this.moviePlayer);
        this.persistOptions();
        this.display.stage.focus({preventScroll: true});
        return 0;
      }
      if (member === 283) {
        this.messageFont = s(0);
        this.display.setMessageFont(this.messageFont);
        this.persistOptions();
        return 0;
      }
      if (member === 284) return this.messageFont;
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
          } else await this.loadSave(save);
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
      if (member === 48) return this.messageSpeed;
      if (member === 50) return Number(this.messageNowait);
      if (member === 46 || member === 47) {
        this.messageSpeed = member === 46 ? Math.max(0, Math.min(255, n(0))) : 30;
        return 0;
      }
      if (member === 49) {
        this.messageNowait = Boolean(n(0));
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
      if (member === 96) return this.voiceDuckLevel;
      if (member === 98) return Number(this.voiceDuckEnabled);
      if (member === 94 || member === 95) {
        this.voiceDuckLevel =
          member === 94 ? n(0) : Number(this.game.config.get('CONFIG.BGMFADE_VOLUME') ?? 255);
        this.audio.setVoiceDuck(this.voiceDuckEnabled ? this.voiceDuckLevel : 255);
        return 0;
      }
      if (member === 97 || member === 106) {
        this.voiceDuckEnabled =
          member === 97 ? Boolean(n(0)) : this.game.config.get('CONFIG.BGMFADE_ONOFF') === '1';
        this.audio.setVoiceDuck(this.voiceDuckEnabled ? this.voiceDuckLevel : 255);
        return 0;
      }
      if (member === 214) {
        this.autoEnabled = Boolean(n(0));
        return 0;
      }
      if (member === 215) return Number(this.autoEnabled);
      if (member === 53) return this.autoCharacterWait;
      if (member === 56) return this.autoMinimumWait;
      if (member === 51 || member === 52) {
        this.autoCharacterWait = member === 51 ? Math.max(0, Math.min(500, n(0))) : 30;
        return 0;
      }
      if (member === 54 || member === 55) {
        this.autoMinimumWait = member === 54 ? Math.max(0, Math.min(10000, n(0))) : 1000;
        return 0;
      }
      if (member === 242) {
        void this.dispose();
        return 0;
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
    // Frame action callbacks are not currently scheduled by the browser host.
    if (root === 53 && member === -1 && path[3] === 2) return 0;
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
    if (root === 39 && member === 2 && Array.isArray(args[3])) {
      const previousTime = n(1);
      let previousValue = n(2);
      const time = n(0);
      if (time <= previousTime) return previousValue;
      const table = args[3];
      for (let index = 0; index + 2 < table.length; index += 3) {
        const start = table[index]!;
        const end = table[index + 1]!;
        const value = table[index + 2]!;
        if (time <= start) return previousValue;
        if (time < end)
          return (
            previousValue + Math.trunc(((value - previousValue) * (time - start)) / (end - start))
          );
        previousValue = value;
      }
      return previousValue;
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
    if (root === 42 && member === 19) return this.root.dataset.bgm ?? '';
    if (root === 42 && member === 0) {
      await this.playBgm(s(0));
      return 0;
    }
    if (root === 42 && member === 4) {
      this.audio.stop('bgm', n(0));
      return 0;
    }
    if (root === 44 && member === -1 && path.length === 4) {
      const channel = `pcm${path[2]}`;
      const opcode = path[3];
      if (opcode === 13) {
        this.audio.setChannelLevel(channel, n(0), n(1));
        return 0;
      }
      if (opcode === 0 && command.named.every((id) => [0, 3, 6, 7, 8].includes(id))) {
        const positional = args.length - command.named.length;
        const namedNumber = (id: number): number | undefined => {
          const index = command.named.indexOf(id);
          return index < 0 ? undefined : n(positional + index);
        };
        const voice = namedNumber(8);
        const volume = namedNumber(3);
        if (voice !== undefined) {
          await this.audio.voice(voice, channel, namedNumber(6), volume);
          return 0;
        }
        const fileIndex = command.named.indexOf(7);
        const file = fileIndex < 0 ? args[0] : args[positional + fileIndex];
        if (typeof file === 'string') {
          await this.audio.effect(channel, file, Boolean(namedNumber(0)), volume);
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
    if (array === 4 && id === undefined) return 0; // Sparse list; absent indices carry default objects.
    if (command !== 175 && command !== 63) this.markObjectsDirty(path[0]!);
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
          font: this.systemFont?.name ?? this.messageFont,
          bold: this.systemFont?.bold ?? this.game.config.get('CONFIG.FONT.FUTOKU') === '1',
          shadow:
            this.systemFont?.shadow ?? Number(this.game.config.get('CONFIG.FONT.SHADOW') ?? 0),
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
    const object = page.get(id!);
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
        started: performance.now(),
      };
      object.x = n(0);
      return 0;
    }
    if (path[0] === 65 && command === 72 && path.length === index + 4) {
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
    } else if (command === 97) object.disabled = true;
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
