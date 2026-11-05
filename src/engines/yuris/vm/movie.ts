import type {FileMovieRect} from '../../../video/browser-file-movie.js';
import type {YurisMachine} from './machine.js';
import {windowsPath, type YurisFolderHost} from './fileact.js';
import {YurisError} from './errors.js';
import {fistp} from './numbers.js';

export interface YurisMovieHost {
  moviePlay(data: Uint8Array, rect: FileMovieRect, gain: number): Promise<void>;
  moviePosition(rect: FileMovieRect): void;
  movieVolume(gain: number): void;
  moviePlaying(): boolean;
  movieStop(): void;
  movieClose(): void;
}

/** MOVIE 0x44A010, MOVIEEND 0x44A5FC, MOVIEINFO 0x44A650. */
export class YurisMovie {
  /** 0x866D40; only physical folder files, never archive entries. */
  private file: Uint8Array | null = null;
  /** 0x87249C, 0x8724A0..0x8724AC and 0x59B7C0. */
  playing = false;
  private x = 0;
  private y = 0;
  private width = 0;
  private height = 0;
  private volume = 256;
  private clientWidth = 0;
  private clientHeight = 0;

  constructor(
    private readonly m: YurisMachine,
    private readonly folder: YurisFolderHost,
    private readonly host: YurisMovieHost,
  ) {
    m.define(0x46, () => this.command());
    m.define(0x47, () => {
      m.decode();
      host.movieClose();
      this.file = null;
      this.playing = false;
      this.volume = 256;
      return 0;
    });
    m.define(0x48, () => this.info());
  }

  /** EC_COMPLETE/EC_USERABORT 0x45D404 and MCI_NOTIFY 0x45D418 clear PLAY. */
  poll(): void {
    if (!this.playing) return;
    if (!this.host.moviePlaying()) {
      this.playing = false;
      return;
    }
    const rect = this.rect();
    // 0x45E308: window resize/fullscreen repositions the native video child.
    if (rect.clientWidth !== this.clientWidth || rect.clientHeight !== this.clientHeight) {
      this.host.moviePosition(rect);
      this.clientWidth = rect.clientWidth;
      this.clientHeight = rect.clientHeight;
    }
  }

  private rect(): FileMovieRect {
    const main = this.m.windows.windows[0]!;
    return {
      x: this.x,
      y: this.y,
      width: this.width,
      height: this.height,
      clientWidth: main.width,
      clientHeight: main.height,
    };
  }

  private async command(): Promise<number> {
    const m = this.m,
      a = m.args;
    m.decode();
    const low = (id: number) => Number(BigInt.asIntN(32, a.int(id)));
    if (a.has(2)) this.x = low(2);
    if (a.has(3)) this.y = low(3);
    if (a.has(4)) this.width = low(4);
    if (a.has(5)) this.height = low(5);
    if (a.has(0)) {
      const main = m.windows.windows[0]!;
      if (!a.has(2)) this.x = 0;
      if (!a.has(3)) this.y = 0;
      if (!a.has(4)) this.width = main.width;
      if (!a.has(5)) this.height = main.height;
      const data = await this.folder.readFile(windowsPath(a.text(0)));
      // A failed fopen returns before volume/play and keeps the previous filename.
      if (!data) return 0;
      this.file = data;
      this.playing = false;
    }
    if (a.has(6)) {
      this.volume = low(6);
      this.host.movieVolume(this.gain());
    }
    if (a.has(1)) {
      if (a.int(1) === 1n) {
        if (!this.file) throw new YurisError(0x18c86, [], false);
        const rect = this.rect();
        try {
          await this.host.moviePlay(this.file, rect, this.gain());
        } catch {
          throw new YurisError(0x18c86, [], false);
        }
        this.clientWidth = rect.clientWidth;
        this.clientHeight = rect.clientHeight;
        this.playing = true;
      } else if (a.int(1) === 0n) {
        this.host.movieStop();
        this.playing = false;
      }
    }
    return 0;
  }

  // 0x573155 DirectShow logarithmic volume, with a native hundredth-dB result.
  private gain(): number {
    if (this.volume === 0) return 0;
    const db = Math.min(
      0,
      Math.max(-10000, Number(BigInt.asIntN(32, fistp(4000 * Math.log10(this.volume / 256))))),
    );
    return db === -10000 ? 0 : 10 ** (db / 2000);
  }

  private async info(): Promise<number> {
    const m = this.m,
      a = m.args;
    m.decode();
    let value: number | undefined;
    if (a.has(0)) value = this.playing ? 1 : 0;
    else if (a.has(1)) value = this.x;
    else if (a.has(2)) value = this.y;
    else if (a.has(3)) value = this.width;
    else if (a.has(4)) value = this.height;
    else if (a.has(5)) value = this.volume;
    else if (a.has(6)) {
      const data = await this.folder.readFile(windowsPath(m.system.string68 + a.text(6)));
      value = 0;
      if (data) {
        value = 255;
        if (data[0] === 0 && data[1] === 0 && data[2] === 1 && data[3] === 186) {
          if ((data[4]! & 0xf0) === 0x20) value = 1;
          else if ((data[4]! & 0xc0) === 0x40) value = 2;
        }
      }
    }
    if (value !== undefined) {
      const slot = a.has(7);
      m.setInt(a.variable[slot]!, a.variableIndex[slot]!, BigInt(value));
    }
    return 0;
  }
}
