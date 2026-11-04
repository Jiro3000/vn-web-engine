import {YurisError} from './errors.js';
import type {YurisMachine} from './machine.js';
import {LookupMode, type YurisNode, resolveNodePath} from './nodes.js';
import type {ByteString} from './numbers.js';
import {YurisTask} from './task.js';
import {YurisType} from './variables.js';

const TASK = 0x5f,
  TASKEND = 0x60,
  TASKINFO = 0x61;

const enum TaskArg {
  Id = 0,
  E = 1,
  A = 2,
  Z = 3,
  Tint = 4,
  Tflt = 14,
  Label = 34,
  ScriptPos = 35,
  Restart = 37,
}

const enum InfoArg {
  Id,
  Let,
  Exist,
  E,
  A,
  Z,
  File,
  FileNo,
  Line,
  File0,
  FileNo0,
  Line0,
  TextLine,
  NextVoice,
  GoLabel,
  GosubLabel,
  IfNest,
  GosubNest,
  LoopNest,
  ScriptPos,
  TextPos,
}

export function installTasks(m: YurisMachine): void {
  m.define(TASK, () => task(m));
  m.define(TASKEND, () => taskEnd(m));
  m.define(TASKINFO, () => taskInfo(m));
}

/** 0x4573E8 in the task namespace 0x87242C; a group path is error 0x18BAD. */
function taskPath(m: YurisMachine, command: number, id: ByteString): ByteString {
  const {path, group} = resolveNodePath(m.system.names[2]!, id);
  if (group) throw new YurisError(0x18bad, [m.commandName(command), path]);
  return path;
}

/**
 * The Z assignment of TASK: the operator applies to the node's Z as a 32-bit value (1 for a
 * task that does not exist yet). `-=`, `*=` and `/=` results below 1 become 1; `=` and `+=`
 * keep the low 32 bits unbounded; `/= 0` keeps the current value.
 */
function taskZ(op: number, current: bigint, value: bigint): bigint {
  const atLeast1 = (z: bigint) => (z < 1n ? 1n : z);
  switch (op) {
    case 0:
      return BigInt.asIntN(32, value);
    case 1:
      return BigInt.asIntN(32, current + value);
    case 2:
      return atLeast1(BigInt.asIntN(64, current - value));
    case 3:
      return atLeast1(BigInt.asIntN(64, current * value)); // _allmul 0x470860
    case 4:
      return value === 0n ? current : atLeast1(BigInt.asIntN(64, current / value));
  }
  return current;
}

/**
 * TASK 0x450204. ID names a task leaf (empty: the running task). Without RESTART, Z moves the
 * task among its siblings. `#` (re)starts the task at a label, creating the leaf when it does
 * not exist (a missing task without `#` is error 0x18C18): its TINT, TFLT and TSTR are
 * cleared and TINT1..10 and TFLT1..10 set from the arguments, while its IF, LOOP and GOSUB
 * state is kept. E and A set the task's flags, SCRIPTPOS restores a position encoded by
 * TASKINFO, and RESTART makes the frame run the dispatcher again from the tasks at or below
 * Z (all tasks without Z).
 */
function task(m: YurisMachine): number {
  const a = m.args;
  m.decode();
  const id = a.has(TaskArg.Id) ? a.text(TaskArg.Id) : '';
  let path: ByteString, node: YurisNode<YurisTask> | null;
  if (id === '') {
    node = m.taskNode;
    path = node.name;
  } else {
    path = taskPath(m, TASK, id);
    node = m.taskTree.lookup(path, LookupMode.Leaf);
  }
  let z = -1n;
  const zSlot = a.has(TaskArg.Z);
  if (zSlot && !a.has(TaskArg.Restart)) {
    const current = node ? BigInt.asIntN(32, node.z) : 1n;
    z = taskZ(a.op[zSlot]!, current, a.value[zSlot]!);
    if (node) m.taskTree.setZ(node, z);
  }
  if (!node) {
    if (!a.has(TaskArg.Label)) throw new YurisError(0x18c18, [m.commandName(TASK), path]);
    if (z === -1n) z = 1n;
  }
  if (a.has(TaskArg.Label)) {
    const name = a.text(TaskArg.Label);
    const index = m.label(Uint8Array.from(name, (c) => c.charCodeAt(0) & 0xff));
    if (index < 0) throw new YurisError(0x1a694, [name]);
    const label = m.project.labels.labels[index]!;
    if (!node) {
      // 0x46753D with a zeroed task (0x46BD8C) whose E and A are set.
      const created = new YurisTask(path.slice(path.lastIndexOf('/') + 1));
      node = m.taskTree.create(path, false, z, created);
      created.node = node;
    }
    const t = node.payload!;
    t.position = label.position;
    t.script = label.script;
    m.loadFor(label.script);
    t.ints.fill(0n);
    t.floats.fill(0);
    t.strings.fill('');
    for (let i = 0; i < 10; i++) {
      const s = a.has(TaskArg.Tint + i);
      if (s) t.ints[i + 1] = a.value[s]!;
      const f = a.has(TaskArg.Tflt + i);
      if (f) t.floats[i + 1] = Number(a.value[f]!);
    }
  }
  const t = node!.payload!;
  if (a.has(TaskArg.E)) t.enabled = Number(a.int(TaskArg.E) & 0xffn);
  if (a.has(TaskArg.A)) t.active = Number(a.int(TaskArg.A) & 0xffn);
  if (a.has(TaskArg.ScriptPos)) {
    const script = t.script;
    decodeScriptPos(m, t, a.text(TaskArg.ScriptPos));
    if (t.script !== script) m.loadFor(t.script);
  }
  if (a.has(TaskArg.Restart)) {
    m.restartPending = true;
    if (zSlot) m.restartZ = a.value[zSlot]!;
  }
  return 0;
}

