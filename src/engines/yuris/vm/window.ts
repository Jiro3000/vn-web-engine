import type {YurisCgNode} from './cg.js';
import {YurisError} from './errors.js';
import type {YurisMachine} from './machine.js';
import {resolveNodePath} from './nodes.js';
import type {ByteString} from './numbers.js';
import {YurisType} from './variables.js';

/** The program's windows: 0 is the main window, 1-3 are WINDOW sub-windows. */
export const WINDOWS = 4;

/**
 * The window manager calls of WINDOW, WINDOWEND and WINDOWINFO. Window `no` is 0 for the main
 * window; sizes are client pixels. The project layer decides how each maps onto the page.
 */
export interface YurisWindowHost {
  /** CreateWindowExA of a sub-window ("%s_sub_%d", 0x457784); false when it failed. */
  createWindow(no: number, caption: ByteString, width: number, height: number): boolean;
  /** ShowWindow: SW_HIDE, SW_SHOW, SW_MINIMIZE or OpenIcon (restore). */
  showWindow(no: number, state: 'hide' | 'show' | 'minimize' | 'restore'): void;
  /** WM_SETTEXT. */
  setCaption(no: number, caption: ByteString): void;
  /** SetLayeredWindowAttributes with LWA_ALPHA, 0..255. */
  setAlpha(no: number, alpha: number): void;
  /** SetWindowPos (0x457388): the window's top-left corner on the desktop. */
  setPosition(no: number, x: number, y: number): void;
  /** GetWindowRect: the window's top-left corner. */
  position(no: number): {readonly x: number; readonly y: number};
  /** MoveWindow to a client area of this size (AdjustWindowRectEx). */
  setClientSize(no: number, width: number, height: number): void;
  /** GetClientRect. */
  clientSize(no: number): {readonly width: number; readonly height: number};
  /**
   * Whether the main window swallows SC_SCREENSAVE (SYSTEM SCREENSAVER, 0x45D76C): the screen
   * saver cannot start while the program is in the foreground. Called at start-up and on
   * every change.
   */
  blockScreenSaver(blocked: boolean): void;
  /** GetDeviceCaps HORZRES, VERTRES and BITSPIXEL of the screen DC, read once at start-up (0x468EB0). */
  desktop(): {readonly width: number; readonly height: number; readonly bitsPerPixel: number};
  /** SetWindowPos: 0 top, 1 topmost, 2 bottom, 3 behind the main window (0x457C0C). */
  setOrder(no: number, z: number): void;
  /** SetForegroundWindow. */
  activate(no: number): void;
  /** WS_MAXIMIZEBOX (FULLSCREENBUTTON) and WS_THICKFRAME (RESIZE) of the frame style. */
  setFrame(no: number, maximizeBox: boolean, resizable: boolean): void;
  /** The display mode switch 0x4121E8 (on) and 0x4118AC (off). */
  setFullscreen(fullscreen: boolean): void;
  /** WM_SYSCOMMAND SC_MAXIMIZE, or SC_RESTORE of a maximised window. */
  setMaximized(no: number, maximized: boolean): void;
  /** FlashWindowEx with FLASHW_TRAY, `count` times, every `timeout` milliseconds (0x457C2C). */
  flash(no: number, count: number, timeout: number): void;
  /** IsIconic. */
  minimized(no: number): boolean;
}

/** A window object at 0x87279C + no * 4. */
export class YurisWindow {
  /** 0x872404 + no * 4: the window exists (it is -1 before WINDOW creates it). */
  exists = false;
  /** +0x4, +0x8: the top-left corner; +0xC, +0x10: the screen (client) size in game pixels. */
  x = 0;
  y = 0;
  width = 0x80;
  height = 0x80;
  /** +0x14 A, +0x18 E, +0x1A CLOSEMODE, +0x1B MAXMODE, +0x1C MINMODE (0x4677C4 defaults). */
  alpha = 0x100;
  e = 0;
  closeMode = 1;
  maxMode = 0;
  minMode = 1;
  /** +0x1D: the caption. */
  caption: ByteString = '';
  /** +0x2A8: the window is active. */
  active = true;

  constructor(readonly no: number) {
    if (no === 0) this.maxMode = 1;
    else this.e = 1;
  }
}

