import test from 'node:test';
import assert from 'node:assert/strict';
import {ArtemisFileFonts} from '../dist/engines/artemis/file-fonts.js';
import {
  ARTEMIS_2868_EXECUTABLE_SHA256,
  ARTEMIS_3179_EXECUTABLE_SHA256,
  ARTEMIS_3139_EXECUTABLE_SHA256,
  ARTEMIS_3139_RESOURCE_VARIANT_SHA256,
  ARTEMIS_3257_EXECUTABLE_SHA256,
  ARTEMIS_3257_WRAPPED_RESOURCE_VARIANT_SHA256,
} from '../dist/engines/artemis/revision.js';
import {rectangleFont, createNodeFontWorker} from './freetype-fixtures.mjs';

const legacy = [
  ARTEMIS_2868_EXECUTABLE_SHA256,
  ARTEMIS_3179_EXECUTABLE_SHA256,
  ARTEMIS_3139_EXECUTABLE_SHA256,
  ARTEMIS_3139_RESOURCE_VARIANT_SHA256,
];

for (const hash of [ARTEMIS_3257_EXECUTABLE_SHA256, ARTEMIS_3257_WRAPPED_RESOURCE_VARIANT_SHA256])
  test(`Rev3257 ${hash.slice(0, 8)} preserves a 300-pixel file-font request through real FreeType rasterization`, async () => {
    const worker = await createNodeFontWorker();
    const requests = [];
    const owner = new ArtemisFileFonts(hash, {
      readFontFile: async () => rectangleFont(),
      hasSystemFontFamily: async () => false,
      openFontFace: async (bytes) => {
        const face = await worker.open(bytes);
        return {
          requestSize: (...args) => {
            requests.push(args);
            return face.requestSize(...args);
          },
          rasterize: (...args) => face.rasterize(...args),
          close: () => face.close(),
        };
      },
    });
    try {
      const font = await owner.load('synthetic.ttf', 300);
      assert.deepEqual(requests, [[3, 0, 19200]]);
      assert.equal(font.metrics.size, 300);
      const glyph = await font.glyph(65);
      assert.deepEqual([glyph.width, glyph.height, glyph.advance], [75, 150, 225]);
      await font.close();
    } finally {
      await owner.close();
      worker.close();
    }
  });

test('Legacy file-font hashes keep uint8 sizing and the zero-size refusal', async () => {
  for (const hash of legacy) {
    const requests = [];
    const owner = new ArtemisFileFonts(hash, {
      readFontFile: async () => new Uint8Array([1]),
      hasSystemFontFamily: async () => false,
      openFontFace: async () => ({
        requestSize: async (...args) => {
          requests.push(args);
          return {
            unitsPerEm: 1000,
            yPpem: 44,
            ascender: 1000,
            descender: -1000,
            underlineThickness: 20,
            underlinePosition: -20,
          };
        },
        rasterize: async () => {
          throw Error('Unexpected raster job');
        },
        close: async () => {},
      }),
    });
    try {
      const font = await owner.load('synthetic.ttf', 300);
      assert.deepEqual(requests, [[3, 0, 2816]]);
      assert.equal(font.metrics.size, 44);
      await font.close();
      await assert.rejects(owner.load('synthetic.ttf', 256), /zero/);
    } finally {
      await owner.close();
    }
  }
});

test('Rendered-font names and cached misses use the revision size width', async () => {
  for (const hash of [...legacy, ARTEMIS_3257_EXECUTABLE_SHA256]) {
    const reads = [];
    const owner = new ArtemisFileFonts(hash, {
      readFontFile: async (path) => {
        reads.push(path);
        return null;
      },
      hasSystemFontFamily: async () => false,
      openFontFace: async () => {
        throw Error('Unexpected file-font open');
      },
    });
    try {
      assert.equal(await owner.loadRendered('synthetic', 300), null);
      assert.equal(await owner.loadRendered('synthetic', 556), null);
      const sizes = hash === ARTEMIS_3257_EXECUTABLE_SHA256 ? [300, 556] : [44];
      assert.deepEqual(
        reads,
        sizes.flatMap((size) => [`synthetic_${size}.rft`, `synthetic_${size}.rft.rft`]),
      );
    } finally {
      await owner.close();
    }
  }
});
