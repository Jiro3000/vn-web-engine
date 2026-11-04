import type {YurisNode} from './nodes.js';
import type {ByteString} from './numbers.js';

/** Nesting limit of the IF, LOOP and GOSUB stacks (error 0x18CE0). */
export const NESTING_LIMIT = 0x40;

/** Parameter and result groups of a call frame, in the order of their flag blocks. */
const enum Group {
  ParamInt,
  ParamFloat,
  ParamString,
  ResultInt,
  ResultFloat,
  ResultString,
}

/**
 * A GOSUB frame (0x328 bytes, allocated on first use at task + 0x144 + depth * 4 and reused,
 * so values persist between calls). Each group stores 17 values (index 0 unused by scripts)
 * and a flag block whose first byte is the group's count: PINT at +0x10 with flags at +700,
 * PFLT +0x98 / +0x2CD, PSTR +0x120 / +0x2DE, RINT +0x168 / +0x2EF, RFLT +0x1F0 / +0x300,
 * RSTR +0x278 / +0x311. Readers accept indexes up to the count (signed 64-bit compare).
 */
export class YurisFrame {
  readonly ints = [new BigInt64Array(17), new BigInt64Array(17)];
  readonly floats = [new Float64Array(17), new Float64Array(17)];
  readonly strings: (ByteString | null)[][] = [new Array(17).fill(null), new Array(17).fill(null)];
  /** The six flag blocks; byte 0 of each is the count. */
  readonly flags = Array.from({length: 6}, () => new Int8Array(17));
  /** +0, +1: the caller's IF and LOOP depth; +4 return position; +8 script; +0xC line. */
  ifDepth = 0;
  loopDepth = 0;
  returnPosition = 0;
  returnScript = 0;
  returnLine = 0;

  private within(group: Group, index: number, indexHigh: number): boolean {
    const count = this.flags[group]![0]!;
    return indexHigh < 0 || (indexHigh === 0 && index <= count);
  }

  /** The byte at flag block + index, with index 0 the count; 0 outside the block. */
  private flag(group: Group, index: number): number {
    return this.flags[group]![index] ?? 0;
  }

  paramInt(index: number, indexHigh: number): bigint {
    return this.within(Group.ParamInt, index, indexHigh) ? (this.ints[0]![index] ?? 0n) : 0n;
  }
  paramFloat(index: number, indexHigh: number): number {
    return this.within(Group.ParamFloat, index, indexHigh) ? (this.floats[0]![index] ?? 0) : 0;
  }
  paramString(index: number, indexHigh: number): ByteString {
    return this.within(Group.ParamString, index, indexHigh) ? (this.strings[0]![index] ?? '') : '';
  }
  resultInt(index: number, indexHigh: number): bigint {
    return this.within(Group.ResultInt, index, indexHigh) ? (this.ints[1]![index] ?? 0n) : 0n;
  }
  resultFloat(index: number, indexHigh: number): number {
    return this.within(Group.ResultFloat, index, indexHigh) ? (this.floats[1]![index] ?? 0) : 0;
  }
  resultString(index: number, indexHigh: number): ByteString {
    return this.within(Group.ResultString, index, indexHigh)
      ? (this.strings[1]![index] ?? '')
      : '';
  }

  /** Ids 0x39-0x3B and 0x40-0x42: 1 when the flag byte is positive. */
  paramFlag(group: number, index: number, indexHigh: number): bigint {
    return this.within(group, index, indexHigh) && this.flag(group, index) > 0 ? 1n : 0n;
  }

  /** Id 0x38: whether any parameter group has a positive flag at `index`. */
  anyParam(index: number, indexHigh: number): boolean {
    for (let g = Group.ParamInt; g <= Group.ParamString; g++)
      if (this.within(g, index, indexHigh) && this.flag(g, index) > 0) return true;
    return false;
  }

  /** Id 0x3F. */
  anyResult(index: number, indexHigh: number): boolean {
    for (let g = Group.ResultInt; g <= Group.ResultString; g++)
      if (this.within(g, index, indexHigh) && this.flag(g, index) > 0) return true;
    return false;
  }

  /** Writes allowed by LET to PINT and PFLT: the same bound as the readers. */
  writable(group: number, index: number): boolean {
    return index >= 0 && index <= this.flags[group]![0]!;
  }
}

export interface YurisIfEntry {
  /** +0: the LOOP depth when the IF was entered. */
  loopDepth: number;
  /** +4: the IF instruction. */
  position: number;
  /** +8: the IFEND target. */
  end: number;
}

export interface YurisLoopEntry {
  /** +0: the IF depth when the LOOP was entered. */
  ifDepth: number;
  /** +4: the first instruction of the body. */
  start: number;
  /** +8: the LOOPEND instruction. */
  end: number;
  /** +0x10: the iteration counter, from 1. */
  counter: bigint;
  /** +0x18: the iteration count; -1 loops forever. */
  limit: bigint;
}

/**
 * A script task (struct at task node + 0x44). The dispatcher 0x40449C runs the instruction at
 * `position` while the task is enabled and active, its frame and time waits are over and no
 * handler yields.
 */
export class YurisTask {
  /** +0x14 E and +0x15 A: both must be set for the task to run. */
  enabled = 1;
  active = 1;
  /** +8: set for tasks whose top-level RETURN is an error. */
  noReturn = 0;
  /** +9: the text buffer is cleared before the task next runs (0x40480C). */
  flushText = 0;
  /** +0x18: frames left to wait; +0x1C: `timeGetTime` deadline. */
  waitFrames = 0;
  waitUntil = 0;
  /** +0x20 next instruction, +0x3C script number. */
  position = 0;
  script = 0;
  /** +0x3E, +0x40: IF stack. */
  ifDepth = 0;
  readonly ifs: YurisIfEntry[] = [];
  /** +0x244, +0x248: LOOP stack. */
  loopDepth = 0;
  readonly loops: YurisLoopEntry[] = [];
  /** +0x140, +0x144: GOSUB depth and frames. */
  gosubDepth = 0;
  readonly frames: YurisFrame[] = [];
  /** +0x348 TINT, +0x3D0 TFLT, +0x458 TSTR (ids 0x43-0x45), indexed from 1. */
  readonly ints = new BigInt64Array(17);
  readonly floats = new Float64Array(17);
  readonly strings: ByteString[] = new Array(17).fill('');
  /** +0xC and +0x10: TASKINFO TEXTLINE and NEXTVOICE. */
  textLine = 0;
  nextVoice = 0;
  /** +0: the dispatcher pass (0x871F40) in which the task last ran. */
  pass = 0n;
  /** The task tree leaf that owns the task (its Z and name). */
  node: YurisNode<YurisTask> | null = null;

  constructor(readonly name: ByteString) {}

  /** The current frame (task + 0x144 + depth * 4), allocated on first use. */
  get frame(): YurisFrame {
    return this.frameAt(this.gosubDepth);
  }

  frameAt(depth: number): YurisFrame {
    let frame = this.frames[depth];
    if (!frame) this.frames[depth] = frame = new YurisFrame();
    return frame;
  }

  ifEntry(depth: number): YurisIfEntry {
    let entry = this.ifs[depth];
    if (!entry) this.ifs[depth] = entry = {loopDepth: 0, position: 0, end: 0};
    return entry;
  }

  loopEntry(depth: number): YurisLoopEntry {
    let entry = this.loops[depth];
    if (!entry) this.loops[depth] = entry = {ifDepth: 0, start: 0, end: 0, counter: 0n, limit: 0n};
    return entry;
  }
}
