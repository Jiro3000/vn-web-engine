import {YurisError} from './errors.js';
import type {YurisSystemValues} from './expression.js';
import {type ByteString, fistp, i64} from './numbers.js';
import {SYSTEM_VARIABLE_LIMIT, YurisType, type YurisVariables} from './variables.js';
import type {YurisTask} from './task.js';

/** Size of the input state arrays at 0x663B60 and 0x665C60 (int64 entries). */
export const INPUT_SLOTS = 0x400;

/** First slot of the game pad block in the input arrays: pad `n` button `b` is `0x180 + n * 0x24 + b`. */
const PAD_BASE = 0x180;
const PAD_STRIDE = 0x24;

/** The engine services the system variables read: clock, screen and windows. */
export interface YurisSystemHost {
  /** `timeGetTime()` in milliseconds. */
  now(): number;
}

/**
 * Engine state behind the system variables (ids below 1000), named by the native globals.
 * The getters are 0x448280 (int), 0x448110 (float) and 0x4212D4 (string); the setters are the
 * system-variable branches of LET (0x443BCC).
 */
export class YurisSystem implements YurisSystemValues {
  /** 0x663B60: input state per slot (keys by virtual-key code, pads from 0x180). */
  readonly input = new BigInt64Array(INPUT_SLOTS);
  /** 0x663760: slots whose LET keeps positive values instead of negative ones (0x444994). */
  readonly inputLatched = new Uint8Array(INPUT_SLOTS);
  /** 0x665C60: the second input array (edge state), written by LET directly. */
  readonly inputEdge = new BigInt64Array(INPUT_SLOTS);
  /** 0x667D60: the YSCM key table, mapping key variable ids to input slots. */
  readonly keys: Uint8Array;

  /** 0x87232C, 0x872330, 0x8722D4, 0x8722E4, 0x8722C4. */
  osVersion = 0;
  drive = 0;
  setting4 = 0;
  setting9 = 0;
  debug = 0;
  /** 0x872338 (nine strings) and 0x872334 (their count minus one): command-line arguments. */
  readonly arguments: ByteString[] = Array.from({length: 9}, () => '');
  argumentCount = -1;
  /** 0x87235C and 0x872360: the string list of id 0xE. */
  list: ByteString[] = [];
  listLength = 0;
  /** 0x872374.. (four bases), 0x59B740.. (running flags), 0x871F00.. (frozen values): timers 1-4. */
  readonly timerBase = new Float64Array(5);
  readonly timerRunning = Uint8Array.of(1, 1, 1, 1, 1);
  readonly timerFrozen = new Float64Array(5);
  /** 0x59B784 SCREENSAVER: the main window swallows SC_SCREENSAVE (0x45D76C). */
  screenSaverBlocked = 1;
  /** 0x59B73C BACKGROUNDEXEC: the program keeps running while its main window is inactive. */
  backgroundExec = 1;
  /** 0x87225C: the program is suspended in the background; 0x871F20: when it was suspended. */
  suspended = false;
  private suspendedAt = 0;
  /** 0x871F48: the frame counter (0x6D); 0x871F40: the dispatcher pass counter (0x6E). */
  frames = 0n;
  passes = 0n;
  /** 0x59B050: the CG preload thread runs (on unless the engine settings file turns it off). */
  preloadEnabled = true;
  /**
   * 0x59B04C: the SSE image routines are used (yscfg.dat word 2, read by 0x466AC0; on by
   * default). They also need the CPU's SSE flag 0x5B8614, which every browser host has.
   */
  simd = true;
  /**
   * 0x872030 (save folder kind), 0x871FF4, and the desktop's GetDeviceCaps values read by
   * 0x468EB0: 0x8723A4 BITSPIXEL, 0x87239C HORZRES and 0x8723A0 VERTRES.
   */
  saveFolderKind = 0;
  value71 = 0;
  bitsPerPixel = 0;
  desktopWidth = 0;
  desktopHeight = 0;
  /** 0x8726B8..0x8726C4 (bytes), 0x872048, 0x872464 (YSTD text count). */
  readonly bytes75 = new Uint8Array(4);
  value79 = 0;
  textCount = 0;
  /** 0x8726A8: the last WM_KEYDOWN key; 0x8726AC: the last mouse button pressed (1, 2, 4). */
  lastKey = 0;
  lastButton = 0;
  /** 0x871F60: the value of id 0x84 (the last LET of 0x84). */
  value84 = 0n;
  /** 0x87241C + 0x34. */
  value7e = 0;
  /** +0x2AC and +0x2B0 of the windows at 0x87279C..0x8727A8: the cursor in each (ids 0x85-0x8E). */
  readonly mouseX = new Int32Array(4);
  readonly mouseY = new Int32Array(4);
  /** 0x448F6C. */
  value8f = 0;
  /** 0x660C80 (game folder), 0x660DA0, 0x5CF080 (save folder), 0x660EC0, 0x660FE0. */
  folder = '';
  string68 = '';
  saveFolder = 'save\\';
  appData = '';
  documents = '';
  /**
   * The current paths of the node namespaces (ids 0x80-0x83), set by tree initialisation
   * 0x46891C: layers 0x872424 "W0", sounds 0x872430 "S0", tasks 0x87242C "", 0x872428 "M0".
   */
  readonly names: ByteString[] = ['W0', 'S0', '', 'M0'];
  /** The text buffer at 0x8725A4 + 0x18 and its kind buffer at + 0x1C (ids 0x7A, 0x7B). */
  text = '';
  textKinds = '';

