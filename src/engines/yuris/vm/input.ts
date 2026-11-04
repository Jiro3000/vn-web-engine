import type {YurisMachine} from './machine.js';
import {resolveNodePath} from './nodes.js';
import type {YurisSystem} from './system.js';

/** A game pad as `joyGetPosEx` reports it: axes 0..0xFFFF (0x7FFF centred) and 32 button bits. */
export interface YurisPad {
  readonly x: number;
  readonly y: number;
  readonly buttons: number;
}

/** A cursor image made from a layer (0x449E2C): straight BGRA rows and the hot spot. */
export interface YurisCursorImage {
  readonly pixels: Uint8Array;
  readonly width: number;
  readonly height: number;
  readonly hotX: number;
  readonly hotY: number;
}

/** The pointer and game pad services the input update uses. */
export interface YurisInputHost {
  /** `joyGetPosEx` of every pad `joyGetNumDevs` counted; null for one that cannot be read. */
  readPads(): readonly (YurisPad | null)[];
  /** `ShowCursor` (0x43D5B8). */
  showCursor(visible: boolean): void;
  /** `SetCursorPos` (MOUSE X and Y), in client pixels of the main window. */
  moveCursor(x: number, y: number): void;
  /** MOUSE CURSOR: a system cursor id (`IDC_*`, 0x7F00..) or MOUSE ID's layer image. */
  setCursor(cursor: number | YurisCursorImage): void;
}

/** Number of key slots in 0x663360; the pad block starts at 0x180, 0x24 slots per pad. */
const KEY_SLOTS = 0x400;
export const PAD_SLOTS = 0x180;
export const PAD_STRIDE = 0x24;
const PAD_LIMIT = 0x10;

/** 0x5797E0: the virtual keys the key pass updates, in order. */
const KEYS = Uint8Array.of(
  0x08, 0x09, 0x0d, 0x10, 0x11, 0x12, 0x13, 0x1b, 0x20, 0x21, 0x22, 0x23, 0x24, 0x25, 0x26, 0x27,
  0x28, 0x2c, 0x2d, 0x2e, 0x2f, 0x30, 0x31, 0x32, 0x33, 0x34, 0x35, 0x36, 0x37, 0x38, 0x39, 0x41,
  0x42, 0x43, 0x44, 0x45, 0x46, 0x47, 0x48, 0x49, 0x4a, 0x4b, 0x4c, 0x4d, 0x4e, 0x4f, 0x50, 0x51,
  0x52, 0x53, 0x54, 0x55, 0x56, 0x57, 0x58, 0x59, 0x5a, 0x60, 0x61, 0x62, 0x63, 0x64, 0x65, 0x66,
  0x67, 0x68, 0x69, 0x6a, 0x6b, 0x6c, 0x6d, 0x6e, 0x6f, 0x70, 0x71, 0x72, 0x73, 0x74, 0x75, 0x76,
  0x77, 0x78, 0x79, 0x7a, 0x7b, 0x7c, 0x7d, 0x7e, 0x7f, 0x80, 0x81, 0x82, 0x83, 0x84, 0x85, 0x86,
  0x87, 0x90, 0x91, 0xa0, 0xa1, 0xa2, 0xa3, 0xa4, 0xa5, 0xba, 0xbb, 0xbc, 0xbd, 0xbe, 0xbf, 0xc0,
  0xdb, 0xdc, 0xdd, 0xde, 0xe2,
);

/** The mouse slots: buttons (1 L, 2 R, 4 M), the wheel (5 up, 6 down) and movement (7). */
const enum Mouse {
  Left = 1,
  Right = 2,
  Middle = 4,
  WheelUp = 5,
  WheelDown = 6,
  Move = 7,
}

/**
 * The input model: the key state read before a frame (0x403F2C), the window procedure's
 * mouse messages (0x45CEBC) and the per-frame update 0x40FEF0. Every slot runs the state
 * machine of the handler table 0x872D6C: a press sets the counter to 1 and counts an edge,
 * holding counts up, a release sets -1 and idling counts down.
 */
