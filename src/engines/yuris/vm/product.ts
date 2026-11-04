import {decodeCp932} from '../../../text/cp932.js';
import type {YurisFolderHost} from './fileact.js';
import {YurisFileKind} from './files.js';
import type {YurisMachine} from './machine.js';
import {type ByteString, isLeadByte} from './numbers.js';
import {asciiLower} from './sjis.js';
import type {YurisWindowHost} from './window.js';

type HostResult<T> = T | Promise<T>;

/** The operating-system services behind PRODUCT. The project layer decides each outcome. */
export interface YurisProductHost {
  /**
   * The `IDD_YSC` dialog (procedure 0x4596CC): one edit control (0x421) holding `text`, at most
   * `limit` characters, with OK and Cancel and no close box. The edited text on OK, null on
   * Cancel.
   */
  inputDialog(text: ByteString, limit: number): HostResult<ByteString | null>;
  /**
   * GetSaveFileNameA (0x45A8F8) titled "保存する場所を指定してください。" with one filter
   * ("PNG File(*.png)" or "BMP File(*.bmp)") and OFN_EXPLORER | OFN_PATHMUSTEXIST |
   * OFN_NOCHANGEDIR | OFN_OVERWRITEPROMPT | OFN_HIDEREADONLY | OFN_NOREADONLYRETURN. The
   * chosen path, null when the dialog was cancelled.
   */
  saveFileDialog(name: ByteString, type: 'png' | 'bmp'): HostResult<ByteString | null>;
  /** SHBrowseForFolderA from the desktop (0x45C85C) with `title`, `initial` selected; '' when cancelled. */
  browseFolder(title: ByteString, initial: ByteString): HostResult<ByteString>;
  /** GetDiskFreeSpaceExA: the bytes available to the caller on the volume of `root` ("C:\"). */
  diskFreeSpace(root: ByteString): HostResult<bigint>;
  /** GetWindowsDirectoryA. */
  windowsDirectory(): ByteString;
  /** SetCurrentDirectoryA. */
  setCurrentDirectory(path: ByteString): HostResult<void>;
  /** RegOpenKeyExA and RegDeleteValueA; false when either failed. */
  deleteRegistryValue(
    hive: 'HKCU' | 'HKLM',
    key: ByteString,
    name: ByteString,
  ): HostResult<boolean>;
  /** RegDeleteKeyA; false when it failed. */
  deleteRegistryKey(hive: 'HKCU' | 'HKLM', key: ByteString): HostResult<boolean>;
  /** Shell32 `IsUserAnAdmin` (ordinal 680 on the OS version 0x28). */
  isUserAnAdmin(): boolean;
  /**
   * The child EDIT control 0x872C2C (0x45C650): WS_CHILD | WS_VISIBLE | ES_AUTOHSCROLL with
   * WS_EX_STATICEDGE over the main window's client area, a 14-pixel default font and a
   * 256-character limit.
   */
  createEdit(text: ByteString, x: number, y: number, width: number, height: number): void;
  /** WM_CLOSE to the edit control (0x45C6D0). */
  closeEdit(): void;
  /** SetWindowTextA of the edit control (0x45C6EC). */
  setEditText(text: ByteString): void;
  /** GetWindowTextA of the edit control into 0x105 bytes (0x45C700); '' without one. */
  editText(): ByteString;
  /** WM_SETFOCUS (true) or WM_KILLFOCUS (false) sent to the edit control. */
  focusEdit(focused: boolean): void;
}

/** PRODUCT argument ids (`ysc.ybn`). */
const enum Arg {
  Com = 0,
  Let = 1,
  Pint = 2,
  Pint2 = 3,
  Pint3 = 4,
  Pint4 = 5,
  Pstr = 22,
  Pstr2 = 23,
  Pstr3 = 24,
}

const PRODUCT = 0x74;
/** 0x5CD680, 0x5CDA80 and 0x5CDE80: the PSTR buffers. */
const BUFFER = 0x400;
/** The list capacity of 0x45AA09 and 0x45BFEC. */
const LIST_LIMIT = 0x2000;
/** The engine version COM 1 returns. */
const VERSION = 0x1f6n;

