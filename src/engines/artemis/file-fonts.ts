import type {FreeTypeMetrics, FreeTypeGlyph, FreeTypeRasterOptions} from '../../text/freetype.js';
import {artemisRevision} from './revision.js';

export interface ArtemisFileFontFace {
  requestSize(type: 0 | 1 | 2 | 3 | 4, width: number, height: number): Promise<FreeTypeMetrics>;
  rasterize(codePoint: number, options: FreeTypeRasterOptions): Promise<FreeTypeGlyph>;
  close(): Promise<void>;
}
export interface ArtemisFileFontHost {
  readFontFile(path: string): Promise<Uint8Array | null>;
  /** Must provide FreeType 2.4.8 with Unicode charmap and face index0. */
  openFontFace(bytes: Uint8Array): Promise<ArtemisFileFontFace>;
}
export interface ArtemisFileFontMetrics {
  readonly size: number;
  readonly baseline: number;
  readonly decorationThickness: number;
  readonly underlineThickness: number;
  readonly strikeoutPosition: number;
  readonly underlinePosition: number;
}
export interface ArtemisFileGlyph {
  readonly width: number;
  readonly height: number;
  readonly left: number;
  readonly top: number;
  readonly advance: number;
  readonly pixels: Uint8Array;
}
interface Entry {
  face: Promise<ArtemisFileFontFace>;
  references: number;
}
/** File-backed Unicode subset of CFreeTypeFont. Faces are shared by exact path,
 * with size changes applied atomically inside each raster job. System/rendered
 * font providers and legacy character conversion remain separate owners.
 */
export class ArtemisFileFonts {
  private readonly entries = new Map<string, Entry>();
  private closed = false;
  constructor(
    executableSha256: string,
    private readonly host: ArtemisFileFontHost,
  ) {
    artemisRevision(executableSha256);
  }
  async load(path: string, size: number, styleBits = 0): Promise<ArtemisFileFont> {
    if (this.closed) throw Error('Artemis file fonts closed');
    path = path.split('\0', 1)[0]!;
    if (!path || new TextDecoder().decode(new TextEncoder().encode(path)) !== path)
      throw Error('Unsupported Artemis font path');
    for (const value of [size, styleBits])
      if (!Number.isInteger(value) || value < -0x80000000 || value > 0x7fffffff)
        throw Error('Unsupported Artemis font integer');
    const byteSize = size & 255;
    if (!byteSize) throw Error('Unsupported zero Artemis file font size');
    let entry = this.entries.get(path);
    if (!entry) {
      entry = {references: 0, face: this.open(path)};
      this.entries.set(path, entry);
    }
    entry.references++;
    try {
      const face = await entry.face;
      if (this.closed) throw Error('Artemis file fonts closed');
      const native = await face.requestSize(3, 0, byteSize * 64);
      if (this.closed) throw Error('Artemis file fonts closed');
      const metrics = artemisFileFontMetrics(byteSize, native);
      return new ArtemisFileFont(
        face,
        metrics,
        styleBits,
        () => !this.closed,
        () => this.release(path, entry!),
      );
    } catch (error) {
      await this.release(path, entry);
      throw error;
    }
  }
  private async open(path: string): Promise<ArtemisFileFontFace> {
    const bytes = await this.host.readFontFile(path);
    if (!bytes) throw Error('Missing Artemis font file ' + path);
    if (this.closed) throw Error('Artemis file fonts closed');
    return this.host.openFontFace(bytes);
  }
  private async release(path: string, entry: Entry): Promise<void> {
    if (--entry.references !== 0) return;
    if (this.entries.get(path) !== entry) return;
    this.entries.delete(path);
    try {
      const face = await entry.face;
      await face.close();
    } catch (error) {
      // A failed open owns no face. A face-close failure must remain observable.
      try {
        await entry.face;
      } catch {
        return;
      }
      throw error;
    }
  }
  async close(): Promise<void> {
    if (this.closed) return;
    this.closed = true;
    const entries = [...this.entries.values()];
    this.entries.clear();
    const results = await Promise.allSettled(
      entries.map(async (entry) => {
        let face: ArtemisFileFontFace;
        try {
          face = await entry.face;
        } catch {
          return;
        }
        await face.close();
      }),
    );
    const failure = results.find((result) => result.status === 'rejected');
    if (failure?.status === 'rejected') throw failure.reason;
  }
}
/** Native signed integer formulas in16a0a0, after the CELL size request. */
export function artemisFileFontMetrics(
  size: number,
  face: FreeTypeMetrics,
): ArtemisFileFontMetrics {
  if (
    !Number.isInteger(size) ||
    size < 1 ||
    size > 255 ||
    !Number.isInteger(face.unitsPerEm) ||
    face.unitsPerEm <= 0
  )
    throw Error('Unsupported Artemis file font metrics');
  for (const [value, minimum, maximum] of [
    [face.yPpem, 0, 65535],
    [face.ascender, -32768, 32767],
    [face.underlineThickness, -32768, 32767],
    [face.underlinePosition, -32768, 32767],
  ])
    if (!Number.isInteger(value) || value! < minimum! || value! > maximum!)
      throw Error('Unsupported Artemis file font metrics');
  const scale = (value: number) => Math.trunc((face.yPpem * value) / face.unitsPerEm);
  const baseline = scale(face.ascender),
    height = Math.max(1, scale(face.underlineThickness));
  let leading = scale(
    face.ascender - Math.trunc(face.underlineThickness / 2) - face.underlinePosition,
  );
  if (size <= leading) leading = size - height;
  return Object.freeze({
    size,
    baseline,
    decorationThickness: height,
    underlineThickness: height,
    strikeoutPosition: Math.trunc((baseline * 7) / 10),
    underlinePosition: leading,
  });
}
export class ArtemisFileFont {
  private closed = false;
  constructor(
    private readonly face: ArtemisFileFontFace,
    readonly metrics: ArtemisFileFontMetrics,
    private readonly styleBits: number,
    private readonly ownerOpen: () => boolean,
    private readonly release: () => Promise<void>,
  ) {}
  async glyph(codePoint: number): Promise<ArtemisFileGlyph> {
    if (this.closed || !this.ownerOpen()) throw Error('Artemis file font closed');
    const glyph = await this.face.rasterize(codePoint, {
      flags: 6,
      bold: !!(this.styleBits & 8),
      shear: this.styleBits & 16 ? 0x6000 : 0,
      size: {type: 3, width: 0, height: this.metrics.size * 64},
    });
    if (this.closed || !this.ownerOpen()) throw Error('Artemis file font closed');
    if (glyph.width && glyph.height && glyph.bitmapMode !== 2)
      throw Error('Unsupported Artemis file glyph bitmap mode');
    return {
      width: glyph.width,
      height: glyph.height,
      left: glyph.left,
      top: (this.metrics.baseline - glyph.top) | 0,
      advance: glyph.advanceX >> 6,
      pixels: glyph.pixels,
    };
  }
  async close(): Promise<void> {
    if (this.closed) return;
    this.closed = true;
    await this.release();
  }
}