/**
 * TASKEND 0x45195C: removes the running task (without ID) or the named leaf (0x451AE8). The
 * task SYSTEM, or the running task when it may not return, is error 0x18C2C. The command
 * yields when it removes the running task.
 */
function taskEnd(m: YurisMachine): number {
  const a = m.args;
  m.decode();
  const name = m.commandName(TASKEND);
  if (!a.has(TaskArg.Id)) {
    if (m.task.noReturn) throw new YurisError(0x18c2c, [name]);
    m.taskTree.remove(m.taskNode);
    return -1;
  }
  const path = taskPath(m, TASKEND, a.text(TaskArg.Id));
  if (path === 'SYSTEM') throw new YurisError(0x18c2c, [name]);
  const node = m.taskTree.lookup(path, LookupMode.Leaf);
  if (!node) throw new YurisError(0x18c18, [name, path]);
  m.taskTree.remove(node);
  return node.name === m.taskNode.name ? -1 : 0;
}

/**
 * TASKINFO 0x451BFC: one value of the running task (without ID) or a named one into LET, the
 * first present of EXIST, E, A, Z, FILE, FILE0, LINE, LINE0, TEXTLINE, NEXTVOICE, IFNEST,
 * GOSUBNEST, LOOPNEST, FILENO and FILENO0 (followed by SCRIPTPOS). FILE, FILE0 and SCRIPTPOS
 * only store into strings. The "0" variants describe the outermost GOSUB caller. A missing
 * task stores 0 or ''. GOLABEL, GOSUBLABEL and TEXTPOS store nothing.
 */
function taskInfo(m: YurisMachine): number {
  const a = m.args;
  m.decode();
  const slot = a.has(InfoArg.Let),
    id = a.variable[slot]!,
    index = a.variableIndex[slot]!;
  const type = m.variables.get(id).type;
  const put = (value: number | bigint) => (m.setInt(id, index, BigInt(value)), 0);
  let t: YurisTask, line: number;
  if (!a.has(InfoArg.Id)) {
    t = m.task;
    line = m.line;
  } else {
    const path = taskPath(m, TASKINFO, a.text(InfoArg.Id));
    const node = m.taskTree.lookup(path, LookupMode.Leaf);
    if (!node) {
      if (type === YurisType.String) m.setString(id, index, '');
      else if (type === YurisType.Int || type === YurisType.Float) put(0);
      return 0;
    }
    t = node.payload!;
    line = m.lineOf(t.script, t.position - 1);
  }
  const outer = t.gosubDepth > 0 ? t.frameAt(0) : null;
  const line0 = outer ? outer.returnLine : line;
  const script0 = outer ? outer.returnScript : t.script;
  if (a.has(InfoArg.Exist)) return put(1);
  if (a.has(InfoArg.E)) return put(t.enabled);
  if (a.has(InfoArg.A)) return put(t.active);
  if (a.has(InfoArg.Z)) return put(t.node?.z ?? 0n);
  if (a.has(InfoArg.File)) {
    if (type === YurisType.String) m.setString(id, index, m.scriptName(t.script));
    return 0;
  }
  if (a.has(InfoArg.File0)) {
    if (type === YurisType.String) m.setString(id, index, m.scriptName(script0));
    return 0;
  }
  if (a.has(InfoArg.Line)) return put(line);
  if (a.has(InfoArg.Line0)) return put(line0);
  if (a.has(InfoArg.TextLine)) return put(t.textLine);
  if (a.has(InfoArg.NextVoice)) return put(t.nextVoice);
  if (a.has(InfoArg.IfNest)) return put(t.ifDepth);
  if (a.has(InfoArg.GosubNest)) return put(t.gosubDepth);
  if (a.has(InfoArg.LoopNest)) return put(t.loopDepth);
  if (a.has(InfoArg.FileNo)) return put(t.script);
  if (a.has(InfoArg.FileNo0)) put(script0);
  if (a.has(InfoArg.ScriptPos) && type === YurisType.String)
    m.setString(id, index, encodeScriptPos(m, t));
  return 0;
}