/** SYSTEM, WINDOW, WINDOWEND and WINDOWINFO command ids. */
const SYSTEM = 0x5d,
  WINDOW = 0x69,
  WINDOWEND = 0x6a,
  WINDOWINFO = 0x6b;

const enum Arg {
  No,
  Caption,
  A,
  E,
  X,
  Y,
  Z,
  Sx,
  Sy,
  Wsx,
  Wsy,
  Active,
  FullscreenButton,
  Fullscreen,
  Minimize,
  Maximize,
  MaxMode,
  MinMode,
  CloseMode,
  Flash,
  FlashTime,
  CgId,
  MenuId,
  RegionId,
  DragId,
  Resize,
}

const enum SystemArg {
  ScreenSaver,
  BackgroundExec,
  Sx,
  Sy,
  TimeCount,
}

const enum Info {
  No,
  Let,
  Exist,
  A,
  E,
  Active,
  Caption,
  X,
  Y,
  Z,
  Sx,
  Sy,
  Wsx,
  Wsy,
  DisplayNo,
  Fullscreen,
  Fullscreen2,
  Minimize,
}

/** The windows and the display state shared by them. */
export class YurisWindows {
  readonly windows = Array.from({length: WINDOWS}, (_, no) => new YurisWindow(no));
  /** 0x8722F4: full-screen display mode; 0x8722F8: the main window is maximised. */
  fullscreen = false;
  maximized = false;
  /** 0x8721CC: the display the main window is on. */
  display = 0;
  /** 0x8722FC: the main window frame is resizable; WS_MAXIMIZEBOX of FULLSCREENBUTTON. */
  resizable = 0;
  maximizeBox = true;
  /** 0x872284..0x87228C: the layer whose area drags the main window (WINDOW DRAGID). */
  dragLayer: YurisCgNode | null = null;

  constructor(
    private readonly m: YurisMachine,
    private readonly host: YurisWindowHost,
    width: number,
    height: number,
  ) {
    const main = this.windows[0]!;
    main.exists = true;
    main.e = 1;
    main.width = width;
    main.height = height;
  }

  install(): void {
    this.host.blockScreenSaver(this.m.system.screenSaverBlocked !== 0);
    this.m.define(SYSTEM, () => this.system());
    this.m.define(WINDOW, () => this.window());
    this.m.define(WINDOWEND, () => this.windowEnd());
    this.m.define(WINDOWINFO, () => this.windowInfo());
  }

  /**
   * SYSTEM 0x44FD2C: SCREENSAVER, BACKGROUNDEXEC (taken only while the main window is
   * active), the screen size SX and SY (both positive; the main window's +0xC and +0x10 and
   * 0x8723BC/0x8723C0) and the timers' running flags TIMECOUNT..TIMECOUNT4.
   *
   * A full-screen or maximised display then recomputes its scaled area (0x412768), clears the
   * window (0x450074) and, composed with Direct3D, resets the device (0x407660); the
   * presenter does this from the new screen size.
   */
  private system(): number {
    const m = this.m,
      a = m.args,
      s = m.system;
    m.decode();
    const byte = (arg: number) => Number(BigInt.asUintN(8, a.int(arg)));
    const int = (arg: number) => (a.has(arg) ? Number(BigInt.asIntN(32, a.int(arg))) : 0);
    if (a.has(SystemArg.ScreenSaver)) {
      s.screenSaverBlocked = byte(SystemArg.ScreenSaver);
      this.host.blockScreenSaver(s.screenSaverBlocked !== 0);
    }
    if (a.has(SystemArg.BackgroundExec) && this.windows[0]!.active)
      s.backgroundExec = byte(SystemArg.BackgroundExec);
    const width = int(SystemArg.Sx),
      height = int(SystemArg.Sy);
    if (width > 0 && height > 0) {
      const main = this.windows[0]!;
      main.width = width;
      main.height = height;
    }
    for (let n = 1; n <= 4; n++) {
      const arg = SystemArg.TimeCount + n - 1;
      if (a.has(arg)) s.setTimerRunning(n, byte(arg), m.now());
    }
    return 0;
  }

