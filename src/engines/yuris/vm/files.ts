import {type YurisConfig, YBN_VERSION, YBN_VERSION_500} from '../../../formats/yuris/ybn.js';
import {type ProgressiveBytes, completeBytes} from '../../../formats/zlib.js';
import {resolveNodePath} from './nodes.js';
import {type ByteString, isLeadByte} from './numbers.js';
import {asciiLower} from './sjis.js';

/** The file a script names: game folder files and archive entries, searched by 0x4406DD. */
export interface YurisFileHost {
  /** Whether the folder or an archive holds `path` (lower case, '\' separated). */
  exists(path: ByteString): boolean;
  read(path: ByteString): Promise<Uint8Array>;
  /** Like `read`, but readable from the start before the whole file is available. */
  readProgressive?(path: ByteString): Promise<ProgressiveBytes>;
  /**
   * The archive list 0x8725AC (`pac\*.ypf` in directory order, then `update1.ypf`..): each
   * archive's entry names in table order, as their decoded bytes.
   */
  archiveNames(): readonly (readonly ByteString[])[];
}

/**
 * File types of 0x440C68, by extension. The values are `hajiron.exe`'s; the YBN version 500
 * build numbers its types differently (Relirium.exe 0x470F1C: bmp 1, png 2, jpg 3, gif 4,
 * ydg 5, webp 6, jxl 7, qoi 8, avif 9, wav 10, ogg 11, opus 12) and they never reach scripts.
 */
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
  Ydg = 11,
  Jxl = 12,
  Qoi = 13,
  Avif = 14,
  Opus = 15,
}

type TypeTable = readonly (readonly [ByteString, YurisFileType])[];

