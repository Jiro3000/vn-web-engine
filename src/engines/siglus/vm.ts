import {byteDataView} from '../../core/binary.js';
import type {SiglusScene, SiglusScenePack} from '../../formats/siglus/scene-pack.js';

export type Value = number | string;
export type Argument = Value | readonly number[];
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
  command(command: SiglusCommand): Promise<Value | undefined>;
  property(path: number[], value?: Value): Value | undefined;
  message(tag: Extract<SiglusTag, {tag: 'name' | 'text'}>): void;
  trace(tag: SiglusTag): void;
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

class ReturnToMenu {
  constructor(
    readonly scene: string,
    readonly entry: number,
  ) {}
}

function binary(op: number, a: Value, b: Value): Value {
  switch (op) {
    case 1:
      return typeof a === 'string' || typeof b === 'string' ? String(a) + b : (a + b) | 0;
    case 2:
      return (Number(a) - Number(b)) | 0;
    case 3:
      return Math.imul(Number(a), Number(b));
    case 4:
      return (Number(a) / Number(b)) | 0;
    case 5:
      return Number(a) % Number(b);
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
      return Number(a) >>> Number(b);
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
      .flatMap((value) => (typeof value === 'object' ? [...value] : [Number(value)]));
  }
  args(): Argument[] {
    return this.words()
      .map((form) => {
        if (form === 0 || form === 10 || form === 20 || form === 30) return this.scalar();
        if (form > 0) return this.path();
        throw new Error(`Unsupported Siglus argument form ${form}`);
      })
      .reverse();
  }
}

/** SceneScript stack machine. Include commands can bind to equivalent host services. */
export class SiglusVm {
  private readonly globals = new Map<string, Value>();
  private readonly frames: Frame[] = [];
  private readonly sceneJumps = new Map<Frame, Frame>();
  private pendingLoad?: SiglusCheckpoint;

  constructor(
    private readonly pack: SiglusScenePack,
    private readonly services: SiglusServices,
    private readonly signal: AbortSignal,
    private readonly menu?: {scene: string; entry: number},
  ) {}

  async run(scene: string, label = 0): Promise<void> {
    let frames = [this.entry(scene, label)];
    for (;;) {
      try {
        await this.resume(frames);
        return;
      } catch (error) {
        if (error instanceof ReturnToMenu) {
          frames = [this.entry(error.scene, error.entry)];
        } else if (this.pendingLoad && error === this.pendingLoad) {
          frames = this.restore(this.pendingLoad);
          this.pendingLoad = undefined;
        } else {
          throw error;
        }
      }
    }
  }

  /** Capture the stack while a host command is waiting at a save point. */
  checkpoint(commandResult: Value): SiglusCheckpoint {
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
    frames.at(-1)!.stack.push(commandResult);
    return {globals: [...this.globals], frames};
  }

  requestLoad(checkpoint: SiglusCheckpoint): void {
    this.pendingLoad = checkpoint;
  }