  /**
   * WM_ACTIVATE of window `no` (0x45D738): +0x2A8 follows the activation. The repaint of the
   * window's layer set that follows (0x45EC98) is left to the presenter, whose canvas keeps
   * its content.
   */
  activate(no: number, active: boolean): void {
    this.windows[no]!.active = active;
  }

  /**
   * WM_NCLBUTTONDOWN on the caption (0x45D48C) and WM_NCLBUTTONUP, WM_LBUTTONUP or
   * WM_EXITSIZEMOVE (0x45D470) of the main window: with PRODUCT COM 0x4E2B set, the program
   * suspends while the caption is held.
   */
  captionPress(pressed: boolean): void {
    const s = this.m.system;
    if (!s.suspendOnCaption) return;
    if (pressed) s.suspend(this.m.now());
    else if (s.suspended) s.resume(this.m.now());
  }

  /**
   * The per-frame activity check (0x41022A..0x410261): a minimised window is inactive. Without
   * BACKGROUNDEXEC the program then suspends while the main window is inactive and resumes
   * when it is active again (0x45CA80); with it, a pending suspension ends.
   */
  background(): void {
    const s = this.m.system,
      now = this.m.now();
    for (const w of this.windows)
      if (w.exists && w.active && this.host.minimized(w.no)) w.active = false;
    const active = this.windows[0]!.active;
    if (s.backgroundExec !== 0) s.suspended = false;
    else if (!active) s.suspend(now);
    else s.resume(now);
  }

