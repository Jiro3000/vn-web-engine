import type {ArtemisVariables} from './variables.js';

export const ARTEMIS_3179_EXECUTABLE_SHA256 =
  '8953562b80608046662bd8c89015d04236b0ba3afee10c36469c11403de3ebaf';
export const ARTEMIS_3139_EXECUTABLE_SHA256 =
  '455676b09503309b82dc78d7bac45d2eeb1837bed9ec0ab41053d7d9bb298f9e';
/** A second Rev.3139 executable: its .text, .rdata, .data, .pdata, second .text and _RDATA
 * sections and the PE timestamp are byte-identical to ARTEMIS_3139_EXECUTABLE_SHA256; only
 * .rsrc (and the header fields that size it) differ. Every Rev.3139 address applies. */
export const ARTEMIS_3139_RESOURCE_VARIANT_SHA256 =
  '852e457db9b3d84def9a892a1a93ea752152207f36106889229c50098068da43';

export interface ArtemisRevision {
  readonly executableSha256: string;
  readonly engineVersion: number;
  readonly buildDate: string;
  readonly minimumSupportVersion: number;
  readonly saveDataVersion: number;
  /** What `takess` puts into the screenshot surface +0x1c0. 'scene': Rev.3179 0x1400e1cf0
   * renders the committed scene offscreen. 'presented': Rev.3139 0x1400e1cf0 copies the
   * frame presented last (renderer virtual +0x48 reads the swap chain buffer) and records
   * the stage margins +0x74/+0x78 as the crop +0x1d0/+0x1d4 that savess applies. */
  readonly screenshot: 'scene' | 'presented';
  /** CSoundLoaders (Rev.3179 0x140190290/0x140190170) seeks the opened file back to 0
   * (file virtual +0x30) before it offers it to a further loader. Rev.3139
   * (0x14018e760/0x14018e650) does not: the next loader continues at the position the
   * failed one left. */
  readonly soundLoaderRewinds: boolean;
}
// Rev.3139 0x1400c36f0 publishes the same support and save data versions.
const rev3139 = {
  executableSha256: ARTEMIS_3139_EXECUTABLE_SHA256,
  engineVersion: 3139,
  buildDate: 'Wed Aug 30 19:57:57 2023',
  minimumSupportVersion: 1103,
  saveDataVersion: 1003,
  screenshot: 'presented' as const,
  soundLoaderRewinds: false,
};
const revisions: ReadonlyMap<string, ArtemisRevision> = new Map(
  [
    {
      executableSha256: ARTEMIS_3179_EXECUTABLE_SHA256,
      engineVersion: 3179,
      buildDate: 'Thu Dec 21 04:26:04 2023',
      minimumSupportVersion: 1103,
      saveDataVersion: 1003,
      screenshot: 'scene' as const,
      soundLoaderRewinds: true,
    },
    rev3139,
    {...rev3139, executableSha256: ARTEMIS_3139_RESOURCE_VARIANT_SHA256},
  ].map((revision) => [revision.executableSha256, Object.freeze(revision)]),
);

/** Exact executable identity, never a display-name or version-only heuristic. Native
 * addresses in this engine name Rev.3179 functions; docs/artemis-revisions.md maps them to
 * the other supported executables. */
export function artemisRevision(executableSha256: string): ArtemisRevision {
  const revision = revisions.get(executableSha256.toLowerCase());
  if (!revision) throw new Error(`Unsupported Artemis executable ${executableSha256}`);
  return revision;
}

/** Confirmed static subset of 0x1400c37e0 (Rev.3139 0x1400c36f0); platform paths/capabilities remain host-owned. */
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
