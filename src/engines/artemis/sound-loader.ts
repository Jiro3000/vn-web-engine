export interface ArtemisSoundCodec<S> {
  /** Case-sensitive native plugin extensions, in registration order. */
  readonly extensions: readonly string[];
  /** Null is a decode miss; exceptions are host failures and must propagate. */
  decode(bytes: Uint8Array, bufferMode: number): Promise<S | null>;
}
export interface ArtemisLoadedSound<S> {
  readonly path: string;
  readonly sound: S;
}

/** Rev.3179 0x140190290: preferred suffix, sniff exact file, append suffixes.
 * The caller supplies the installation's actual registered codecs and order.
 * Each decode receives independent bytes starting at native file offset zero.
 */
export class ArtemisSoundLoader<S> {
  private readonly codecs: readonly ArtemisSoundCodec<S>[];
  constructor(
    private readonly readFile: (path: string) => Promise<Uint8Array | null>,
    codecs: readonly ArtemisSoundCodec<S>[],
  ) {
    this.codecs = codecs.map((codec) => ({
      extensions: [...codec.extensions],
      decode: (bytes, bufferMode) => codec.decode(bytes, bufferMode),
    }));
  }
  async load(name: string, bufferMode: number): Promise<ArtemisLoadedSound<S> | null> {
    if (!Number.isInteger(bufferMode) || bufferMode < -2147483648 || bufferMode > 2147483647)
      throw new Error('Artemis sound buffer mode must be int32');
    // This entry receives a native char pointer, not a length-bearing CString.
    name = name.split('\0', 1)[0]!;
    const decode = (codec: ArtemisSoundCodec<S>, bytes: Uint8Array) =>
      codec.decode(Uint8Array.from(bytes), bufferMode);
    const exact = await this.readFile(name);
    if (exact !== null) {
      const basename = name.slice(name.lastIndexOf('\\') + 1);
      const dot = basename.lastIndexOf('.');
      const extension = dot < 0 ? '' : basename.slice(dot + 1);
      if (extension)
        for (const codec of this.codecs)
          if (codec.extensions.includes(extension)) {
            const sound = await decode(codec, exact);
            if (sound !== null) return {path: name, sound};
          }
      for (const codec of this.codecs) {
        const sound = await decode(codec, exact);
        if (sound !== null) return {path: name, sound};
      }
    }
    for (const codec of this.codecs)
      for (const extension of codec.extensions) {
        const path = `${name}.${extension}`;
        const bytes = await this.readFile(path);
        if (bytes === null) continue;
        const sound = await decode(codec, bytes);
        if (sound !== null) return {path, sound};
      }
    return null;
  }
}
