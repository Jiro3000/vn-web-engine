/** Nonvisual Lua/script diagnostics with optional actual memory asset/PCM providers. No native game process or audio-device output. */
import {createHash} from 'node:crypto';
import {createArtemisShaderFixture} from './artemis-shader-fixture.mjs';
import {createArtemisSurfacePreloadFixture} from './artemis-surface-preload-fixture.mjs';
import {createArtemisGlyphLayoutFixture} from './artemis-glyph-layout-fixture.mjs';
import {createArtemisOfflineSoundFixture} from './artemis-offline-sound-fixture.mjs';
import {createArtemisSoundDecodeFixture} from './artemis-sound-decode-fixture.mjs';
import {ArtemisSoundFinish} from '../dist/engines/artemis/sound-finish.js';
import {ArtemisSePlay} from '../dist/engines/artemis/se-play.js';
import {ArtemisMusic} from '../dist/engines/artemis/music.js';
import {ArtemisSeStop} from '../dist/engines/artemis/se-stop.js';
import {ArtemisPrint} from '../dist/engines/artemis/print.js';
import {ArtemisRuby} from '../dist/engines/artemis/ruby.js';
import {ArtemisTextCommands} from '../dist/engines/artemis/text-commands.js';
import {createMetadataLayerFixture} from './artemis-metadata-layer-fixture.mjs';
import {BrowserWindowsSystemProfileHost} from '../dist/platform/browser-windows-system-profile.js';
import {
  initializeArtemisVariables,
  initializeArtemisGraphicsFeatureLevel,
  initializeArtemisWindowsVersion,
  initializeArtemisResourcePaths,
} from '../dist/engines/artemis/revision.js';
import {openArtemisInstallation} from './artemis-installation.mjs';
import {windowsTextFileBytes} from '../dist/platform/windows-text-file.js';
import {ArtemisLua} from '../dist/engines/artemis/lua.js';
import {ArtemisScript} from '../dist/engines/artemis/script.js';
import {ArtemisVariables} from '../dist/engines/artemis/variables.js';
import {artemisExpressionBytes} from '../dist/engines/artemis/expression.js';
import {ArtemisDialog} from '../dist/engines/artemis/dialog.js';
import {artemisFontProperties} from '../dist/engines/artemis/font-properties.js';
import {
  ArtemisTextBreakControls,
  artemisUtf8Prohibition,
} from '../dist/engines/artemis/text-break-controls.js';
import {ArtemisSceneTweens} from '../dist/engines/artemis/scene-tweens.js';
import {ArtemisFontStack} from '../dist/engines/artemis/font-stack.js';
import {
  ArtemisMessageLayers,
  ArtemisMessageSelection,
} from '../dist/engines/artemis/message-layers.js';
import {ArtemisCaption} from '../dist/engines/artemis/caption.js';
import {ArtemisMouse} from '../dist/engines/artemis/mouse.js';
import {ArtemisSave} from '../dist/engines/artemis/save.js';
import {
  ArtemisReadHistory,
  writeArtemisGlobalArchive,
  writeArtemisSystemArchive,
} from '../dist/engines/artemis/global-save.js';
import {packArtemisSaveFile} from '../dist/formats/artemis/save-file.js';
import {ArtemisClickGlyphs} from '../dist/engines/artemis/click-glyph.js';
import {ArtemisReset} from '../dist/engines/artemis/reset.js';
import {ArtemisTimedWait} from '../dist/engines/artemis/wait.js';
import {ArtemisTextDisplay} from '../dist/engines/artemis/text-display.js';
import {ArtemisTextControls} from '../dist/engines/artemis/text-controls.js';
import {ArtemisKeyBindings} from '../dist/engines/artemis/key-bindings.js';
import {ArtemisEventCommands} from '../dist/engines/artemis/event-commands.js';
import {ArtemisNativeLibrary} from '../dist/engines/artemis/native-library.js';
import {BrowserWindowsDynamicLibraryHost} from '../dist/platform/windows-dynamic-library.js';
import {ArtemisModes} from '../dist/engines/artemis/modes.js';
import {ArtemisExec} from '../dist/engines/artemis/exec.js';
import {ArtemisStop} from '../dist/engines/artemis/stop.js';
import {ArtemisRandom} from '../dist/engines/artemis/random.js';
import {artemisInteger} from '../dist/engines/artemis/numbers.js';
import {createArtemisScriptEvents} from '../dist/engines/artemis/script-events.js';
import {luaText} from '../dist/core/lua51/runtime.js';
import {ArtemisSaveData} from '../dist/engines/artemis/save-data.js';
import {ArtemisFullscreenVideo} from '../dist/engines/artemis/fullscreen-video.js';
import {readAsfHeader} from '../dist/formats/asf/header.js';
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
const suspendableTags = process.argv.slice(3).includes('--async-lua');
const metadataLayers = process.argv.slice(3).includes('--image-metadata');
const glyphLayout = process.argv.slice(3).includes('--glyph-layout');
const surfacePreloads = process.argv.slice(3).includes('--surface-preloads');
const soundDecode = process.argv.slice(3).includes('--sound-decode');
const soundRender = process.argv.slice(3).includes('--sound-render');
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
const shaderPresets = process.argv.slice(3).includes('--shader-presets');
if (shaderPresets && !metadataLayers) throw Error('--shader-presets requires --image-metadata');
const graphicsFeatureArgument = process.argv
  .slice(3)
  .find((value) => value.startsWith('--graphics-feature-level='));
const simulatedGraphicsFeatureLevel =
  graphicsFeatureArgument === undefined ? null : Number(graphicsFeatureArgument.split('=')[1]);
if (soundRender && !soundDecode) throw Error('--sound-render requires --sound-decode');
if (soundDecode && !surfacePreloads) throw Error('--sound-decode requires --surface-preloads');
if (surfacePreloads && !glyphLayout) throw Error('--surface-preloads requires --glyph-layout');
if (glyphLayout && !metadataLayers)
  throw Error('--glyph-layout requires --async-lua --image-metadata');
if (metadataLayers && !suspendableTags) throw Error('--image-metadata requires --async-lua');
let fontStack = null,
  glyphFixture = null,
  surfaceFixture = null,
  soundFixture = null,
  shaderFixture = null,
  sePlay = null,
  ruby = null,
  textCommands = null;
