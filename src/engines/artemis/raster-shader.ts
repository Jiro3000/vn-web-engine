import {
  artemisCompositeShade,
  artemisCompositeFragmentSource,
  type ArtemisCompositeKind,
  type ArtemisCompositeUniforms,
} from './composite-shader.js';
import {artemisMosaicShade, ARTEMIS_MOSAIC_FRAGMENT_SOURCE} from './mosaic-shader.js';
import {artemisRadialShade, ARTEMIS_RADIAL_FRAGMENT_SOURCE} from './radial-shader.js';
import {
  artemisBlurShade,
  artemisBlurFragmentSource,
  type ArtemisBlurKind,
  type ArtemisBlurUniforms,
} from './blur-shader.js';
import {
  artemisColorShade,
  artemisColorFragmentSource,
  type ArtemisColorKind,
  type ArtemisColorUniforms,
} from './color-shader.js';
import {artemisRevision} from './revision.js';
import {ARTEMIS_SCREEN_FRAGMENT_SOURCE, artemisScreenShade} from './screen-shader.js';

export interface ArtemisRasterUniforms {
  readonly alpha: number;
  readonly angle: number;
  readonly inter: number;
  readonly size: number;
}
export type ArtemisShaderSample = (
  u: number,
  v: number,
) => readonly [number, number, number, number];
const f = Math.fround;

/** CPU executable reference for the recognized game raster program. Texture
 * filtering/addressing belongs to the sampler; hardware sin approximations vary.
 */
export function artemisRasterCoordinates(
  u: number,
  v: number,
  p: ArtemisRasterUniforms,
): readonly [number, number] {
  if (![u, v, p.alpha, p.angle, p.inter, p.size].every(Number.isFinite))
    throw Error('Unsupported nonfinite Artemis raster uniform');
  const phase = f(f(f(v) * f(p.inter)) - f(p.angle)),
    radians = f(phase * f(Math.PI / 180));
  return [f(f(u) + f(f(Math.sin(radians)) * f(p.size))), f(v)];
}
export function artemisRasterShade(
  sample: ArtemisShaderSample,
  u: number,
  v: number,
  p: ArtemisRasterUniforms,
): readonly [number, number, number, number] {
  const [x, y] = artemisRasterCoordinates(u, v, p),
    pixel = sample(x, y);
  return [pixel[0], pixel[1], pixel[2], f(f(pixel[3]) * f(p.alpha))];
}

export const ARTEMIS_RASTER_FRAGMENT_SOURCE = `#version 300 es
precision highp float;
in vec2 vUv;
uniform sampler2D uFore;
uniform float uAlpha;
uniform float uAngle;
uniform float uInter;
uniform float uSize;
out vec4 outColor;
void main() {
  vec2 uv = vUv;
  uv.x += sin(radians(uv.y * uInter - uAngle)) * uSize;
  vec4 color = texture(uFore, uv);
  color.a *= uAlpha;
  outColor = color;
}`;

/** Exact input signature selects a reconstructed executable; unknown HLSL is
 * refused rather than registered as compiled. Original shader text is not shipped.
 */
export async function compileArtemisRasterPreset(
  hash: string,
  bytes: Uint8Array,
): Promise<{
  readonly kind: 'raster';
  readonly fragmentSource: string;
  readonly shade: typeof artemisRasterShade;
}> {
  artemisRevision(hash);
  const digest = await crypto.subtle.digest('SHA-256', Uint8Array.from(bytes).buffer),
    signature = [...new Uint8Array(digest)]
      .map((value) => value.toString(16).padStart(2, '0'))
      .join('');
  if (signature !== '56f51f6ef596f287bc75bfe9266ce382a98884b8659267822ca74c1a22e49aba')
    throw Error('Unsupported Artemis custom shader source');
  return {
    kind: 'raster',
    fragmentSource: ARTEMIS_RASTER_FRAGMENT_SOURCE,
    shade: artemisRasterShade,
  };
}

export async function compileArtemisShaderPreset(
  hash: string,
  bytes: Uint8Array,
): Promise<
  | {
      readonly kind: 'raster';
      readonly fragmentSource: string;
      readonly shade: typeof artemisRasterShade;
    }
  | {
      readonly kind: 'screen';
      readonly fragmentSource: string;
      readonly shade: typeof artemisScreenShade;
    }
  | {
      readonly kind: ArtemisColorKind;
      readonly fragmentSource: string;
      readonly shade: (
        sample: ArtemisShaderSample,
        u: number,
        v: number,
        p: ArtemisColorUniforms,
      ) => readonly [number, number, number, number];
    }
  | {
      readonly kind: ArtemisBlurKind;
      readonly fragmentSource: string;
      readonly shade: (
        sample: ArtemisShaderSample,
        u: number,
        v: number,
        p: ArtemisBlurUniforms,
      ) => readonly [number, number, number, number];
    }
  | {
      readonly kind: 'radial';
      readonly fragmentSource: string;
      readonly shade: typeof artemisRadialShade;
    }
  | {
      readonly kind: ArtemisCompositeKind;
      readonly fragmentSource: string;
      readonly shade: (
        fore: ArtemisShaderSample,
        user: ArtemisShaderSample,
        u: number,
        v: number,
        p: ArtemisCompositeUniforms,
      ) => readonly [number, number, number, number];
    }
  | {
      readonly kind: 'mosaic';
      readonly fragmentSource: string;
      readonly shade: typeof artemisMosaicShade;
    }
