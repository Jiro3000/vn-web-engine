/** Actual font/glyph/layout resources for nonvisual control-flow diagnostics.
 * No canvas, image encoding, screen output or game-picture decoder is used. */
import {createHash} from 'node:crypto';
import {createNodeBrowserWorker} from './node-browser-worker.mjs';
import {FreeTypeWorker} from '../dist/text/freetype-worker-client.js';
import {ArtemisGlyphPainter} from '../dist/engines/artemis/glyph-paint-client.js';
import {ArtemisFileFonts} from '../dist/engines/artemis/file-fonts.js';
import {ArtemisTextGlyphs} from '../dist/engines/artemis/text-glyphs.js';
import {ArtemisTextInsertion} from '../dist/engines/artemis/text-insertion.js';
import {artemisDefaultFontAttributes} from '../dist/engines/artemis/font-state.js';
export function createArtemisGlyphLayoutFixture(hash, readFont) {
  const fontWorker = new FreeTypeWorker(() =>
      createNodeBrowserWorker(new URL('../dist/text/freetype-worker.js', import.meta.url)),
    ),
    painter = new ArtemisGlyphPainter(hash, () =>
      createNodeBrowserWorker(
        new URL('../dist/engines/artemis/glyph-paint-worker.js', import.meta.url),
      ),
    );
  const openedFonts = [],
    samples = [],
    owners = new Map();
  let rasterJobs = 0;
  const fonts = new ArtemisFileFonts(hash, {
    readFontFile: async (path) => {
      const bytes = await readFont(path);
      if (bytes)
        openedFonts.push({
          path,
          bytes: bytes.length,
          sha256: createHash('sha256').update(bytes).digest('hex'),
        });
      return bytes;
    },
    openFontFace: async (bytes) => {
      const face = await fontWorker.open(bytes);
      return {
        requestSize: (...args) => face.requestSize(...args),
        rasterize: (...args) => {
          rasterJobs++;
          return face.rasterize(...args);
        },
        close: () => face.close(),
      };
    },
  });
  const glyphs = new ArtemisTextGlyphs(hash, fonts, painter);
  const style = (resource) => ({
    ...artemisDefaultFontAttributes(hash),
    ...Object.fromEntries(resource.font),
  });
  const host = (resource) => ({
    loadBlock: async (...args) => {
      const block = await glyphs.load(...args);
      if (samples.length < 128)
        samples.push({
          layer: resource.name,
          mainGlyphs: block.main.length,
          rubyGlyphs: block.ruby.length,
          width: block.width,
          height: block.height,
          paintedSha256: [...block.main, ...block.ruby]
            .filter((g) => g.glyph.surface.image)
            .map((g) => createHash('sha256').update(g.glyph.surface.image.pixels).digest('hex')),
        });
      return block;
    },
    publishFrame: async () => {
      throw Error('Nonvisual glyph fixture cannot publish visual frames');
    },
  });
  const get = (resource) => {
    let owner = owners.get(resource);
    if (!owner) {
      owner = new ArtemisTextInsertion(hash, style(resource), host(resource));
      owners.set(resource, owner);
    }
    owner.setStyle(style(resource));
    owner.setIndentation(
      resource.indentation ?? {pairs: new Map(), range: 0, logicalRange: false, nest: false},
    );
    owner.setWordParts(resource.wordParts ?? new Set());
    owner.setProhibitedCharacters(
      resource.prohibition?.head ?? new Set(),
      resource.prohibition?.foot ?? new Set(),
    );
    return owner;
  };
  return {
    get,
    copy: (old, resource) => {
      const owner = owners.get(old);
      if (owner) owners.set(resource, owner.copy(host(resource)));
    },
    release: (resource) => {
      owners.get(resource)?.close();
      owners.delete(resource);
    },
    summary: () => ({
      glyphLayout: 'actual-workers-nonvisual',
      sceneRendering: false,
      gameVisualAssetsDisplayed: false,
      rasterJobs,
      openedFonts,
      samples,
      layers: [...owners].map(([resource, owner]) => ({
        name: resource.name,
        glyphCount: owner.glyphCount,
        ...owner.measure(),
      })),
    }),
    close: async () => {
      for (const owner of owners.values()) owner.close();
      owners.clear();
      await glyphs.close();
      await fonts.close();
      painter.close();
      fontWorker.close();
    },
  };
}
