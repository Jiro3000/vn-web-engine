import {byteDataView} from '../../core/binary.js';
import type {SiglusScene, SiglusScenePack} from '../../formats/siglus/scene-pack.js';

export type Value = number | string;
export type Argument = Value | readonly Argument[];
export interface ScriptPosition {
  scene: string;
  offset: number;
  line: number;
}
export interface SiglusCommand extends ScriptPosition {
  path: number[];
  name?: string;
  args: Argument[];
  named: number[];
  readFlag?: number;
}
export type SiglusTag =
  | (SiglusCommand & {tag: 'command'})
  | (ScriptPosition & {tag: 'name' | 'text'; value: string; readFlag?: number});

export interface SiglusServices {
  command(command: SiglusCommand): Promise<Argument | undefined>;
  property(path: number[], value?: Value): Value | undefined;
  message(tag: Extract<SiglusTag, {tag: 'name' | 'text'}>): void | Promise<void>;
  trace(tag: SiglusTag): void;
  yieldDelay?(): number;
}

export interface SiglusCheckpoint {
  globals: [string, Value][];
  frames: {
    scene: string;
    pc: number;
    line: number;
    stack: Argument[];
    points: number[];
    locals: [string, Value][];
    declarations: [number, number][];
    references?: [number, readonly number[]][];
  }[];
}

const globalCommand = 0x7e000000;
const localRoot = 83;
const userProperty = 127;
const callProperty = 125;
const elementOwner = (code: number): number => code >>> 24;
const elementIndex = (code: number): number => code & 0xffff;

// Native 0x54c4a0 global roots and 0x5502a0 mwnd members consuming a trailing 4-byte readFlag.
const readFlagGlobalRoots = new Set([0x0c, 0x12, 0x13, 0x4c, 0x4d, 0x5a, 0x5b, 0x64, 0x65, 0x66, 0x7f]);
const readFlagMwndMembers = new Set([4, 5, 9, 0x1a, 0x1b, 0x32, 0x33, 0x34]);

function hasTrailingReadFlag(path: readonly number[]): boolean {
  if (path.length === 1) return readFlagGlobalRoots.has(path[0]!);
  if (path.length >= 4) {
    const member = path.at(-1)!;
    if (
      readFlagMwndMembers.has(member) &&
      path[path.length - 4] === 3 &&
      path[path.length - 3] === -1 &&
      (path[0] === 37 || path[0] === 38 || path[0] === 49 || path[0] === 65)
    )
      return true;
  }
  return false;
}

class ReturnFromHostScene {}

class ReturnToMenu {
  constructor(
    readonly scene: string,
    readonly entry: number,
  ) {}
}

// Built-in string comparisons use case-insensitive resource identifiers.
const foldAscii = (value: string): string =>
  value.replace(/[A-Z]/g, (letter) => letter.toLowerCase());

function binary(op: number, a: Value, b: Value): Value {
  if (op >= 16 && op <= 21 && typeof a === 'string' && typeof b === 'string') {
    a = foldAscii(a);
    b = foldAscii(b);
  }
  switch (op) {
    case 1:
      return typeof a === 'string' || typeof b === 'string' ? String(a) + b : (a + b) | 0;
    case 2:
      return (Number(a) - Number(b)) | 0;
    case 3:
      if (typeof a === 'string') {
        const count = Number(b) | 0;
        return count > 0 ? a.repeat(count) : '';
      }
      return Math.imul(Number(a), Number(b));
    case 4: {
      const divisor = Number(b) | 0;
      return divisor === 0 ? 0 : Math.trunc((Number(a) | 0) / divisor) | 0;
    }
    case 5: {
      const divisor = Number(b) | 0;
      return divisor === 0 ? 0 : ((Number(a) | 0) % divisor) | 0;
    }
    case 16:
      return Number(a === b);
    case 17:
      return Number(a !== b);
    case 18:
      return Number(a > b);
    case 19:
      return Number(a >= b);
    case 20:
      return Number(a < b);
    case 21:
      return Number(a <= b);
    case 32:
      return Number(Boolean(a && b));
    case 33:
      return Number(Boolean(a || b));
    case 49:
      return Number(a) & Number(b);
    case 50:
      return Number(a) | Number(b);
    case 51:
      return Number(a) ^ Number(b);
    case 52:
      return Number(a) << Number(b);
    case 53:
      return Number(a) >> Number(b);
    case 54:
      return (Number(a) >>> Number(b)) | 0;
    default:
      throw new Error(`Unsupported Siglus binary operator ${op}`);
  }
}