> {
  artemisRevision(hash);
  const digest = await crypto.subtle.digest('SHA-256', Uint8Array.from(bytes).buffer),
    signature = [...new Uint8Array(digest)]
      .map((value) => value.toString(16).padStart(2, '0'))
      .join('');
  if (signature === '56f51f6ef596f287bc75bfe9266ce382a98884b8659267822ca74c1a22e49aba')
    return {
      kind: 'raster',
      fragmentSource: ARTEMIS_RASTER_FRAGMENT_SOURCE,
      shade: artemisRasterShade,
    };
  if (signature === 'd55bc26b8b72c1f38ff34aa1d41a15a7be69f2351518a8f8a3e99b39f61b59d2')
    return {
      kind: 'screen',
      fragmentSource: ARTEMIS_SCREEN_FRAGMENT_SOURCE,
      shade: artemisScreenShade,
    };
  const colors: Record<string, ArtemisColorKind> = {
    e296e41bbad54c2a5e30e9cdf044aef6482baffa055a9e4dd939dd1ea6f4f748: 'cadd',
    '807fd3b8ef52658c6ee664aa43ccafc61632d3bd1e72810f108cde9edba68254': 'cmul',
    da797c82c78f9c4929262a40c4d6f58a47e4401cd0c048680f81f7450d32997d: 'reset',

    c7c5cebcfb6cacb90e9c7dc22c847ece6f3954b725eb9c565920be1a2a430c0d: 'nega',
    d4204bafc284e3becc3cdcf3a0477c9c34ee4ecfea27abf716229d81132017b0: 'rgb',
    '36c560ed78d7f48b8f04426b45c1cc18c441e0fbcad9967f0809a26e5c391e9b': 'sepia',
    a637849ea00721f8aebdf2a197c33c7198951401bc5530fc89bfa13973b31fc6: 'sepia2',
    '693a8b58386c0b58e7e8cbb9b655ca42d71ce6792db7a6172ad3eac4836c3e1e': 'gray',
  };
  const kind = colors[signature];
  if (kind)
    return {
      kind,
      fragmentSource: artemisColorFragmentSource(kind),
      shade: (sample, u, v, p) => artemisColorShade(kind, sample, u, v, p),
    };
  const blurKind =
    signature === 'd39f149a08d912ab94ab6770fb4fa082a8df78d8e3ad5fef449ffdbad3b6d799'
      ? 'blur_h'
      : signature === '7fc240a2d4ac5f4264661078ab2fa343cd4a17366a859f018941111478a71662'
        ? 'blur_v'
        : null;
  if (blurKind)
    return {
      kind: blurKind,
      fragmentSource: artemisBlurFragmentSource(blurKind),
      shade: (sample, u, v, p) => artemisBlurShade(blurKind, sample, u, v, p),
    };
  if (signature === '33f20c759657d25064c273dcc5f55b6d25de00c49d1fc3b4d21fa307f53c3f96')
    return {
      kind: 'radial',
      fragmentSource: ARTEMIS_RADIAL_FRAGMENT_SOURCE,
      shade: artemisRadialShade,
    };
  const composite: Record<string, ArtemisCompositeKind> = {
    '7f8bdd36691555ba007e13419dc0e1f2bbdc9f161bbdb580879a199049910826': 'add',
    cd766e279e166d58badef0665dc4867d5cdbae12bfda3acaba5e23ef9b509d51: 'mul',
    d9ca93dba80619b4fd24c1e027244de7580f6ce9fb91e400ad11e640a00f5120: 'compbr',
    f7af4d49fab7ace7dacb4b8ca6aea33492384fd13ec9acab0a0264a9de0c8c5f: 'compbrc',
    ba6c993f0416c6e66bafb769c245e26d6f36ed45756a5669f53ff913013176ff: 'compdk',
    ecdc808ce2aeeb243a87f36177bd15c696c3ed3fccfe770bab4273457bd30e59: 'compdkc',
  };
  const comp = composite[signature];
  if (comp)
    return {
      kind: comp,
      fragmentSource: artemisCompositeFragmentSource(comp),
      shade: (fore, user, u, v, p) => artemisCompositeShade(comp, fore, user, u, v, p),
    };
  if (signature === 'faf7e8e1e83551bdfde4c5bc1b3af08cb9d4c9a06fa1b2d8f5b529bb52c94e0d')
    return {
      kind: 'mosaic',
      fragmentSource: ARTEMIS_MOSAIC_FRAGMENT_SOURCE,
      shade: artemisMosaicShade,
    };
  throw Error('Unsupported Artemis custom shader source');
}
