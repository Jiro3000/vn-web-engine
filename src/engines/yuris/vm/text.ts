import type {YurisMachine} from './machine.js';
import {YurisError} from './errors.js';
import {windowsPath} from './fileact.js';
import {cString, isLeadByte} from './numbers.js';
import {YurisScenarioText} from './scenario-text.js';

const TEXT = 0x62,
  TEXTINFO = 0x63;

/** TEXT argument ids (`ysc.ybn`). */
const enum Arg {
  File,
  Let,
  Clear,
}

export function installText(m: YurisMachine): void {
  const label = (name: string) => m.project.labels.labels[m.label(new TextEncoder().encode(name))];
  const scenario = label('es.SCENARIO.LOAD');
  const bilingual = label('es.ScenarioMacro.ML.TEXT');
  m.define(TEXT, () =>
    text(
      m,
      !!bilingual && m.task.script === scenario?.script && m.position === scenario.position + 1,
    ),
  );
  // TEXTINFO 0x452F94 only decodes its arguments.
  m.define(TEXTINFO, () => {
    m.decode();
    return 0;
  });
}

/**
 * TEXT 0x452C4C. FILE reads a text file through 0x40BC29 into the string array LET, one line
 * per element from element 0. CLEAR=1 empties the message text buffers (0x46A1CC).
 */
async function text(m: YurisMachine, scenario: boolean): Promise<number> {
  const a = m.args;
  m.decode();
  const fileSlot = a.has(Arg.File);
  if (fileSlot) {
    const letSlot = a.has(Arg.Let),
      id = letSlot ? a.variable[letSlot]! : 0;
    const name = windowsPath(a.text(Arg.File));
    // 0x40BC29 (ECX = 1) reports a missing file as 0x1967C and an unreadable one as 0x1964A.
    if (!m.files.exists(name)) throw new YurisError(0x1967c, [name], false);
    let bytes: Uint8Array;
    try {
      bytes = await m.files.read(name);
    } catch {
      throw new YurisError(0x1964a, [name], false);
    }
    splitLines(m, id, bytes, scenario ? new YurisScenarioText() : undefined);
  }
  const clearSlot = a.has(Arg.Clear);
  if (clearSlot && a.int(Arg.Clear) === 1n) {
    // 0x8725A4 + 0x15 is set, so 0x46A1CC always clears: the lengths +0x20..+0x2C and the
    // 0x2000-byte text and kind buffers.
    m.system.text = '';
    m.system.textKinds = '';
  }
  return 0;
}

/**
 * The line loop of 0x452C4C over the file with "\r\n" appended. CR LF, a lone CR and a lone
 * LF each end a line, which is stored with a trailing CR. The loop stops before storing a line
 * at or past the first dimension (+4, a signed 64-bit compare). The pending partial line and
 * an empty string follow at the next two indices; 0x45BDE4 drops out-of-range writes. Lines
 * are built in a C string buffer, so an embedded NUL ends what is stored.
 */
function splitLines(
  m: YurisMachine,
  id: number,
  bytes: Uint8Array,
  scenario?: YurisScenarioText,
): void {
  const size = bytes.length + 2,
    data = new Uint8Array(size);
  data.set(bytes);
  data[size - 2] = 0x0d;
  data[size - 1] = 0x0a;
  const bound = BigInt(m.variables.get(id).dimensions[0] ?? 0);
  let line = 0n,
    current = '',
    i = 0;
  while (i < size) {
    const byte = data[i]!;
    if (byte === 0x0d || byte === 0x0a) {
      if (line >= bound) break;
      const value = cString(current);
      m.setString(id, line, (scenario?.normalize(value) ?? value) + '\r');
      i += byte === 0x0d && data[i + 1] === 0x0a ? 2 : 1;
      line++;
      current = '';
    } else if (isLeadByte(byte)) {
      current += String.fromCharCode(byte, data[i + 1] ?? 0);
      i += 2;
    } else {
      current += String.fromCharCode(byte);
      i++;
    }
  }
  m.setString(id, line, cString(current));
  m.setString(id, line + 1n, '');
}
