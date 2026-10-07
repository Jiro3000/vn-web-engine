/** Runs Lua/script control only; no renderer, media decoder or native game process. */
import {createHash} from 'node:crypto';
import {createMetadataLayerFixture} from './artemis-metadata-layer-fixture.mjs';
import {BrowserWindowsSystemProfileHost} from '../dist/platform/browser-windows-system-profile.js';
import {
  initializeArtemisVariables,
  initializeArtemisWindowsVersion,
  initializeArtemisResourcePaths,
} from '../dist/engines/artemis/revision.js';
import {openArtemisInstallation} from './artemis-installation.mjs';
import {ArtemisLua} from '../dist/engines/artemis/lua.js';
import {ArtemisScript} from '../dist/engines/artemis/script.js';
import {ArtemisVariables} from '../dist/engines/artemis/variables.js';
import {ArtemisDialog} from '../dist/engines/artemis/dialog.js';
import {artemisFontProperties} from '../dist/engines/artemis/font-properties.js';
import {ArtemisFontStack} from '../dist/engines/artemis/font-stack.js';
import {
  ArtemisMessageLayers,
  ArtemisMessageSelection,
} from '../dist/engines/artemis/message-layers.js';
import {ArtemisCaption} from '../dist/engines/artemis/caption.js';
import {ArtemisMouse} from '../dist/engines/artemis/mouse.js';
import {ArtemisSave} from '../dist/engines/artemis/save.js';
import {ArtemisTimedWait} from '../dist/engines/artemis/wait.js';
import {ArtemisTextControls} from '../dist/engines/artemis/text-controls.js';
import {ArtemisKeyBindings} from '../dist/engines/artemis/key-bindings.js';
import {ArtemisEventCommands} from '../dist/engines/artemis/event-commands.js';
import {ArtemisNativeLibrary} from '../dist/engines/artemis/native-library.js';
import {BrowserWindowsDynamicLibraryHost} from '../dist/platform/windows-dynamic-library.js';
import {ArtemisModes} from '../dist/engines/artemis/modes.js';
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
const suspendableTags = process.argv.slice(3).includes('--async-lua');
const metadataLayers = process.argv.slice(3).includes('--image-metadata');
if (metadataLayers && !suspendableTags) throw Error('--image-metadata requires --async-lua');
let fontStack = null;
let messageStage = null,
  messageSelection = null;
let layerFixture = null,
  pendingResource = null,
  resourceResumptions = 0;
let probeTick = 1,
  advancedWaits = 0;
