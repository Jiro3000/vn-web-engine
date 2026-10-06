import type {BlendState} from '../../graphics/blend.js';
import type {ArtemisFloatTrig} from './display-object.js';
import {artemisRevision} from './revision.js';

export interface ArtemisRasterPolicy {
  readonly filter: 'nearest' | 'linear';
  readonly blend: BlendState;
  readonly trig?: ArtemisFloatTrig;
  readonly discardTransparent?: boolean;
  readonly clearColor?: readonly [number, number, number, number];
}

/** Exact revision's ordinary mode-0 D3D11 image path, with single-level surfaces.
 * 15f1d0 sampler, 15fd30 binding, 15d120 blend descriptor, shader table 349f50[0].
 * Other blend modes, custom shaders, transition textures and mip chains require owners.
 */
export function createArtemisOrdinaryGpuRaster(
  executableSha256: string,
  trig?: ArtemisFloatTrig,
): ArtemisRasterPolicy {
  artemisRevision(executableSha256);
  return {
    filter: 'linear',
    blend: {
      color: {source: 'source-alpha', destination: 'inverse-source-alpha', operation: 'add'},
      alpha: {source: 'source-alpha', destination: 'one', operation: 'add'},
    },
    discardTransparent: false,
    clearColor: [0, 0, 0, 0],
    trig,
  };
}
