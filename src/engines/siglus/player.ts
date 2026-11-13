import type {ByteSource} from '../../core/source.js';
import {SiglusScenePack} from '../../formats/siglus/scene-pack.js';
import {BrowserFullscreenMoviePlayer} from '../../video/fullscreen-movie.js';
import {SiglusAudio} from './audio.js';
import {SiglusDisplay, type DrawObject} from './display.js';
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
const systemFlags = new Set([6, 7, 11, 12, 21, 109, 117, 133, 134, 214, 223, 251, 258]);
const scriptFlags = new Set([12, 13, 14, 15, 25, 27, 32, 33, 34, 35, 38, 39, 48, 51, 54, 55]);

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

interface PlayerSave {
  version: 1;
  vm: SiglusCheckpoint;
  stage: [string, Value][];
  message: ReturnType<SiglusDisplay['saveMessage']>;
  background?: string;
  bgm?: string;
  cast: string[];
  speed: number;
}

export class SiglusPlayer {
  private readonly controller = new AbortController();
  private readonly display: SiglusDisplay;
  private readonly audio: SiglusAudio;
  private readonly objects = [new Map<number, DrawObject>(), new Map<number, DrawObject>()];
  private wait?: (value: number) => void;
  private decide?: (value: number) => void;
  private pendingDecision?: number;
  private pages = 0;
  private pendingText = false;
  private speed = 0;
  private readonly startScene: string;
  private readonly movies: BrowserFullscreenMoviePlayer;
  private vm!: SiglusVm;
  private saveEnabled = true;
  private loadEnabled = true;
  private saved?: PlayerSave;
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
    return this.skip && this.skipAllowed;
  }

  constructor(
    private readonly root: HTMLElement,
    private readonly game: SiglusGame,
    windowOptions: ConstructorParameters<typeof SiglusDisplay>[7],
    private readonly trace: (tag: SiglusTag) => void = () => {},
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
    this.audio = new SiglusAudio(files, config, root);
    this.display = new SiglusDisplay(
      root,
      files,
      config,
      width,
      height,
      this.controller.signal,
      () => this.wait?.(1),
      windowOptions,
      (active) => {
        this.skip = active;
        if (this.skipping && this.pendingText) this.wait?.(1);
      },
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
    const saved = localStorage.getItem(game.saveKey + ':slot');
    if (saved) {
      const slot = JSON.parse(saved) as PlayerSave;
      if (slot.version === 1) this.saved = slot;
    }
    const system = localStorage.getItem(game.saveKey + ':system');
    if (system)
      for (const [index, value] of JSON.parse(system) as [number, number][])
        this.system.set(index, value);
  }

  get windowDisplay(): SiglusDisplay['windowDisplay'] {
    return this.display.windowDisplay;
  }

  async start(): Promise<void> {
    await this.audio.resume();
    await this.display.prepare();
    const [menu, entry] = (this.game.config.get('MENU_SCENE') ?? '"_titlemenu", 0').split(',');
    this.vm = new SiglusVm(
      this.game.pack,
      {
        command: (command) => this.command(command),
        property: (path, value) => this.property(path, value),
        trace: this.trace,
        message: (tag) => {
          if (!this.pendingText) {
            this.display.clearText();
            this.pendingText = true;
          }
          if (tag.tag === 'name') this.display.name(tag.value);
          else this.display.append(tag.value);
        },
      },
      this.controller.signal,
      {scene: menu!.split('"')[1] ?? '_titlemenu', entry: Number(entry ?? 0)},
    );
    await this.vm.run(this.startScene);
  }

  private object(path: number[]): DrawObject | undefined {
    const [page, , , id] = path;
    return this.objects[page === 37 ? 1 : 0]!.get(id!);
  }

  private property(path: number[], value?: Value): Value | undefined {
    const [page, list, array, , property] = path;
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
    if ((page !== 37 && page !== 38) || list !== 2 || array !== -1) return;
    const object = this.object(path);
    if (!object) return 0;
    if (property === 0) {
      if (value !== undefined) object.visible = Boolean(value);
      return Number(object.visible);
    }
    const field =
      property === 1 ? 'pattern' : property === 3 ? 'x' : property === 4 ? 'y' : undefined;
    if (!field) return;
    if (value !== undefined) object[field] = Number(value);
    return object[field];
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

  private async pageInput(): Promise<boolean> {
    if (!this.pendingText) return false;
    if (this.speed > 0) await this.delay(this.speed, true);
    this.root.dataset.page = String(++this.pages);
    if (!this.skipping) this.updateSaveControls();
    let result: number;
    try {
      result = await this.delay(undefined, true);
    } finally {
      this.display.pageControls(undefined, undefined);
    }
    this.audio.stop('voice');
    this.pendingText = false;
    return result === 2;
  }

  private updateSaveControls(): void {
    this.display.pageControls(
      this.saveEnabled ? () => this.save() : undefined,
      this.loadEnabled && this.saved ? () => this.wait?.(2) : undefined,
    );
  }

  private save(): void {
    const {background, bgm} = this.root.dataset;
    const save: PlayerSave = {
      version: 1,
      vm: this.vm.checkpoint(0),
      stage: [...this.stageProperties],
      message: this.display.saveMessage(),
      background,
      bgm,
      cast: this.currentCast,
      speed: this.speed,
    };
    localStorage.setItem(this.game.saveKey + ':slot', JSON.stringify(save));
    this.saved = save;
    this.root.dataset.savedPage = String(this.pages);
    this.updateSaveControls();
  }

  private async loadSave(): Promise<void> {
    const save = this.saved;
    if (!save) return;
    this.skip = false;
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
    await this.display.loadMessage(save.message);
    this.pendingText = true;
    this.root.dataset.loaded = 'true';
    this.root.dataset.page = String(++this.pages);
    await this.delay(undefined, true);
    this.pendingText = false;
    this.vm.requestLoad(save.vm);
  }

  private choose(id: number): void {
    this.skip = false;
    if (this.decide) this.decide(id);
    else this.pendingDecision = id;
  }

  private titleChoice(): Promise<number> {
    if (this.pendingDecision !== undefined) {
      const id = this.pendingDecision;
      this.pendingDecision = undefined;
      return Promise.resolve(id);
    }
    return new Promise((resolve) => {
      const signal = this.controller.signal;
      signal.throwIfAborted();
      const cancel = (): void => this.decide?.(-2);
      this.decide = (id) => {
        this.decide = undefined;
        signal.removeEventListener('abort', cancel);
        resolve(id);
      };
      signal.addEventListener('abort', cancel, {once: true});
    });
  }

  private async wipe(ms: number): Promise<void> {
    const back = this.objects[1]!;
    this.display.closeMessage();
    this.currentCast = [];
    await this.display.show(
      [...back.entries()].sort(([a], [b]) => a - b).map(([, obj]) => obj),
      this.skipping ? 0 : ms,
      (id) => this.choose(id),
    );
    this.objects[0] = new Map([...back].map(([id, object]) => [id, {...object}]));
  }

  private backgroundName(name: string): string {
    const key = name.toLowerCase();
    return /^(?:b_)?bg\d\d$/.test(key) ? key + 'a' : key;
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
      this.skipping ? 0 : (fadeTimes[fade] ?? 0),
      pan,
    );
  }

  private async cast(names: string[], fade: number): Promise<void> {
    this.currentCast = names;
    await this.display.showCast(names, this.skipping ? 0 : (fadeTimes[fade] ?? 0));
  }

  private async movie(name: string, skippable: boolean): Promise<number> {
    this.skip = false;
    this.movieError = undefined;
    this.root.dataset.movie = name;
    this.display.pageControls(undefined, undefined);
    const volume = Number(this.game.config.get('CONFIG.VOLUME.MOV') ?? 255) / 255;
    const attenuation = volume > 0 ? 2000 * Math.log10(volume) : -10000;
    try {
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
          await this.background(name, 0, pan);
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
        const actor = (name: string) => name.replace(/^bs\d_/, '').slice(0, 2);
        for (const [i, value] of args.entries()) {
          const face = String(value);
          if (face === 'none') break;
          const index = names.findIndex((name) => actor(name) === actor(face));
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
      case '$change_days':
        await this.background(s(1), 3, {from: [-360, -360], to: [0, -360], time: 15000});
        await this.display.dayCard(n(0));
        await this.delay(2000, true);
        await this.delay(4000, true);
        this.display.removeDayCard();
        break;
      case '$scene_fade':
        this.audio.stop('bgm', n(3));
        this.audio.stopEffects();
        await this.cast([], -1);
        await this.background('bg_kuro', n(0));
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
        await this.background(s(1), n(0));
        await this.cast([], -1);
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
        this.backlog.push(s(3));
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

  private readonly backlog: string[] = [];

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
        case 6:
          break; // The browser composites on its own refresh cycle.
        case 7:
          await this.wipe(n(1));
          break;
        case 8:
          this.display.selectMessageWindow(n(0));
          break;
        case 10:
          this.display.closeMessage();
          this.pendingText = false;
          break;
        case 12:
          this.display.append(s(0));
          this.pendingText = true;
          break;
        case 13:
        case 15:
          this.display.newline();
          break;
        case 14:
          if (await this.pageInput()) await this.loadSave();
          break;
        case 16:
          this.display.setTextSize(n(0));
          break;
        case 18:
          await this.audio.voice(n(0));
          break;
        case 54:
          if (!this.skipping) await this.delay(n(0));
          break;
        case 55:
          return this.delay(n(0), true);
        case 61:
          this.display.annotate(s(0));
          break;
        case 84:
          break; // Message-block boundaries delimit CD_NAME / CD_TEXT.
        case 95:
          break; // Subsequent message blocks share the active message window.
        case 120:
          this.display.slideMessage(n(0));
          break;
        case 122:
          this.display.slideMessage(0);
          break;
        case 151:
          this.display.repPosition(n(0), n(1));
          break;
        case 111:
        case 113:
          break; // No browser save or backlog history on a new session.
        case 118:
          this.backlog.length = 0;
          break;
        default:
          return undefined;
      }
      return 0;
    }
    if ((root === 37 || root === 38) && member === 2) return this.objectCommand(command);
    if (root === 38 && member === 6) {
      const id = path.at(-1);
      if (id === 3) return this.titleChoice();
      if (id === 6 || id === 7) return -1;
      if (id === 10) return 0;
    }
    if (root === 63) {
      if (member === 79) return this.saved ? 0 : -1;
      if (member === 2) {
        await this.loadSave();
        return 0;
      }
      if (member === 242) {
        void this.dispose();
        return 0;
      }
      if (systemFlags.has(member!)) {
        if (member === 21) this.audio.setBgmVolume(n(0));
        if (member === 251) this.saveEnabled = Boolean(n(0));
        if (member === 258) this.loadEnabled = Boolean(n(0));
        return 0;
      }
    }
    if (root === 64 && (member === 6 || member === 7)) {
      this.skipAllowed = member === 7;
      return 0;
    }
    if (root === 20 && (member === 2 || member === 3)) return this.movie(s(0), member === 3);
    if (root === 64 && scriptFlags.has(member!)) {
      if (member === 25 || member === 27) this.speed = n(0);
      return 0;
    }
    if (root === 86 && (member === 2 || member === 3)) return 0;
    if (root === 42 && member === 0) {
      await this.playBgm(s(0));
      return 0;
    }
    if (root === 42 && member === 4) {
      this.audio.stop('bgm', n(0));
      return 0;
    }
    if (root === 44 && path.at(-1) === 0) {
      await this.audio.voice(n(0), `pcm${path[2]}`);
      return 0;
    }
    if (root === 45 && member === 0) {
      const name = this.game.config.get(`SE.${String(n(0)).padStart(3, '0')}`)?.split('"')[1];
      if (name) await this.audio.effect('se', name);
      return 0;
    }
    if (root !== undefined && root >= 23 && root <= 28 && member === 10) return 0;
    return undefined;
  }

  private async objectCommand({path, args}: SiglusCommand): Promise<Value | undefined> {
    const [root, , array, id, command] = path;
    const page = this.objects[root === 37 ? 1 : 0]!;
    if (array === 3 && id === undefined) return Math.max(0, ...page.keys()) + 1;
    const n = (index: number) => Number(args[index] ?? 0);
    if (command === 35) {
      page.delete(id!);
      return 0;
    }
    if (command === 41) {
      const source = args[0];
      if (!Array.isArray(source)) throw new Error('Invalid Siglus source object reference');
      const object = this.object(source);
      if (object) page.set(id!, {...object});
      else page.delete(id!);
      return 0;
    }
    if (command === 38) {
      const name = String(args[0]);
      const pattern = n(4);
      const frames = [];
      frames[pattern] = await this.display.graphic(name, pattern);
      page.set(id!, {name, frames, x: n(2), y: n(3), visible: Boolean(n(1)), pattern});
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
    if (!object && (command === 175 || command === 63 || command === 72 || command === 113))
      return 0;
    if (!object) throw new Error(`Missing Siglus object ${id}`);
    if (command === 42) object.button = n(0);
    else if (command === 48) {
      object.x = n(0);
      object.y = n(1);
    } else if (command === 97) object.disabled = true;
    else if (command === 175 || (command === 63 && path.at(-1) === 2)) return 0;
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