/** 0x440C68: the extension tests in their native order (strings at 0x8789C0..0x878A48). */
const TYPES: TypeTable = [
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

/** Version 500, Relirium.exe 0x470F1C (strings 0x89A5C0..0x89A618). */
const TYPES_500: TypeTable = [
  ['.bmp', YurisFileType.Bmp],
  ['.png', YurisFileType.Png],
  ['.jpg', YurisFileType.Jpg],
  ['.gif', YurisFileType.Gif],
  ['.ydg', YurisFileType.Ydg],
  ['.webp', YurisFileType.Webp],
  ['.jxl', YurisFileType.Jxl],
  ['.qoi', YurisFileType.Qoi],
  ['.avif', YurisFileType.Avif],
  ['.wav', YurisFileType.Wav],
  ['.ogg', YurisFileType.Ogg],
  ['.opus', YurisFileType.Opus],
];

function typeTable(version: number): TypeTable {
  return version === YBN_VERSION_500 ? TYPES_500 : TYPES;
}

export function fileType(path: ByteString, version: number = YBN_VERSION): YurisFileType {
  for (const [extension, type] of typeTable(version)) if (path.endsWith(extension)) return type;
  return YurisFileType.None;
}

/** Whether a resolved type is a sound rather than an image (0x425B34 rejects these for CG). */
export function isSoundFileType(type: YurisFileType): boolean {
  return type === YurisFileType.Wav || type === YurisFileType.Ogg || type === YurisFileType.Opus;
}

/** What the resolver looks for: images (0), sounds (1) or any file (9). */
export const enum YurisFileKind {
  Image = 0,
  Sound = 1,
  Any = 9,
}

interface ResolverTables {
  /** The extensions an image or sound name may carry already. */
  readonly images: readonly ByteString[];
  readonly sounds: readonly ByteString[];
  /** YSCF search-order codes and how many order bytes the resolver reads. */
  readonly imageOrder: Readonly<Record<number, ByteString>>;
  readonly soundOrder: Readonly<Record<number, ByteString>>;
  readonly imageLimit: number;
  readonly soundLimit: number;
}

/**
 * 0x43F9B4: the known extensions (its 0x440DA0 tests), image codes 1-6 (0x872318, strings
 * 0x878A00..0x878A28) over seven order bytes and sound codes 1-2 (0x872320).
 */
const RESOLVER: ResolverTables = {
  images: ['.bmp', '.png', '.jpg', '.gif', '.psb', '.webp'],
  sounds: ['.wav', '.ogg'],
  imageOrder: {1: '.png', 2: '.bmp', 3: '.jpg', 4: '.gif', 5: '.psb', 6: '.webp'},
  soundOrder: {1: '.ogg', 2: '.wav'},
  imageLimit: 7,
  soundLimit: 4,
};

/**
 * Version 500, Relirium.exe 0x46FB20: nine known image extensions and three sound ones; image
 * codes 1-9 (0x893C54, strings 0x89A620..0x89A660) over nine order bytes and sound codes
 * 1-3 (0x893C64, strings 0x89A668..0x89A678) over three.
 */
const RESOLVER_500: ResolverTables = {
  images: ['.bmp', '.png', '.jpg', '.gif', '.ydg', '.webp', '.jxl', '.qoi', '.avif'],
  sounds: ['.wav', '.ogg', '.opus'],
  imageOrder: {
    1: '.bmp',
    2: '.png',
    3: '.jpg',
    4: '.gif',
    5: '.ydg',
    6: '.webp',
    7: '.avif',
    8: '.qoi',
    9: '.jxl',
  },
  soundOrder: {1: '.wav', 2: '.ogg', 3: '.opus'},
  imageLimit: 9,
  soundLimit: 3,
};

export interface YurisResolvedFile {
  /** The searched path: lower case, '\' separated, with the extension that was found. */
  readonly path: ByteString;
  readonly found: boolean;
  readonly type: YurisFileType;
}

/**
 * The file resolver 0x43F9B4 (version 500: Relirium.exe 0x46FB20). The name is normalised like
 * a node id (0x4573E8 relative to the empty path, spaces allowed) and lower-cased; '\' and '/'
 * are both separators. A name without a known extension is tried with each extension of the
 * YSCF search order; otherwise the name is searched as it is.
 */
export class YurisFiles {
  constructor(
    private readonly host: YurisFileHost,
    private readonly config: YurisConfig,
  ) {}

  resolve(name: ByteString, kind: YurisFileKind): YurisResolvedFile {
    let path = asciiLower(resolveNodePath('', separators(name, '\\', '/'), true).path);
    path = separators(path, '/', '\\');
    const tables = this.config.version === YBN_VERSION_500 ? RESOLVER_500 : RESOLVER;
    const extensions =
      kind === YurisFileKind.Image
        ? tables.images
        : kind === YurisFileKind.Sound
          ? tables.sounds
          : null;
    const known =
      extensions === null ? kind === YurisFileKind.Any : extensions.some((e) => path.endsWith(e));
    if (!known && kind !== YurisFileKind.Any) {
      const order = kind === YurisFileKind.Image ? this.config.reserved : this.config.reserved2;
      const names = kind === YurisFileKind.Image ? tables.imageOrder : tables.soundOrder;
      const limit = Math.min(
        order.length,
        kind === YurisFileKind.Image ? tables.imageLimit : tables.soundLimit,
      );
      for (let i = 0; i < limit; i++) {
        const extension = names[order[i]!];
        if (!extension) continue;
        const candidate = path + extension;
        if (this.host.exists(candidate))
          return {path: candidate, found: true, type: fileType(candidate, this.config.version)};
      }
      return {path, found: false, type: YurisFileType.None};
    }
    const found = this.host.exists(path);
    return {path, found, type: found ? fileType(path, this.config.version) : YurisFileType.None};
  }

  /** The YBN version of the project (selects the version 500 tables). */
  get version(): number {
    return this.config.version;
  }

  exists(path: ByteString): boolean {
    return this.host.exists(path);
  }

  read(path: ByteString): Promise<Uint8Array> {
    return this.host.read(path);
  }

  async readProgressive(path: ByteString): Promise<ProgressiveBytes> {
    return this.host.readProgressive
      ? this.host.readProgressive(path)
      : completeBytes(await this.host.read(path));
  }

  archiveNames(): readonly (readonly ByteString[])[] {
    return this.host.archiveNames();
  }
}

/** Replaces `from` with `to` outside double-byte characters. */
function separators(text: ByteString, from: string, to: string): ByteString {
  let out = '';
  for (let i = 0; i < text.length;) {
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