export class YurisInput {
  /** GetKeyboardState of the active window (bit 7 = held), mouse buttons included. */
  readonly keyboard = new Uint8Array(0x100);
  /** Whether a window of the program is active (window + 0x2A8). */
  active = true;
  /** The cursor in client pixels of the main window. */
  cursorX = 0;
  cursorY = 0;
  /** 0x663360: the key state the update reads, game pads from 0x180. */
  readonly state = new Uint8Array(KEY_SLOTS);
  /** INPUT KEY (0x59B7A8), PAD (0x8722EC) and MOUSE (0x59B7AC). */
  keys = 1;
  pad = 0;
  mouse = 1;
  /** 0x8722E8: pads were found at start-up; 0x8727BC: which pads the last read reached. */
  padsPresent = false;
  readonly padConnected = new Uint8Array(PAD_LIMIT);
  /** The last reading of each pad; one that cannot be read keeps it (centred initially). */
  private readonly pads: YurisPad[] = Array.from({length: PAD_LIMIT}, () => ({x: 0x7fff, y: 0x7fff, buttons: 0}));
  /** 0x872D7C: the active window, -1 when none is. */
  activeWindow = 0;
  /** Main window + 0x2B4 (cursor outside the client area) and + 0x2B5 (outside the margins). */
  outside = false;
  far = false;
  /** 0x8726B0 (WM_MOUSEMOVE) and 0x8726B4 (the wheel delta). */
  private moved = 0;
  private wheelDelta = 0;
  /** 0x8724F4: frames a touch (WM_TOUCH 0x240) keeps forcing the left button. */
  private touchFrames = 0;
  /** 0x59B798 cursor shown, 0x872600 pending ShowCursor (1 show, 2 hide). */
  cursorVisible = true;
  private cursorRequest = 0;
  /** MOUSE MODE (0x59B79C), auto-hiding (0x59B7A0) and its delay (0x59B7A4, TIME). */
  cursorMode = 1;
  autoHide = 1;
  hideDelay = 2500;
  /** Main window + 0x2B6..0x2B8: movement, clicks and the wheel show a hidden cursor. */
  wakeOnMove = 1;
  wakeOnClick = 1;
  wakeOnWheel = 1;
  /** Main window + 0x2B9 (hide timer running) and + 0x2BC (its start). */
  private hideTimer = false;
  private hideStart = 0;

  constructor(
    private readonly system: YurisSystem,
    private readonly host: YurisInputHost,
  ) {}

  /** WM_KEYDOWN. */
  keyDown(key: number): void {
    this.system.lastKey = key;
  }

  /** WM_MOUSEMOVE. */
  mouseMove(): void {
    this.moved = 0x80;
  }

  /** WM_LBUTTONDOWN (1, 0x45D4B8), WM_RBUTTONDOWN (2) and WM_MBUTTONDOWN (4). */
  buttonDown(button: number): void {
    this.system.lastButton = button;
  }

  /** WM_MOUSEWHEEL (0x45D4A8): the signed delta of the last message. */
  wheel(delta: number): void {
    this.wheelDelta = (delta << 16) >> 16;
  }

  /** WM_TOUCH (0x45D434): a left click held for the next frame. */
  touch(): void {
    this.system.lastButton = 1;
    this.touchFrames = 2;
  }

  /** 0x403F2C: the key state and cursor of the active window. */
  poll(width: number, height: number): void {
    if (this.active) {
      this.activeWindow = 0;
      this.state.set(this.keyboard);
      if (this.touchFrames > 0) {
        if (this.touchFrames === 1) this.state[Mouse.Left] = 0x80;
        this.touchFrames--;
      }
    } else {
      this.activeWindow = -1;
      this.state.fill(0);
      return;
    }
    const x = this.cursorX,
      y = this.cursorY;
    // Windows 1-3 (WINDOW) do not exist here: their cursor reads 0, 0.
    this.system.mouseX.fill(0);
    this.system.mouseY.fill(0);
    this.system.mouseX[0] = x;
    this.system.mouseY[0] = y;
    // The margins are the letterbox offsets 0x872270/0x872274, none for a window of the game size.
    this.outside = x < 0 || y < 0 || x >= width || y >= height;
    this.far = this.outside;
  }

