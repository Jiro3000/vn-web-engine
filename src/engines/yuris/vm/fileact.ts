import type {YurisCg} from './cg.js';
import {YurisError} from './errors.js';
import {YurisFileKind} from './files.js';
import type {YurisMachine} from './machine.js';
import {type ByteString, isLeadByte} from './numbers.js';
import {asciiLower} from './sjis.js';
import {YurisType} from './variables.js';

type HostResult<T> = T | Promise<T>;

/**
 * The game folder as the Win32 file API sees it (paths relative to the game folder, '\'
 * separated, Shift-JIS bytes). The project layer decides where writes land.
 */
export interface YurisFolderHost {
  /** FindFirstFileA: the entry at `path`, null when there is none. */
  stat(path: ByteString): HostResult<{readonly directory: boolean; readonly size: number} | null>;
  /** CreateDirectoryA; an existing directory is left as it is. */
  createDirectory(path: ByteString): HostResult<void>;
  /** CopyFileA with overwriting allowed. */
  copyFile(from: ByteString, to: ByteString): HostResult<void>;
  deleteFile(path: ByteString): HostResult<void>;
  removeDirectory(path: ByteString): HostResult<void>;
  writeFile(path: ByteString, data: Uint8Array): HostResult<void>;
  /** ShellExecuteExA "open" of `file`; `wait` waits for the started process (EXEC2). */
  shellExecute(file: ByteString, parameters: ByteString | null, wait: boolean): HostResult<void>;
  /** FindExecutableA: the program associated with `file`, empty when there is none. */
  findExecutable(file: ByteString): HostResult<ByteString>;
  /** The CG preload queue 0x78B840 (CGCASH) feeding the loader thread 0x417DDC. */
  preload(path: ByteString, priority: bigint): void;
}

/**
 * Image file writers. BMP is written by the executable (0x43EB88); the others are the
 * `SavePNG` (YSPNG.DLL), JPEG and WebP (YSWBP.DLL) exports. `pixels` are straight BGRA rows;
 * `alpha` is the layer's mask flag, which keeps the alpha channel.
 */
export interface YurisImageEncoder {
  encodeImage(
    format: 'png' | 'jpeg' | 'webp',
    pixels: Uint8Array,
    width: number,
    height: number,
    alpha: boolean,
    quality: number,
  ): Promise<Uint8Array>;
}

/** FILEACT argument ids (`ysc.ybn`). */
const enum Act {
  File,
  File2,
  Folder,
  Create,
  Copy,
  Delete,
  Exec,
  Exec2,
  Param,
  Set,
  Id,
  IdNo,
  Bmp,
  Png,
  Jpg,
  Webp,
  CgCash,
  SoundCash,
}

/** FILEINFO argument ids. */
const enum Info {
  Folder,
  File,
  CgFile,
  SoundFile,
  Exist,
  Size,
  Relation,
  Let,
}

const FILEACT = 0x14,
  FILEINFO = 0x15;

export function installFiles(m: YurisMachine, folder: YurisFolderHost, encoder: YurisImageEncoder): void {
  m.define(FILEACT, () => fileAct(m, folder, encoder));
  m.define(FILEINFO, () => fileInfo(m, folder));
}

/** 0x4652F8 and the '/' to '\' pass of FILEACT: the form the Win32 calls receive. */
function windowsPath(text: ByteString): ByteString {
  return replaceSingle(asciiLower(text), '/', '\\');
}

function replaceSingle(text: ByteString, from: string, to: string): ByteString {
  let out = '';
  for (let i = 0; i < text.length; ) {
    if (isLeadByte(text.charCodeAt(i))) {
      out += text.slice(i, i + 2);
      i += 2;
    } else {
      out += text[i] === from ? to : text[i];
      i++;
    }
  }
  return out;
}

/** Whether the last character (not the trail byte of a double-byte one) is '\'. */
function endsWithSeparator(text: ByteString): boolean {
  let last = -1;
  for (let i = 0; i < text.length; i += isLeadByte(text.charCodeAt(i)) ? 2 : 1) last = i;
  return last >= 0 && last === text.length - 1 && text[last] === '\\';
}

