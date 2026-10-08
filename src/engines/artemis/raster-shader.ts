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
  throw Error('Unsupported Artemis custom shader source');
}
