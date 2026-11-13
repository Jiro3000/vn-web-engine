import {byteDataView} from '../../core/binary.js';
import type {SiglusScene, SiglusScenePack} from '../../formats/siglus/scene-pack.js';

export type Value = number | string;
export interface ScriptPosition {
  scene: string;
  offset: number;
  line: number;
}
export interface SiglusCommand extends ScriptPosition {
  path: number[];
  name?: string;
  args: Value[];
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

const globalCommand = 0x7e000000;
const localRoot = 83;

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
  readonly stack: Value[] = [];
  readonly points: number[] = [];
  readonly locals = new Map<string, Value>();
  readonly code: DataView;
  constructor(
    readonly scene: SiglusScene,
    offset: number,
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
  pop(): Value {
    const value = this.stack.pop();
    if (value === undefined) throw new Error('Siglus value stack underflow');
    return value;
  }
  path(): number[] {
    const start = this.points.pop();
    if (start === undefined || this.stack.length <= start)
      throw new Error('Missing Siglus element path');
    return this.stack.splice(start).map(Number);
  }
  args(): Value[] {
    return this.words()
      .map(() => this.pop())
      .reverse();
  }
}

/** SceneScript stack machine. Include commands can bind to equivalent host services. */
export class SiglusVm {
  private readonly globals = new Map<string, Value>();

  constructor(
    private readonly pack: SiglusScenePack,
    private readonly services: SiglusServices,
    private readonly signal: AbortSignal,
  ) {}

  async run(scene: string, label = 0): Promise<void> {
    await this.execute(this.entry(scene, label));
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
    const store = path[0] === localRoot ? frame.locals : this.globals;
    const key = path.join('.');
    if (value !== undefined) store.set(key, value);
    return store.get(key) ?? 0;
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
          case 5:
            frame.stack.push(this.property(frame, frame.path()));
            break;
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
            frame.locals.set(String(index), form === 20 ? '' : 0);
            break;
          }
          case 8:
            frame.points.push(frame.stack.length);
            break;
          case 9:
            break;
          case 16:
          case 17:
          case 18: {
            const op = frame.code.getUint8(offset);
            const label = frame.word();
            const jump = op === 16 || Boolean(frame.pop()) === (op === 17);
            if (jump) {
              const target = frame.scene.labels[label];
              if (target === undefined) throw new Error(`Invalid Siglus label ${label}`);
              frame.pc = target;
            }
            break;
          }
          case 21:
            return frame.args()[0] ?? 0;
          case 22:
            return 0;
          case 32: {
            frame.word();
            frame.word();
            frame.word();
            const value = frame.pop();
            this.property(frame, frame.path(), value);
            break;
          }
          case 33: {
            frame.word();
            const op = frame.byte();
            const value = Number(frame.pop());
            if (op !== 1 && op !== 2 && op !== 48)
              throw new Error(`Unsupported Siglus unary operator ${op}`);
            frame.stack.push(op === 1 ? value : op === 2 ? -value | 0 : ~value);
            break;
          }
          case 34: {
            frame.word();
            frame.word();
            const op = frame.byte();
            const right = frame.pop();
            frame.stack.push(binary(op, frame.pop(), right));
            break;
          }
          case 48: {
            frame.word(); // Overload index, reflected in the argument forms and count.
            const args = frame.args();
            const named = frame.words().reverse();
            frame.word(); // Return form. Even void calls have a matching CD_POP.
            const path = frame.path();
            const id = path.length === 1 ? path[0]! : -1;
            const include = id >>> 24 === globalCommand >>> 24 ? id & 0xffffff : -1;
            const name = this.pack.commandNames[include];
            const readFlag = id === 18 ? frame.word() : undefined;
            const command = {...position(), path, args, named, name, readFlag};
            this.services.trace({...command, tag: 'command'});
            if (id === 4) {
              frame = this.entry(String(args[0]), Number(args[1] ?? 0));
              break;
            }
            if (id === 5) {
              frame.stack.push(
                await this.execute(this.entry(String(args[0]), Number(args[1] ?? 0)), depth + 1),
              );
              break;
            }
            const result = await this.services.command(command);
            if (result !== undefined) frame.stack.push(result);
            else if (include >= 0) {
              const target = this.pack.sceneNames[this.pack.commandScenes[include * 2]!];
              const entry = this.pack.commandScenes[include * 2 + 1];
              if (target === undefined || entry === undefined)
                throw new Error(`Unknown Siglus command ${id}`);
              if (args.length) throw new Error(`Unsupported Siglus include arguments for ${name}`);
              frame.stack.push(
                await this.execute(new Frame(this.pack.scene(target), entry), depth + 1),
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
              value: String(frame.pop()),
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
        this.signal.throwIfAborted();
        throw new Error(
          `${frame.scene.name}:${frame.line} @ ${offset.toString(16)}: ${error instanceof Error ? error.message : String(error)}`,
          {cause: error},
        );
      }
    }
  }
}