  task: YurisTask | null = null;

  constructor(
    private readonly variables: YurisVariables,
    keyTable: Uint8Array,
    private readonly host: YurisSystemHost,
  ) {
    this.keys = keyTable;
  }

  /** 0x468209: the four timers start with the program. */
  startTimers(now: number): void {
    this.timerBase.fill(now, 1);
  }

  /**
   * SYSTEM TIMECOUNT..TIMECOUNT4 (0x44FE4C): 0 stops timer n at the current time, 1 restarts
   * it. A restart adds the stopped time to the base of timer 1 (0x872374) whichever timer it
   * is, so only timer 1 leaves out its pause; the others jump ahead by it.
   */
  setTimerRunning(n: number, value: number, now: number): void {
    if (this.timerRunning[n] === 1 && value === 0) {
      this.timerRunning[n] = 0;
      this.timerFrozen[n] = now;
    } else if (this.timerRunning[n] === 0 && value === 1) {
      this.timerRunning[n] = 1;
      this.timerBase[1]! += Math.trunc(now - this.timerFrozen[n]!) >>> 0;
      this.timerFrozen[n] = 0;
    }
  }

  /** 0x45CB64: the program enters the background suspension. */
  suspend(now: number): void {
    if (this.suspended) return;
    this.suspended = true;
    this.suspendedAt = now;
  }

  /** 0x45CACC: the suspension ends; every running timer leaves it out. */
  resume(now: number): void {
    if (!this.suspended) return;
    this.suspended = false;
    const elapsed = Math.trunc(now - this.suspendedAt) >>> 0;
    for (let n = 1; n <= 4; n++) if (this.timerRunning[n]) this.timerBase[n]! += elapsed;
    this.suspendedAt = 0;
  }

  private timer(n: number): bigint {
    const now = this.timerRunning[n] ? this.host.now() : this.timerFrozen[n]!;
    return BigInt(Math.trunc(now - this.timerBase[n]!) >>> 0);
  }