export function installProduct(
  m: YurisMachine,
  folder: YurisFolderHost,
  window: YurisWindowHost,
  host: YurisProductHost,
): void {
  const product = new YurisProduct(m, folder, window, host);
  m.define(PRODUCT, () => product.run());
}

/**
 * PRODUCT 0x4598CC. COM picks the operation. LET receives its result. PSTR..PSTR3 are read as
 * the string element their expression named last (0x44D8AC) and PINT..PINT4 as the int
 * element (0x459854), so both name variables. Several operations take PINT values as element
 * references: the variable id in the high 32 bits and the element in the low 32 bits.
 */
class YurisProduct {
  /** 0x86CA20: the text the last `IDD_YSC` dialog returned. */
  private inputText: ByteString = '';
  /** 0x872C30: 1 when that dialog ended with OK. */
  private inputAccepted = 0;
  /** 0x59B088: the debug log has not written its session header yet. */
  private logFresh = true;

  constructor(
    private readonly m: YurisMachine,
    private readonly folder: YurisFolderHost,
    private readonly window: YurisWindowHost,
    private readonly host: YurisProductHost,
  ) {}

  async run(): Promise<number> {
    const m = this.m,
      a = m.args;
    m.decode();
    const com = a.int(Arg.Com);
    const letSlot = a.has(Arg.Let),
      letId = a.variable[letSlot]!,
      letIndex = a.variableIndex[letSlot]!;
    const text = (id: number): ByteString => {
      const slot = a.has(id);
      return slot
        ? m.getString(a.variable[slot]!, a.variableIndex[slot]!).slice(0, BUFFER - 1)
        : '';
    };
    const int = (id: number): bigint => {
      const slot = a.has(id);
      return slot ? m.getInt(a.variable[slot]!, a.variableIndex[slot]!) : 0n;
    };
    let pstr = text(Arg.Pstr);
    let pstr2 = text(Arg.Pstr2);
    text(Arg.Pstr3);
    const pint = int(Arg.Pint),
      pint2 = int(Arg.Pint2),
      pint3 = int(Arg.Pint3),
      pint4 = int(Arg.Pint4);
    const setInt = (value: bigint): void => m.setInt(letId, letIndex, value);
    const setString = (value: ByteString): void => m.setString(letId, letIndex, value);
    const host = this.host,
      s = m.system;
    if (com < 0n || com > 0xffffffffn) return 0;
    switch (Number(com)) {
      case 1:
        setInt(VERSION);
        break;
      case 2:
        m.messageBox(decode('= ' + pstr));
        break;
      case 10:
        m.messageBox('COM:10 Deleted.');
        break;
      case 0xc: {
        // 0x4652F8 lower-cases the source; 0x45A990 reads it like any script file (0x40BC29)
        // and writes it to PSTR2 ("wb").
        const source = asciiLower(backslashes(pstr));
        pstr2 = backslashes(pstr2);
        const file = m.files.resolve(source, YurisFileKind.Any);
        if (!file.found) break;
        await this.folder.writeFile(pstr2, await m.files.read(file.path));
        break;
      }
      case 0xf:
        // fopen "wb" of PSTR, then PSTR2 and CR LF.
        await this.folder.writeFile(backslashes(pstr), bytes(pstr2 + '\r\n'));
        break;
      case 0x15:
        this.publish(await this.listFolder(backslashes(pstr), pstr2, pint !== 0n));
        break;
      case 0x16:
        setInt(this.tokenize(pstr, pint, pint2, pint3));
        break;
      case 0x17:
        setInt(this.measure(pint, pint2));
        break;
      case 0x18: {
        const list = this.listArchives(backslashes(pstr));
        this.publish(list);
        break;
      }
      case 0x19:
      case 0x1a: {
        const chosen = await host.saveFileDialog(pstr, com === 0x19n ? 'png' : 'bmp');
        if (chosen === null) return 0;
        setString(chosen);
        break;
      }
      case 0x1b:
        s.runDuringMovie = true;
        break;
      case 0x1c:
        s.runDuringMovie = false;
        break;
      case 0x1d:
        setInt(BigInt(s.archives));
        break;
      case 0x1e:
        m.messageBox('COM:30 Deleted.');
        break;
      case 0x1f:
        m.messageBox('COM:31 Deleted.');
        break;
      case 0x20:
        await host.setCurrentDirectory(backslashes(pstr));
        break;
      case 0x21: {
        // 0x45C330: HKCU, the value and then the key.
        const key = backslashes(pstr);
        if (await host.deleteRegistryValue('HKCU', key, pstr2))
          await host.deleteRegistryKey('HKCU', key);
        break;
      }
      case 0x22:
        // GetDiskFreeSpaceExA of the first three characters ("C:\").
        setInt(BigInt.asIntN(64, await host.diskFreeSpace(backslashes(pstr).slice(0, 3))));
        break;
      case 0x24:
        await host.deleteRegistryValue('HKLM', backslashes(pstr), pstr2);
        break;
      case 0x25:
        await host.deleteRegistryKey('HKLM', backslashes(pstr));
        break;
      case 0x26:
        // 0x45C47C: OS versions 0x14..0x27 count as administrator.
        setInt(s.osVersion > 0x13 && s.osVersion < 0x28 ? 1n : host.isUserAnAdmin() ? 1n : 0n);
        break;
      case 0x33:
        // 0x469A28: the debug log is deleted; its session header is not written again.
        await this.folder.deleteFile('debuglog.txt');
        break;
      case 0x34:
        await this.log(pstr);
        break;
      case 0x38:
        setInt(BigInt(s.config23));
        break;
      case 0x39:
        s.config23 = Number(BigInt.asIntN(8, pint));
        await this.saveConfig();
        break;
      case 0x50:
        s.direct3d = true;
        break;
      case 0x51:
        s.direct3d = false;
        break;
      case 100:
        this.window.showWindow(0, 'hide');
        break;
      case 0x6e:
        this.window.showWindow(0, 'show');
        break;
      case 0x78:
        // ShellExecuteA "Open" of IExplore with PSTR as its parameters, SW_SHOWNORMAL.
        await this.folder.shellExecute('IExplore', pstr, false);
        break;
      case 0x2776:
        host.createEdit(pstr, low(pint), low(pint2), low(pint3), low(pint4));
        break;
      case 0x2777:
        host.closeEdit();
        break;
      case 0x2778:
        host.setEditText(pstr);
        break;
      case 0x2779:
        setString(host.editText().slice(0, 0x104));
        break;
      case 0x27d9: {
        const result = await host.inputDialog(pstr, 0x100);
        if (result === null) this.inputAccepted = 0;
        else {
          this.inputAccepted = 1;
          this.inputText = result.slice(0, 0xfff);
        }
        setInt(BigInt(this.inputAccepted));
        break;
      }
      case 0x27dd:
        setString(this.inputText);
        break;
      case 0x4e25:
        host.focusEdit(true);
        break;
      case 0x4e26:
        host.focusEdit(false);
        break;
      case 0x4e2b:
        s.suspendOnCaption = true;
        break;
      case 0x4e2c:
        s.suspendOnCaption = false;
        break;
      case 0x4e2d:
        s.pauseTimers(m.now());
        break;
      case 0x4e2e:
        s.resumeTimers(m.now());
        break;
      case 0x4e35:
        // 0x872050, which nothing writes.
        setInt(0n);
        break;
      case 21000:
        setString(await host.browseFolder(pstr2, backslashes(pstr)));
        break;
      case 0x5227:
        setString(host.windowsDirectory());
        break;
    }
    return 0;
  }

