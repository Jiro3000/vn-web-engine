import type {ArtemisShaderSample} from './raster-shader.js';
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