class Frame {
  pc: number;
  line = 0;
  readonly stack: Argument[] = [];
  readonly points: number[] = [];
  readonly locals = new Map<string, Value>();
  readonly declarations = new Map<number, number>();
  readonly references = new Map<number, readonly number[]>();
  readonly code: DataView;
  constructor(
    readonly scene: SiglusScene,
    offset: number,
    readonly parameters: Argument[] = [],
  ) {
    this.pc = offset;
    this.code = byteDataView(scene.code);
  }
  byte(): number {
    return this.code.getUint8(this.pc++);
  }
  word(): number {
    const value = this.code.getInt32(this.pc, true);
    this.pc += 4;
    return value;
  }
  words(): number[] {
    const count = this.word();
    if (count < 0 || count > (this.code.byteLength - this.pc) / 4)
      throw new Error('Invalid Siglus argument table');
    return Array.from({length: count}, () => this.word());
  }
  pop(): Argument {
    const value = this.stack.pop();
    if (value === undefined) throw new Error('Siglus value stack underflow');
    return value;
  }
  scalar(): Value {
    const value = this.pop();
    if (typeof value === 'object') throw new Error('Expected a Siglus scalar');
    return value;
  }
  path(): number[] {
    const start = this.points.pop();
    if (start === undefined || this.stack.length <= start)
      throw new Error('Missing Siglus element path');
    return this.stack
      .splice(start)
      .flatMap((value) => (Array.isArray(value) ? (value as readonly number[]) : [Number(value)]));
  }
  args(): Argument[] {
    return this.readArguments(this.word());
  }
  private readArguments(count: number): Argument[] {
    if (count < 0 || count > (this.code.byteLength - this.pc) / 4)
      throw new Error('Invalid Siglus argument table');
    const args: Argument[] = [];
    for (let index = 0; index < count; index++) {
      const form = this.word();
      if (form === -1) {
        args.push(this.readArguments(this.word()));
      } else if (form === 0 || form === 10 || form === 20 || form === 30) {
        args.push(this.scalar());
      } else if (form > 0) {
        args.push(this.path());
      } else throw new Error(`Unsupported Siglus argument form ${form}`);
    }
    return args.reverse();
  }
}

/** SceneScript stack machine. Include commands can bind to equivalent host services. */
export class SiglusVm {
  private readonly globals = new Map<string, Value>();
  private readonly frames: Frame[] = [];
  private readonly sceneJumps = new Map<Frame, Frame>();
  private pendingLoad?: {checkpoint: SiglusCheckpoint; beforeResume: () => Promise<void>};

  constructor(
    private readonly pack: SiglusScenePack,
    private readonly services: SiglusServices,
    private readonly signal: AbortSignal,
    private readonly menu?: {scene: string; entry: number},
  ) {}

  async run(scene: string, label = 0): Promise<void> {
    let frames = [this.entry(scene, label)];
    let beforeResume: (() => Promise<void>) | undefined;
    for (;;) {
      try {
        const initialize = beforeResume;
        beforeResume = undefined;
        await this.resume(frames, initialize);
        return;
      } catch (error) {
        if (error instanceof ReturnToMenu) {
          frames = [this.entry(error.scene, error.entry)];
        } else if (this.pendingLoad && error === this.pendingLoad.checkpoint) {
          frames = this.restore(this.pendingLoad.checkpoint);
          beforeResume = this.pendingLoad.beforeResume;
          this.pendingLoad = undefined;
        } else {
          throw error;
        }
      }
    }
  }

  /** Capture the stack while a host command is waiting at a save point. */
  checkpoint(commandResult?: Value): SiglusCheckpoint {
    const frames = this.frames.map((original) => {
      const frame = this.sceneJumps.get(original) ?? original;
      return {
        scene: frame.scene.name,
        pc: frame.pc,
        line: frame.line,
        stack: [...frame.stack],
        points: [...frame.points],
        locals: [...frame.locals],
        declarations: [...frame.declarations],
        references: [...frame.references],
      };
    });
    if (!frames.length) throw new Error('Siglus has no running frame');
    if (commandResult !== undefined) frames.at(-1)!.stack.push(commandResult);
    return {globals: [...this.globals], frames};
  }