  /**
   * 0x40FEF0 without the window bookkeeping: mouse, keys, pads and the cursor timer. `time` is
   * the paced time of the previous frame (0x8725A8).
   */
  update(now: number, time: number): void {
    const s = this.state,
      input = this.system.input;
    if (this.mouse) {
      if (this.activeWindow >= 0) {
        if (!this.far) {
          if (this.wheelDelta !== 0) s[this.wheelDelta > 0 ? Mouse.WheelUp : Mouse.WheelDown] = 0x80;
          s[Mouse.Move] = this.moved;
        } else {
          // Outside the window a button only stays held.
          for (const slot of [Mouse.Left, Mouse.Right, Mouse.Middle, Mouse.WheelUp, Mouse.WheelDown, Mouse.Move])
            if (!(input[slot]! > 0n)) s[slot] = 0;
        }
      }
      for (let slot = 1; slot < 8; slot++) this.step(slot, s[slot]! >> 7);
    }
    this.moved = 0;
    this.wheelDelta = 0;
    if (this.keys) {
      let any = 0;
      for (const key of KEYS) {
        any |= s[key]! >> 7;
        this.step(key, s[key]! >> 7);
      }
      this.step(0, any);
    }
    if (this.pad) this.updatePads();
    // The cursor of the main window hides after TIME milliseconds without movement.
    if (this.autoHide && !this.hideTimer) {
      this.hideTimer = true;
      this.hideStart = now >>> 0;
    }
    if (this.hideTimer) {
      if ((this.hideDelay + this.hideStart) >>> 0 < time >>> 0 && this.cursorVisible) {
        this.cursorRequest = 2;
        this.cursorVisible = false;
      }
      const held = (slot: number) => input[slot]! > 0n;
      if (
        this.autoHide &&
        (this.far ||
          (held(Mouse.Move) && this.wakeOnMove) ||
          ((held(Mouse.Left) || held(Mouse.Right) || held(Mouse.Middle)) && this.wakeOnClick) ||
          ((held(Mouse.WheelUp) || held(Mouse.WheelDown)) && this.wakeOnWheel))
      ) {
        this.hideTimer = false;
        this.show();
      }
    }
    this.applyCursor();
  }

  /** 0x41032C: the axes and buttons of every pad, then their slots. */
  private updatePads(): void {
    if (!this.padsPresent) return;
    this.padConnected.fill(0);
    const readings = this.host.readPads();
    for (let n = 0; n < Math.min(readings.length, PAD_LIMIT); n++) {
      const reading = readings[n];
      if (reading) {
        this.pads[n] = reading;
        this.padConnected[n] = 1;
      }
      const pad = this.pads[n]!,
        base = PAD_SLOTS + n * PAD_STRIDE,
        s = this.state;
      s[base] = pad.y < 0x7fff ? 0x80 : 0;
      s[base + 1] = pad.y > 0x7fff ? 0x80 : 0;
      s[base + 2] = pad.x < 0x7fff ? 0x80 : 0;
      s[base + 3] = pad.x > 0x7fff ? 0x80 : 0;
      for (let b = 0; b < 32; b++) s[base + 4 + b] = (pad.buttons >>> b) & 1 ? 0x80 : 0;
      for (let slot = base; slot < base + PAD_STRIDE; slot++) this.step(slot, s[slot]! >> 7);
    }
  }

  /** The handler table 0x872D6C (0x45CC0C, 0x45CC5C, 0x45CC3C, 0x45CC24) by state and key. */
  private step(slot: number, pressed: number): void {
    const system = this.system,
      input = system.input;
    const held = system.inputLatched[slot] !== 0;
    if (!held && !pressed) input[slot] = input[slot]! - 1n;
    else if (!held) {
      input[slot] = 1n;
      system.inputLatched[slot] = 2;
      system.inputEdge[slot] = BigInt.asIntN(64, system.inputEdge[slot]! + 1n);
    } else if (!pressed) {
      input[slot] = -1n;
      system.inputLatched[slot] = 0;
    } else input[slot] = BigInt.asIntN(64, input[slot]! + 1n);
  }

  /** 0x43D590: shows the cursor and stops the hide timer. */
  show(): void {
    if (!this.cursorVisible) {
      this.hideTimer = false;
      this.cursorRequest = 1;
      this.cursorVisible = true;
    }
  }

  /** 0x43D5B8: the pending ShowCursor call. */
  applyCursor(): void {
    if (this.cursorRequest === 1) this.host.showCursor(true);
    if (this.cursorRequest === 2) this.host.showCursor(false);
    this.cursorRequest = 0;
  }

  /** INPUT 0x443844: KEY, PAD and MOUSE; turning the mouse off hides the cursor, on shows it. */
  setEnabled(keys: number | null, pad: number | null, mouse: bigint | null): void {
    if (keys !== null) this.keys = keys & 0xff;
    if (pad !== null) this.pad = pad & 0xff;
    if (mouse === null) return;
    if (this.mouse === 1 && mouse === 0n) {
      this.cursorRequest = 2;
      this.cursorVisible = false;
    }
    if (this.mouse === 0 && mouse === 1n) {
      this.cursorRequest = 1;
      this.cursorVisible = true;
    }
    this.mouse = Number(BigInt.asIntN(8, mouse));
  }

