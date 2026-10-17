import type {ArtemisVariables} from './variables.js';

export const ARTEMIS_2601_EXECUTABLE_SHA256 =
  '38feda70823430350ae58086225ac4a983ab727bd68b4800c4bbeed285ea0123';
export const ARTEMIS_2868_EXECUTABLE_SHA256 =
  'e551146298aa98987b5965964610c909ae8f2c06ab3ac536a733b4bc1e9bbcde';
export const ARTEMIS_2898_EXECUTABLE_SHA256 =
  'd20ffaa064efa01eeccf4e315de99a419492e5fe7a8e44bc1a0eb22fc719883e';
export const ARTEMIS_2908_EXECUTABLE_SHA256 =
  'ae16f3c762a036855edc3099cd96156b80f82546cf5686464179b1f8fafc96e4';
/** Root wrapper containing the statically identified Rev.3083 PE32 engine.
 * Embedded PE SHA-256: abbaf6524cdaf7ac4c4c5ac50af63a74c6a4f5b22d5a4336f95ab5d85c863a87. */
export const ARTEMIS_3083_EXECUTABLE_SHA256 =
  '1249dc214c68e781ad57bf99126986d37892280342961f6dc898eee72f9bba51';
export const ARTEMIS_3179_EXECUTABLE_SHA256 =
  '8953562b80608046662bd8c89015d04236b0ba3afee10c36469c11403de3ebaf';
export const ARTEMIS_3139_EXECUTABLE_SHA256 =
  '455676b09503309b82dc78d7bac45d2eeb1837bed9ec0ab41053d7d9bb298f9e';
/** A second Rev.3139 executable: its .text, .rdata, .data, .pdata, second .text and _RDATA
 * sections and the PE timestamp are byte-identical to ARTEMIS_3139_EXECUTABLE_SHA256; only
 * .rsrc (and the header fields that size it) differ. Every Rev.3139 address applies. */
export const ARTEMIS_3139_RESOURCE_VARIANT_SHA256 =
  '852e457db9b3d84def9a892a1a93ea752152207f36106889229c50098068da43';
/** Rev.3257 is a recompiled engine, not a resource-only variant of an older build. */
export const ARTEMIS_3257_EXECUTABLE_SHA256 =
  '7c604c92b434cbee3620dcf4af8dde40d9313d04cefa794d168b03477135a08a';
/** Wrapped resource variant. Its embedded PE at 0x7e000 has byte-identical code,
 * constants, data and unwind sections to the original Rev.3257; only .rsrc differs. */
export const ARTEMIS_3257_WRAPPED_RESOURCE_VARIANT_SHA256 =
  '116507c5967b82f7816b69aeeb1553b47f2bfd2b91aac6dc02eb9371497d0c66';