  requestLoad(checkpoint: SiglusCheckpoint, beforeResume: () => Promise<void>): never {
    this.pendingLoad = {checkpoint, beforeResume};
    throw checkpoint;
  }

  /** Run a host-invoked scenario while the current command is suspended. */
  async callScene(
    scene: string,
    entry: number | string = 0,
    parameters: Argument[] = [],
  ): Promise<Value> {
    this.signal.throwIfAborted();
    if (!this.frames.length) throw new Error('No Siglus command to suspend');
    try {
      if (typeof entry === 'number')
        return await this.call(this.entry(scene, entry, parameters), this.frames.length);
      const script = this.pack.scene(scene);
      const exported = this.pack.commandNames.findIndex(
        (name, index) =>
          name === entry &&
          this.pack.sceneNames[this.pack.commandScenes[index * 2]!] === script.name,
      );
      const offset =
        exported >= 0
          ? this.pack.commandScenes[exported * 2 + 1]
          : script.commands[script.commandNames.indexOf(entry)];
      if (offset === undefined) throw new Error(`Missing Siglus system command ${scene}.${entry}`);
      return await this.call(new Frame(script, offset, parameters), this.frames.length);
    } catch (error) {
      if (error instanceof ReturnFromHostScene) return 0;
      throw error;
    }
  }

  returnFromHostScene(): never {
    throw new ReturnFromHostScene();
  }

  currentPosition(): {scene: string; line: number} | undefined {
    const frame = this.frames.at(-1);
    return frame ? {scene: frame.scene.name, line: frame.line} : undefined;
  }

  returnToMenu(scene = this.menu?.scene, entry = this.menu?.entry): never {
    if (scene === undefined || entry === undefined)
      throw new Error('Siglus menu scene is undefined');
    throw new ReturnToMenu(scene, entry);
  }

  /** Write a value through an element-reference path (e.g. intref args for system.get_calendar). */
  assign(path: readonly number[], value: Value): void {
    const frame = this.frames.at(-1);
    if (!frame) throw new Error('Siglus has no running frame');
    const slot = path[1];
    const reference =
      path[0] === localRoot && slot !== undefined && elementOwner(slot) === callProperty
        ? frame.references.get(elementIndex(slot))
        : undefined;
    this.property(frame, reference ? [...reference, ...path.slice(2)] : [...path], value);
  }

  readIntList(path: readonly number[], start: number, count: number): number[] {
    const frame = this.frames.at(-1);
    if (!frame || count <= 0) return [];
    const slot = path[1];
    const reference =
      path[0] === localRoot && slot !== undefined && elementOwner(slot) === callProperty
        ? frame.references.get(elementIndex(slot))
        : undefined;
    const base = reference ? [...reference, ...path.slice(2)] : [...path];
    const out: number[] = [];
    for (let i = 0; i < count; i++) {
      out.push(Number(this.property(frame, [...base, -1, start + i])) | 0);
    }
    return out;
  }

  writeIntList(path: readonly number[], start: number, values: readonly number[]): void {
    const frame = this.frames.at(-1);
    if (!frame) return;
    const slot = path[1];
    const reference =
      path[0] === localRoot && slot !== undefined && elementOwner(slot) === callProperty
        ? frame.references.get(elementIndex(slot))
        : undefined;
    const base = reference ? [...reference, ...path.slice(2)] : [...path];
    for (let i = 0; i < values.length; i++) {
      this.property(frame, [...base, -1, start + i], values[i]! | 0);
    }
  }

  private restore(checkpoint: SiglusCheckpoint): Frame[] {
    const system = [...this.globals].filter(([key]) => key.startsWith('31.'));
    this.globals.clear();
    for (const [key, value] of checkpoint.globals)
      if (!key.startsWith('31.')) this.globals.set(key, value);
    for (const [key, value] of system) this.globals.set(key, value);
    return checkpoint.frames.map((saved) => {
      const scene = this.pack.scene(saved.scene);
      if (!Number.isInteger(saved.pc) || saved.pc < 0 || saved.pc >= scene.code.length)
        throw new Error('Invalid Siglus save address');
      const frame = new Frame(scene, saved.pc);
      frame.line = saved.line;
      frame.stack.push(...saved.stack);
      frame.points.push(...saved.points);
      for (const [key, value] of saved.locals) frame.locals.set(key, value);
      for (const [key, form] of saved.declarations) frame.declarations.set(key, form);
      for (const [key, reference] of saved.references ?? []) frame.references.set(key, reference);
      return frame;
    });
  }