/** 0x59B094: the eight bytes that open an encoded script position. */
const MAGIC = [1, 2, 3, 4, 5, 6, 7, 8];

/**
 * The script position codec of TASKINFO SCRIPTPOS (0x452258) and TASK SCRIPTPOS (0x4508B8).
 * Every byte becomes two letters 'a' + high nibble, 'a' + low nibble; a u32 is its four
 * bytes, most significant first. After the magic come the IF stack (depth, then per entry the
 * LOOP depth, IF position and end), the GOSUB frames (depth, then per frame the IF and LOOP
 * depth, return position and return script), the LOOP stack (depth, then per entry the IF
 * depth, start, end and the low 32 bits of counter and limit), TEXTLINE, the next instruction
 * and the script's file name.
 */
export function encodeScriptPos(m: YurisMachine, t: YurisTask): ByteString {
  let out = '';
  const byte = (b: number) => {
    out += String.fromCharCode(0x61 + ((b >> 4) & 15), 0x61 + (b & 15));
  };
  const u32 = (v: number) => {
    for (let s = 24; s >= 0; s -= 8) byte((v >>> s) & 0xff);
  };
  MAGIC.forEach(byte);
  byte(t.ifDepth);
  for (let i = 0; i < t.ifDepth; i++) {
    const e = t.ifEntry(i);
    byte(e.loopDepth);
    u32(e.position);
    u32(e.end);
  }
  byte(t.gosubDepth);
  for (let i = 0; i < t.gosubDepth; i++) {
    const f = t.frameAt(i);
    byte(f.ifDepth);
    byte(f.loopDepth);
    u32(f.returnPosition);
    u32(f.returnScript & 0xffff);
  }
  byte(t.loopDepth);
  for (let i = 0; i < t.loopDepth; i++) {
    const e = t.loopEntry(i);
    byte(e.ifDepth);
    u32(e.start);
    u32(e.end);
    u32(Number(BigInt.asUintN(32, e.counter)));
    u32(Number(BigInt.asUintN(32, e.limit)));
  }
  u32(t.textLine);
  u32(t.position);
  const name = m.scriptName(t.script);
  u32(name.length);
  for (let i = 0; i < name.length; i++) byte(name.charCodeAt(i) & 0xff);
  return out;
}

/**
 * Decodes an encoded script position into the task. A wrong magic is error 900000 and an
 * unknown file name (compared ASCII case-insensitively, 0x46F350) error 0x18EF2; both are
 * reported without the file and line prefix.
 */
export function decodeScriptPos(m: YurisMachine, t: YurisTask, text: ByteString): void {
  let p = 0;
  const byte = () => {
    const hi = (text.charCodeAt(p) || 0) - 0x61,
      lo = (text.charCodeAt(p + 1) || 0) - 0x61;
    p += 2;
    return ((hi << 4) | (lo & 15)) & 0xff;
  };
  const u32 = () => ((byte() << 24) | (byte() << 16) | (byte() << 8) | byte()) >>> 0;
  for (const b of MAGIC) if (byte() !== b) throw new YurisError(900000, [], false);
  t.ifDepth = byte();
  for (let i = 0; i < t.ifDepth; i++) {
    const e = t.ifEntry(i);
    e.loopDepth = byte();
    e.position = u32();
    e.end = u32();
  }
  t.gosubDepth = byte();
  for (let i = 0; i < t.gosubDepth; i++) {
    const f = t.frameAt(i);
    f.ifDepth = byte();
    f.loopDepth = byte();
    f.returnPosition = u32();
    f.returnScript = u32() & 0xffff;
  }
  t.loopDepth = byte();
  for (let i = 0; i < t.loopDepth; i++) {
    const e = t.loopEntry(i);
    e.ifDepth = byte();
    e.start = u32();
    e.end = u32();
    e.counter = BigInt(u32() | 0);
    e.limit = BigInt(u32() | 0);
  }
  t.textLine = u32();
  t.position = u32();
  const length = u32();
  let name = '';
  for (let i = 0; i < length; i++) name += String.fromCharCode(byte());
  const script = m.findScript(name);
  if (script < 0) throw new YurisError(0x18ef2, [m.commandName(TASK), name], false);
  t.script = script;
}