  /** Run a host-invoked scenario while the current command is suspended. */
  async callScene(scene: string, entry = 0): Promise<Value> {
    this.signal.throwIfAborted();
    if (!this.frames.length) throw new Error('No Siglus command to suspend');
    return this.call(this.entry(scene, entry), this.frames.length);
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

  private async resume(frames: Frame[], index = 0): Promise<Value> {
    const frame = frames[index]!;
    this.frames.push(frame);
    try {
      if (index + 1 < frames.length) frame.stack.push(await this.resume(frames, index + 1));
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

  private entry(name: string, label: number): Frame {
    const scene = this.pack.scene(name);
    const offset = scene.entries[label];
    if (offset === undefined) throw new Error(`Missing Siglus entry ${name}:${label}`);
    return new Frame(scene, offset);
  }

  private property(frame: Frame, path: number[], value?: Value): Value {
    const owned = this.services.property(path, value);
    if (owned !== undefined) return owned;
    const [root = 0, member = 0] = path;
    const local = root === localRoot;
    const index = elementIndex(root);
    const sceneProperty =
      elementOwner(root) === userProperty && index >= this.pack.properties.length / 2;
    const store = local ? frame.locals : this.globals;
    const key = (sceneProperty ? frame.scene.name + ':' : '') + path.join('.');
    if (value !== undefined) store.set(key, value);
    let form: number | undefined;
    if (local) {
      form =
        elementOwner(member) === callProperty
          ? [...frame.declarations.values()][elementIndex(member)]
          : member === 1
            ? 21
            : 11;
    } else if (elementOwner(root) === userProperty) {
      form = sceneProperty
        ? frame.scene.properties[index * 2 - this.pack.properties.length]
        : this.pack.properties[index * 2];
    }
    return store.get(key) ?? (form === 20 || form === 21 ? '' : 0);
  }

  private async execute(initial: Frame, depth = 0): Promise<Value> {
    if (depth >= 128) throw new Error('Siglus call stack overflow');
    let frame = initial;
    for (let steps = 0; ; steps++) {
      if (steps % 8192 === 0) {
        this.signal.throwIfAborted();
        if (steps) await new Promise((resolve) => setTimeout(resolve, 0));
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
          case 3:
            frame.word();
            frame.pop();
            break;
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
              if (typeof value === 'object') frame.references.set(i, value);
              else frame.locals.set(`${localRoot}.${(callProperty << 24) | i}`, value);
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
            frame.stack.push(await this.call(new Frame(frame.scene, target, args), depth + 1));
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
            this.property(frame, frame.path(), value);
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
            frame.word(); // Return form. Even void calls have a matching CD_POP.
            const path = frame.path();
            const id = path.length === 1 ? path[0]! : -1;
            const include =
              elementOwner(id) === elementOwner(globalCommand) ? elementIndex(id) : -1;
            const name = this.pack.commandNames[include];
            const readFlag = id === 18 ? frame.word() : undefined;
            const command = {...position(), path, args, named, name, readFlag};
            this.services.trace({...command, tag: 'command'});
            if (path.length === 2 && path[0]! >= 23 && path[0]! <= 31 && path[1] === 10) {
              for (const key of this.globals.keys()) {
                if (key.startsWith(path[0] + '.')) this.globals.delete(key);
              }
              frame.stack.push(0);
              break;
            }
            if (id === 3) {
              const menu = args.length
                ? {scene: String(args[0]), entry: Number(args[1] ?? 0)}
                : this.menu;
              if (!menu) throw new Error('Siglus menu scene is undefined');
              throw new ReturnToMenu(menu.scene, menu.entry);
            }
            if (id === 4) {
              frame = this.entry(String(args[0]), Number(args[1] ?? 0));
              this.sceneJumps.set(initial, frame);
              break;
            }
            if (id === 5) {
              frame.stack.push(
                await this.call(this.entry(String(args[0]), Number(args[1] ?? 0)), depth + 1),
              );
              break;
            }
            const receiver =
              path.length > 1 && (path[0] === localRoot || elementOwner(path[0]!) === userProperty)
                ? this.property(frame, path.slice(0, -1))
                : undefined;
            const result =
              typeof receiver === 'string'
                ? this.stringCommand(receiver, path.at(-1)!, args)
                : await this.services.command(command);
            if (this.pendingLoad) throw this.pendingLoad;
            if (result !== undefined) frame.stack.push(result);
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
              frame.stack.push(
                await this.call(new Frame(this.pack.scene(target), entry, args), depth + 1),
              );
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
            this.services.message(tag);
            break;
          }
          default:
            throw new Error(`Unsupported Siglus opcode ${frame.code.getUint8(offset)}`);
        }
      } catch (error) {
        if (error instanceof ReturnToMenu || (this.pendingLoad && error === this.pendingLoad))
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
      case 10:
        return receiver.indexOf(String(args[0]));
      case 11:
        return receiver.lastIndexOf(String(args[0]));
      case 12:
        return Number.parseInt(receiver, 10) || 0;
      default:
        throw new Error(`Unsupported Siglus string command ${member}`);
    }
  }
}