const installation = await openArtemisInstallation(process.argv[2]);
let lua, script;
try {
  const prepared = new Map();
  let preparedBytes = 0;
  for (const path of installation.paths)
    if (/\.(lua|ast|iet|asb|tbl|ini)$/.test(path)) {
      const bytes = await installation.files.read(path);
      if (bytes === null) throw new Error(`Missing inventoried source ${path}`);
      preparedBytes += bytes.length;
      if (preparedBytes > 64 * 1024 * 1024)
        throw new Error('Script corpus exceeds probe memory budget');
      prepared.set(path, bytes);
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
    savePathCsidl;
  for (const sourceLine of ini.split(/\r?\n/)) {
    const line = sourceLine.split(';', 1)[0].trim();
    const header = /^\[([^\]]+)\]$/.exec(line);
    if (header) section = header[1].toUpperCase();
    if (section !== 'WINDOWS') continue;
    const setting = /^(SAVEPATH|SAVEPATH_CSIDL)\s*=\s*(.*)$/.exec(line);
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
  });
  const executablePaths = [...installation.paths].filter(
    (path) => /\.exe$/i.test(path) && !path.includes('/'),
  );
  if (executablePaths.length !== 1) throw new Error('Probe requires exactly one root executable');
  const executable = await installation.files.read(executablePaths[0]);
  if (executable === null) throw new Error('Missing Artemis executable');
  const executableSha256 = createHash('sha256').update(executable).digest('hex');
  initializeArtemisVariables(variables, executableSha256);
  // Installation-relative read-only namespace; no Windows known-folder resolution or writes.
  if (savePath !== undefined && savePathCsidl === undefined && /^[\w-]+$/.test(savePath))
    initializeArtemisResourcePaths(variables, {dataPath: '', savePath});
  const systemProfile = new BrowserWindowsSystemProfileHost();
  initializeArtemisWindowsVersion(variables, () => systemProfile.readVersion());
  const modes = new ArtemisModes({
    writeStatus: (name, value) => (variables.write(name, value), modeEffects.push({name, value})),
    commandSkipChanged: (active) => modeEffects.push({commandSkip: active}),
    controlSkipChanged: (active) => modeEffects.push({controlSkip: active}),
    automodeChanged: (active) => modeEffects.push({automode: active}),
    releaseScheduler: () => modeEffects.push({releaseScheduler: true}),
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
  const save = new ArtemisSave(variables, {
    beforeScenario: (file) => lua.events.emit('onSave', new Map([['file', file]])),
    reportEventError: (error) => modeEffects.push({saveEventError: String(error)}),
    writeScenario: () => {
      throw new Error('Artemis scenario save serialization is not implemented');
    },
    writeGlobal: () => {
      throw new Error('Artemis global save serialization is not implemented');
    },
    writeSystem: () => {
      throw new Error('Artemis system save serialization is not implemented');
    },
  });
  const wait = new ArtemisTimedWait(modes, save, {
    now: () => probeTick,
    debugSkipActive: () => false,
    hasActiveMessage: () => false,
    beginWait: (inputEnabled, skipIndicator) => {
      modeEffects.push({wait: {inputEnabled, skipIndicator}});
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
  });
  const messageLayers = new Set(),
    messageHistory = new Set(),
    messageFrames = new Map();
  if (metadataLayers) {
    let serial = 0;
    const resource = (name) => ({name, serial: ++serial, references: 1, font: new Map()});
    messageStage = new ArtemisMessageLayers(executableSha256, '', {
      createMessageLayer: (name) => {
        modeEffects.push({messageCreate: name, simulation: true});
        return resource(name);
      },
      copyMessageLayer: (old) => {
        modeEffects.push({messageCopy: old.name, simulation: true});
        const copy = resource(old.name);
        copy.font = new Map(old.font);
        return copy;
      },
      retainMessageLayer: (layer) => {
        layer.references++;
      },
      releaseMessageLayer: (layer) => {
        if (--layer.references < 0) throw Error('Probe message resource released twice');
      },
      attachMessageLayer: (name, layer) => {
        messageFrames.set(name, layer);
        layer.references++;
        modeEffects.push({messageAttach: name, simulation: true});
      },
      detachMessageLayer: (name) => {
        const old = messageFrames.get(name);
        if (old) {
          old.references--;
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
        return {font, overflow: patch.overflow, simulation: true};
      },
      applyFontSnapshot: (snapshot) => {
        messageStage.currentLayer().font = new Map(snapshot.font);
      },
      releaseFontSnapshot: () => modeEffects.push({fontSnapshotReleased: true, simulation: true}),
      recordFontCommand: (name, tag) =>
        modeEffects.push({fontCommand: tag.name, messageLayer: name, simulation: true}),
      stackUnderflow: (name) => modeEffects.push({fontStackUnderflow: name, simulation: true}),
    });
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
    layerFixture = createMetadataLayerFixture(executableSha256, (path) =>
      installation.files.read(path),
    );
  const dispatch = (tag) => {
    nativeTags.push({name: tag.name, args: Object.fromEntries(tag.args)});
    if (layerFixture?.accepts(tag)) {
      if (pendingResource) throw Error('Probe resource operation overlaps');
      pendingResource = layerFixture.dispatch(tag);
      return 'suspended';
    }
    if (messageSelection?.dispatch(tag) || fontStack?.dispatch(tag)) return;
    if (dialog.dispatch(tag)) return;
    if (
      keyBindings.dispatch(tag) ||
      eventCommands.dispatch(tag) ||
      nativeLibrary.dispatch(tag) ||
      textControls.dispatch(tag) ||
      modes.dispatch(tag) ||
      variables.dispatch(tag) ||
      caption.dispatch(tag) ||
      mouse.dispatch(tag) ||
      wait.dispatch(tag)
    )
      return;
    throw new Error(`Unsupported native Artemis tag ${tag.name}`);
  };
  lua = new ArtemisLua({
    suspendableTags,
    readFile: (path) => {
      includes.push(path);
      return readFile(path);
    },
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
  });
  let compiled = 0;
  for (const [path, bytes] of prepared)
    if (/\.(lua|ast)$/.test(path)) {
      lua.vm.compile(bytes, `@${path}`);
      compiled++;
    }
  script = new ArtemisScript(lua, {
    pushLocal: () => variables.pushLocal(),
    popLocal: () => variables.popLocal(),
    readFile,
    dispatch,
    trace: ({origin, file, tagIndex, tag}) =>
      events.push({origin, file, tagIndex, name: tag.name, sourceLine: tag.sourceLine}),
  });
  let refusal = null;
  try {
    script.load('system/first.iet');
    script.run(1000);
    while (script.state === 'waiting') {
      if (pendingResource) {
        if (resourceResumptions >= 1000) throw Error('Probe resource budget exceeded');
        const operation = pendingResource;
        pendingResource = null;
        await operation;
        resourceResumptions++;
        if (script.pendingLuaCalls) script.resumeLua();
        else script.resume();
        script.run(1000);
        continue;
      }
      if (!advanceWaits || !wait.pending || advancedWaits >= 100) break;
      probeTick = (wait.deadlineTick + 1) >>> 0;
      advancedWaits++;
      if (!wait.tick(probeTick)) break;
      script.run(1000);
    }
  } catch (error) {
    refusal = error.message;
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
        dialogPending: dialog.pending,
        simulatedDialogResult,
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
        luaVersion: luaText(lua.vm.getGlobal('_VERSION')),
        state: script.state,
        refusal,
        events,
        nativeTags,
        includes,
        modeEffects,
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
  layerFixture?.close();
  fontStack?.close();
  messageStage?.close();
  await installation.close();
}