  /**
   * The list copy at the end of COM 0x15 and 0x18: the names become the system string list
   * (id 0xE) and its length (id 0xF).
   */
  private publish(names: ByteString[]): void {
    const s = this.m.system;
    s.list = names;
    s.listLength = names.length;
  }

  /**
   * 0x45AA09: the entries of `path\*.*` except '.' and '..'. Files are kept when `extension`
   * is empty or the name ends with '.' + `extension` (any case); folders only with `folders`,
   * then with '/' appended. The list stops at 0x2000 names with a message.
   */
  private async listFolder(
    path: ByteString,
    extension: ByteString,
    folders: boolean,
  ): Promise<ByteString[]> {
    const names: ByteString[] = [],
      suffix = '.' + extension,
      entries = await this.folder.list(path);
    if (!entries) return names;
    for (const entry of entries) {
      if (entry.name === '.' || entry.name === '..') continue;
      if (
        entry.directory ? !folders : extension !== '' && !endsWithIgnoringCase(entry.name, suffix)
      )
        continue;
      names.push(entry.directory ? entry.name + '/' : entry.name);
      if (names.length === LIST_LIMIT) {
        this.m.messageBox(`リストが ${LIST_LIMIT} 個に達しました. 取得を中断します。`);
        break;
      }
    }
    return names;
  }