let messageStage = null,
  messageSelection = null;
let layerFixture = null,
  pendingResource = null,
  resourceInFlight = false,
  runModeHeld = false,
  resourceResumptions = 0;
let probeTick = 1,
  advancedWaits = 0;
const saveFiles = new Map(),
  saveWrites = [];
const installation = await openArtemisInstallation(process.argv[2]);
let lua, script;
try {
  const prepared = new Map(),
    plainFiles = new Map();
  let preparedBytes = 0;
  for (const path of installation.paths)
    if (/\.(lua|ast|iet|ipt|asb|tbl|ini)$/.test(path)) {
      const bytes = await installation.files.read(path);
      if (bytes === null) throw new Error(`Missing inventoried source ${path}`);
      preparedBytes += bytes.length;
      if (preparedBytes > 64 * 1024 * 1024)
        throw new Error('Script corpus exceeds probe memory budget');
      prepared.set(path, bytes);
      if (/\.(lua|ast)$/.test(path)) {
        const plain = await installation.files.readPlain(path);
        if (plain !== null) {
          plainFiles.set(path, plain);
          preparedBytes += plain.length;
          if (preparedBytes > 64 * 1024 * 1024)
            throw new Error('Script corpus exceeds probe memory budget');
        }
      }
    }
  const readFile = (path) => {
    path = installation.files.resolvePath(path);
    if (prepared.has(path)) return prepared.get(path);
    if (installation.paths.has(path))
      throw new Error(`Resource is not prepared for synchronous Lua: ${path}`);
    return null;
  };
  const events = [],
    nativeTags = [],
    includes = [],
    luaIncludeErrors = [],
    luaCallErrors = [],
    unknownTagReports = [],
    modeEffects = [];
  // This probe accepts explicit Windows stage dimensions from the real INI;
  // it does not supply defaults or implement the complete native INI loader.
  const iniBytes = await installation.files.read('system.ini');
  if (iniBytes === null) throw new Error('Missing system.ini');
  const ini = new TextDecoder('utf-8', {fatal: true}).decode(iniBytes);
  let section = '',
    width,
    height,
    savePath,
    savePathCsidl,
    bootPath = '';
  for (const sourceLine of ini.split(/\r?\n/)) {
    const line = sourceLine.split(';', 1)[0].trim();
    const header = /^\[([^\]]+)\]$/.exec(line);
    if (header) section = header[1].toUpperCase();
    if (section !== 'WINDOWS') continue;
    const setting = /^(SAVEPATH|SAVEPATH_CSIDL|BOOT)\s*=\s*(.*)$/.exec(line);
    if (setting?.[1] === 'BOOT') bootPath = setting[2];
    if (setting?.[1] === 'SAVEPATH') savePath = setting[2];
    if (setting?.[1] === 'SAVEPATH_CSIDL') savePathCsidl = setting[2];
    const entry = /^(WIDTH|HEIGHT)\s*=\s*(\d+)$/.exec(line);
    if (entry?.[1] === 'WIDTH') width = Number(entry[2]);
    if (entry?.[1] === 'HEIGHT') height = Number(entry[2]);
  }
  if (!width || !height) throw new Error('Probe needs explicit WINDOWS WIDTH and HEIGHT');
  const variables = new ArtemisVariables({
    stageSize: () => ({width, height}),
    windowDisplay: () => ({width, height, fullscreen: false}),
    applicationArguments: {readApplicationArguments: () => new Map()},
    messageLayerMeasure: () => {
      if (!glyphFixture || !messageStage)
        throw Error('Probe message layer measure requires --glyph-layout');
      return glyphFixture.get(messageStage.currentLayer()).measure();
    },
  });
  const executablePaths = [...installation.paths].filter(
    (path) => /\.exe$/i.test(path) && !path.includes('/'),
  );
  if (executablePaths.length !== 1) throw new Error('Probe requires exactly one root executable');
  const executable = await installation.files.read(executablePaths[0]);
  if (executable === null) throw new Error('Missing Artemis executable');
  const executableSha256 = createHash('sha256').update(executable).digest('hex');
  // c37e0 static variables run inside the bf210 boot path, after the save-file loads.
  const initializeStaticVariables = () => {
    initializeArtemisVariables(variables, executableSha256);
    if (simulatedGraphicsFeatureLevel !== null)
      initializeArtemisGraphicsFeatureLevel(
        variables,
        executableSha256,
        () => simulatedGraphicsFeatureLevel,
      );
    // Installation-relative read-only namespace; no Windows known-folder resolution or writes.
    if (savePath !== undefined && savePathCsidl === undefined && /^[\w-]+$/.test(savePath))
      initializeArtemisResourcePaths(variables, {dataPath: '', savePath});
    initializeArtemisWindowsVersion(variables, () => systemProfile.readVersion());
  };
  if (glyphLayout)
    glyphFixture = createArtemisGlyphLayoutFixture(executableSha256, (path) =>
      installation.files.read(path),
    );
  if (surfacePreloads)
    surfaceFixture = createArtemisSurfacePreloadFixture(executableSha256, (path) =>
      installation.files.read(path),
    );
  if (soundDecode)
    soundFixture = soundRender
      ? createArtemisOfflineSoundFixture(executableSha256, (path) => installation.files.read(path))
      : createArtemisSoundDecodeFixture((path) => installation.files.read(path));
  if (shaderPresets)
    shaderFixture = createArtemisShaderFixture(executableSha256, (path) =>
      installation.files.read(path),
    );
  const systemProfile = new BrowserWindowsSystemProfileHost();
  // Slots begin empty; --sound-render supplies actual non-device PCM voices.
  const effectSlots = new Map(),
    saveData = new ArtemisSaveData();
  const seStop = new ArtemisSeStop(executableSha256, {
    effectIndex: (id) => effectSlots.get(id),
    stopEffect:
      soundFixture?.stopEffect ??
      (() => {
        throw Error('Unsupported Artemis diagnostic sound voice owner');
      }),
    hasEffectHistory: (id) => saveData.hasEffect(id),
    deleteEffectHistory: (id) => saveData.deleteEffect(id),
  });
  const soundFinish = soundRender
    ? new ArtemisSoundFinish(executableSha256, {
        currentFile: () => script.currentFile,
        musicIndex: () => music.currentIndex,
        effectIndex: (id) => effectSlots.get(id),
        setEffectFinish: (index, callback) => soundFixture.setFinishCallback(index, callback),
        setMusicFinish: (index, callback) => soundFixture.setMusicFinishCallback(index, callback),
        emit: (command) => {
          modeEffects.push({
            soundFinishCommand: {name: command.name, args: Object.fromEntries(command.args)},
          });
          // f8050 at 0x1400dfe2b/0x1400dff1f: b73e0(script, mode 0, force 1, tag copy).
          scriptEvents.emit(command, 0, true);
        },
      })
    : null;
  const modes = new ArtemisModes({
    writeStatus: (name, value) => (variables.write(name, value), modeEffects.push({name, value})),
    commandSkipChanged: (active) => modeEffects.push({commandSkip: active}),
    controlSkipChanged: (active) => modeEffects.push({controlSkip: active}),
    automodeChanged: (active) => modeEffects.push({automode: active}),
    releaseScheduler: () => modeEffects.push({releaseScheduler: true}),
    currentMessageLayer: () => messageSelection?.currentMessageLayer() ?? '',
  });
  if (soundFixture)
    sePlay = new ArtemisSePlay(executableSha256, {
      debugSkipActive: () => false,
      commandSkipActive: () => modes.skipAllowed && (modes.commandSkip || modes.controlSkip),
      effectIndex: (id) => effectSlots.get(id),
      ...soundFixture,
      setEffectIndex: (id, index) => effectSlots.set(id, index),
      effectGainVariable: (id) => {
        const value = variables.lookup('s.segain.' + id);
        return value === undefined ? undefined : Number(new TextDecoder().decode(value));
      },
      replaceEffectHistory: (id, tag) => saveData.replaceEffect(id, tag),
      effectLoadFailed: () => {
        throw Error('Artemis actual sound load failed');
      },
    });
  // BGM manager script +0x3d60 over the same non-device PCM owner (--sound-render only).
  const music =
    soundFixture?.prepareMusic &&
    new ArtemisMusic(executableSha256, {
      debugSkipActive: () => false,
      ...soundFixture,
      musicLoadFailed: () => {
        throw Error('Artemis actual music load failed');
      },
    });
  const exec = new ArtemisExec(modes, {
    window: {
      minimized: () => false,
      show: (command) => modeEffects.push({windowShow: command, simulation: true}),
      toggleFullscreen: () => modeEffects.push({toggleFullscreen: true, simulation: true}),
    },
    enterRunMode: () => {
      throw Error('Unsupported diagnostic Artemis run mode owner');
    },
    now: () => 0,
    setWaitStart: () => {
      throw Error('Unsupported diagnostic Artemis wait timestamp owner');
    },
    // Matches the simulated hardware feature level; no software renderer fallback.
    softwareRenderer: () => false,
    displayModeChanged: () => modeEffects.push({displayModeChanged: true, simulation: true}),
  });
  const caption = new ArtemisCaption({
    setCaption: (title) => {
      modeEffects.push({windowCaption: title, simulation: true});
      return true;
    },
  });
  const mouse = new ArtemisMouse(
    {
      setVisible: (visible) => modeEffects.push({cursorVisible: visible}),
      setPosition: (left, top) => modeEffects.push({cursorPosition: {left, top}}),
    },
    () => 0,
  );
  const dialogs = [];
  const dialog = new ArtemisDialog(
    {
      present: (request, complete) => {
        dialogs.push(request);
        if (simulatedDialogResult !== null) complete({result: simulatedDialogResult});
      },
    },
    {
      blocked: () => false,
      beginWait: () => script.pause(),
      endWait: () => script.resume(),
      writeVariable: (name, value) => variables.write(name, value),
    },
  );
  const clickGlyphs = new ArtemisClickGlyphs({
    currentMessageLayer: () => messageSelection?.currentMessageLayer() ?? '',
    setLayerByte16c: (name, value) => {
      if (layerFixture?.hasLayer(name))
        modeEffects.push({layerByte16c: {name, value}, simulation: true});
    },
  });
  const readHistory = new ArtemisReadHistory();
  const save = new ArtemisSave(variables, {
    beforeScenario: (file) => lua.events.emit('onSave', new Map([['file', file]])),
    reportEventError: (error) => modeEffects.push({saveEventError: String(error)}),
    writeScenario: () => {
      throw new Error('Artemis scenario save serialization is not implemented');
    },
    // Archives are snapshotted synchronously; SIMULATED storage keeps the packed files in
    // memory and the loop awaits the pending compression.
    writeGlobal: () => {
      const archive = writeArtemisGlobalArchive(readHistory, variables);
      saveWrites.push(
        packArtemisSaveFile('G', archive).then((file) => saveFiles.set('saveg.dat', file)),
      );
    },
    writeSystem: () => {
      const archive = writeArtemisSystemArchive(variables);
      saveWrites.push(
        packArtemisSaveFile('X', archive).then((file) => saveFiles.set('system.dat', file)),
      );
    },
  });
  // Text display owners per message resource. Glyph actors are nonvisual property stores;
  // every logical glyph receives one.
  const textDisplays = new Map(),
    displayActors = new WeakMap();
  const displayActor = (key) => {
    let actor = displayActors.get(key);
    if (!actor) {
      const values = new Map([
        ['left', 0],
        ['top', 0],
        ['alpha', 1],
        ['xscale', 1],
        ['yscale', 1],
        ['rotate', 0],
      ]);
      actor = {
        property: (parameter) => values.get(parameter),
        setProperty: (parameter, value) => values.set(parameter, value),
      };
      displayActors.set(key, actor);
    }
    return actor;
  };
  const textDisplayHost = (resource) => ({
    lines: () => glyphFixture.get(resource).displayBlocks(),
    glyphIndex: (glyph) => glyph.glyphId,
    glyphCount: () => glyphFixture.get(resource).glyphCount,
    glyphActor: displayActor,
    blockActor: displayActor,
  });
  const textDisplay = (resource) => {
    let display = textDisplays.get(resource);
    if (!display) {
      if (!glyphFixture || !layerFixture) throw Error('Probe text display requires --glyph-layout');
      display = new ArtemisTextDisplay(
        executableSha256,
        layerFixture.tweenRegistry,
        textDisplayHost(resource),
      );
      textDisplays.set(resource, display);
    }
    return display;
  };
  const currentTextDisplay = () => {
    const resource = messageStage?.currentLayer();
    if (!resource) throw Error('Probe text display has no current text layer');
    return textDisplay(resource);
  };
  const startTextDisplay = (skip) => {
    const display = currentTextDisplay(),
      before = display.tweens.length;
    // The skip vector +0x3718 is zero-initialized and has no decoded writer.
    display.show(skip ? [] : sceneTweens.snapshot('in'), true);
    modeEffects.push({
      textDisplay: messageSelection.currentMessageLayer(),
      skip,
      tweens: display.tweens.length - before,
      start: display.start,
      simulation: true,
    });
  };
  const wait = new ArtemisTimedWait(modes, save, {
    now: () => probeTick,
    debugSkipActive: () => false,
    startTextDisplay,
    textDisplayComplete: () => currentTextDisplay().complete,
    finishTextDisplay: () => currentTextDisplay().finish(),
    writeClickSkip: () => variables.write('s.clickskip', '1'),
    beginWait: (inputEnabled) => {
      modeEffects.push({wait: {inputEnabled}});
      script.pause();
    },
    endWait: () => {
      modeEffects.push({waitEnd: true});
      script.resume();
    },
    clickWaitEvent: (kind) => {
      try {
        lua.events.emit(kind === 'in' ? 'onClickWaitIn' : 'onClickWaitOut');
      } catch (error) {
        modeEffects.push({waitEventError: String(error)});
      }
    },
    resumeMessageState: () => modeEffects.push({resumeMessageState: true}),
    effectIndex: (id) => effectSlots.get(id),
    effectPlaying: (index) => {
      if (!soundFixture?.effectPlaying) throw Error('Probe se waits require --sound-render');
      return soundFixture.effectPlaying(index);
    },
    videoPlaying: (id) => {
      if (!layerFixture) throw Error('Probe video waits require --image-metadata');
      return layerFixture.videoPlaying(id);
    },
  });
  // Run mode 3 has no click/frame owner in this probe: stop pauses at an input boundary.
  let probeRunMode = 0;
  const stop = new ArtemisStop(modes, save, {
    debugSkipActive: () => false,
    startTextDisplay,
    enterStopMode: () => {
      probeRunMode = 3;
      modeEffects.push({runMode: 3, simulation: true});
      script.pause();
      return true;
    },
  });
  // SIMULATED device: a fullscreen movie plays for its ASF header duration in probe ticks;
  // no media is decoded or shown. No input arrives while it plays.
  let moviePrevious = 0;
  const moviePlayer = {
    end: null,
    get playing() {
      return this.end !== null && probeTick < this.end;
    },
    async play(request) {
      const bytes = await installation.files.readPlain(request.path);
      if (!bytes) return false;
      const header = readAsfHeader(bytes);
      if (header.duration === null) throw Error('Probe fullscreen movie has no duration');
      this.end = probeTick + Math.ceil(header.duration);
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
  const fullscreenVideo = new ArtemisFullscreenVideo(executableSha256, modes, {
    debugSkipActive: () => false,
    videoVolume: () => artemisInteger(new TextDecoder().decode(variables.read('s.videovol'))),
    player: moviePlayer,
    playbackFailed: (tag) => {
      throw Error('Probe fullscreen video failed: ' + tag.args.get('file'));
    },
    enterVideoMode: () => {
      if (probeRunMode === 13) return;
      moviePrevious = probeRunMode;
      probeRunMode = 7;
      modeEffects.push({runMode: 7, simulation: true});
      if (resourceInFlight) runModeHeld = true;
      else script.pause();
    },
    releaseRunMode: () => {
      if (probeRunMode !== 7) return;
      probeRunMode = moviePrevious;
      moviePlayer.end = null;
      modeEffects.push({runMode: probeRunMode, simulation: true});
      script.resume();
    },
    rolePushed: () => false,
    writeClickSkip: () => variables.write('s.clickskip', '1'),
  });
  const messageLayers = new Set(),
    messageHistory = new Set(),
    messageFrames = new Map();
  if (metadataLayers) {
    let serial = 0;
    const resource = (name) => ({name, serial: ++serial, references: 1, font: new Map()});
    const retainMessage = (layer) => {
      layer.references++;
    };
    const releaseMessage = (layer) => {
      if (--layer.references < 0) throw Error('Probe message resource released twice');
      if (layer.references === 0) {
        glyphFixture?.release(layer);
        textDisplays.delete(layer);
      }
    };
    messageStage = new ArtemisMessageLayers(executableSha256, '', {
      createMessageLayer: (name) => {
        modeEffects.push({messageCreate: name, simulation: true});
        return resource(name);
      },
      copyMessageLayer: (old) => {
        modeEffects.push({messageCopy: old.name, simulation: true});
        const copy = resource(old.name);
        copy.font = new Map(old.font);
        if (old.indentation)
          copy.indentation = {...old.indentation, pairs: new Map(old.indentation.pairs)};
        if (old.wordParts) copy.wordParts = new Set(old.wordParts);
        if (old.prohibition)
          copy.prohibition = {
            head: new Set(old.prohibition.head),
            foot: new Set(old.prohibition.foot),
          };
        glyphFixture?.copy(old, copy);
        const display = textDisplays.get(old);
        if (display) textDisplays.set(copy, display.copy(textDisplayHost(copy)));
        return copy;
      },
      retainMessageLayer: retainMessage,
      releaseMessageLayer: releaseMessage,
      attachMessageLayer: (name, layer) => {
        layerFixture.attachMessageActor(name, layer, {
          retain: retainMessage,
          release: releaseMessage,
        });
        messageFrames.set(name, layer);
        modeEffects.push({messageAttach: name, simulation: true});
      },
      detachMessageLayer: (name) => {
        const old = messageFrames.get(name);
        if (old) {
          layerFixture.detachMessageActor(name);
          messageFrames.delete(name);
        }
        modeEffects.push({messageDetach: name, simulation: true});
      },
    });
    messageSelection = new ArtemisMessageSelection(messageStage, {
      nextMessageLayerId: () => {
        throw Error('Metadata fixture unnamed message allocator not implemented');
      },
      ensureMessageHistory: (name) => {
        if (!messageHistory.has(name)) {
          messageHistory.add(name);
          fontStack?.seedCurrentLayer();
          modeEffects.push({messageHistorySeed: name, simulation: true});
        }
      },
      deleteMessageHistory: (name) => {
        messageHistory.delete(name);
        fontStack?.deleteLayer(name);
        modeEffects.push({messageHistoryDelete: name, simulation: true});
      },
      publishCurrentMessageLayer: (name) => variables.write('s.current_message_layer', name),
      selectionChanged: (_tag, name) => modeEffects.push({messageSelected: name, simulation: true}),
      stackUnderflow: (_tag, name) =>
        modeEffects.push({messageStackUnderflow: name, simulation: true}),
      messageStateUpdated: () => modeEffects.push({messageStateUpdated: true, simulation: true}),
    });
  }
  if (messageSelection)
    fontStack = new ArtemisFontStack({
      currentMessageLayer: () => messageSelection.currentMessageLayer(),
      snapshotCurrentFont: () => ({
        font: new Map(messageStage.currentLayer().font),
        simulation: true,
      }),
      createFontCommandSnapshot: (tag) => {
        const patch = artemisFontProperties(tag.args),
          font = new Map(messageStage.currentLayer().font);
        for (const [key, value] of Object.entries(patch))
          if (key !== 'overflow') font.set(key, value);
        modeEffects.push({
          fontAttributeKeys: Object.keys(patch),
          simulation: true,
          fontRendering: false,
        });
        return {
          font,
          overflow: patch.overflow ?? (glyphLayout ? 2 : undefined),
          simulation: !glyphLayout,
        };
      },
      applyFontSnapshot: (snapshot) => {
        messageStage.currentLayer().font = new Map(snapshot.font);
      },
      releaseFontSnapshot: () => modeEffects.push({fontSnapshotReleased: true, simulation: true}),
      recordFontCommand: (name, tag) =>
        modeEffects.push({fontCommand: tag.name, messageLayer: name, simulation: true}),
      stackUnderflow: (name) => modeEffects.push({fontStackUnderflow: name, simulation: true}),
    });
  const sceneTweens = messageSelection
    ? new ArtemisSceneTweens(executableSha256, () => messageSelection.currentMessageLayer())
    : null;
  const textBreakControls = messageSelection
    ? new ArtemisTextBreakControls({
        currentMessageLayer: () => messageSelection.currentMessageLayer(),
        setIndentation: (value) => {
          messageStage.currentLayer().indentation = {...value, pairs: new Map(value.pairs)};
          modeEffects.push({indentationConfigured: true, simulation: true, textLayout: false});
        },
        setProhibitedCharacters: (head, foot) => {
          messageStage.currentLayer().prohibition = artemisUtf8Prohibition(head, foot);
          modeEffects.push({prohibitionConfigured: true, simulation: true, textLayout: false});
        },
        setWordParts: (parts) => {
          messageStage.currentLayer().wordParts = new Set(parts);
          modeEffects.push({wordPartsConfigured: true, simulation: true, textLayout: false});
        },
        recordTextCommand: (layer, tag) => {
          modeEffects.push({textCommand: tag.name, messageLayer: layer, simulation: true});
          if (glyphLayout) recordText(layer, tag);
        },
        rememberTextCommand: (layer, slot, tag) => {
          modeEffects.push({textReplaySlot: slot, messageLayer: layer, simulation: true});
          if (glyphLayout) saveData.rememberText(layer, slot, tag);
        },
      })
    : null;
  const textControls = new ArtemisTextControls({
    currentMessageLayer: () => messageSelection?.currentMessageLayer() ?? '',
    messageLayerExists: (id) =>
      messageStage ? messageStage.messageLayerExists(id) : messageLayers.has(id),
    selectMessageLayer: (id) => {
      if (messageStage) messageStage.selectMessageLayer(id, 0);
      else messageLayers.add(id);
      modeEffects.push({selectMessageLayer: id});
    },
    clearBacklog: () => {
      throw new Error('Artemis backlog collection storage is not implemented');
    },
  });
  const keyBindings = new ArtemisKeyBindings(() => script.currentFile);
  const eventCommands = new ArtemisEventCommands(() => script.currentFile);
  const nativeLibrary = new ArtemisNativeLibrary(
    new BrowserWindowsDynamicLibraryHost(),
    (name, bytes) => variables.write(name, bytes),
  );
  if (metadataLayers)
    layerFixture = createMetadataLayerFixture(
      executableSha256,
      (path) => installation.files.read(path),
      {
        // A rule trans enters its run mode after the asynchronous rule load; the resource
        // wait then becomes the run mode wait instead of resuming.
        enter: () => (resourceInFlight ? (runModeHeld = true) : script.pause()),
        release: () => script.resume(),
        now: () => probeTick,
        emit: (tag) => scriptEvents.emit(tag, 0, true),
        stageSize: () => ({width, height}),
        skipState: () => ({
          allowed: modes.skipAllowed,
          command: modes.commandSkip,
          control: modes.controlSkip,
        }),
      },
    );
  const recordText = (name, tag) => saveData.recordText(name, tag);
  const selectedResource = (name) => {
    if (name !== messageSelection.currentMessageLayer())
      throw Error('Probe selected message resource changed');
    return messageStage.currentLayer();
  };
  const overflowPolicy = (name) => {
    const frame = fontStack.borrowFrames(name).at(-1);
    if (frame?.overflow === undefined)
      throw Error('Probe cached fontinit overflow extra is unresolved');
    return frame.overflow;
  };
  if (glyphFixture) {
    ruby = new ArtemisRuby(executableSha256, {
      currentMessageLayer: () => messageSelection.currentMessageLayer(),
      insertRuby: (name, main, annotation) =>
        glyphFixture.get(selectedResource(name)).insertRuby(main, annotation),
      fontOverflowPolicy: overflowPolicy,
      writeOverflowed: (value) => variables.write('s.overflowed', value),
      enqueue: (tag) => script.enqueue(tag),
      recordTextCommand: recordText,
      reportRubyError: (tag, kind) => modeEffects.push({rubyError: kind, tag: tag.name}),
    });
    textCommands = new ArtemisTextCommands(executableSha256, {
      currentMessageLayer: () => messageSelection.currentMessageLayer(),
      newline: (name, omit) => glyphFixture.get(selectedResource(name)).newline(omit),
      backlogAllowed: () => modes.writeBacklog,
      backlogIncludeFont: () => textControls.backlogIncludeFont,
      captureBacklog: () => {
        throw Error('Native backlog resource snapshot not implemented in nonvisual glyph fixture');
      },
      clearCommandHistory: (name) => saveData.clearText(name),
      saveCurrentFontHistory: (name) => saveData.saveFonts(name, fontStack.borrowFrames(name)),
      promoteRememberedTextCommands: (name) => saveData.promoteText(name),
      forceImmediateClear: () => modes.skipAllowed && (modes.commandSkip || modes.controlSkip),
      clearText: async (name, out) => {
        if (out && sceneTweens.snapshot('out', name).length)
          throw Error('Native outgoing text effects are not implemented');
        const resource = selectedResource(name);
        if (glyphFixture.get(resource).clearEmptyEffects()) textDisplays.get(resource)?.clear();
      },
      recordTextCommand: recordText,
    });
  }
  const print = glyphFixture
    ? new ArtemisPrint(executableSha256, {
        currentMessageLayer: () => messageSelection.currentMessageLayer(),
        rubyActive: () => ruby.active,
        debugSkipActive: () => false,
        print: (name, bytes) => glyphFixture.get(selectedResource(name)).insert(bytes),
        appendRubyBytes: (bytes) => ruby.appendRubyBytes(bytes),
        fontOverflowPolicy: overflowPolicy,
        writeOverflowed: (value) => variables.write('s.overflowed', value),
        reportPrintError: (tag, kind) => modeEffects.push({printError: kind, tag: tag.name}),
        enqueue: (tag) => script.enqueue(tag),
        recordPrintCommand: recordText,
      })
    : null;
  const dispatch = (tag) => {
    nativeTags.push({name: tag.name, args: Object.fromEntries(tag.args)});
    if (glyphFixture && ['print', 'ruby', '/ruby', 'rt', 'rp'].includes(tag.name)) {
      if (pendingResource) throw Error('Probe text resource operation overlaps');
      pendingResource =
        tag.name === 'print'
          ? print.dispatch(tag)
          : ['ruby', '/ruby'].includes(tag.name)
            ? ruby.dispatch(tag)
            : textCommands.dispatch(tag);
      return 'suspended';
    }
    if (layerFixture && tag.name === 'trans') {
      const result = layerFixture.dispatchTransition(tag);
      if (!(result instanceof Promise)) return;
      if (pendingResource) throw Error('Probe transition operation overlaps');
      pendingResource = result;
      return 'suspended';
    }
    if (layerFixture && ['lytween', 'lytweendel', 'tweenset', '/tweenset'].includes(tag.name)) {
      layerFixture.dispatchTween(tag);
      return;
    }
    if (fullscreenVideo.accepts(tag)) {
      if (pendingResource) throw Error('Probe resource operation overlaps');
      pendingResource = fullscreenVideo.dispatch(tag);
      return 'suspended';
    }
    if (layerFixture?.accepts(tag)) {
      if (pendingResource) throw Error('Probe resource operation overlaps');
      pendingResource = layerFixture.dispatch(tag);
      return 'suspended';
    }
    if (
      messageSelection?.dispatch(tag) ||
      fontStack?.dispatch(tag) ||
      sceneTweens?.dispatch(tag) ||
      textBreakControls?.dispatch(tag)
    )
      return;
    if (dialog.dispatch(tag)) return;
    if (
      keyBindings.dispatch(tag) ||
      eventCommands.dispatch(tag) ||
      nativeLibrary.dispatch(tag) ||
      textControls.dispatch(tag) ||
      modes.dispatch(tag) ||
      exec.dispatch(tag) ||
      variables.dispatch(tag) ||
      caption.dispatch(tag) ||
      seStop.dispatch(tag) ||
      soundFinish?.dispatch(tag) ||
      mouse.dispatch(tag) ||
      wait.dispatch(tag) ||
      stop.dispatch(tag)
    )
      return;
    if (shaderFixture && tag.name === 'lyshader') {
      if (pendingResource) throw Error('Probe shader resource operation overlaps');
      pendingResource = shaderFixture.dispatch(tag);
      return 'suspended';
    }
    if (reset.dispatch(tag)) return;
    if (save.dispatch(tag)) return;
    if (clickGlyphs.dispatch(tag)) return;
    if (music) {
      const result = music.dispatch(tag);
      if (result === true) return;
      if (result) {
        if (pendingResource) throw Error('Probe sound resource operation overlaps');
        pendingResource = result;
        return 'suspended';
      }
    }
    if (sePlay && ['seplay', 'sefadein'].includes(tag.name)) {
      if (pendingResource) throw Error('Probe sound resource operation overlaps');
      pendingResource = sePlay.dispatch(tag);
      return 'suspended';
    }
    throw new Error(`Unsupported native Artemis tag ${tag.name}`);
  };
  const random = new ArtemisRandom(executableSha256, 1733961600);
  lua = new ArtemisLua({
    ...(surfaceFixture
      ? {
          bindSurface: (name) => {
            if (pendingResource) throw Error('Probe surface resource operation overlaps');
            // Foreground load; the returned lease is released at once (native 0x140134180).
            pendingResource = surfaceFixture.manager
              .load(name)
              .then((image) => image?.lease?.release());
            return 'suspended';
          },
          bindSurfaceAsync: (name) => surfaceFixture.manager.bindSurfaceAsync(name),
          unbindSurface: (name) => surfaceFixture.manager.unbindSurface(name),
          clearSurfaceLoadQueue: () => surfaceFixture.manager.clearSurfaceLoadQueue(),
          isLoadingSurface: (name) => surfaceFixture.manager.isLoadingSurface(name),
        }
      : {}),
    suspendableTags,
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
    readPlainFile: (path) => {
      includes.push(path);
      return plainFiles.get(path.replaceAll('\\', '/')) ?? null;
    },
    readFile: (path) => {
      includes.push(path);
      return readFile(path);
    },
    // SIMULATED seed: a fixed Unix time keeps probe runs deterministic.
    random: () => random.next(),
    // Lua receives the se/video ids (ba0/bc8) as strings.
    scriptWaitReason: () => {
      const {sound, video, ...reason} = wait.reason;
      const encoder = new TextEncoder();
      return {
        ...reason,
        ...(sound === undefined ? {} : {sound: encoder.encode(sound)}),
        ...(video === undefined ? {} : {video: encoder.encode(video)}),
      };
    },
    // Unprepared files are read asynchronously, then the Lua call repeats.
    readResource: (path) => {
      const resolved = installation.files.resolvePath(path);
      if (prepared.has(resolved)) return prepared.get(resolved);
      if (!installation.paths.has(resolved)) return null;
      if (pendingResource) throw Error('Probe Lua resource read overlaps');
      pendingResource = installation.files.read(path).then((bytes) => {
        if (bytes === null) throw Error('Probe Lua resource disappeared: ' + path);
        prepared.set(resolved, bytes);
      });
      return 'suspended';
    },
    reportError: (message) =>
      luaCallErrors.push({
        engineMethod: true,
        message: new TextDecoder('shift_jis').decode(message),
        severity: 1,
      }),
    fileExists: (path) => installation.paths.has(installation.files.resolvePath(path)),
    setMagicPath: (name, root) => {
      installation.files.setMagicPath(name, root);
      modeEffects.push({magicPath: {name, root}});
    },
    setTouchLimit: (limit) => modeEffects.push({touchLimit: limit}),
    ...(metadataLayers ? {pointerPosition: {readPointerPosition: () => ({x: 0, y: 0})}} : {}),
    now: () => probeTick, // Deterministic probe clock, not a production game clock.
    tag: (tag) => script.executeTag(tag),
    enqueueTag: (tag) => script.enqueue(tag),
    variable: (name) => variables.queryLiteral(name),
    scriptStack: () => script.stack(),
  });
  let compiled = 0;
  for (const [path, bytes] of prepared)
    if (/\.(lua|ast)$/.test(path)) {
      const plain = plainFiles.get(path);
      if (plain !== undefined) lua.vm.compileFile(plain, path, windowsTextFileBytes(plain));
      else lua.vm.compile(bytes, `@${path}`);
      compiled++;
    }
  script = new ArtemisScript(lua, {
    pushLocal: () => variables.pushLocal(),
    popLocal: () => variables.popLocal(),
    readFile,
    dispatch,
    evaluateExpression: (expression) =>
      new TextDecoder().decode(artemisExpressionBytes(expression, variables)),
    trace: ({origin, file, tagIndex, tag}) =>
      events.push({origin, file, tagIndex, name: tag.name, sourceLine: tag.sourceLine}),
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
  });
  const scriptEvents = createArtemisScriptEvents(executableSha256, lua, script, {
    nativeMode: () => probeRunMode,
    disabled: () => false,
    latched: () => false,
    latch: () => {},
    report: (kind, command, error) =>
      modeEffects.push({eventError: {kind, name: command.name, error: String(error)}}),
  });
  const resetOwners = () => {
    exec.clearRequests();
    clickGlyphs.reset();
    scriptEvents.clear();
    messageSelection?.reset();
    if (fontStack) {
      fontStack.reset(() => ({font: new Map(), simulation: true}));
      messageHistory.clear();
      messageHistory.add('').add('backlog');
    }
    sceneTweens?.reset();
    ruby?.reset();
    textControls.reset();
    modeEffects.push({cursorVisible: true, reset: true});
    keyBindings.resetPushHandlers();
    eventCommands.reset();
    // New music/effect managers: every effect voice stops and the id map empties.
    for (const index of new Set(effectSlots.values())) soundFixture?.stopEffect(index, 0);
    effectSlots.clear();
    if (music) {
      soundFixture.stopMusic(music.currentIndex, 0);
      soundFixture.stopMusic(music.fadingIndex, 0);
      music.reset();
    }
    lua.events.clear();
    layerFixture?.reset();
    messageStage?.reset();
  };
  const reset = new ArtemisReset(modes, save, variables, readHistory, {
    bootPath: () => bootPath,
    updateMessageState: () => modeEffects.push({messageStateUpdated: true, reset: true}),
    releaseScheduler: () => modeEffects.push({releaseScheduler: true, reset: true}),
    resetOwners,
    applyVolumes: (music, effect) => modeEffects.push({volumes: {music, effect}, simulation: true}),
    resetSaveObject: () => {
      saveData.clear();
      music?.clearHistory();
      layerFixture?.clearLayerCommands();
    },
    loadBoot: (path) => {
      modeEffects.push({boot: path});
      script.reset(path);
    },
    // SIMULATED storage: the in-memory files written earlier in this probe run.
    readSaveFile: async (name) => saveFiles.get(name) ?? null,
    initializeStaticVariables,
  });
  let refusal = null;
  try {
    await reset.boot();
    script.run(1000);
    while (script.state === 'waiting') {
      if (pendingResource) {
        if (resourceResumptions >= 10000000) throw Error('Probe resource budget exceeded');
        const operation = pendingResource;
        pendingResource = null;
        resourceInFlight = true;
        try {
          await operation;
        } finally {
          resourceInFlight = false;
        }
        resourceResumptions++;
        if (runModeHeld) {
          runModeHeld = false;
          continue;
        }
        if (script.pendingLuaCalls) script.resumeLua();
        else script.resume();
        script.run(1000);
        // Native loads resources synchronously inside the tag or Lua call; the frame that
        // advances sound and delivers its finish events runs only once the script settles.
        if (soundRender && !pendingResource) {
          probeTick = (probeTick + 1) >>> 0;
          soundFixture.advanceToTick(probeTick);
          layerFixture?.tickTweens(probeTick);
          if (script.state === 'ready') script.run(1000);
        }
        continue;
      }
      if (advanceWaits && layerFixture?.transitionPending && advancedWaits < 1000000) {
        probeTick = layerFixture.finishTransition((probeTick + 1) >>> 0 || 1);
        advancedWaits++;
        soundFixture?.advanceToTick?.(probeTick);
        layerFixture.tickTweens(probeTick);
        script.run(1000);
        continue;
      }
      if (advanceWaits && layerFixture?.tweenSyncPending && advancedWaits < 1000000) {
        // Deterministic 16 ms frames until the sync tween's completion ends run mode 4.
        for (let frame = 0; layerFixture.tweenSyncPending; frame++) {
          if (frame >= 100000) throw Error('Probe sync tween did not finish');
          probeTick = (probeTick + 16) >>> 0 || 1;
          soundFixture?.advanceToTick?.(probeTick);
          layerFixture.tickTweens(probeTick);
        }
        advancedWaits++;
        script.run(1000);
        continue;
      }
      if (probeRunMode === 7) {
        // Deterministic 16 ms frames of run mode 7 until the movie ends.
        for (let frame = 0; probeRunMode === 7; frame++) {
          if (frame >= 10000000) throw Error('Probe fullscreen video did not finish');
          probeTick = (probeTick + 16) >>> 0 || 1;
          soundFixture?.advanceToTick?.(probeTick);
          layerFixture?.tickTweens(probeTick);
          fullscreenVideo.frame();
        }
        script.run(1000);
        continue;
      }
      if (probeInputs.length && probeRunMode === 3 && !wait.pending) {
        const input = probeInputs.shift();
        if (input.id !== undefined) {
          if (!layerFixture) throw Error('Probe layer events require --image-metadata');
          modeEffects.push({layerEvent: input, simulation: true});
          layerFixture.invokeLayerEvent(input.id, input.type, scriptEvents);
        } else {
          modeEffects.push({keyPush: input.key, simulation: true});
          keyBindings.deliverPushed(
            (candidate, slot) => slot === 0 && candidate === input.key,
            (command) => scriptEvents.dispatch(command),
          );
        }
        script.run(1000);
        continue;
      }
      if (wait.clickPending && probeClicks > 0) {
        for (let frame = 0; !currentTextDisplay().complete; frame++) {
          if (frame >= 100000) throw Error('Probe click-wait display did not finish');
          probeTick = (probeTick + 16) >>> 0 || 1;
          soundFixture?.advanceToTick?.(probeTick);
          layerFixture?.tickTweens(probeTick);
          wait.tick(probeTick);
        }
        probeClicks--;
        probeTick = (probeTick + 16) >>> 0 || 1;
        modeEffects.push({click: true, simulation: true});
        if (!wait.tick(probeTick, true)) throw Error('Probe click did not end the click-wait');
        script.run(1000);
        continue;
      }
      if (advanceWaits && wait.scenarioPending && advancedWaits < 1000000) {
        // Deterministic 16 ms frames until the text display completes; no click is simulated.
        for (let frame = 0; ; frame++) {
          if (frame >= 100000) throw Error('Probe scenario wait did not finish');
          probeTick = (probeTick + 16) >>> 0 || 1;
          soundFixture?.advanceToTick?.(probeTick);
          layerFixture?.tickTweens(probeTick);
          if (wait.tick(probeTick)) break;
        }
        advancedWaits++;
        script.run(1000);
        continue;
      }
      if (advanceWaits && (wait.videoPending || wait.soundPending) && advancedWaits < 1000000) {
        // Deterministic 16 ms frames play the video or se until it stops; no click.
        for (let frame = 0; ; frame++) {
          if (frame >= 100000) throw Error('Probe video/se wait did not finish');
          probeTick = (probeTick + 16) >>> 0 || 1;
          soundFixture?.advanceToTick?.(probeTick);
          layerFixture?.tickTweens(probeTick);
          if (wait.tick(probeTick)) break;
        }
        advancedWaits++;
        script.run(1000);
        continue;
      }
      if (!advanceWaits || !wait.pending || wait.clickPending || advancedWaits >= 1000000) break;
      // 16 ms frames up to the deadline keep sound and video layers advancing meanwhile.
      const deadline = (wait.deadlineTick + 1) >>> 0;
      while (((deadline - probeTick) | 0) > 16) {
        probeTick = (probeTick + 16) >>> 0 || 1;
        soundFixture?.advanceToTick?.(probeTick);
        layerFixture?.tickTweens(probeTick);
      }
      if (((deadline - probeTick) | 0) > 0) probeTick = deadline;
      advancedWaits++;
      soundFixture?.advanceToTick?.(probeTick);
      layerFixture?.tickTweens(probeTick);
      if (!wait.tick(probeTick)) break;
      script.run(1000);
    }
  } catch (error) {
    refusal = error.message;
    if (process.env.ARTEMIS_PROBE_STACK) console.error(error.stack, error.hostCause?.stack ?? '');
  }
  await Promise.all(saveWrites);
  if (surfaceFixture) {
    try {
      await surfaceFixture.manager.waitForLoads();
    } catch (error) {
      refusal = refusal ? `${refusal}; preload: ${error.message}` : error.message;
    }
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
        saveFiles: Object.fromEntries(
          [...saveFiles].map(([name, bytes]) => [name, {bytes: bytes.length}]),
        ),
        dialogPending: dialog.pending,
        simulatedDialogResult,
        graphicsFeatureLevel:
          simulatedGraphicsFeatureLevel === null
            ? null
            : {value: simulatedGraphicsFeatureLevel, simulation: true},
        advanceWaits,
        advancedWaits,
        timedWaitPending: wait.pending,
        effectMode: 'record-only',
        metadataLayerFixture: layerFixture?.snapshot() ?? null,
        fontStackFixture: fontStack
          ? {depth: fontStack.depth(), fontRendering: false, simulation: true}
          : null,
        messageSelectionFixture: messageSelection
          ? {
              current: messageSelection.currentMessageLayer(),
              depth: messageSelection.depth,
              presentation: false,
              simulation: true,
            }
          : null,
        pointerPositionFixture: metadataLayers ? {x: 0, y: 0, simulation: true} : null,
        resourceResumptions,
        preparedFiles: prepared.size,
        preparedBytes,
        compiled,
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
        glyphLayoutFixture: glyphFixture?.summary(),
        surfacePreloadFixture: surfaceFixture?.summary(),
        soundDecodeFixture: soundFixture?.summary(),
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
  lua?.close();
  ruby?.close();
  sePlay?.close();
  textCommands?.close();
  fontStack?.close();
  messageStage?.close();
  layerFixture?.close();
  await glyphFixture?.close();
  await surfaceFixture?.close();
  await soundFixture?.close();
  shaderFixture?.close();
  await installation.close();
}
