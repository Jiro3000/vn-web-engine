import {
  hasSignedFile,
  type InstallationProbeFile,
  type InstallationRecognizer,
} from '../../platform/installation-detection.js';

export function siglusDirectory(files: readonly InstallationProbeFile[]): string | undefined {
  const paths = new Set(files.map(({path}) => path.replaceAll('\\', '/').toLowerCase()));
  let nestedDir: string | undefined;
  for (const path of paths) {
    if (!/(^|\/)scene\.pck$/.test(path)) continue;
    const dir = path.slice(0, -'scene.pck'.length);
    if (!paths.has(dir + 'gameexe.dat')) continue;
    if (paths.has(dir + 'siglusengine.exe')) return dir;
    const parent = dir.replace(/[^/]+\/$/, '');
    if (!nestedDir && parent !== dir && paths.has(parent + 'siglusengine.exe')) nestedDir = dir;
  }
  return nestedDir;
}

export const isSiglusInstallation: InstallationRecognizer = (files) => {
  const dir = siglusDirectory(files);
  if (dir === undefined) return Promise.resolve(false);
  return hasSignedFile(
    files.filter(({path}) => path.replaceAll('\\', '/').toLowerCase() === dir + 'scene.pck'),
    /scene\.pck$/i,
    [[92, 0, 0, 0]],
  );
};
