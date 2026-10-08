import {artemisRevision} from './revision.js';
import {artemisShaderFragmentSource, type ArtemisShaderPresetKind} from './raster-shader.js';

interface UniformField {
  readonly name: string;
  readonly glsl: string;
  readonly size: number;
}
export interface ArtemisDrawShaderPreset {
  readonly kind: ArtemisShaderPresetKind;
  /** Shared DrawList shade ABI; actual target compiles/links this executable. */
  readonly fragment: string;
  readonly fields: readonly {readonly name: string; readonly size: number}[];
  readonly needsUserTexture: boolean;
  /** Explicit required values, no inferred defaults or native reflection claim. */
  parameters(values: ReadonlyMap<string, readonly number[]>): Float32Array;
}
/** Adapt reconstructed executables to shared DrawList's atlas/tex/tint/parameters
 * ABI. Per-actor native uniform preparation is a separate caller-owned effect.
 */
export function createArtemisDrawShaderPreset(
  hash: string,
  kind: ArtemisShaderPresetKind,
  userTextureIndex = 0,
): ArtemisDrawShaderPreset {
  artemisRevision(hash);
  if (!Number.isInteger(userTextureIndex) || userTextureIndex < 0 || userTextureIndex > 29)
    throw Error('Invalid Artemis user texture binding');
  const fields: UniformField[] = [];
  const scalar = (name: string, glsl: string) => fields.push({name, glsl, size: 1});
  switch (kind) {
    case 'raster':
      scalar('angle', 'uAngle');
      scalar('inter', 'uInter');
      scalar('size', 'uSize');
      break;
    case 'sepia':
    case 'sepia2':
    case 'rgb':
    case 'cadd':
    case 'cmul':
      scalar('red', 'uRed');
      scalar('green', 'uGreen');
      scalar('blue', 'uBlue');
      break;
    case 'blur_h':
    case 'blur_v':
      fields.push({name: 'weights', glsl: 'uWeights', size: 8});
      scalar(kind === 'blur_h' ? 'width' : 'height', 'uStep');
      break;
    case 'radial':
      scalar('ax', 'uAx');
      scalar('ay', 'uAy');
      scalar('size', 'uSize');
      scalar('fade', 'uFade');
      break;
    case 'mosaic':
      scalar('size', 'uSize');
      scalar('ratio', 'uRatio');
      break;
    case 'add':
    case 'mul':
    case 'compbr':
    case 'compbrc':
    case 'compdk':
    case 'compdkc':
      scalar('param', 'uParam');
      break;
    case 'gray':
    case 'nega':
    case 'reset':
    case 'screen':
      break;
    default:
      throw Error('Unsupported Artemis draw shader kind');
  }
  const needsUserTexture = [
    'screen',
    'add',
    'mul',
    'compbr',
    'compbrc',
    'compdk',
    'compdkc',
  ].includes(kind);
  let index = 0;
  const value = (offset: number) => `parameters[${Math.floor(offset / 4)}].${'xyzw'[offset % 4]}`;
  const declarations = fields
    .map((field) => {
      const values = Array.from({length: field.size}, () => value(index++));
      return field.size === 1
        ? `float ${field.glsl}=${values[0]};`
        : `float ${field.glsl}[${field.size}]=float[${field.size}](${values.join(',')});`;
    })
    .join('\n');
  let source = artemisShaderFragmentSource(kind)
    .replace(/^#version.*\n/, '')
    .replace(/precision highp float;/g, '')
    .replace(/in vec2 vUv;/g, '')
    .replace(/uniform [^;]+;/g, '')
    .replace(/out vec4 outColor;/g, '')
    .replace(
      /texture\(uUser,\s*vUv\)/g,
      `texture(additionalAtlas${userTextureIndex},additionalUV${userTextureIndex})`,
    )
    .replace(/\buFore\b/g, 'atlas')
    .replace(/\bvUv\b/g, 'tex')
    .replace(/\buAlpha\b/g, 'tint.a');
  source = source.replace(
    /void main\(\)\s*\{/,
    `vec4 shade(vec4 sampleColor,vec4 tint){\nvec4 outColor;\n${declarations}`,
  );
  const end = source.lastIndexOf('}');
  source = source.slice(0, end) + 'return outColor;\n' + source.slice(end);
  return {
    kind,
    fragment: source,
    fields: fields.map(({name, size}) => ({name, size})),
    needsUserTexture,
    parameters(values) {
      const result = new Float32Array(32);
      let offset = 0;
      for (const field of fields) {
        const input = values.get(field.name);
        if (
          !input ||
          input.length !== field.size ||
          !input.every((x) => Number.isFinite(Math.fround(x)))
        )
          throw Error(`Missing/invalid Artemis shader constant ${field.name}`);
        result.set(input, offset);
        offset += field.size;
      }
      return result;
    },
  };
}
