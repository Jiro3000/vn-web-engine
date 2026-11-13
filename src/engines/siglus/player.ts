import type {ByteSource} from '../../core/source.js';
import {SiglusScenePack} from '../../formats/siglus/scene-pack.js';
import {SiglusAudio} from './audio.js';
import {SiglusDisplay, type DrawObject} from './display.js';
import {SiglusVm, type SiglusCommand, type SiglusTag, type Value} from './vm.js';

const fadeTimes = [
  250, 100, 500, 1000, 1500, 2000, 2500, 3000, 4000, 5000, 6000, 7000, 8000, 9000, 10000, 12000,
  14000, 16000, 18000, 20000,
];
const systemFlags = new Set([6, 7, 11, 12, 21, 109, 117, 133, 134, 214, 223, 251, 258]);
const scriptFlags = new Set([6, 7, 12, 13, 14, 15, 25, 27, 32, 33, 38, 39, 54, 55]);

export interface SiglusGame {
  files: ReadonlyMap<string, ByteSource>;
  pack: SiglusScenePack;
  config: ReadonlyMap<string, string>;
  title: string;
}

export async function openSiglusGame(files: ReadonlyMap<string, ByteSource>): Promise<SiglusGame> {
  const scenes = files.get('scene.pck');
  const configuration = files.get('gameexe.dat');
  if (!scenes || !configuration) throw new Error('Choose the Siglus game folder.');
  const pack = new SiglusScenePack(await scenes.read(0, scenes.size));
  const config = pack.configuration(await configuration.read(0, configuration.size));
  const title = config.get('GAMENAME')?.split('"')[1]?.normalize('NFKC') ?? 'SiglusEngine';
  return {files, pack, config, title};
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
    );
  }

  get windowDisplay(): SiglusDisplay['windowDisplay'] {
    return this.display.windowDisplay;
  }

  async start(): Promise<void> {
    await this.audio.resume();
    await this.display.prepare();
    const vm = new SiglusVm(
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
    );
    await vm.run(this.startScene);
  }

  private object(path: number[]): DrawObject | undefined {
    const [page, , , id] = path;
    return this.objects[page === 37 ? 1 : 0]!.get(id!);
  }

  private property(path: number[], value?: Value): Value | undefined {
    const [page, list, array, , property] = path;
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

  private async page(): Promise<void> {
    if (!this.pendingText) return;
    if (this.speed > 0) await this.delay(this.speed, true);
    this.root.dataset.page = String(++this.pages);
    await this.delay(undefined, true);
    this.audio.stop('voice');
    this.pendingText = false;
  }

  private choose(id: number): void {
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
    await this.display.show(
      [...back.entries()].sort(([a], [b]) => a - b).map(([, obj]) => obj),
      ms,
      (id) => this.choose(id),
    );
    this.objects[0] = new Map(back);
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
    await this.display.setBackground(this.backgroundName(name), fadeTimes[fade] ?? 0, pan);
  }

  private async include(command: SiglusCommand): Promise<Value | undefined> {
    const args = command.args;
    const n = (i: number) => Number(args[i] ?? 0);
    const s = (i: number) => String(args[i] ?? '');
    switch (command.name) {
      // The browser initializes empty scene properties and owns the display and sound state.
      case '$sys_set_gsd':
        return 0;
      case '$bg_disp_in':
        await this.background(s(0), n(1));
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
        await this.audio.bgm(s(0));
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
        this.display.recollect(false);
        break;
      case '$sc_sepia':
        this.display.sepia(Boolean(n(0)));
        break;
      case '$fade':
        await this.background(s(1), n(0));
        break;
      default:
        return undefined;
    }
    return 0;
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
        case 10:
          this.display.closeMessage();
          this.pendingText = false;
          break;
        case 13:
          this.display.newline();
          break;
        case 14:
          await this.page();
          break;
        case 18:
          await this.audio.voice(n(0));
          break;
        case 54:
          await this.delay(n(0));
          break;
        case 55:
          return this.delay(n(0), true);
        case 61:
          this.display.annotate(s(0));
          break;
        case 84:
          break; // Message-block boundaries delimit CD_NAME / CD_TEXT.
        case 111:
        case 113:
        case 118:
          break; // No browser save or backlog history on a new session.
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
      if (member === 79) return -1;
      if (member === 242) {
        void this.dispose();
        return 0;
      }
      if (systemFlags.has(member!)) {
        if (member === 21) this.audio.setBgmVolume(n(0));
        return 0;
      }
    }
    if (root === 64 && scriptFlags.has(member!)) {
      if (member === 25 || member === 27) this.speed = n(0);
      return 0;
    }
    if (root === 86 && (member === 2 || member === 3)) return 0;
    if (root === 42 && member === 0) {
      await this.audio.bgm(s(0));
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