  private async resume(
    frames: Frame[],
    beforeResume?: () => Promise<void>,
    index = 0,
  ): Promise<Value> {
    const frame = frames[index]!;
    this.frames.push(frame);
    try {
      if (index + 1 < frames.length)
        frame.stack.push(await this.resume(frames, beforeResume, index + 1));
      else await beforeResume?.();
      return await this.execute(frame, index);
    } finally {
      this.frames.pop();
      this.sceneJumps.delete(frame);
    }
  }

  private async call(frame: Frame, depth: number): Promise<Value> {
    this.frames.push(frame);
    try {
      return await this.execute(frame, depth);
    } finally {
      this.frames.pop();
      this.sceneJumps.delete(frame);
    }
  }

  private entry(name: string, label: number, parameters: Argument[] = []): Frame {
    const scene = this.pack.scene(name);
    const offset = scene.entries[label];
    if (offset === undefined) throw new Error(`Missing Siglus entry ${name}:${label}`);
    return this.labelFrame(scene, offset, parameters);
  }

  private labelFrame(scene: SiglusScene, offset: number, parameters: Argument[]): Frame {
    const frame = new Frame(scene, offset);
    const indices = [0, 0];
    for (const value of parameters) {
      if (typeof value === 'object') throw new Error('Unsupported Siglus label reference');
      const list = typeof value === 'string' ? 1 : 0;
      frame.locals.set(`${localRoot}.${list}.-1.${indices[list]}`, value);
      indices[list] = indices[list]! + 1;
    }
    return frame;
  }

  private propertyForm(frame: Frame, path: readonly number[]): number | undefined {
    const [root = 0, member = 0] = path;
    if (root === localRoot) {
      if (elementOwner(member) === callProperty)
        return [...frame.declarations.values()][elementIndex(member)];
      return member === 1 ? 21 : 11;
    }
    if (elementOwner(root) !== userProperty) return undefined;
    const index = elementIndex(root);
    if (index < this.pack.properties.length / 2) return this.pack.properties[index * 2];
    return frame.scene.properties[index * 2 - this.pack.properties.length];
  }

  private property(frame: Frame, path: number[], value?: Value): Value {
    const owned = this.services.property(path, value);
    if (owned !== undefined) return owned;
    const [root = 0] = path;
    const index = elementIndex(root);
    const sceneProperty =
      elementOwner(root) === userProperty && index >= this.pack.properties.length / 2;
    const store = root === localRoot ? frame.locals : this.globals;
    const key = (sceneProperty ? frame.scene.name + ':' : '') + path.join('.');
    if (value !== undefined) store.set(key, value);
    const form = this.propertyForm(frame, path) ?? ([34, 35, 106, 107].includes(root) ? 20 : 0);
    return store.get(key) ?? (form === 20 || form === 21 ? '' : 0);
  }

  private setList(frame: Frame, receiver: number[], [start, ...values]: Argument[]): void {
    if (typeof start !== 'number' || start < 0) throw new Error('Invalid Siglus list start index');
    for (const [index, value] of values.entries()) {
      if (typeof value !== 'number') throw new Error('Expected a Siglus list integer');
      this.property(frame, [...receiver, -1, start + index], value);
    }
  }