  /**
   * 0x45BFEC: the entry names of every archive whose first nine characters match `prefix`
   * (`_strnicmp`), each name once (`_stricmp`), in archive and table order. The list stops at
   * 0x2000 names with a message. The count is also formatted into the message caption buffer
   * 0x8782B0 ("YS_DROPFILE_NUM = %d"), which the host's message boxes do not show.
   */
  private listArchives(prefix: ByteString): ByteString[] {
    const names: ByteString[] = [],
      seen = new Set<ByteString>();
    for (const archive of this.m.files.archiveNames()) {
      for (const name of archive) {
        if (compareIgnoringCase(prefix, name, 9) !== 0) continue;
        const key = asciiLower(name);
        if (seen.has(key)) continue;
        seen.add(key);
        names.push(name);
        if (names.length === LIST_LIMIT) {
          this.m.messageBox(`リストが ${LIST_LIMIT} 個に達しました. 取得を中断します。`);
          break;
        }
      }
      if (names.length === LIST_LIMIT) break;
    }
    return names;
  }

  /**
   * 0x45AC60: splits `line` into tokens. Token texts go to the string elements named by
   * `strings` and their kinds to the int (or float) elements named by `kinds`, both counted
   * from the reference's element. `comment` names the int element holding the open block-comment
   * state across lines: it is read first and written back at the end. Returns the count.
   *
   * Kinds: 0 line end (CR, or `//` which ends the line), 0x0B `++`, 0x0C `+=`, 0x10 any other
   * single character, 0x1F a string from '"' to the closing '"' or CR (both kept), 0x20 a word
   * (a digit, '-', letter, '_', '.' or double-byte character followed by letters, digits,
   * '_', '.', '/' and double-byte characters; it ends at the first other character, so one
   * at the very end of the line is not counted), 0x33 '\', 0x34 '(', 0x35 ')', 0x36 ',',
   * 0x37 '@', 0x38 '$', 0x39 '#' (also for `#=`, which consumes the '='). Spaces, tabs and
   * ';' separate tokens. Inside a comment each CR is a kind-0 token; the closing star-slash stores
   * the comment text in the next slot without counting it. The kinds 0x0D..0x0F the native
   * tests for `-=`, `*=` and `/=` compare against '+' again and so never match.
   */
  private tokenize(line: ByteString, strings: bigint, kinds: bigint, comment: bigint): bigint {
    const m = this.m,
      stringId = high(strings),
      stringBase = low(strings),
      kindId = high(kinds),
      kindBase = low(kinds),
      commentId = high(comment),
      commentIndex = BigInt(low(comment));
    let flag = m.getInt(commentId, commentIndex);
    let state: number = flag !== 0n ? State.Comment : State.None;
    let count = 0,
      at = 0,
      start = 0;
    const kind = (value: number): void =>
      m.setInt(kindId, BigInt((count + kindBase) | 0), BigInt(value));
    const token = (value: ByteString): void =>
      m.setString(stringId, BigInt((count + stringBase) | 0), value);
    const emit = (k: number, value: ByteString): void => {
      kind(k);
      token(value);
      count++;
    };
    const length = line.length;
    while (at < length) {
      const c = line.charCodeAt(at),
        next = at + 1 < length ? line.charCodeAt(at + 1) : 0,
        size = isLeadByte(c) ? 2 : 1;
      if (state === State.None) {
        const wide = c >= 0x81 && c <= 0xfe;
        if ((c >= 0x30 && c <= 0x39) || c === 0x2d) [state, at] = [State.Number, at + 1];
        else if (c >= 0x41 && c <= 0x5a) [state, at] = [State.Upper, at + 1];
        else if (c >= 0x61 && c <= 0x7a) [state, at] = [State.Lower, at + 1];
        else if (c === 0x5f) [state, at] = [State.Underscore, at + 1];
        else if (c === 0x2e) [state, at] = [State.Dot, at + 1];
        else if (wide) [state, at] = [State.Wide, at + size];
        else if (c === 0x22) [state, at] = [State.String, at + 1];
        else if (c === 0x20) [state, at] = [State.Spaces, at + 1];
        else if (c === 0x09) [state, at] = [State.Tabs, at + 1];
        else if (c === 0x2f && next === 0x2f) {
          // A line comment ends the line; the comment state is not written back.
          emit(0, '\r');
          return BigInt(count);
        } else if (c === 0x2f && next === 0x2a) {
          at++;
          flag = 1n;
          state = State.Comment;
        } else if (SINGLE.has(c)) {
          emit(SINGLE.get(c)!, line[at]!);
          at += c === 0x23 && next === 0x3d ? 2 : 1;
          start = at;
        } else if (c === 0x2b && next === 0x2b) {
          emit(0x0b, '++');
          start = at += 2;
        } else if (c === 0x2b && next === 0x3d) {
          emit(0x0c, '+=');
          start = at += 2;
        } else if (c === 0x3b) start = ++at;
        else {
          emit(0x10, line.slice(start, at + 1));
          start = at += size;
        }
        continue;
      }
      switch (state) {
        case State.String:
          if (c === 0x22 || c === 0x0d) {
            emit(0x1f, line.slice(start, at + 1));
            start = at += size;
            state = State.None;
          } else at++;
          break;
        case State.Spaces:
        case State.Tabs:
          if (c === (state === State.Spaces ? 0x20 : 0x09)) at++;
          else {
            start = at;
            state = State.None;
          }
          break;
        case State.Comment:
          if (c === 0x2a && next === 0x2f) {
            token(line.slice(start, at + 2));
            start = at += 2;
            state = State.None;
            flag = 0n;
          } else if (c === 0x0d) {
            emit(0, '\r');
            at++;
          } else at++;
          break;
        default:
          if (
            (c >= 0x30 && c <= 0x39) ||
            (c >= 0x41 && c <= 0x5a) ||
            (c >= 0x61 && c <= 0x7a) ||
            c === 0x5f ||
            c === 0x2e ||
            c === 0x2f ||
            (c >= 0x81 && c <= 0xfe)
          )
            at += size;
          else {
            emit(0x20, line.slice(start, at));
            start = at;
            state = State.None;
          }
      }
    }
    m.setInt(commentId, commentIndex, flag);
    return BigInt(count);
  }