/**
 * FILEACT 0x43DE44. FILE, FILE2 and FOLDER are lower-cased with '/' turned into '\'; FOLDER
 * always ends with '\'. In order: CGCASH queues FILE for preloading, ID saves a layer's pixels
 * to FILE (BMP, PNG by default, JPG or WEBP; SET is the PNG level 0..9, the JPEG quality
 * 1..100 or the WebP quality 0..101), CREATE makes every directory of FOLDER, COPY copies FILE
 * to FILE2, DELETE deletes FILE and removes FOLDER, and EXEC (or EXEC2, which waits) opens
 * FILE with PARAM.
 */
async function fileAct(m: YurisMachine, folder: YurisFolderHost, encoder: YurisImageEncoder): Promise<number> {
  const a = m.args;
  m.decode();
  const file = a.has(Act.File) ? windowsPath(a.text(Act.File)) : null;
  const file2 = a.has(Act.File2) ? windowsPath(a.text(Act.File2)) : null;
  let directory = a.has(Act.Folder) ? windowsPath(a.text(Act.Folder)) : null;
  if (directory !== null && !endsWithSeparator(directory)) directory += '\\';
  const parameters = a.has(Act.Param) ? a.text(Act.Param) : null;
  const flag = (id: Act) => a.has(id) !== 0 && a.int(id) === 1n;
  let format = 2;
  if (flag(Act.Bmp)) format = 1;
  if (flag(Act.Png)) format = 2;
  if (flag(Act.Jpg)) format = 3;
  if (flag(Act.Webp)) format = 4;
  // 0x43E0C8: CGCASH n queues FILE with priority n - 1 when the preload thread is enabled.
  if (a.has(Act.CgCash) && a.int(Act.CgCash) !== 0n && m.system.preloadEnabled)
    folder.preload(file ?? '', a.int(Act.CgCash) - 1n);
  if (a.has(Act.Id)) {
    const target = m.layers.target(Act.Id, Act.IdNo);
    const cg = m.layers.lookup(target.path, target.group)?.payload;
    if (!cg) throw new YurisError(0x18b82, [m.commandName(m.instruction.command), target.path]);
    if ((await saveImage(m, folder, encoder, cg, file ?? '', format)) !== 0) return -1;
  }
  if (a.has(Act.Create) && directory !== null) await createDirectories(folder, directory);
  if (a.has(Act.Copy) && file !== null && file2 !== null) await folder.copyFile(file, file2);
  if (a.has(Act.Delete)) {
    if (file !== null) await folder.deleteFile(file);
    if (directory !== null) await folder.removeDirectory(directory);
  }
  if (a.has(Act.Exec)) {
    if (file) await folder.shellExecute(file, parameters, false);
  } else if (a.has(Act.Exec2) && file) await folder.shellExecute(file, parameters, true);
  return 0;
}

/** 0x43EE70: CreateDirectoryA on the path up to each '\' outside double-byte characters. */
async function createDirectories(folder: YurisFolderHost, path: ByteString): Promise<void> {
  for (let i = 0; i < path.length; i += isLeadByte(path.charCodeAt(i)) ? 2 : 1)
    if (path[i] === '\\') await folder.createDirectory(path.slice(0, i));
}