  /**
   * WINDOW 0x4561A8. SX/SY set the screen size and WSX/WSY the client size (the other side
   * follows the aspect ratio, bounded by the desktop), both ignored in full-screen or maximised
   * display. A missing sub-window is created with CAPTION. Then CAPTION, A, E, X, Y, Z, MAXMODE,
   * MINMODE, CLOSEMODE, FLASH, CGID (the layer set the window shows), MENUID, REGIONID, DRAGID,
   * FULLSCREENBUTTON, ACTIVE, FULLSCREEN, MINIMIZE, MAXIMIZE and RESIZE in that order.
   */
  private window(): number {
    const m = this.m,
      a = m.args,
      host = this.host;
    m.decode();
    const id = a.has(Arg.No) ? a.int(Arg.No) : 0n;
    const no = Number(BigInt.asUintN(32, id));
    const w = this.windows[no]!;
    const low = (arg: number) => Number(BigInt.asIntN(32, a.int(arg)));
    const windowed = !this.fullscreen && !this.maximized;
    const width = a.has(Arg.Sx) && windowed ? low(Arg.Sx) : null;
    const height = a.has(Arg.Sy) && windowed ? low(Arg.Sy) : null;
    const desktopWidth = m.system.desktopWidth,
      desktopHeight = m.system.desktopHeight;
    if (a.has(Arg.Wsx) && windowed) {
      const cw = Math.min(low(Arg.Wsx), desktopWidth);
      host.setClientSize(no, cw, Math.trunc((w.height * cw) / w.width));
    }
    if (a.has(Arg.Wsy) && windowed) {
      const ch = Math.min(low(Arg.Wsy), desktopHeight);
      host.setClientSize(no, Math.trunc((w.width * ch) / w.height), ch);
    }
    if ((width !== null || height !== null) && w.exists) {
      let changed = false;
      if (width !== null) {
        changed = width !== w.width;
        w.width = width;
      }
      if (height !== null) {
        if (height !== w.height) changed = true;
        w.height = height;
      }
      if (changed) {
        const client = host.clientSize(no);
        host.setClientSize(
          no,
          client.width - desktopWidth + w.width,
          client.height - desktopHeight + w.height,
        );
      }
    }
    if (!w.exists) {
      w.x = w.y = 0;
      w.width = width ?? 0x80;
      w.height = height ?? 0x80;
      if (!a.has(Arg.Caption))
        throw new YurisError(0x18bc8, [m.commandName(m.instruction.command)]);
      if (!host.createWindow(no, a.text(Arg.Caption) || ' ', w.width, w.height)) return -1;
      if (id !== 0n) host.showWindow(no, 'show');
      w.exists = true;
    }
    if (a.has(Arg.Caption)) {
      w.caption = a.text(Arg.Caption) || ' ';
      host.setCaption(no, w.caption);
    }
    if (a.has(Arg.A)) {
      w.alpha = low(Arg.A);
      host.setAlpha(no, Math.min(w.alpha, 0xff) & 0xff);
    }
    if (a.has(Arg.E)) {
      const e = (low(Arg.E) << 24) >> 24;
      const changed = e !== w.e;
      w.e = e;
      if (changed) host.showWindow(no, e < 1 ? 'hide' : 'show');
    }
    if (a.has(Arg.X)) {
      w.x = low(Arg.X);
      host.setPosition(no, w.x, w.y);
    }
    if (a.has(Arg.Y)) {
      w.y = low(Arg.Y);
      host.setPosition(no, w.x, w.y);
    }
    if (a.has(Arg.Z)) {
      const z = a.int(Arg.Z);
      if (id === 0n && z === 3n)
        throw new YurisError(0x18bbe, [m.commandName(m.instruction.command), 'Z', '3']);
      if (w.exists && z >= 0n && z <= 3n) host.setOrder(no, Number(z));
    }
    if (a.has(Arg.MaxMode)) w.maxMode = (low(Arg.MaxMode) << 24) >> 24;
    if (a.has(Arg.MinMode)) w.minMode = (low(Arg.MinMode) << 24) >> 24;
    if (a.has(Arg.CloseMode)) {
      const mode = (low(Arg.CloseMode) << 24) >> 24;
      w.closeMode = mode;
      if (id === 0n && (mode < 0 || mode > 2))
        throw new YurisError(0x18bbe, [
          m.commandName(m.instruction.command),
          'CLOSEMODE',
          String(mode),
        ]);
    }
    if (a.has(Arg.Flash))
      host.flash(no, low(Arg.Flash), a.has(Arg.FlashTime) ? low(Arg.FlashTime) : 0);
    if (a.has(Arg.CgId)) {
      const node = this.layer(a.text(Arg.CgId));
      if (!node) return -1;
      const layers = m.layers,
        cg = node.payload!;
      layers.windowLayers[no] = node;
      if (cg.width === 0 || cg.height === 0) {
        layers.windowLayers[no] = null;
        m.quit = true;
        // 0x879C80.
        return m.messageBox('サイズが 0x0 のレイヤセットを表示対象に指定することは出来ません。');
      }
      cg.uploadAll = true;
      cg.dirty = true;
      cg.clip.splice(0, 4, 0, 0, cg.width - 1, cg.height - 1);
    }
    if (a.has(Arg.MenuId)) {
      const result = m.menus.windowMenu(no, a.text(Arg.MenuId));
      if (result) return result;
    }
    if (a.has(Arg.RegionId)) throw new Error('WINDOW REGIONID is not implemented');
    if (a.has(Arg.DragId)) {
      const node = this.layer(a.text(Arg.DragId));
      if (!node) return -1;
      this.dragLayer = node;
    }
    if (a.has(Arg.FullscreenButton) && !this.fullscreen) {
      this.maximizeBox = a.int(Arg.FullscreenButton) === 1n;
      host.setFrame(no, this.maximizeBox, this.resizable !== 0);
    }
    if (a.has(Arg.Active) && a.int(Arg.Active) === 1n) host.activate(no);
    if (
      a.has(Arg.Fullscreen) &&
      id === 0n &&
      this.setFullscreen((low(Arg.Fullscreen) << 24) >> 24 === 1)
    ) {
      const cg = m.layers.windowLayers[no]?.payload;
      if (cg) {
        cg.uploadAll = true;
        cg.dirty = true;
        cg.clip.splice(0, 4, 0, 0, cg.width - 1, cg.height - 1);
      }
    }
    if (a.has(Arg.Minimize)) {
      const mode = a.int(Arg.Minimize);
      if (mode === 1n) host.showWindow(no, 'minimize');
      else if (mode === 2n) {
        host.showWindow(no, 'minimize');
        host.showWindow(no, 'hide');
      } else if (mode === 0n) {
        host.showWindow(no, 'restore');
        this.maximized = false;
      }
    }
    if (a.has(Arg.Maximize)) {
      this.maximized = !this.maximized;
      host.setMaximized(no, this.maximized);
    }
    if (a.has(Arg.Resize)) {
      const value = low(Arg.Resize);
      if (value !== this.resizable) {
        this.resizable = (value << 24) >> 24;
        if (!this.fullscreen) host.setFrame(0, this.maximizeBox, this.resizable !== 0);
      }
    }
    return 0;
  }

