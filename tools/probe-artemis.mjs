/** Nonvisual diagnostics of the Artemis runtime over actual memory asset/PCM providers. No
 * native game process, picture output or audio-device output. */
import {createHash} from 'node:crypto';
import {createArtemisShaderFixture} from './artemis-shader-fixture.mjs';
import {createArtemisSurfacePreloadFixture} from './artemis-surface-preload-fixture.mjs';
import {createArtemisGlyphLayoutFixture} from './artemis-glyph-layout-fixture.mjs';
import {createArtemisOfflineSoundFixture} from './artemis-offline-sound-fixture.mjs';
import {createMetadataLayerFixture} from './artemis-metadata-layer-fixture.mjs';
import {openArtemisInstallation} from './artemis-installation.mjs';
import {BrowserWindowsSystemProfileHost} from '../dist/platform/browser-windows-system-profile.js';
import {BrowserWindowsDynamicLibraryHost} from '../dist/platform/windows-dynamic-library.js';
import {packArtemisSaveFile} from '../dist/formats/artemis/save-file.js';
import {readAsfHeader} from '../dist/formats/asf/header.js';
import {ArtemisRuntime} from '../dist/engines/artemis/runtime.js';
import {artemisInteger} from '../dist/engines/artemis/numbers.js';
import {luaText} from '../dist/core/lua51/runtime.js';
if (!process.argv[2]) throw new Error('Usage: node tools/probe-artemis.mjs GAME_DIRECTORY');
const dialogResultArgument = process.argv
  .slice(3)
  .find((value) => value.startsWith('--dialog-result='));
const simulatedDialogResult = dialogResultArgument
  ? Number(dialogResultArgument.split('=')[1])
  : null;
if (simulatedDialogResult !== null && ![0, 1].includes(simulatedDialogResult))
  throw new Error('Probe dialog result must be 0 or 1');
const advanceWaits = process.argv.slice(3).includes('--advance-waits');
const nativeIncludeReporting = process.argv.slice(3).includes('--native-include-reporting');
const nativeCallLuaReporting = process.argv.slice(3).includes('--native-calllua-reporting');
// Diagnostic layer events (--layer-event=id[:type], type defaults to click) and pushed
// keys (--key-push=key, slot 0 edge) at a run mode 3 stop, one per frame in argument order.
// No pointer hit testing is simulated.
const probeInputs = process.argv
  .slice(3)
  .filter((arg) => arg.startsWith('--layer-event=') || arg.startsWith('--key-push='))
  .map((arg) => {
    if (arg.startsWith('--key-push='))
      return {key: artemisInteger(arg.slice('--key-push='.length))};
    const [id, type = 'click'] = arg.slice('--layer-event='.length).split(':');
    return {id, type};
  });
// Diagnostic clicks (--clicks=N) at `@` click-waits: 16 ms frames run until the text
// display completes, then one run mode 1 click is delivered. No pointer position is used.
// The last --clicks argument wins.
const clickArgument = process.argv.slice(3).findLast((arg) => arg.startsWith('--clicks='));
let probeClicks = clickArgument ? artemisInteger(clickArgument.slice('--clicks='.length)) : 0;
// --save-load-at=N: before the Nth delivered click, save a scenario file and load it; the
// loaded state must match the saved one (see the Artemis README).
const saveLoadArgument = process.argv.slice(3).findLast((arg) => arg.startsWith('--save-load-at='));
const saveLoadAt = saveLoadArgument
  ? artemisInteger(saveLoadArgument.slice('--save-load-at='.length))
  : null;
// --auto-choice=PREFIX (repeatable) with --auto-choices=N: once the scripted inputs are used
// up at a run mode 3 stop, pick the first visible layer with an enabled click event whose id
// starts with a prefix (prefix order, then native child order) and deliver rollover, click
// and key push 1, at most N times. A diagnostic route policy, not player input.
const autoChoicePrefixes = process.argv
  .slice(3)
  .filter((arg) => arg.startsWith('--auto-choice='))
  .map((arg) => arg.slice('--auto-choice='.length));
const autoChoicesArgument = process.argv
  .slice(3)
  .findLast((arg) => arg.startsWith('--auto-choices='));
let autoChoices = autoChoicesArgument
  ? artemisInteger(autoChoicesArgument.slice('--auto-choices='.length))
  : 0;