  private async execute(initial: Frame, depth = 0): Promise<Value> {
    if (depth >= 128) throw new Error('Siglus call stack overflow');
    let frame = initial;
    for (let steps = 0; ; steps++) {
      if (steps % 8192 === 0) {
        this.signal.throwIfAborted();
        if (steps)
          await new Promise((resolve) => setTimeout(resolve, this.services.yieldDelay?.() ?? 0));
      }
      const offset = frame.pc;
      const position = () => ({scene: frame.scene.name, offset, line: frame.line});
      try {
        switch (frame.byte()) {
          case 0:
            break;
          case 1:
            frame.line = frame.word();
            break;
          case 2: {
            const form = frame.word();
            const raw = frame.word();
            const value = form === 20 ? frame.scene.strings[raw] : raw;
            if (value === undefined) throw new Error('Invalid Siglus string index');
            frame.stack.push(value);
            break;
          }
          case 3: {
            const form = frame.word();
            if (form !== 0) frame.pop();
            break;
          }
          case 4:
            frame.word();
            frame.stack.push(frame.stack.at(-1)!);
            break;
          case 5: {
            const path = frame.path();
            const slot = path[1];
            const reference =
              path[0] === localRoot && slot !== undefined && elementOwner(slot) === callProperty
                ? frame.references.get(elementIndex(slot))
                : undefined;
            if (reference && path.length === 2) {
              // The object-valued property becomes the replacement root of the
              // current element, whose following members still need its point.
              frame.points.push(frame.stack.length);
              frame.stack.push(reference);
            } else {
              frame.stack.push(
                this.property(frame, reference ? [...reference, ...path.slice(2)] : path),
              );
            }
            break;
          }
          case 6: {
            const start = frame.points.at(-1);
            if (start === undefined) throw new Error('Missing Siglus element to copy');
            frame.points.push(frame.stack.length);
            frame.stack.push(...frame.stack.slice(start));
            break;
          }
          case 7: {
            const form = frame.word();
            const index = frame.word();
            if (form === 11 || form === 21) frame.pop();
            frame.declarations.set(index, form);
            break;
          }
          case 8:
            frame.points.push(frame.stack.length);
            break;
          case 9: {
            for (const [i, value] of frame.parameters.entries()) {
              if (i >= frame.declarations.size)
                throw new Error('Unsupported Siglus parameter binding');
              if (Array.isArray(value)) frame.references.set(i, value as readonly number[]);
              else frame.locals.set(`${localRoot}.${(callProperty << 24) | i}`, value as Value);
            }
            break;
          }
          case 16:
          case 17:
          case 18: {
            const op = frame.code.getUint8(offset);
            const label = frame.word();
            const jump = op === 16 || Boolean(frame.scalar()) === (op === 17);
            if (jump) {
              const target = frame.scene.labels[label];
              if (target === undefined) throw new Error(`Invalid Siglus label ${label}`);
              frame.pc = target;
            }
            break;
          }
          case 19:
          case 20: {
            const label = frame.word();
            const args = frame.args();
            const target = frame.scene.labels[label];
            if (target === undefined) throw new Error(`Invalid Siglus label ${label}`);
            frame.stack.push(
              await this.call(this.labelFrame(frame.scene, target, args), depth + 1),
            );
            break;
          }
          case 21: {
            const value = frame.args()[0] ?? 0;
            if (typeof value === 'object') throw new Error('Unsupported Siglus reference return');
            return value;
          }
          case 22:
            return 0;
          case 32: {
            frame.word();
            frame.word();
            frame.word();
            const value = frame.scalar();
            const path = frame.path();
            const slot = path[1];
            const reference =
              path[0] === localRoot && slot !== undefined && elementOwner(slot) === callProperty
                ? frame.references.get(elementIndex(slot))
                : undefined;
            this.property(frame, reference ? [...reference, ...path.slice(2)] : path, value);
            break;
          }
          case 33: {
            frame.word();
            const op = frame.byte();
            const value = Number(frame.scalar());
            if (op !== 1 && op !== 2 && op !== 48)
              throw new Error(`Unsupported Siglus unary operator ${op}`);
            frame.stack.push(op === 1 ? value : op === 2 ? -value | 0 : ~value);
            break;
          }
          case 34: {
            frame.word();
            frame.word();
            const op = frame.byte();
            const right = frame.scalar();
            frame.stack.push(binary(op, frame.scalar(), right));
            break;
          }
          case 48: {
            frame.word(); // Overload index, reflected in the argument forms and count.
            const args = frame.args();
            const named = frame.words().reverse();
            const retForm = frame.word();
            const path = frame.path();
            const id = path.length === 1 ? path[0]! : -1;
            const include =
              elementOwner(id) === elementOwner(globalCommand) ? elementIndex(id) : -1;
            const name = this.pack.commandNames[include];
            const readFlag = hasTrailingReadFlag(path) ? frame.word() : undefined;
            const command = {...position(), path, args, named, name, readFlag};
            this.services.trace({...command, tag: 'command'});
            const pushResult = (value: Argument): void => {
              if (retForm === 0) return;
              if (retForm === 23 && Array.isArray(value)) {
                frame.points.push(frame.stack.length);
                frame.stack.push(value);
              } else {
                frame.stack.push(value);
              }
            };
            if (path.length === 2 && path[0]! >= 23 && path[0]! <= 31) {
              if (path[1] === 10) {
                for (const key of this.globals.keys()) {
                  if (key.startsWith(path[0] + '.')) this.globals.delete(key);
                }
                pushResult(0);
                break;
              }
              if (path[1] === 8 && (args.length === 2 || args.length === 3)) {
                const first = Number(args[0]);
                const last = Number(args[1]);
                const fill = args.length >= 3 ? Number(args[2]) : 0;
                if (first < 0 || last < first || last - first > 1_000_000)
                  throw new Error('Invalid Siglus list clear range');
                for (let index = first; index <= last; index++)
                  this.property(frame, [path[0]!, -1, index], fill);
                pushResult(0);
                break;
              }
            }
            if (path.length === 3 && path[0] === localRoot && path[1] === 0 && path[2] === 10) {
              const prefix = `${localRoot}.0.`;
              for (const key of frame.locals.keys()) {
                if (key.startsWith(prefix)) frame.locals.delete(key);
              }
              pushResult(0);
              break;
            }
            if (id === 3) {
              if (args.length) this.returnToMenu(String(args[0]), Number(args[1] ?? 0));
              this.returnToMenu();
            }
            if (id === 4) {
              frame = this.entry(String(args[0]), Number(args[1] ?? 0), args.slice(2));
              this.sceneJumps.set(initial, frame);
              break;
            }
            if (id === 5) {
              const value = await this.call(
                this.entry(String(args[0]), Number(args[1] ?? 0), args.slice(2)),
                depth + 1,
              );
              pushResult(value);
              break;
            }
            const receiverPath = path.slice(0, -1);
            const member = path.at(-1)!;
            const form = this.propertyForm(frame, receiverPath);
            const declaredList =
              elementOwner(receiverPath[0]!) === userProperty && receiverPath.length === 1;
            const sizeIndex = elementIndex(receiverPath[0]!) * 2 + 1;
            const declaredSize = declaredList
              ? (this.pack.properties[sizeIndex] ??
                frame.scene.properties[sizeIndex - this.pack.properties.length])
              : undefined;
            if (
              declaredSize !== undefined &&
              ((form === 11 && member === 9) || (form === 21 && member === 4))
            ) {
              pushResult(declaredSize);
              break;
            }
            if (
              ((receiverPath[0] === localRoot && receiverPath.length === 2) || declaredList) &&
              (form === 11 || form === 14)
            ) {
              if (member === 1) {
                this.setList(frame, receiverPath, args);
                pushResult(0);
                break;
              }
              if (member === 2 && args.length === 1) {
                const nextSize = Math.max(0, Number(args[0]));
                const store = receiverPath[0] === localRoot ? frame.locals : this.globals;
                const prefix =
                  (declaredList && elementIndex(receiverPath[0]!) >= this.pack.properties.length / 2
                    ? frame.scene.name + ':'
                    : '') +
                  receiverPath.join('.') +
                  '.-1.';
                for (const key of store.keys()) {
                  if (!key.startsWith(prefix)) continue;
                  const idx = Number(key.slice(prefix.length));
                  if (idx >= nextSize) store.delete(key);
                }
                pushResult(0);
                break;
              }
              if (member === 8 && form === 11 && declaredList && args.length === 3) {
                const [first, last, value] = args;
                if (
                  typeof first !== 'number' ||
                  typeof last !== 'number' ||
                  typeof value !== 'number' ||
                  declaredSize === undefined ||
                  first < 0 ||
                  last >= declaredSize
                )
                  throw new Error('Invalid Siglus list clear range');
                for (let index = first; index <= last; index++)
                  this.property(frame, [...receiverPath, -1, index], value);
                pushResult(0);
                break;
              }
            }
            if (declaredList && ((member === 10 && form === 11) || (member === 3 && form === 21))) {
              const root = receiverPath[0]!;
              const prefix =
                (elementIndex(root) >= this.pack.properties.length / 2
                  ? frame.scene.name + ':'
                  : '') +
                root +
                '.';
              for (const key of this.globals.keys()) {
                if (key.startsWith(prefix)) this.globals.delete(key);
              }
              pushResult(0);
              break;
            }
            const receiver =
              path.length > 1 &&
              (path[0] === localRoot ||
                elementOwner(path[0]!) === userProperty ||
                path[0] === 34 ||
                path[0] === 35)
                ? this.property(frame, receiverPath)
                : undefined;
            const result =
              typeof receiver === 'string'
                ? this.stringCommand(receiver, member, args)
                : await this.services.command(command);
            if (this.pendingLoad) throw this.pendingLoad.checkpoint;
            if (result !== undefined) pushResult(result);
            else if (include >= 0) {
              const count = this.pack.commandScenes.length / 2;
              const target =
                include < count
                  ? this.pack.sceneNames[this.pack.commandScenes[include * 2]!]
                  : frame.scene.name;
              const entry =
                include < count
                  ? this.pack.commandScenes[include * 2 + 1]
                  : frame.scene.commands[include - count];
              if (target === undefined || entry === undefined)
                throw new Error(`Unknown Siglus command ${id}`);
              const value = await this.call(
                new Frame(this.pack.scene(target), entry, args),
                depth + 1,
              );
              pushResult(value);
            } else throw new Error(`Unsupported Siglus command ${path.join('.')}`);
            this.signal.throwIfAborted();
            break;
          }
          case 49:
          case 50: {
            const isText = frame.code.getUint8(offset) === 49;
            const readFlag = isText ? frame.word() : undefined;
            const tag = {
              ...position(),
              tag: isText ? ('text' as const) : ('name' as const),
              value: String(frame.scalar()),
              readFlag,
            };
            this.services.trace(tag);
            const writing = this.services.message(tag);
            if (writing) await writing;
            break;
          }
          default:
            throw new Error(`Unsupported Siglus opcode ${frame.code.getUint8(offset)}`);
        }
      } catch (error) {
        if (
          error instanceof ReturnToMenu ||
          error instanceof ReturnFromHostScene ||
          (this.pendingLoad && error === this.pendingLoad.checkpoint)
        )
          throw error;
        this.signal.throwIfAborted();
        throw new Error(
          `${frame.scene.name}:${frame.line} @ ${offset.toString(16)}: ${error instanceof Error ? error.message : String(error)}`,
          {cause: error},
        );
      }
    }
  }