  /** 0x4573E8 + 0x40CA7D: the layer an id names, error 0x18B82 when there is none. */
  private layer(id: ByteString): YurisCgNode | null {
    const m = this.m;
    const resolved = resolveNodePath(m.system.names[0]!, id);
    const node = m.layers.lookup(resolved.path, false);
    if (!node) throw new YurisError(0x18b82, [m.commandName(m.instruction.command), id]);
    return node;
  }

  /** 0x458041: switches the display mode; true when it changed. */
  setFullscreen(fullscreen: boolean): boolean {
    if (fullscreen === this.fullscreen) return false;
    if (!fullscreen) this.maximized = false;
    this.fullscreen = fullscreen;
    this.host.setFullscreen(fullscreen);
    return true;
  }

  /** WINDOWEND 0x4580A8: hides a sub-window; the main window cannot be ended (0x18BD2). */
  private windowEnd(): number {
    const m = this.m,
      a = m.args;
    m.decode();
    if (!a.has(Arg.No)) return 0;
    const id = a.int(Arg.No);
    if (id === 0n) throw new YurisError(0x18bd2, [m.commandName(m.instruction.command), 'NO', '0']);
    this.host.showWindow(Number(id), 'hide');
    return 0;
  }

  /**
   * WINDOWINFO 0x458128: one property into LET. A missing window reads 0 (an empty string for
   * a string variable); EXIST is 1 for an existing one. X and Y read the window's position,
   * WSX and WSY its client size, SX and SY the screen size.
   */
  private windowInfo(): number {
    const m = this.m,
      a = m.args;
    m.decode();
    const slot = a.has(Info.Let),
      id = a.variable[slot]!,
      index = a.variableIndex[slot]!;
    const no = Number(BigInt.asUintN(32, a.int(Info.No)));
    const w = this.windows[no]!;
    const type = m.variables.get(id).type;
    const put = (value: number) => m.setInt(id, index, BigInt(value));
    if (!w.exists) {
      if (type === YurisType.String) m.setString(id, index, '');
      else if (type === YurisType.Int || type === YurisType.Float) m.setInt(id, index, 0n);
      return 0;
    }
    if (a.has(Info.Exist)) {
      if (type === YurisType.Int || type === YurisType.Float) m.setInt(id, index, 1n);
      else throw new YurisError(0x18b14);
      return 0;
    }
    if (a.has(Info.A)) return (put(w.alpha), 0);
    if (a.has(Info.E)) return (put(w.e), 0);
    if (a.has(Info.Active)) return (put(w.active ? 1 : 0), 0);
    if (a.has(Info.Caption)) {
      if (type === YurisType.String) m.setString(id, index, w.caption);
      return 0;
    }
    if (a.has(Info.X)) {
      w.x = this.host.position(no).x;
      return (put(w.x), 0);
    }
    if (a.has(Info.Y)) {
      w.y = this.host.position(no).y;
      return (put(w.y), 0);
    }
    if (a.has(Info.Sx)) return (put(w.width), 0);
    if (a.has(Info.Sy)) return (put(w.height), 0);
    if (a.has(Info.Wsx)) return (put(this.host.clientSize(no).width), 0);
    if (a.has(Info.Wsy)) return (put(this.host.clientSize(no).height), 0);
    if (a.has(Info.Fullscreen)) return (put(this.fullscreen ? 1 : 0), 0);
    if (a.has(Info.Fullscreen2)) return (put(this.maximized ? 1 : 0), 0);
    if (a.has(Info.DisplayNo)) return (put(this.display), 0);
    if (a.has(Info.Minimize)) {
      if (type === YurisType.Int || type === YurisType.Float)
        m.setInt(id, index, this.host.minimized(no) ? 1n : 0n);
      else throw new YurisError(0x18b14);
    }
    return 0;
  }
}