const autoChoiceLog = [];
const shaderPresets = process.argv.slice(3).includes('--shader-presets');
const graphicsFeatureArgument = process.argv
  .slice(3)
  .find((value) => value.startsWith('--graphics-feature-level='));
const simulatedGraphicsFeatureLevel =
  graphicsFeatureArgument === undefined ? null : Number(graphicsFeatureArgument.split('=')[1]);
let resourceResumptions = 0,
  advancedWaits = 0;
const saveFiles = new Map();
const installation = await openArtemisInstallation(process.argv[2]);
let runtime, glyphFixture, surfaceFixture, soundFixture, shaderFixture, layerFixture;
try {
  const events = [],
    nativeTags = [],
    includes = [],
    luaIncludeErrors = [],
    luaCallErrors = [],
    unknownTagReports = [],
    modeEffects = [],
    dialogs = [];
  const executablePaths = [...installation.paths].filter(
    (path) => /\.exe$/i.test(path) && !path.includes('/'),
  );
  if (executablePaths.length !== 1) throw new Error('Probe requires exactly one root executable');
  const executable = await installation.files.read(executablePaths[0]);
  if (executable === null) throw new Error('Missing Artemis executable');
  const executableSha256 = createHash('sha256').update(executable).digest('hex');
  const read = (path) => installation.files.read(path);
  glyphFixture = createArtemisGlyphLayoutFixture(executableSha256, read);
  surfaceFixture = createArtemisSurfacePreloadFixture(executableSha256, read);
  soundFixture = createArtemisOfflineSoundFixture(executableSha256, read);
  if (shaderPresets) shaderFixture = createArtemisShaderFixture(executableSha256, read);
  const systemProfile = new BrowserWindowsSystemProfileHost();
  // SIMULATED device: a fullscreen movie plays for its ASF header duration in probe ticks;
  // no media is decoded or shown. No input arrives while it plays.
  const moviePlayer = {
    end: null,
    get playing() {
      return this.end !== null && runtime.now < this.end;
    },
    async play(request) {
      const bytes = await installation.files.readPlain(request.path);
      if (!bytes) return false;
      const header = readAsfHeader(bytes);
      if (header.duration === null) throw Error('Probe fullscreen movie has no duration');
      this.end = runtime.now + Math.ceil(header.duration);
      modeEffects.push({
        fullscreenVideo: request,
        bytes: bytes.length,
        duration: header.duration,
        simulation: true,
      });
      return true;
    },
    close() {
      this.end = null;
    },
  };
  runtime = await ArtemisRuntime.open({
    executableSha256,
    files: {
      read,
      readPlain: (path) => installation.files.readPlain(path),
      resolvePath: (path) => installation.files.resolvePath(path),
      setMagicPath: (name, root) => installation.files.setMagicPath(name, root),
      paths: installation.paths,
    },
    // SIMULATED storage: files written during this probe run stay in memory.
    storage: {
      read: async (name) => saveFiles.get(name) ?? null,
      write: (name, bytes) => void saveFiles.set(name, bytes),
    },
    // SIMULATED seed: a fixed Unix time keeps probe runs deterministic.
    randomSeed: 1733961600,
    createLayers: (host) =>
      (layerFixture = createMetadataLayerFixture(executableSha256, read, host)),
    glyphs: glyphFixture,
    surfaces: surfaceFixture.manager,
    sound: soundFixture,
    ...(shaderFixture ? {shaders: shaderFixture} : {}),
    moviePlayer,
    dialogs: {
      present: (request, complete) => {
        dialogs.push(request);
        if (simulatedDialogResult !== null) complete({result: simulatedDialogResult});
      },
    },
    window: {
      minimized: () => false,
      show: (command) => modeEffects.push({windowShow: command, simulation: true}),
      toggleFullscreen: () => modeEffects.push({toggleFullscreen: true, simulation: true}),
      displayModeChanged: () => modeEffects.push({displayModeChanged: true, simulation: true}),
    },
    caption: {
      setCaption: (title) => {
        modeEffects.push({windowCaption: title, simulation: true});
        return true;
      },
    },
    cursor: {
      setVisible: (visible) => modeEffects.push({cursorVisible: visible}),
      setPosition: (left, top) => modeEffects.push({cursorPosition: {left, top}}),
    },
    pointer: {readPointerPosition: () => ({x: 0, y: 0})},
    dynamicLibraries: new BrowserWindowsDynamicLibraryHost(),
    windowsVersion: () => systemProfile.readVersion(),
    ...(simulatedGraphicsFeatureLevel === null
      ? {}
      : {graphicsFeatureLevel: () => simulatedGraphicsFeatureLevel}),
    applyVolumes: (music, effect) => modeEffects.push({volumes: {music, effect}, simulation: true}),
    setLayerByte16c: (name, value) =>
      modeEffects.push({layerByte16c: {name, value}, simulation: true}),
    setTouchLimit: (limit) => modeEffects.push({touchLimit: limit}),
    ...(nativeIncludeReporting
      ? {
          reportIncludeError: (path, error) => {
            const message = error instanceof Error ? error.message : String(error);
            luaIncludeErrors.push({path, message, severity: 1});
            // Preserve explicit host capability/resource guards in this diagnostic.
            if (/Unsupported|not implemented|not prepared|budget|cancelled|requires/i.test(message))
              throw error;
          },
        }
      : {}),
    // Diagnostic record of native c84b0 severity1 reports; no debug console/LogFilter policy.
    ...(nativeCallLuaReporting
      ? {
          reportLuaCallError: ({file, tag, message, severity}) =>
            luaCallErrors.push({
              file,
              sourceLine: tag.sourceLine,
              function: tag.args.get('function'),
              message: new TextDecoder().decode(message),
              severity,
            }),
          // c5800 unknown command/macro report (c7260 severity 1); the tag returns normally.
          reportUnknownTag: ({file, tag, message, severity}) =>
            unknownTagReports.push({
              file,
              sourceLine: tag.sourceLine,
              name: tag.name,
              message: new TextDecoder('shift_jis').decode(message),
              severity,
            }),
        }
      : {}),
    reportError: (message) =>
      luaCallErrors.push({
        engineMethod: true,
        message: new TextDecoder('shift_jis').decode(message),
        severity: 1,
      }),
    trace: {
      tag: (tag) => nativeTags.push({name: tag.name, args: Object.fromEntries(tag.args)}),
      script: (entry) => events.push(entry),
      include: (path) => includes.push(path),
      effect: (effect) => modeEffects.push(effect),
    },
  });
  const {script, wait, lua} = runtime;
  let deliveredClicks = 0,
    saveLoadReport = null,
    captureLoaded = false,
    loadedArchive = null;
  // The round trip compares the state the loader restored, before `onLoad` runs.
  runtime.scenarioLoaded = () => {
    if (captureLoaded) loadedArchive = runtime.scenarioArchive();
  };
  const saveLoadRoundTrip = async () => {
    const hash = (bytes) => createHash('sha256').update(bytes).digest('hex');
    // A caret saved inside a wait loads at the same tag in run mode 0 with its wait flags
    // clear, so the first load changes the caret. Loading the archive of that loaded state
    // must restore it unchanged. Each load then runs the game's `onLoad` handler.
    const loadFile = async (file) => {
      captureLoaded = true;
      loadedArchive = null;
      try {
        if (!(await runtime.load.load(file, true))) throw Error('Probe scenario load failed');
      } finally {
        captureLoaded = false;
      }
      if (!loadedArchive) throw Error('Probe scenario load did not run the scenario loader');
      if (wait.pending || script.state !== 'ready')
        throw Error('Probe scenario load did not resume the restored caret');
      return loadedArchive;
    };
    runtime.save.request('probe-roundtrip.dat', true, true);
    await runtime.flushSaves();
    // After the save, which ran the game's `onSave` handler first.
    const before = runtime.scenarioArchive();
    const expected = runtime.scenarioArchive(true);
    const loaded = await loadFile('probe-roundtrip.dat');
    saveFiles.set('probe-roundtrip-2.dat', await packArtemisSaveFile('S', loaded));
    const reloaded = await loadFile('probe-roundtrip-2.dat');
    saveLoadReport = {
      click: deliveredClicks,
      archiveBytes: before.length,
      saved: hash(before),
      loaded: hash(loaded),
      reloaded: hash(reloaded),
      restored: hash(loaded) === hash(expected),
      stable: hash(loaded) === hash(reloaded),
      runMode: runtime.runMode,
      callDepth: script.callDepth,
      files: ['probe-roundtrip.dat', 'probe-roundtrip-2.dat'],
    };
    if (!saveLoadReport.restored || !saveLoadReport.stable)
      throw Error('Probe scenario save/load round trip differs');
  };
  // Deterministic 16 ms frame.
  const frame = () => runtime.advanceTo((runtime.now + 16) >>> 0 || 1);
  let refusal = null;
  try {
    await runtime.boot();
    let readySlices = 0;
    while (script.state === 'waiting' || script.state === 'ready') {
      if (script.state === 'ready') {
        // A slice that used up its step budget leaves the script ready.
        if (++readySlices >= 10000000) throw Error('Probe script slice budget exceeded');
        script.run(1000);
        continue;
      }
      if (runtime.resourcePending) {
        if (resourceResumptions >= 10000000) throw Error('Probe resource budget exceeded');
        const settled = await runtime.settleResource();
        resourceResumptions++;
        if (settled === 'held') continue;
        // Native loads resources synchronously inside the tag or Lua call; the frame that
        // advances sound and delivers its finish events runs only once the script settles.
        if (!runtime.resourcePending) {
          runtime.advanceTo((runtime.now + 1) >>> 0);
          if (script.state === 'ready') script.run(1000);
        }
        continue;
      }
      if (advanceWaits && runtime.layers.transitionPending && advancedWaits < 1000000) {
        runtime.advanceTo(runtime.layers.finishTransition((runtime.now + 1) >>> 0 || 1));
        advancedWaits++;
        script.run(1000);
        continue;
      }
      if (advanceWaits && runtime.layers.tweenSyncPending && advancedWaits < 1000000) {
        // Deterministic 16 ms frames until the sync tween's completion ends run mode 4.
        for (let count = 0; runtime.layers.tweenSyncPending; count++) {
          if (count >= 100000) throw Error('Probe sync tween did not finish');
          frame();
        }
        advancedWaits++;
        script.run(1000);
        continue;
      }
      if (runtime.runMode === 7) {
        // Deterministic 16 ms frames of run mode 7 until the movie ends.
        for (let count = 0; runtime.runMode === 7; count++) {
          if (count >= 10000000) throw Error('Probe fullscreen video did not finish');
          frame();
          runtime.fullscreenVideo.frame();
        }
        script.run(1000);
        continue;
      }
      if (
        !probeInputs.length &&
        autoChoices > 0 &&
        autoChoicePrefixes.length &&
        runtime.runMode === 3 &&
        !wait.pending
      ) {
        const clickable = runtime.layers.clickableLayers();
        const id = autoChoicePrefixes
          .map((prefix) => clickable.find((candidate) => candidate.startsWith(prefix)))
          .find((candidate) => candidate !== undefined);
        if (id !== undefined) {
          autoChoices--;
          autoChoiceLog.push({id, click: deliveredClicks, tags: nativeTags.length});
          modeEffects.push({autoChoice: id, simulation: true});
          probeInputs.push({id, type: 'rollover'}, {id, type: 'click'}, {key: 1});
        }
      }
      if (probeInputs.length && runtime.runMode === 3 && !wait.pending) {
        const input = probeInputs.shift();
        if (input.id !== undefined) {
          modeEffects.push({layerEvent: input, simulation: true});
          runtime.layerEvent(input.id, input.type);
        } else {
          modeEffects.push({keyPush: input.key, simulation: true});
          runtime.keyPush(input.key);
        }
        script.run(1000);
        continue;
      }
      if (wait.clickPending && probeClicks > 0) {
        for (let count = 0; !runtime.textDisplayComplete; count++) {
          if (count >= 100000) throw Error('Probe click-wait display did not finish');
          frame();
          wait.tick(runtime.now);
        }
        if (saveLoadAt !== null && deliveredClicks === saveLoadAt && !saveLoadReport) {
          // The loaded caret resumes at the tag after the click-wait instead of a click.
          await saveLoadRoundTrip();
          script.run(1000);
          continue;
        }
        deliveredClicks++;
        probeClicks--;
        runtime.now = (runtime.now + 16) >>> 0 || 1;
        modeEffects.push({click: true, simulation: true});
        if (!wait.tick(runtime.now, true)) throw Error('Probe click did not end the click-wait');
        script.run(1000);
        continue;
      }
      if (advanceWaits && wait.scenarioPending && advancedWaits < 1000000) {
        // Deterministic 16 ms frames until the text display completes; no click is simulated.
        for (let count = 0; ; count++) {
          if (count >= 100000) throw Error('Probe scenario wait did not finish');
          frame();
          if (!wait.pending || wait.tick(runtime.now)) break;
        }
        advancedWaits++;
        script.run(1000);
        continue;
      }
      if (advanceWaits && (wait.videoPending || wait.soundPending) && advancedWaits < 1000000) {
        // Deterministic 16 ms frames play the video or se until it stops; no click.
        for (let count = 0; ; count++) {
          if (count >= 100000) throw Error('Probe video/se wait did not finish');
          frame();
          if (!wait.pending || wait.tick(runtime.now)) break;
        }
        advancedWaits++;
        script.run(1000);
        continue;
      }
      if (!advanceWaits || !wait.pending || wait.clickPending || advancedWaits >= 1000000) break;
      // 16 ms frames up to the deadline keep sound and video layers advancing meanwhile.
      const deadline = (wait.deadlineTick + 1) >>> 0;
      while (((deadline - runtime.now) | 0) > 16) frame();
      advancedWaits++;
      runtime.advanceTo(((deadline - runtime.now) | 0) > 0 ? deadline : runtime.now);
      // A sound-finish handler may end the wait during the frames.
      if (wait.pending && !wait.tick(runtime.now)) break;
      script.run(1000);
    }
  } catch (error) {
    refusal = error.message;
    if (process.env.ARTEMIS_PROBE_STACK) console.error(error.stack, error.hostCause?.stack ?? '');
  }
  await runtime.flushSaves();
  try {
    await surfaceFixture.manager.waitForLoads();
  } catch (error) {
    refusal = refusal ? `${refusal}; preload: ${error.message}` : error.message;
  }
  // Exercise the game's actual AST loader independently after the boot boundary.
  // flag=true is its existing load-only path, avoiding image-cache deletion.
  const loader = lua.vm.referenceGlobal('readScriptFile');
  let astLoadedByGame;
  try {
    astLoadedByGame = loader.invoke([new TextEncoder().encode('flow_start'), true])[0];
  } finally {
    loader.release();
  }
  if (astLoadedByGame !== true) throw new Error('Game AST loader did not confirm the source');
  const ast = lua.vm.getGlobal('ast');
  console.log(
    JSON.stringify(
      {
        executableSha256,
        dialogRequests: dialogs,
        saveLoad: saveLoadReport,
        autoChoices: autoChoiceLog,
        saveFiles: Object.fromEntries(
          [...saveFiles].map(([name, bytes]) => [name, {bytes: bytes.length}]),
        ),
        dialogPending: runtime.dialog.pending,
        simulatedDialogResult,
        graphicsFeatureLevel:
          simulatedGraphicsFeatureLevel === null
            ? null
            : {value: simulatedGraphicsFeatureLevel, simulation: true},
        advanceWaits,
        advancedWaits,
        timedWaitPending: wait.pending,
        effectMode: 'record-only',
        metadataLayerFixture: layerFixture.snapshot(),
        fontStackFixture: {
          depth: runtime.fontStack.depth(),
          fontRendering: false,
          simulation: true,
        },
        messageSelectionFixture: {
          current: runtime.messageSelection.currentMessageLayer(),
          depth: runtime.messageSelection.depth,
          presentation: false,
          simulation: true,
        },
        pointerPositionFixture: {x: 0, y: 0, simulation: true},
        resourceResumptions,
        preparedFiles: runtime.prepared.size,
        preparedBytes: runtime.preparedBytes,
        compiled: runtime.compiled,
        nativeIncludeReporting,
        luaIncludeErrors,
        nativeCallLuaReporting,
        luaCallErrors,
        unknownTagReports,
        luaVersion: luaText(lua.vm.getGlobal('_VERSION')),
        state: script.state,
        refusal,
        events,
        nativeTags,
        includes,
        modeEffects,
        glyphLayoutFixture: glyphFixture.summary(),
        surfacePreloadFixture: surfaceFixture.summary(),
        soundDecodeFixture: soundFixture.summary(),
        shaderFixture: shaderFixture?.summary(),
        astLoadedByGame,
        astVersion: lua.vm.getGlobal('astver'),
        astTopLevelKeys: ast.size,
      },
      null,
      2,
    ),
  );
} finally {
  runtime?.close();
  await glyphFixture?.close();
  await surfaceFixture?.close();
  await soundFixture?.close();
  shaderFixture?.close();
  await installation.close();
}
