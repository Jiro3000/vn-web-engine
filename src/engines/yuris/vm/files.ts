import type {YurisConfig} from '../../../formats/yuris/ybn.js';
import {resolveNodePath} from './nodes.js';
import {type ByteString, isLeadByte} from './numbers.js';
import {asciiLower} from './sjis.js';

/** The file a script names: game folder files and archive entries, searched by 0x4406DD. */
export interface YurisFileHost {
  /** Whether the folder or an archive holds `path` (lower case, '\' separated). */
  exists(path: ByteString): boolean;
  read(path: ByteString): Promise<Uint8Array>;
}

/** File types of 0x440C68, by extension. */
export const enum YurisFileType {
  None = 0,
  Bmp = 1,
  Png = 2,
  Jpg = 3,
  Gif = 4,
  Wav = 5,
  Ogg = 6,
  Psd = 7,
  Ycg = 8,
  Psb = 9,
  Webp = 10,
}

/** 0x440C68: the extension tests in their native order (strings at 0x8789C0..0x878A48). */
const TYPES: readonly (readonly [ByteString, YurisFileType])[] = [
  ['.bmp', YurisFileType.Bmp],
  ['.png', YurisFileType.Png],
  ['.jpg', YurisFileType.Jpg],
  ['.gif', YurisFileType.Gif],
  ['.psd', YurisFileType.Psd],
  ['.ycg', YurisFileType.Ycg],
  ['.psb', YurisFileType.Psb],
  ['.webp', YurisFileType.Webp],
  ['.wav', YurisFileType.Wav],
  ['.ogg', YurisFileType.Ogg],
];

export function fileType(path: ByteString): YurisFileType {
  for (const [extension, type] of TYPES) if (path.endsWith(extension)) return type;
  return YurisFileType.None;
}

/** What the resolver looks for: images (0), sounds (1) or any file (9). */
export const enum YurisFileKind {
  Image = 0,
  Sound = 1,
  Any = 9,
}

/** The extensions an image or sound name may carry already (0x43F9B4's 0x440DA0 tests). */
const IMAGE_EXTENSIONS = ['.bmp', '.png', '.jpg', '.gif', '.psb', '.webp'];
const SOUND_EXTENSIONS = ['.wav', '.ogg'];

/** YSCF search orders: image codes 1-6 (0x872318, strings 0x878A00..0x878A28), sounds 1-2 (0x872320). */
const IMAGE_ORDER: Record<number, ByteString> = {
  1: '.png',
  2: '.bmp',
  3: '.jpg',
  4: '.gif',
  5: '.psb',
  6: '.webp',
};
const SOUND_ORDER: Record<number, ByteString> = {1: '.ogg', 2: '.wav'};

export interface YurisResolvedFile {
  /** The searched path: lower case, '\' separated, with the extension that was found. */
  readonly path: ByteString;
  readonly found: boolean;
  readonly type: YurisFileType;
}

/**
 * The file resolver 0x43F9B4. The name is normalised like a node id (0x4573E8 relative to the
 * empty path, spaces allowed) and lower-cased; '\' and '/' are both separators. A name without
 * a known extension is tried with each extension of the YSCF search order (the first seven
 * codes); otherwise the name is searched as it is.
 */
export class YurisFiles {
  constructor(
    private readonly host: YurisFileHost,
    private readonly config: YurisConfig,
  ) {}

  resolve(name: ByteString, kind: YurisFileKind): YurisResolvedFile {
    let path = asciiLower(resolveNodePath('', separators(name, '\\', '/'), true).path);
    path = separators(path, '/', '\\');
    const extensions =
      kind === YurisFileKind.Image ? IMAGE_EXTENSIONS : kind === YurisFileKind.Sound ? SOUND_EXTENSIONS : null;
    const known = extensions === null ? kind === YurisFileKind.Any : extensions.some((e) => path.endsWith(e));
    if (!known && kind !== YurisFileKind.Any) {
      const order = kind === YurisFileKind.Image ? this.config.reserved : this.config.reserved2;
      const names = kind === YurisFileKind.Image ? IMAGE_ORDER : SOUND_ORDER;
      const limit = kind === YurisFileKind.Image ? 7 : order.length;
      for (let i = 0; i < limit; i++) {
        const extension = names[order[i]!];
        if (!extension) continue;
        const candidate = path + extension;
        if (this.host.exists(candidate)) return {path: candidate, found: true, type: fileType(candidate)};
      }
      return {path, found: false, type: YurisFileType.None};
    }
    const found = this.host.exists(path);
    return {path, found, type: found ? fileType(path) : YurisFileType.None};
  }

  read(path: ByteString): Promise<Uint8Array> {
    return this.host.read(path);
  }
}

/** Replaces `from` with `to` outside double-byte characters. */
function separators(text: ByteString, from: string, to: string): ByteString {
  let out = '';
  for (let i = 0; i < text.length; ) {
    const c = text.charCodeAt(i);
    if (isLeadByte(c)) {
      out += text.slice(i, i + 2);
      i += 2;
    } else {
      out += text[i] === from ? to : text[i];
      i++;
    }
  }
  return out;
}
