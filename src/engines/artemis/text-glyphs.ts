import type {ArtemisFileFont, ArtemisFileFonts} from './file-fonts.js';
import type {ArtemisGlyphPainter} from './glyph-paint-client.js';
import type {ArtemisGlyphSurface} from './glyph-paint.js';
import {
  layoutArtemisTextBlock,
  type ArtemisTextBlock,
  type ArtemisTextBlockStyle,
  type ArtemisBlockGlyph,
} from './text-block.js';
import {artemisRevision} from './revision.js';

export interface ArtemisTextGlyphStyle extends ArtemisTextBlockStyle {
  readonly face: string;
  readonly rubyface: string;
  readonly styleBits: number;
  readonly color: number;
  readonly shadowcolor: number;
  readonly outlinecolor: number;
}
export interface ArtemisTextGlyphResource {
  readonly codePoint: number;
  readonly surface: ArtemisGlyphSurface;
}
interface Cached {
  promise: Promise<ArtemisTextGlyphResource>;
  bytes: number;
}
/** File font→native paint→normal/ruby block pipeline. Resources can outlive this
 * cache through a frame owner's references. This does not claim line insertion,
 * scene attachment, display transforms or tween completion.
 */
export class ArtemisTextGlyphs {
  private readonly fonts = new Map<string, Promise<ArtemisFileFont>>();
  private readonly glyphs = new Map<string, Cached>();
  private cachedBytes = 0;
  private closed = false;
  constructor(
    private readonly hash: string,
    private readonly fontOwner: ArtemisFileFonts,
    private readonly painter: ArtemisGlyphPainter,
  ) {
    artemisRevision(hash);
  }
  async load(
    mainText: string,
    rubyText: string,
    style: ArtemisTextGlyphStyle,
  ): Promise<ArtemisTextBlock<ArtemisTextGlyphResource>> {
    this.assertOpen();
    const snapshot = {...style};
    if (
      !Number.isInteger(snapshot.styleBits) ||
      snapshot.styleBits < -0x80000000 ||
      snapshot.styleBits > 0x7fffffff
    )
      throw Error('Unsupported Artemis font style bits');
    // Validate all reserved geometry before allocating fonts or worker resources.
    layoutArtemisTextBlock(this.hash, [], [], snapshot);
    const symbolsFor = (text: string): string[] => {
      text = text.split('\0', 1)[0]!;
      if (new TextDecoder().decode(new TextEncoder().encode(text)) !== text)
        throw Error('Unsupported Artemis glyph text UTF-8');
      const symbols = Array.from(text);
      if (symbols.length > 10000) throw Error('Artemis text glyph budget exceeded');
      return symbols;
    };
    const mainSymbols = symbolsFor(mainText),
      rubySymbols = symbolsFor(rubyText);
    const stream = async (
      symbols: string[],
      ruby: boolean,
    ): Promise<ArtemisBlockGlyph<ArtemisTextGlyphResource>[]> => {
      const size = ruby ? snapshot.rubysize : snapshot.size;
      if (!size || !symbols.length) return [];
      const path = (ruby ? snapshot.rubyface : snapshot.face).split('\0', 1)[0]!;
      const shadow = ruby ? snapshot.rubyshadow : snapshot.shadow,
        outline = ruby ? snapshot.rubyoutline : snapshot.outline;
      const font = await this.font(path, size, snapshot.styleBits);
      const output: ArtemisBlockGlyph<ArtemisTextGlyphResource>[] = [];
      for (const symbol of symbols) {
        this.assertOpen();
        const codePoint = symbol.codePointAt(0)!;
        const key = JSON.stringify([
          path,
          size,
          snapshot.styleBits,
          shadow,
          outline,
          snapshot.color,
          snapshot.shadowcolor,
          snapshot.outlinecolor,
          codePoint,
        ]);
        let cached = this.glyphs.get(key);
        if (cached) {
          this.glyphs.delete(key);
          this.glyphs.set(key, cached);
        } else {
          const entry: Cached = {
            bytes: 0,
            promise: Promise.resolve().then(async () => {
              const glyph = await font.glyph(codePoint);
              this.assertOpen();
              const surface = await this.painter.paint(glyph, {
                shadow,
                outline,
                color: snapshot.color,
                shadowColor: snapshot.shadowcolor,
                outlineColor: snapshot.outlinecolor,
                underline: !!(snapshot.styleBits & 32),
                strikeout: !!(snapshot.styleBits & 64),
                decorationMetrics: font.metrics,
              });
              this.assertOpen();
              entry.bytes = surface.image?.pixels.byteLength ?? 0;
              if (this.glyphs.get(key) === entry) {
                this.cachedBytes += entry.bytes;
                this.trim();
              }
              return Object.freeze({codePoint, surface});
            }),
          };
          entry.promise.catch(() => {
            if (this.glyphs.get(key) === entry) this.glyphs.delete(key);
          });
          this.glyphs.set(key, entry);
          this.trim();
          cached = entry;
        }
        const glyph = await cached.promise;
        output.push({glyph, advance: glyph.surface.advance});
      }
      return output;
    };
    // Size changes are atomic in each worker job; simultaneous main/ruby owners
    // can safely borrow one file face without drawing at another stream's size.
    const [main, ruby] = await Promise.all([stream(mainSymbols, false), stream(rubySymbols, true)]);
    this.assertOpen();
    return layoutArtemisTextBlock(this.hash, main, ruby, snapshot);
  }
  private font(path: string, size: number, styleBits: number): Promise<ArtemisFileFont> {
    const key = JSON.stringify([path, size, styleBits & 24]);
    let font = this.fonts.get(key);
    if (!font) {
      if (this.fonts.size >= 128) throw Error('Artemis text font budget exceeded');
      font = this.fontOwner.load(path, size, styleBits);
      this.fonts.set(key, font);
      font.catch(() => {
        if (this.fonts.get(key) === font) this.fonts.delete(key);
      });
    }
    return font;
  }
  private trim(): void {
    while (this.glyphs.size > 512 || this.cachedBytes > 10 * 1024 * 1024) {
      const [key, entry] = this.glyphs.entries().next().value!;
      this.glyphs.delete(key);
      this.cachedBytes -= entry.bytes;
    }
  }
  private assertOpen(): void {
    if (this.closed) throw Error('Artemis text glyphs closed');
  }
  async close(): Promise<void> {
    if (this.closed) return;
    this.closed = true;
    this.glyphs.clear();
    this.cachedBytes = 0;
    const fonts = [...this.fonts.values()];
    this.fonts.clear();
    const results = await Promise.allSettled(
      fonts.map(async (promise) => {
        let font: ArtemisFileFont;
        try {
          font = await promise;
        } catch {
          return;
        }
        await font.close();
      }),
    );
    const failure = results.find((result) => result.status === 'rejected');
    if (failure?.status === 'rejected') throw failure.reason;
  }
}