/** 0x43E1B0..0x43E2D0: the extension is appended unless FILE ends with it already (0x440DA0). */
async function saveImage(
  m: YurisMachine,
  folder: YurisFolderHost,
  encoder: YurisImageEncoder,
  cg: YurisCg,
  file: ByteString,
  format: number,
): Promise<number> {
  const a = m.args;
  const set = a.has(Act.Set) ? a.int(Act.Set) : null;
  const clamp = (fallback: number, min: bigint, max: bigint) =>
    set === null ? fallback : Number(set < min ? min : set > max ? max : set);
  const named = (extension: string) => (file.endsWith(extension) ? file : file + extension);
  const pixels = cg.pixels ?? new Uint8Array(cg.width * cg.height * 4);
  if (format === 1) {
    await folder.writeFile(named('.bmp'), bitmap(pixels, cg.width, cg.height));
    return 0;
  }
  const [type, extension, quality] =
    format === 2
      ? (['png', '.png', clamp(5, 0n, 9n)] as const)
      : format === 3
        ? (['jpeg', '.jpg', clamp(90, 1n, 100n)] as const)
        : (['webp', '.webp', clamp(90, 0n, 101n)] as const);
  const data = await encoder.encodeImage(type, pixels, cg.width, cg.height, cg.masked !== 0, quality);
  await folder.writeFile(named(extension), data);
  return 0;
}

/** 0x43EB88: a 24-bit bottom-up BMP of the layer's colour channels. */
function bitmap(pixels: Uint8Array, width: number, height: number): Uint8Array {
  const stride = (width * 3 + 3) & ~3,
    size = stride * height;
  const out = new Uint8Array(0x36 + size);
  const view = new DataView(out.buffer);
  view.setUint16(0, 0x4d42, true);
  view.setUint32(2, size + 0x36, true);
  view.setUint32(10, 0x36, true);
  view.setUint32(14, 0x28, true);
  view.setInt32(18, width, true);
  view.setInt32(22, height, true);
  view.setUint16(26, 1, true);
  view.setUint16(28, 0x18, true);
  for (let y = 0; y < height; y++) {
    let o = 0x36 + y * stride;
    for (let x = 0, i = (height - 1 - y) * width * 4; x < width; x++, i += 4, o += 3) {
      out[o] = pixels[i]!;
      out[o + 1] = pixels[i + 1]!;
      out[o + 2] = pixels[i + 2]!;
    }
  }
  return out;
}

/**
 * FILEINFO 0x43EEEC: one query on the last of FOLDER, FILE, CGFILE and SOUNDFILE given. EXIST
 * is 1 when the folder is a directory or the file resolves (0x43F9B4: any file, an image or a
 * sound), SIZE the folder entry's size for FILE (0 otherwise), RELATION the program associated
 * with FILE (FindExecutableA), stored as a string, or 0 in a number element.
 */
async function fileInfo(m: YurisMachine, folder: YurisFolderHost): Promise<number> {
  const a = m.args;
  m.decode();
  const slot = a.has(Info.Let),
    id = a.variable[slot]!,
    index = a.variableIndex[slot]!;
  let kind = 0,
    name: ByteString = '';
  for (const [arg, k] of [
    [Info.Folder, 1],
    [Info.File, 2],
    [Info.CgFile, 3],
    [Info.SoundFile, 4],
  ] as const)
    if (a.has(arg)) {
      kind = k;
      name = a.text(arg);
    }
  const path = asciiLower(name);
  if (a.has(Info.Exist)) {
    let exists = false;
    if (kind === 1) exists = (await folder.stat(path))?.directory ?? false;
    else if (kind >= 2) {
      const resolver = kind === 2 ? YurisFileKind.Any : kind === 3 ? YurisFileKind.Image : YurisFileKind.Sound;
      exists = m.files.resolve(name, resolver).found;
    }
    if (kind !== 0) m.setInt(id, index, exists ? 1n : 0n);
    return 0;
  }
  if (a.has(Info.Size)) {
    const entry = kind === 2 ? await folder.stat(path) : null;
    m.setInt(id, index, entry && !entry.directory ? BigInt(entry.size) : 0n);
    return 0;
  }
  if (a.has(Info.Relation)) {
    const type = m.variables.get(id).type;
    if (type === YurisType.String) {
      const program = kind === 1 ? '' : await folder.findExecutable(path);
      m.setString(id, index, program.endsWith(' ') ? program.slice(0, -1) : program);
    } else if (type === YurisType.Int || type === YurisType.Float) m.setInt(id, index, 0n);
  }
  return 0;
}