export interface ArtemisRevision {
  readonly executableSha256: string;
  readonly engineVersion: number;
  readonly buildDate: string;
  readonly minimumSupportVersion: number;
  readonly saveDataVersion: number;
  /** Native boot publication, independently checked for each exact hash. */
  readonly llp64: boolean;
  readonly publishesGraphicsFeatureLevel: boolean;
  /** Proven absent boot fields whose literal queries create native integer zero. */
  readonly absentSystemVariables: readonly string[];
  /** Names explicitly deleted by native boot, including any restored value. */
  readonly bootDeletedSystemVariables?: readonly string[];
  /** Native actor parser accepts custom shader names/constants (absent in Rev.2601). */
  readonly shaderProperties: boolean;
  /** Native actor-property parser accepts shadertexture paths (absent in Rev.2868/2898/2908). */
  readonly shaderTextureProperties: boolean;
  readonly shaderConstantBinding: 'named-effect' | 'ordered-buffer';
  readonly graphicsApi: 'd3d9' | 'd3d11';
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
  /** Confirmed first-page libogg sync boundary; null keeps the prior strict decoder
   * until that revision's header-search operation is investigated. */
  readonly vorbisHeaderSyncBoundary: number | null;
  /** Rev.3257's indentation mutation tag and nesting query. */
  readonly indentModify: boolean;
  /** Provider size argument: older callers narrow to uint8; Rev.3257 passes all 32 bits. */
  readonly fontSizeBits: 8 | 32;
  /** Glyph result ABI: older PE32 profiles return clipped cells; PE64 preserves bearings/advance. */
  readonly glyphGeometry: 'clipped-cell' | 'bearing-advance';
  /** Painted-glyph index key layout; null where restore has not been reconstructed. */
  readonly fontCacheKey: 'packed' | 'expanded' | 'expanded-metrics' | null;
  /** Temporary scenario replay hold and application exit; Rev.3257 inserted a mode. */
  readonly loadRunMode: 13 | 14;
  readonly exitRunMode: 14 | 15;
  /** Exit queries and publishes fullscreen state; absent in the exact Rev.2898 build. */
  readonly publishesFullscreenAtExit: boolean;
}
// Rev.3139 0x1400c36f0 publishes the same support and save data versions.
const rev3139 = {
  executableSha256: ARTEMIS_3139_EXECUTABLE_SHA256,
  engineVersion: 3139,
  buildDate: 'Wed Aug 30 19:57:57 2023',
  minimumSupportVersion: 1103,
  saveDataVersion: 1003,
  llp64: true,
  publishesGraphicsFeatureLevel: true,
  absentSystemVariables: Object.freeze([] as string[]),
  shaderProperties: true,
  shaderTextureProperties: true,
  shaderConstantBinding: 'ordered-buffer' as const,
  graphicsApi: 'd3d11' as const,
  screenshot: 'presented' as const,
  soundLoaderRewinds: false,
  vorbisHeaderSyncBoundary: null,
  indentModify: false,
  fontSizeBits: 8 as const,
  glyphGeometry: 'bearing-advance' as const,
  fontCacheKey: null,
  loadRunMode: 13 as const,
  exitRunMode: 14 as const,
  publishesFullscreenAtExit: true,
};
const rev3257: ArtemisRevision = {
  executableSha256: ARTEMIS_3257_EXECUTABLE_SHA256,
  engineVersion: 3257,
  glyphGeometry: 'bearing-advance',
  fontCacheKey: 'expanded-metrics',
  indentModify: true,
  fontSizeBits: 32,
  loadRunMode: 14,
  exitRunMode: 15,
  publishesFullscreenAtExit: true,
  buildDate: 'Thu Apr 17 21:58:09 2025',
  minimumSupportVersion: 1103,
  saveDataVersion: 1003,
  llp64: true,
  publishesGraphicsFeatureLevel: true,
  absentSystemVariables: Object.freeze([] as string[]),
  shaderProperties: true,
  shaderTextureProperties: true,
  shaderConstantBinding: 'ordered-buffer',
  graphicsApi: 'd3d11',
  // 0x1400ee300 renders the scene; 0x140197120/0x140197010 rewind sound inputs.
  screenshot: 'scene',
  soundLoaderRewinds: true,
  vorbisHeaderSyncBoundary: null,
};
const revisions: ReadonlyMap<string, ArtemisRevision> = new Map(
  [
    {
      executableSha256: ARTEMIS_2601_EXECUTABLE_SHA256,
      // PE32 boot 0x493520; native writer 0x504a40 emits version 1002.
      engineVersion: 2601,
      buildDate: 'Thu May  9 03:14:56 2019',
      minimumSupportVersion: 1103,
      saveDataVersion: 1002,
      llp64: false,
      publishesGraphicsFeatureLevel: false,
      absentSystemVariables: Object.freeze(['s.llp64', 's.windowsfeaturelevel']),
      // Complete property parser 0x4e1b70 ends at visible, without shader keys.
      shaderProperties: false,
      shaderTextureProperties: false,
      shaderConstantBinding: 'named-effect' as const,
      graphicsApi: 'd3d9' as const,
      // 0x4854a0 -> renderer +0x24 / 0x522370 copies the existing GPU target.
      screenshot: 'presented' as const,
      soundLoaderRewinds: false,
      vorbisHeaderSyncBoundary: null,
      indentModify: false,
      fontSizeBits: 8 as const,
      glyphGeometry: 'clipped-cell' as const,
      fontCacheKey: 'packed' as const,
      // Replay 0x5061a0 holds 13; return/exit 0x496d40/0x496d60 enter 14.
      loadRunMode: 13 as const,
      exitRunMode: 14 as const,
      publishesFullscreenAtExit: false,
    },
    {
      executableSha256: ARTEMIS_2868_EXECUTABLE_SHA256,
      // Independent PE32 boot 0x539360, before the Rev.2898 build.
      engineVersion: 2868,
      buildDate: 'Sun May 2 21:34:14 2021',
      minimumSupportVersion: 1103,
      saveDataVersion: 1003,
      llp64: false,
      publishesGraphicsFeatureLevel: false,
      absentSystemVariables: Object.freeze(['s.llp64', 's.windowsfeaturelevel']),
      // 0x58ca90 ends after shaderconstant; no texture-path property setter.
      shaderProperties: true,
      shaderTextureProperties: false,
      shaderConstantBinding: 'named-effect' as const,
      graphicsApi: 'd3d9' as const,
      // 0x5588b0 -> renderer +0x24 / 0x5d0200 copies the presented target.
      screenshot: 'presented' as const,
      // 0x5f7e70 / 0x5f7f40 reuse the opened file for successive loaders.
      soundLoaderRewinds: false,
      // 0x603b80 -> 0x501250 -> 0x500fa0 -> 0x4fff20 -> 0x4ffb50.
      vorbisHeaderSyncBoundary: 65536,
      indentModify: false,
      // 0x5d64e0 takes a byte; glyph 0x5d6a10 returns a clipped cell.
      fontSizeBits: 8 as const,
      glyphGeometry: 'clipped-cell' as const,
      // 0x4a6280 restores the expanded painted-glyph index.
      fontCacheKey: 'expanded' as const,
      // 0x5b3020 holds 13; 0x53b8b0 / 0x53dd40 exit in 14 without fullscreen.
      loadRunMode: 13 as const,
      exitRunMode: 14 as const,
      publishesFullscreenAtExit: false,
    },
    {
      executableSha256: ARTEMIS_2898_EXECUTABLE_SHA256,
      engineVersion: 2898,
      buildDate: 'Sat Aug 7 22:21:32 2021',
      minimumSupportVersion: 1103,
      saveDataVersion: 1003,
      // 0x539360 publishes neither field. 0x5ca1a0 creates an integer-zero
      // expression leaf for an absent name; this is not a boot initializer.
      llp64: false,
      publishesGraphicsFeatureLevel: false,
      absentSystemVariables: Object.freeze(['s.llp64', 's.windowsfeaturelevel']),
      // 0x58cc90 ends after shaderconstant; no texture-path property setter.
      shaderProperties: true,
      shaderTextureProperties: false,
      shaderConstantBinding: 'named-effect' as const,
      graphicsApi: 'd3d9' as const,
      // 0x558900 -> renderer 0x5d0db0 reads the existing GPU buffer. Sound
      // loaders 0x5f8ab0/0x5f89e0 reuse the opened file without a rewind.
      screenshot: 'presented' as const,
      soundLoaderRewinds: false,
      vorbisHeaderSyncBoundary: 65536,
      indentModify: false,
      fontSizeBits: 8 as const,
      glyphGeometry: 'clipped-cell' as const,
      fontCacheKey: 'expanded' as const,
      // 0x5b4bb4 pushes 13 before replay; 0x53dd40 enters 14 for exit.
      loadRunMode: 13 as const,
      exitRunMode: 14 as const,
      publishesFullscreenAtExit: false,
    },
    {
      executableSha256: ARTEMIS_2908_EXECUTABLE_SHA256,
      // Independent PE32 boot 0x53a650, not a resource alias of Rev.2898.
      engineVersion: 2908,
      buildDate: 'Tue Aug 24 23:19:23 2021',
      minimumSupportVersion: 1103,
      saveDataVersion: 1003,
      llp64: false,
      publishesGraphicsFeatureLevel: false,
      absentSystemVariables: Object.freeze(['s.llp64', 's.windowsfeaturelevel']),
      // Complete 0x58ea00 reads shader/constant, without shadertexture.
      shaderProperties: true,
      shaderTextureProperties: false,
      shaderConstantBinding: 'named-effect' as const,
      graphicsApi: 'd3d9' as const,
      // 0x55a080 -> 0x5d0de0 copies the presented GPU buffer.
      screenshot: 'presented' as const,
      // 0x5f8990 / 0x5f88c0 retry the opened file without a seek.
      soundLoaderRewinds: false,
      // 0x6044b0 -> 0x5012b0 -> 0x501000 -> 0x4fff80 -> 0x4ffbb0.
      vorbisHeaderSyncBoundary: 65536,
      indentModify: false,
      // 0x5d70c0 takes byte size; 0x5d75f0 returns clipped cells.
      fontSizeBits: 8 as const,
      glyphGeometry: 'clipped-cell' as const,
      // 0x4a6280 restores the expanded key and inclusive clip edges.
      fontCacheKey: 'expanded' as const,
      // Replay 0x5b67e4 pushes 13; 0x53f040 exits in 14.
      loadRunMode: 13 as const,
      exitRunMode: 14 as const,
      publishesFullscreenAtExit: false,
    },
    {
      executableSha256: ARTEMIS_3083_EXECUTABLE_SHA256,
      engineVersion: 3083,
      buildDate: 'Thu Oct 6 02:52:54 2022',
      minimumSupportVersion: 1103,
      saveDataVersion: 1003,
      // PE32 DX9 boot 0x552cb0 deletes these names through variable virtual +0x18.
      llp64: false,
      publishesGraphicsFeatureLevel: false,
      absentSystemVariables: Object.freeze(['s.llp64', 's.windowsfeaturelevel']),
      bootDeletedSystemVariables: Object.freeze(['s.llp64', 's.windowsfeaturelevel']),
      shaderProperties: true,
      shaderTextureProperties: true,
      shaderConstantBinding: 'named-effect' as const,
      graphicsApi: 'd3d9' as const,
      screenshot: 'presented' as const,
      soundLoaderRewinds: false,
      vorbisHeaderSyncBoundary: 65536,
      indentModify: false,
      fontSizeBits: 8 as const,
      glyphGeometry: 'clipped-cell' as const,
      fontCacheKey: 'expanded' as const,
      loadRunMode: 13 as const,
      exitRunMode: 14 as const,
      publishesFullscreenAtExit: true,
    },
    {
      executableSha256: ARTEMIS_3179_EXECUTABLE_SHA256,
      engineVersion: 3179,
      glyphGeometry: 'bearing-advance' as const,
      fontCacheKey: null,
      indentModify: false,
      fontSizeBits: 8 as const,
      loadRunMode: 13 as const,
      exitRunMode: 14 as const,
      publishesFullscreenAtExit: true,
      buildDate: 'Thu Dec 21 04:26:04 2023',
      minimumSupportVersion: 1103,
      saveDataVersion: 1003,
      llp64: true,
      publishesGraphicsFeatureLevel: true,
      absentSystemVariables: Object.freeze([] as string[]),
      shaderProperties: true,
      shaderTextureProperties: true,
      shaderConstantBinding: 'ordered-buffer' as const,
      graphicsApi: 'd3d11' as const,
      screenshot: 'scene' as const,
      soundLoaderRewinds: true,
      vorbisHeaderSyncBoundary: null,
    },
    rev3139,
    {...rev3139, executableSha256: ARTEMIS_3139_RESOURCE_VARIANT_SHA256},
    rev3257,
    {...rev3257, executableSha256: ARTEMIS_3257_WRAPPED_RESOURCE_VARIANT_SHA256},
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
  if (version.llp64) variables.write('s.llp64', '1');
  for (const key of version.bootDeletedSystemVariables ?? []) variables.delete(key);
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
  if (!artemisRevision(executableSha256).publishesGraphicsFeatureLevel) return;
  const value = readFeatureLevel();
  if (!Number.isInteger(value) || value < 0 || value > 0x7fffffff)
    throw Error('Invalid Artemis graphics feature level');
  variables.write('s.windowsfeaturelevel', String(value));
}