  /** 0x448280. */
  int(id: number, index: number, indexHigh: number): bigint {
    const task = this.task!;
    switch (id) {
      case 0:
        return localTime(index, indexHigh);
      case 1:
        if (indexHigh !== 0 || index > 4) return 0n;
        if (index === 0) return BigInt(Math.trunc(this.host.now()) >>> 0);
        return this.timer(index);
      case 2:
        return BigInt(this.osVersion);
      case 3:
        return BigInt(this.drive);
      case 4:
        return this.setting4 ? 1n : 0n;
      case 5:
      case 6:
      case 7:
        // GlobalMemoryStatus: total physical memory, memory load and available memory.
        return id === 5 ? 0x80000000n : id === 6 ? 50n : 0x40000000n;
      case 8:
        return 0n;
      case 9:
        return BigInt(this.setting9);
      case 0xb:
        return BigInt(this.debug);
      case 0xd:
        return BigInt(this.argumentCount);
      case 0xf:
        return BigInt(this.listLength >>> 0);
      case 0x30:
        return task.loopDepth === 0 ? 0n : task.loops[task.loopDepth - 1]!.counter;
      case 0x31:
        return 999n;
      case 0x32:
        return this.indirectInt(index, indexHigh);
      case 0x35:
        return task.frame.paramInt(index, indexHigh);
      case 0x38:
        return task.frame.anyParam(index, indexHigh) ? 1n : 0n;
      case 0x39:
        return task.frame.paramFlag(0, index, indexHigh);
      case 0x3a:
        return task.frame.paramFlag(1, index, indexHigh);
      case 0x3b:
        return task.frame.paramFlag(2, index, indexHigh);
      case 0x3c:
        return task.frame.resultInt(index, indexHigh);
      case 0x3f:
        return task.frame.anyResult(index, indexHigh) ? 1n : 0n;
      case 0x40:
        return task.frame.paramFlag(3, index, indexHigh);
      case 0x41:
        return task.frame.paramFlag(4, index, indexHigh);
      case 0x42:
        return task.frame.paramFlag(5, index, indexHigh);
      case 0x43:
        return task.ints[index] ?? 0n;
      case 0x46: {
        if (indexHigh < SYSTEM_VARIABLE_LIMIT) return 0n;
        const variable = this.variables.entries[indexHigh];
        return BigInt(variable ? variable.type : 0);
      }
      case 0x6c:
        return 0x22bn;
      case 0x6d:
        return this.frames;
      case 0x6e:
        return this.passes;
      case 0x6f:
        return this.timer(1);
      case 0x70:
        return BigInt(this.saveFolderKind);
      case 0x71:
        return BigInt(this.value71);
      case 0x72:
        return BigInt(this.bitsPerPixel);
      case 0x73:
        return BigInt(this.desktopWidth);
      case 0x74:
        return BigInt(this.desktopHeight);
      case 0x75:
      case 0x76:
      case 0x77:
      case 0x78:
        return BigInt(this.bytes75[id - 0x75]!);
      case 0x79:
        return BigInt(this.value79);
      case 0x7c:
        return BigInt(this.textCount);
      case 0x7e:
        return BigInt(this.value7e);
      case 0x84:
        return this.value84;
      case 0x85:
      case 0x86:
      case 0x87:
      case 0x88:
      case 0x89:
        return BigInt(this.mouseX[Math.max(0, id - 0x86)]!);
      case 0x8a:
      case 0x8b:
      case 0x8c:
      case 0x8d:
      case 0x8e:
        return BigInt(this.mouseY[Math.max(0, id - 0x8b)]!);
      case 0x8f:
        return BigInt(this.value8f);
      case 0x90:
        return indexHigh < 0 || (indexHigh === 0 && index === 0) ? 0n : this.input[index >>> 0]!;
      case 0x91:
        return BigInt(this.lastKey);
      case 0x92:
        return BigInt(this.lastButton);
    }
    if (id >= 0x93 && id <= 0x113) return this.input[this.keys[id - 0x93]!]!;
    if (id >= 0x114 && id <= 0x117) return this.input[PAD_BASE - 0x114 + id + index * PAD_STRIDE] ?? 0n;
    if (id === 0x118) return this.input[padButton(index)] ?? 0n;
    if (id >= 0x119 && id <= 0x198) return this.inputEdge[this.keys[id - 0x119]!]!;
    if (id >= 0x19a && id <= 0x19d)
      return this.inputEdge[PAD_BASE - 0x19a + id + index * PAD_STRIDE] ?? 0n;
    if (id === 0x19e) return this.inputEdge[padButton(index)] ?? 0n;
    // 0x19F-0x223: the slot numbers themselves, for INPUT and key commands.
    if (id >= 0x19f && id <= 0x21e) return BigInt(this.keys[id - 0x19f]!);
    if (id >= 0x21f && id <= 0x222) return BigInt(index * PAD_STRIDE + (id - 0x21f) + PAD_BASE);
    if (id === 0x223) return BigInt(padButton(index));
    return 0n;
  }