  /**
   * 0x45BF7C: the byte length of each string element from the `strings` reference on goes to
   * the int elements from the `lengths` reference on, through the first empty string (whose
   * 0 is written too). Returns the number of non-empty strings.
   */
  private measure(strings: bigint, lengths: bigint): bigint {
    const m = this.m;
    let n = 0;
    for (;;) {
      const length = m.getString(high(strings), BigInt((low(strings) + n) | 0)).length;
      m.setInt(high(lengths), BigInt((low(lengths) + n) >>> 0), BigInt(length));
      if (length === 0) return BigInt(n);
      n++;
    }
  }

  /**
   * COM 0x34, 0x45C4D4 and 0x40F509: `text` and a line feed are appended to debuglog.txt in
   * the game folder. The first entry of a session deletes the old log and starts with a
   * header holding the local time. (The 10 MB warning of 0x40F509 never fires: its byte count
   * stays 0.)
   */
  private async log(text: ByteString): Promise<void> {
    const path = 'debuglog.txt';
    if (this.logFresh) {
      await this.folder.deleteFile(path);
      const t = new Date(),
        two = (n: number): string => String(n).padStart(2, '0'),
        rule = '//' + '-'.repeat(76);
      const header =
        `${rule}\n//\x81\xa1${two(t.getFullYear() % 100)}/${two(t.getMonth() + 1)}/${two(t.getDate())}` +
        ` time=${two(t.getHours())}:${two(t.getMinutes())}:${two(t.getSeconds())}\n${rule}`;
      await this.folder.appendFile(path, bytes(header + '\n'));
      this.logFresh = false;
    }
    await this.folder.appendFile(path, bytes(text + '\n'));
  }

