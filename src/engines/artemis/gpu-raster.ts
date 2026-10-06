import type {BlendState} from '../../graphics/blend.js';
import type {ArtemisFloatTrig} from './display-object.js';
import {artemisRevision} from './revision.js';
import type {ArtemisLayerMode} from './layer-properties.js';

export interface ArtemisRasterPolicy {
  readonly filter: 'nearest' | 'linear';
  readonly blend: BlendState;
  readonly trig?: ArtemisFloatTrig;
  readonly discardTransparent?: boolean;
  readonly clearColor?: readonly [number, number, number, number];
  /** Ordinary foreground-only mode shader/blend selection; no captured back texture. */
  readonly layerMode?: (mode: ArtemisLayerMode) => {blend: BlendState; fragment?: string};
}

/** Exact revision's ordinary D3D11 image modes, with single-level surfaces.
 * 15f1d0 sampler, 15fd30 binding, 15d120 blending, shader table 349f50[0,24,48].
 * Captured-back shaders, custom shaders, transition textures and mip chains require owners.
 */
export function createArtemisOrdinaryGpuRaster(
  executableSha256: string,
  trig?: ArtemisFloatTrig,
): ArtemisRasterPolicy {
  artemisRevision(executableSha256);
  const layerMode: NonNullable<ArtemisRasterPolicy['layerMode']> = (mode) => {
    const alpha: BlendState['alpha'] = {
      source: 'source-alpha',
      destination: 'one',
      operation: 'add',
    };
    switch (mode) {
      case 'normal':
        return {
          blend: {
            color: {source: 'source-alpha', destination: 'inverse-source-alpha', operation: 'add'},
            alpha,
          },
        };
      case 'add':
        return {
          blend: {color: {source: 'source-alpha', destination: 'one', operation: 'add'}, alpha},
        };
      case 'screen':
        return {
          blend: {
            color: {source: 'inverse-destination-color', destination: 'one', operation: 'add'},
            alpha,
          },
          fragment:
            'vec4 shade(vec4 sampleColor,vec4 tint){vec4 s=sampleColor*tint;return vec4(s.rgb*s.a,0.0);}',
        };
      case 'multiply':
        return {
          blend: {color: {source: 'zero', destination: 'source-color', operation: 'add'}, alpha},
          fragment:
            'vec4 shade(vec4 sampleColor,vec4 tint){vec4 s=sampleColor*tint;return vec4(s.rgb+(vec3(1.0)-s.rgb)*(1.0-s.a),1.0);}',
        };
      default:
        throw new Error('Unsupported Artemis layer mode');
    }
  };
  return {
    filter: 'linear',
    blend: {
      color: {source: 'source-alpha', destination: 'inverse-source-alpha', operation: 'add'},
      alpha: {source: 'source-alpha', destination: 'one', operation: 'add'},
    },
    discardTransparent: false,
    clearColor: [0, 0, 0, 0],
    trig,
    layerMode,
  };
}