  /** 0x448110. */
  float(id: number, index: number, indexHigh: number): number {
    const task = this.task!;
    switch (id) {
      case 10:
        return Math.PI;
      case 0x33:
        return this.indirectFloat(index, indexHigh);
      case 0x36:
        return task.frame.paramFloat(index, indexHigh);
      case 0x3d:
        return task.frame.resultFloat(index, indexHigh);
      case 0x44:
        return task.floats[index] ?? 0;
    }
    return 0;
  }

  /** 0x4212D4. */
  string(id: number, index: number, indexHigh: number): ByteString {
    const task = this.task!;
    switch (id) {
      case 0xc:
        return this.arguments[index] ?? '';
      case 0xe:
        if (this.listLength === 0 || indexHigh >= (index >>> 0 < this.listLength ? 1 : 0))
          throw new YurisError(0x1a202);
        return this.list[index] ?? '';
      case 0x34:
        return this.indirectString(index, indexHigh);
      case 0x37:
        return task.frame.paramString(index, indexHigh);
      case 0x3e:
        return task.frame.resultString(index, indexHigh);
      case 0x45:
        return task.strings[index] ?? '';
      case 0x67:
        return this.folder;
      case 0x68:
        return this.string68;
      case 0x69:
        return this.saveFolder;
      case 0x6a:
        return this.appData;
      case 0x6b:
        return this.documents;
      case 0x7a:
        return this.text;
      case 0x7b:
        return this.textKinds;
      case 0x7d:
        return task.name;
      case 0x7f:
        return String.fromCharCode(index & 0xff);
      case 0x80:
      case 0x81:
      case 0x82:
      case 0x83:
        return this.names[id - 0x80]!;
    }
    return '';
  }

  /** Id 0x32: the int element `index` of variable `indexHigh` (0x459854), a float rounded. */
  private indirectInt(index: number, id: number): bigint {
    if (id < SYSTEM_VARIABLE_LIMIT) return 0n;
    const variable = this.variables.get(id);
    let value = 0n;
    if (variable.type === YurisType.Int) value = variable.has(index) ? variable.ints![index]! : 0n;
    if (variable.type === YurisType.Float)
      value = fistp(variable.has(index) ? variable.floats![index]! : 0);
    this.select(id, index);
    return value;
  }

  private indirectFloat(index: number, id: number): number {
    if (id < SYSTEM_VARIABLE_LIMIT) return 0;
    const variable = this.variables.get(id);
    let value = 0;
    if (variable.type === YurisType.Int)
      value = Number(variable.has(index) ? variable.ints![index]! : 0n);
    if (variable.type === YurisType.Float) value = variable.has(index) ? variable.floats![index]! : 0;
    this.select(id, index);
    return value;
  }

  private indirectString(index: number, id: number): ByteString {
    if (id < SYSTEM_VARIABLE_LIMIT) return '';
    const variable = this.variables.get(id);
    const value =
      variable.type === YurisType.String && variable.has(index) ? variable.strings![index]! : '';
    this.select(id, index);
    return value;
  }

  /** The indirect reads leave the addressed element as the last variable (0x7DB980/0x7DB988). */
  selected: {id: number; index: number} | null = null;
  private select(id: number, index: number): void {
    this.selected = {id, index};
  }

  /** 0x444994: LET of an input slot keeps only values of the slot's sign convention. */
  setInput(slot: number, value: bigint): void {
    const v = i64(value);
    this.input[slot] = this.inputLatched[slot] ? (v > 0n ? v : 0n) : v < 0n ? v : 0n;
  }
}

/** `(index / 32) * 0x24 + index % 32 + 0x184` with C division: pad buttons by flat number. */
function padButton(index: number): number {
  const quotient = Math.trunc(index / 32);
  return quotient * PAD_STRIDE + (index - quotient * 32) + 0x184;
}

/** Id 0: `GetLocalTime` fields through the jump table at 0x578180. */
function localTime(index: number, indexHigh: number): bigint {
  if (indexHigh !== 0 || index >= 0xf) return 0n;
  const now = new Date();
  const fields = [
    now.getFullYear(),
    now.getMonth() + 1,
    now.getDay(),
    now.getDate(),
    now.getHours(),
    now.getMinutes(),
    now.getSeconds(),
    now.getMilliseconds(),
  ];
  return BigInt(fields[index] ?? 0);
}
