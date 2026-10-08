import type {ArtemisVariables} from './variables.js';

export const ARTEMIS_3179_EXECUTABLE_SHA256 =
  '8953562b80608046662bd8c89015d04236b0ba3afee10c36469c11403de3ebaf';

export interface ArtemisRevision {
  readonly executableSha256: string;
  readonly engineVersion: number;
  readonly buildDate: string;
  readonly minimumSupportVersion: number;
  readonly saveDataVersion: number;
}
const revision: ArtemisRevision = Object.freeze({
  executableSha256: ARTEMIS_3179_EXECUTABLE_SHA256,
  engineVersion: 3179,
  buildDate: 'Thu Dec 21 04:26:04 2023',
  minimumSupportVersion: 1103,
  saveDataVersion: 1003,
});

/** Exact executable identity, never a display-name or version-only heuristic. */
export function artemisRevision(executableSha256: string): ArtemisRevision {
  if (executableSha256.toLowerCase() !== ARTEMIS_3179_EXECUTABLE_SHA256)
    throw new Error(`Unsupported Artemis executable ${executableSha256}`);
  return revision;
}

/** Confirmed static subset of 0x1400c37e0; platform paths/capabilities remain host-owned. */
export function initializeArtemisVariables(
  variables: ArtemisVariables,
  executableSha256: string,
): void {
  const version = artemisRevision(executableSha256);
  variables.write('s.engineversion', String(version.engineVersion));
  variables.write('s.builddate', version.buildDate);
  variables.write('s.minimumsupportversion', String(version.minimumSupportVersion));
  variables.write('s.savedataversion', String(version.saveDataVersion));
  variables.write('s.llp64', '1');
  for (const key of [
    'automode',
    'commandskip',
    'controlskip',
    'alreadyread',
    'avoid',
    'windowbutton',
  ])
    variables.write(`s.status.${key}`, '0');
}

/** The platform supplies the resolved Windows version, or null after failed queries.
 * Native 0x140181db0 leaves the zero-initialized major/minor on failure.
 */
export function initializeArtemisWindowsVersion(
  variables: ArtemisVariables,
  readVersion: () => {major: number; minor: number} | null,
): void {
  const version = readVersion() ?? {major: 0, minor: 0};
  for (const component of [version.major, version.minor])
    if (!Number.isInteger(component) || component < 0 || component > 0xffffffff)
      throw new Error('Invalid Artemis Windows version');
  variables.write('s.windowsversion', `${version.major}.${version.minor}`);
}

/** Native 0x1400c37e0 publishes the owner's resolved GameDataPath/SaveDataPath.
 * Resolution and the backing storage namespace belong to the filesystem owner.
 */
export function initializeArtemisResourcePaths(
  variables: ArtemisVariables,
  paths: {readonly dataPath: string | Uint8Array; readonly savePath: string | Uint8Array},
): void {
  variables.write('s.datapath', paths.dataPath);
  variables.write('s.savepath', paths.savePath);
}

/** Native c37e0 queries graphics owner.virtual+a8 and publishes its feature level.
 * The renderer supplies the value; no capability or missing-owner fallback is inferred.
 */
export function initializeArtemisGraphicsFeatureLevel(
  variables: ArtemisVariables,
  executableSha256: string,
  readFeatureLevel: () => number,
): void {
  artemisRevision(executableSha256);
  const value = readFeatureLevel();
  if (!Number.isInteger(value) || value < 0 || value > 0x7fffffff)
    throw Error('Invalid Artemis graphics feature level');
  variables.write('s.windowsfeaturelevel', String(value));
}
