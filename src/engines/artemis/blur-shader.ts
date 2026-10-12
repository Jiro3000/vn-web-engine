import type {ArtemisShaderSample} from './raster-shader.js';
export interface ArtemisDiagonalBlurUniforms {
  readonly alpha: number;
  readonly offset: number;
  readonly size: number;
}

export type ArtemisOffsetBlurKind = 'blur_diag' | 'blur_pair_h' | 'blur_pair_v';
/** Offset samples; the native source retains the center sample's alpha. */
export function artemisDiagonalBlurShade(
  sample: ArtemisShaderSample,
  u: number,
  v: number,
  p: ArtemisDiagonalBlurUniforms,
  kind: ArtemisOffsetBlurKind = 'blur_diag',
): readonly [number, number, number, number] {
  if (![u, v, p.alpha, p.offset, p.size].every(Number.isFinite))
    throw Error('Invalid Artemis diagonal blur uniforms');
  const distance = Math.fround(Math.fround(p.offset) * Math.fround(p.size));
  const center = sample(Math.fround(u), Math.fround(v));
  const color = [0, 0, 0, Math.fround(center[3])];
  const offsets: readonly (readonly [number, number])[] =
    kind === 'blur_diag'
      ? [
          [1, 1],
          [-1, 1],
          [-1, -1],
          [1, -1],
        ]
      : kind === 'blur_pair_h'
        ? [
            [1, 0],
            [-1, 0],
          ]
        : [
            [0, 1],
            [0, -1],
          ];
  const weight = kind === 'blur_diag' ? 0.25 : 0.5;
  for (const [sx, sy] of offsets) {
    const pixel = sample(
      Math.fround(Math.fround(u) + Math.fround(sx * distance)),
      Math.fround(Math.fround(v) + Math.fround(sy * distance)),
    );
    for (let i = 0; i < 4; i++)
      color[i] = Math.fround(color[i]! + Math.fround(Math.fround(pixel[i]!) * weight));
  }
  color[3] = Math.fround(color[3]! * Math.fround(p.alpha));
  return color as [number, number, number, number];
}
export function artemisOffsetBlurFragmentSource(kind: ArtemisOffsetBlurKind): string {
  const samples =
    kind === 'blur_diag'
      ? ['d,d', '-d,d', '-d,-d', 'd,-d']
      : kind === 'blur_pair_h'
        ? ['d,0.0', '-d,0.0']
        : ['0.0,d', '0.0,-d'];
  return `#version 300 es
precision highp float;
in vec2 vUv;
uniform sampler2D uFore;
uniform float uAlpha;
uniform float uOffset;
uniform float uSize;
out vec4 outColor;
void main(){
 vec4 c=texture(uFore,vUv);c.rgb=vec3(0.0);
 float d=uOffset*uSize;
 ${samples.map((uv) => `c+=texture(uFore,vUv+vec2(${uv}))*${kind === 'blur_diag' ? '0.25' : '0.5'};`).join('\n ')}
 c.a*=uAlpha;outColor=c;
}`;
}
export const ARTEMIS_DIAGONAL_BLUR_FRAGMENT_SOURCE = artemisOffsetBlurFragmentSource('blur_diag');
export type ArtemisBlurKind = 'blur_h' | 'blur_v';
export interface ArtemisBlurUniforms {
  readonly alpha: number;
  readonly weights: readonly number[];
  readonly step: number;
}
const f = Math.fround;
/** Fifteen taps in native accumulation order; step is a UV offset, not pixel size. */
export function artemisBlurShade(
  kind: ArtemisBlurKind,
  sample: ArtemisShaderSample,
  u: number,
  v: number,
  p: ArtemisBlurUniforms,
): readonly [number, number, number, number] {
  if (p.weights.length !== 8 || ![u, v, p.alpha, p.step, ...p.weights].every(Number.isFinite))
    throw Error('Invalid Artemis blur uniforms');
  const c = sample(u, v).map((x) => f(f(x) * f(p.weights[0]!))) as [number, number, number, number];
  for (let i = 1; i < 8; i++)
    for (const sign of [1, -1]) {
      const d = f(f(p.step) * f(i * sign)),
        pixel = sample(kind === 'blur_h' ? f(f(u) + d) : u, kind === 'blur_v' ? f(f(v) + d) : v);
      for (let ch = 0; ch < 4; ch++) c[ch] = f(c[ch]! + f(f(pixel[ch]!) * f(p.weights[i]!)));
    }
  c[3] = f(c[3] * f(p.alpha));
  return c;
}
export function artemisBlurFragmentSource(kind: ArtemisBlurKind): string {
  return `#version 300 es
precision highp float;
in vec2 vUv;
uniform sampler2D uFore;
uniform float uAlpha;
uniform float uWeights[8];
uniform float uStep;
out vec4 outColor;
void main() {
 vec4 c = texture(uFore,vUv)*uWeights[0];
 for(int i=1;i<8;i++) {
   vec2 d = ${kind === 'blur_h' ? 'vec2(uStep * float(i),0.0)' : 'vec2(0.0,uStep * float(i))'};
   c += texture(uFore,vUv+d)*uWeights[i];
   c += texture(uFore,vUv-d)*uWeights[i];
 }
 c.a *= uAlpha; outColor=c;
}`;
}