  private stringCommand(receiver: string, member: number, args: Argument[]): Value {
    const start = Math.max(0, Number(args[0] ?? 0));
    switch (member) {
      case 0:
        return receiver.toUpperCase();
      case 1:
        return receiver.toLowerCase();
      case 7: {
        // left_len uses one column for halfwidth characters and two for fullwidth.
        let width = 0;
        let end = 0;
        for (const character of receiver) {
          const code = character.codePointAt(0)!;
          width += code <= 0x7f || (code >= 0xff61 && code <= 0xff9f) ? 1 : 2;
          if (width > start) break;
          end += character.length;
        }
        return receiver.slice(0, end);
      }
      case 2:
        return receiver.slice(0, start);
      case 3:
        return receiver.slice(
          start,
          args.length > 1 ? start + Math.max(0, Number(args[1])) : undefined,
        );
      case 4:
        return receiver.slice(Math.max(0, receiver.length - start));
      case 5:
      case 6:
        return receiver.length;
      case 8: {
        // mid_len(start, maxCols): slice from char index start up to maxCols display columns (half=1, full=2)
        const sliced = receiver.slice(start);
        if (args.length <= 1) return sliced;
        const limit = Math.max(0, Number(args[1] ?? 0));
        let width = 0;
        let end = 0;
        for (const character of sliced) {
          const code = character.codePointAt(0)!;
          width += code <= 0x7f || (code >= 0xff61 && code <= 0xff9f) ? 1 : 2;
          if (width > limit) break;
          end += character.length;
        }
        return sliced.slice(0, end);
      }
      case 10:
        return foldAscii(receiver).indexOf(foldAscii(String(args[0])));
      case 11:
        return foldAscii(receiver).lastIndexOf(foldAscii(String(args[0])));
      case 12:
        return Number.parseInt(receiver, 10) || 0;
      case 13: {
        const index = Number(args[0] ?? 0) | 0;
        return index >= 0 && index < receiver.length ? receiver.charCodeAt(index) : 0;
      }
      default:
        throw new Error(`Unsupported Siglus string command ${member}`);
    }
  }
}
