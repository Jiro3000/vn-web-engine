import type {TriangleImage} from '../../graphics/triangle-draw.js';
import {decodePng} from '../../formats/png/decode.js';
import {decodeImageOffThread} from '../../graphics/image-decode-offload.js';
import {artemisRevision} from './revision.js';

export interface ArtemisImageCodec {
  /** Native plugins expose case-sensitive extension strings in registration order. */
  readonly extensions: readonly string[];
  /** Null is native decode failure; exceptions represent unsupported/host failures. */
  decode(bytes: Uint8Array): Promise<TriangleImage | null>;
}
export interface ArtemisLoadedImage {
  readonly path: string;
  readonly image: TriangleImage;
  /** Present when the resource path explicitly determines a native surface format. */
  readonly surfaceFormat?: 1 | 2;
}

/** Native 0x1401756a0: extension preference, content sniffing, then appended candidates. */
export class ArtemisImageLoader {
  private readonly codecs: readonly ArtemisImageCodec[];
  constructor(
    private readonly readFile: (path: string) => Promise<Uint8Array | null>,
    codecs: readonly ArtemisImageCodec[],
  ) {
    this.codecs = codecs.map((codec) => ({
      extensions: [...codec.extensions],
      decode: (bytes) => codec.decode(bytes),
    }));
  }
  async load(name: string): Promise<ArtemisLoadedImage | null> {
    if (name.includes('\0')) throw new Error('Unsupported Artemis image path containing NUL');
    const exact = await this.readFile(name);
    if (exact !== null) {
      // Native CFileName uses its Windows separator and does not fold extension case.
      const basename = name.slice(name.lastIndexOf('\\') + 1);
      const dot = basename.lastIndexOf('.');
      const extension = dot < 0 ? '' : basename.slice(dot + 1);
      if (extension)
        for (const codec of this.codecs)
          if (codec.extensions.includes(extension)) {
            const image = await codec.decode(exact);
            if (image !== null) return {path: name, image};
          }
      for (const codec of this.codecs) {
        const image = await codec.decode(exact);
        if (image !== null) return {path: name, image};
      }
    }
    for (const codec of this.codecs)
      for (const extension of codec.extensions) {
        const path = `${name}.${extension}`;
        const bytes = await this.readFile(path);
        if (bytes === null) continue;
        const image = await codec.decode(bytes);
        if (image !== null) return {path, image};
      }
    return null;
  }
}

/** Exact revision's stage codec order. Missing optional codecs refuse when their file is selected. */
export function createArtemisImageLoader(
  executableSha256: string,
  readFile: (path: string) => Promise<Uint8Array | null>,
  decoders: {
    readonly jpeg?: ArtemisImageCodec['decode'];
    readonly psd?: ArtemisImageCodec['decode'];
  } = {},
): ArtemisImageLoader {
  artemisRevision(executableSha256);
  const absent =
    (name: string): ArtemisImageCodec['decode'] =>
    async () => {
      throw new Error(`Unsupported Artemis ${name} image decoder`);
    };
  return new ArtemisImageLoader(readFile, [
    {
      extensions: ['png', 'PNG'],
      decode: async (bytes) => {
        if (![137, 80, 78, 71, 13, 10, 26, 10].every((byte, index) => bytes[index] === byte))
          return null;
        return (await decodeImageOffThread(bytes, 'png')) ?? decodePng(bytes);
      },
    },
    {extensions: ['jpg', 'jpeg', 'JPG', 'JPEG'], decode: decoders.jpeg ?? absent('JPEG')},
    {extensions: ['psd', 'PSD'], decode: decoders.psd ?? absent('PSD')},
  ]);
}