  /**
   * COM 0x39, 0x45C510: yscfg.dat (32 words) is read, word 0x17 set to the value when it is
   * 0..3, and the file written back. A file that cannot be read or written is reported (the
   * messages are stored GBK-encoded in the executable).
   */
  private async saveConfig(): Promise<void> {
    const m = this.m,
      path = 'yscfg.dat';
    const words = new Uint8Array(0x80),
      file = await this.folder.readFile(path);
    if (file === null) {
      m.messageBox('无法读取 [ yscfg.dat ] 。');
      return;
    }
    words.set(file.subarray(0, 0x80));
    const value = m.system.config23;
    if (value >= 0 && value <= 3) new DataView(words.buffer).setUint32(0x17 * 4, value, true);
    try {
      await this.folder.writeFile(path, words);
    } catch {
      m.messageBox('无法将设置保存到配置数据文件。\r\n\r\n[ yscfg.dat ]可能是只读的。');
    }
  }
}

/** The lexer states of 0x45AC60 (EBP). */
const enum State {
  None = 0,
  String = 0x16,
  Spaces = 0x1f,
  Tabs = 0x20,
  Number = 0x5b,
  Upper = 0x5c,
  Lower = 0x5d,
  Underscore = 0x5e,
  Dot = 0x5f,
  Wide = 0x60,
  Comment = 0x63,
}

/** Single-character tokens of 0x45AC60 and their kinds. */
const SINGLE = new Map<number, number>([
  [0x5c, 0x33],
  [0x28, 0x34],
  [0x29, 0x35],
  [0x2c, 0x36],
  [0x40, 0x37],
  [0x24, 0x38],
  [0x23, 0x39],
]);

function low(value: bigint): number {
  return Number(BigInt.asIntN(32, value));
}

function high(value: bigint): number {
  return Number(BigInt.asUintN(32, value >> 32n));
}

/** The '/' to '\' pass PRODUCT applies to path arguments (outside double-byte characters). */
function backslashes(text: ByteString): ByteString {
  let out = '';
  for (let i = 0; i < text.length;) {
    if (isLeadByte(text.charCodeAt(i))) {
      out += text.slice(i, i + 2);
      i += 2;
    } else {
      out += text[i] === '/' ? '\\' : text[i];
      i++;
    }
  }
  return out;
}

/** `_strnicmp` in the C locale (0x471A60). */
function compareIgnoringCase(a: ByteString, b: ByteString, limit: number): number {
  for (let i = 0; i < limit; i++) {
    const x = fold(i < a.length ? a.charCodeAt(i) : 0),
      y = fold(i < b.length ? b.charCodeAt(i) : 0);
    if (x !== y) return x - y;
    if (x === 0) return 0;
  }
  return 0;
}

function fold(c: number): number {
  return c >= 0x41 && c <= 0x5a ? c + 0x20 : c;
}

/** 0x440DA0: whether `name` ends with `suffix`, compared with `_strnicmp`. */
export function endsWithIgnoringCase(name: ByteString, suffix: ByteString): boolean {
  if (name.length < suffix.length) return false;
  return compareIgnoringCase(name.slice(name.length - suffix.length), suffix, suffix.length) === 0;
}

function bytes(text: ByteString | Uint8Array): Uint8Array {
  if (typeof text !== 'string') return text;
  return Uint8Array.from(text, (c) => c.charCodeAt(0) & 0xff);
}

function decode(text: ByteString): string {
  return decodeCp932(bytes(text));
}
