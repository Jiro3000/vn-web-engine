/** Known-source executable CPU shader registry. No game pixels are shown/rendered. */
import {compileArtemisRasterPreset} from '../dist/engines/artemis/raster-shader.js';
import {ArtemisShaderLibrary} from '../dist/engines/artemis/shader-library.js';
import {createHash} from 'node:crypto';
export function createArtemisShaderFixture(hash, readFile) {
  const compiled = [];
  const library = new ArtemisShaderLibrary(
    hash,
    readFile,
    {
      compile: async (id, bytes) => {
        const program = await compileArtemisRasterPreset(hash, bytes);
        let disposed = false;
        const shader = {
          kind: program.kind,
          shade: (...args) => {
            if (disposed) throw Error('CPU shader disposed');
            return program.shade(...args);
          },
          dispose: () => {
            disposed = true;
          },
        };
        const calibration = shader.shade((u, v) => [u, v, 0, 1], 0.5, 0.25, {
          alpha: 0.5,
          angle: 0,
          inter: 360,
          size: 0.125,
        });
        compiled.push({
          id,
          kind: program.kind,
          sourceSha256: createHash('sha256').update(bytes).digest('hex'),
          executable: 'actual-CPU-preset',
          calibration: [...calibration],
        });
        return {shader};
      },
      dispose: (shader) => shader.dispose(),
    },
    (tag, reason, error) => {
      throw Error(`Artemis shader ${reason} failure: ${tag.args.get('file') ?? ''} ${error ?? ''}`);
    },
  );
  return {
    dispatch: (tag) => library.dispatch(tag),
    summary: () => ({
      mode: 'known-source-CPU-executable',
      gpuPreparation: false,
      gamePixelsRendered: false,
      compiled,
    }),
    close: () => library.close(),
  };
}
