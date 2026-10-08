import type {ArtemisShaderSample} from './raster-shader.js';
export type ArtemisColorKind = 'sepia' | 'sepia2' | 'gray';
export interface ArtemisColorUniforms {
  readonly alpha: number;
  readonly red?: number;
  readonly green?: number;
  readonly blue?: number;
}
const f = Math.fround;
/** Reconstructed source semantics; GPU dot/FMA rounding may differ. */
export function artemisColorShade(
  kind: ArtemisColorKind,
  sample: ArtemisShaderSample,
  u: number,
  v: number,
  p: ArtemisColorUniforms,
): readonly [number, number, number, number] {
  if (
    ![u, v, p.alpha, ...(kind === 'gray' ? [] : [p.red, p.green, p.blue])].every(
      (x) => typeof x === 'number' && Number.isFinite(x),
    )
  )
    throw Error('Invalid Artemis color uniforms');
  const c = sample(u, v),
    g = f(f(f(f(c[0]) * f(0.298912)) + f(f(c[1]) * f(0.586611))) + f(f(c[2]) * f(0.114478)));
  return kind === 'gray'
    ? [g, g, g, f(f(c[3]) * f(p.alpha))]
    : [
        kind === 'sepia2' ? f(g + f(p.red!)) : f(g * f(p.red!)),
        f(g * f(p.green!)),
        f(g * f(p.blue!)),
        f(f(c[3]) * f(p.alpha)),
      ];
}
export function artemisColorFragmentSource(kind: ArtemisColorKind): string {
  return `#version 300 es
precision highp float;
in vec2 vUv;
uniform sampler2D uFore;
uniform float uAlpha;
uniform float uRed;
uniform float uGreen;
uniform float uBlue;
out vec4 outColor;
void main() {
  vec4 c = texture(uFore, vUv);
  float g = dot(c.rgb, vec3(.298912, .586611, .114478));
  outColor = vec4(${kind === 'gray' ? 'vec3(g)' : `g ${kind === 'sepia2' ? '+' : '*'} uRed, g * uGreen, g * uBlue`}, c.a * uAlpha);
}`;
}