  /** MOUSE MODE (0x449920): 0 hides the cursor for good, 1 auto-hides it, 2 always shows it. */
  setMode(mode: bigint): void {
    if (mode === 0n) {
      if (this.cursorVisible) {
        this.cursorRequest = 2;
        this.cursorVisible = false;
      }
      this.hideTimer = false;
      this.autoHide = 0;
      this.cursorMode = 0;
    }
    if (mode === 1n) {
      if (!this.hideTimer && !this.cursorVisible) this.show();
      this.autoHide = 1;
      this.cursorMode = 1;
    }
    if (mode === 2n) {
      this.show();
      this.hideTimer = false;
      this.autoHide = 0;
      this.cursorMode = 2;
    }
  }
}

/** INPUT and MOUSE command ids and arguments (`ysc.ybn`). */
const INPUT = 0x31,
  MOUSE = 0x45;
const enum MouseArg {
  Mode,
  Time,
  Move,
  Click,
  Wheel,
  X,
  Y,
  Cursor,
  HotX,
  HotY,
  Id,
}

/** MOUSE CURSOR 1..13: IDC_IBEAM .. IDC_HAND; anything else is IDC_ARROW (0x7F00). */
const CURSORS = [0x7f00, 0x7f01, 0x7f02, 0x7f03, 0x7f04, 0x7f82, 0x7f83, 0x7f84, 0x7f85, 0x7f86, 0x7f88, 0x7f89, 0x7f8a, 0x7f8b];

export function installInput(m: YurisMachine, input: YurisInput, host: YurisInputHost): void {
  m.define(INPUT, () => {
    const a = m.args;
    m.decode();
    const low = (id: number) => (a.has(id) ? Number(BigInt.asIntN(32, a.int(id))) : null);
    input.setEnabled(low(0), low(1), a.has(2) ? a.int(2) : null);
    return 0;
  });
  m.define(MOUSE, () => mouse(m, input, host));
}

/**
 * MOUSE 0x449920: MODE and TIME of the cursor hiding, which of MOVE, CLICK and WHEEL show it
 * again, X and Y move it, CURSOR picks a system cursor and ID makes one from a layer, with
 * HX and HY as its hot spot.
 */
function mouse(m: YurisMachine, input: YurisInput, host: YurisInputHost): number {
  const a = m.args;
  m.decode();
  const low = (id: number) => Number(BigInt.asIntN(32, a.int(id)));
  if (a.has(MouseArg.Mode)) input.setMode(a.int(MouseArg.Mode));
  if (a.has(MouseArg.Time)) input.hideDelay = low(MouseArg.Time) >>> 0;
  if (a.has(MouseArg.Move)) input.wakeOnMove = low(MouseArg.Move) & 0xff;
  if (a.has(MouseArg.Click)) input.wakeOnClick = low(MouseArg.Click) & 0xff;
  if (a.has(MouseArg.Wheel)) input.wakeOnWheel = low(MouseArg.Wheel) & 0xff;
  const system = m.system;
  if (a.has(MouseArg.X)) {
    system.mouseX[0] = low(MouseArg.X);
    host.moveCursor(system.mouseX[0], input.cursorY);
    input.cursorX = system.mouseX[0];
  }
  if (a.has(MouseArg.Y)) {
    system.mouseY[0] = low(MouseArg.Y);
    host.moveCursor(input.cursorX, system.mouseY[0]);
    input.cursorY = system.mouseY[0];
  }
  if (a.has(MouseArg.Cursor)) host.setCursor(CURSORS[low(MouseArg.Cursor)] ?? 0x7f00);
  const hotX = a.has(MouseArg.HotX) ? low(MouseArg.HotX) & 0xffff : 0,
    hotY = a.has(MouseArg.HotY) ? low(MouseArg.HotY) & 0xffff : 0;
  if (a.has(MouseArg.Id)) {
    const resolved = resolveNodePath(system.names[0]!, a.text(MouseArg.Id));
    const cg = m.layers.lookup(resolved.path, false)?.payload;
    if (cg) {
      const pixels = cg.pixels ?? new Uint8Array(cg.width * cg.height * 4);
      host.setCursor({pixels, width: cg.width, height: cg.height, hotX, hotY});
    }
  }
  return 0;
}
