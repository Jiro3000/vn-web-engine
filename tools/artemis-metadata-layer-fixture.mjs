/** Read-only geometry fixture for control-flow probing. It decodes only transition rule
 * images into native gray bytes and video layers through the native CTheora model, both
 * reported as hashes and counters; it never prepares GPU resources, displays game media
 * or claims production rendering.
 */
import {createHash} from 'node:crypto';
import {ArtemisImageLoader} from '../dist/engines/artemis/image-loader.js';
import {ArtemisLayers} from '../dist/engines/artemis/layers.js';
import {ArtemisLayerCommands} from '../dist/engines/artemis/layer-commands.js';
import {ArtemisLayerEventSlots, ArtemisLayerEvents} from '../dist/engines/artemis/layer-events.js';
import {ArtemisDisplayObject} from '../dist/engines/artemis/display-object.js';
import {ArtemisStage} from '../dist/engines/artemis/stage.js';
import {ArtemisTransition} from '../dist/engines/artemis/transition.js';
import {ArtemisLayerTweens} from '../dist/engines/artemis/layer-tweens.js';
import {ArtemisTweenRegistry} from '../dist/engines/artemis/tween.js';
import {ArtemisShaderProperties} from '../dist/engines/artemis/shader-properties.js';
import {artemisRevision} from '../dist/engines/artemis/revision.js';
import {readJpegHeader} from '../dist/formats/jpeg/header.js';
import {decodePng} from '../dist/formats/png/decode.js';
import {artemisPngSurface} from '../dist/engines/artemis/png-surface.js';

/** `runMode` supplies the probe's run mode/wait owner for trans and sync tweens, `emit`
 * for tween completion events and `stageSize` for rule transitions; an absent owner
 * refuses them. */
export function createMetadataLayerFixture(hash, readFile, runMode = null) {
  artemisRevision(hash);
  const loads = [],
    effects = [],
    actors = new Set(),
    // Video decoders shared by actor copies, with their reference counts.
    videos = new Map();
  let sequence = 0,
    transitionState = 0,
    refreshState = 0;
  const dimensions = (width, height) => {
    if (![width, height].every((n) => Number.isInteger(n) && n > 0 && n <= 0x7fffffff))
      throw Error('Invalid probe image metadata dimensions');
    return {width, height};
  };
  const imageSource = new ArtemisImageLoader(readFile, [
    {
      extensions: ['png', 'PNG'],
      decode: async (bytes) => {
        if (![137, 80, 78, 71, 13, 10, 26, 10].every((v, i) => bytes[i] === v)) return null;
        if (bytes.length < 33) throw Error('Truncated probe PNG header');
        const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
        if (view.getUint32(8) !== 13 || view.getUint32(12) !== 0x49484452)
          throw Error('Invalid probe PNG IHDR');
        return dimensions(view.getUint32(16), view.getUint32(20));
      },
    },
    {
      extensions: ['jpg', 'jpeg', 'JPG', 'JPEG'],
      decode: async (bytes) => {
        if (bytes[0] !== 255 || bytes[1] !== 216) return null;
        const header = readJpegHeader(bytes);
        return dimensions(header.width, header.height);
      },
    },
    {
      extensions: ['psd', 'PSD'],
      decode: async (bytes) => {
        if (![56, 66, 80, 83].every((v, i) => bytes[i] === v)) return null;
        if (bytes.length < 26) throw Error('Truncated probe PSD header');
        const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
        return dimensions(view.getUint32(18), view.getUint32(14));
      },
    },
  ]);
  const source = {
    async load(name) {
      const resource = await imageSource.load(name);
      loads.push({
        name,
        path: resource?.path ?? null,
        width: resource?.image.width ?? null,
        height: resource?.image.height ?? null,
        pixelDecode: false,
      });
      return resource;
    },
  };
  const host = {
    creationMode: () => 0,
    createImageLayer(resource, anchor) {
      const display = new ArtemisDisplayObject(hash);
      display.apply({anchorx: anchor.x, anchory: anchor.y});
      const actor = {
        id: ++sequence,
        kind: 'image',
        path: resource.path,
        width: resource.image.width,
        height: resource.image.height,
        display,
        wrapper: {alpha: 1},
        properties: {},
      };
      actors.add(actor);
      return actor;
    },
    createGroupLayer() {
      const actor = {
        id: ++sequence,
        kind: 'group',
        display: new ArtemisDisplayObject(hash),
        wrapper: {alpha: 1},
        properties: {},
      };
      actors.add(actor);
      return actor;
    },
    // CAnimationLayer with the shared frame map; frames are ordinary image actors.
    createAnimationLayer(animation) {
      const actor = {
        id: ++sequence,
        kind: 'animation',
        animation,
        display: new ArtemisDisplayObject(hash),
        wrapper: {alpha: 1},
        properties: {},
      };
      actors.add(actor);
      return actor;
    },
    animationFrames: (actor) => actor.animation,
    readVideoFile: async (path) => {
      const bytes = await readFile(path);
      loads.push({name: path, kind: 'video', bytes: bytes?.length ?? null});
      return bytes;
    },
    createVideoLayer(video, anchor) {
      const display = new ArtemisDisplayObject(hash);
      display.apply({anchorx: anchor.x, anchory: anchor.y});
      const actor = {
        id: ++sequence,
        kind: 'video',
        video,
        width: video.width,
        height: video.height,
        display,
        wrapper: {alpha: 1},
        properties: {},
      };
      videos.set(video, 1);
      actors.add(actor);
      effects.push({kind: 'video', width: video.width, height: video.height, mask: video.hasMask});
      return actor;
    },
    videoError: (tag, error) => {
      throw Error(`Probe video ${error}: ` + tag.args.get('file'));
    },
    animationError: (tag, error) => {
      throw Error(`Probe animation ${error}: ` + tag.args.get('id'));
    },
    appendLayerCommand: (id, tag) => {
      effects.push({kind: 'appendCommand', id, name: tag.name});
      layerCommands.append(id, tag);
    },
    copyImageLayer(old) {
      if (!actors.has(old)) throw Error('Probe actor released');
      const actor = {
        ...old,
        id: ++sequence,
        animation: old.animation?.copy(),
        display: old.display.copy(),
        properties: {...old.properties},
        events: old.events?.copy(),
        shader: old.shader?.copy(),
      };
      if (actor.kind === 'message') actor.messageOwner.retain(actor.message);
      if (actor.video) videos.set(actor.video, videos.get(actor.video) + 1);
      actors.add(actor);
      return actor;
    },
    applyImageProperties(id, actor, patch) {
      actor.display.apply(patch);
      if (patch.wrapperAlpha !== undefined) actor.wrapper.alpha = patch.wrapperAlpha;
      Object.assign(actor.properties, patch);
      effects.push({kind: 'properties', id, keys: Object.keys(patch), simulation: true});
    },
    // Shader state is recorded through the shared property owner; no program is compiled.
    supportsShaderProperties: () => true,
    createShaderTexture(resource) {
      let references = 1;
      const texture = Object.freeze({path: resource.path, width: resource.image.width});
      const lease = {
        resource: texture,
        retain() {
          if (!references) throw Error('Probe shader texture released');
          references++;
          return lease;
        },
        release() {
          if (!references) throw Error('Probe shader texture released twice');
          references--;
        },
      };
      return lease;
    },
    applyShaderProperties(actor, patch, textures) {
      if (!actors.has(actor)) throw Error('Probe actor released');
      if (patch.textures !== undefined && textures === undefined)
        throw Error('Artemis shader textures require prepared resource leases');
      actor.shader ??= new ArtemisShaderProperties(hash);
      if (patch.shader !== undefined) actor.shader.setShader(patch.shader);
      if (patch.constants !== undefined) actor.shader.setConstants(patch.constants);
      if (textures !== undefined) actor.shader.setTextures(textures);
      effects.push({kind: 'shader', keys: Object.keys(patch), simulation: true});
    },
    releaseImageLayer(actor) {
      if (!actors.delete(actor)) throw Error('Probe actor released twice');
      actor.shader?.close();
      actor.animation?.close();
      if (actor.kind === 'message') actor.messageOwner.release(actor.message);
      if (actor.video) {
        const references = videos.get(actor.video) - 1;
        if (references) videos.set(actor.video, references);
        else {
          videos.delete(actor.video);
          actor.video.close();
        }
      }
      effects.push({kind: 'release', actor: actor.id});
    },
    clearLayerCommands: (ids) => {
      effects.push({kind: 'clearCommands', ids});
      layerCommands.clear(ids);
    },
    resetLayerCommands: (id, tag) => {
      effects.push({kind: 'resetCommands', id});
      layerCommands.reset(id, tag);
    },
    // lyprop (and lytween's synthesized end state) outside replay: coalescing record b9cd0.
    recordLayerProperties: (tag) => {
      effects.push({kind: 'recordProperties', id: tag.args.get('id')});
      layerCommands.record(tag);
    },
    imageLoadFailed: (tag) => {
      throw Error('Probe image metadata missing: ' + tag.args.get('file'));
    },
    layerNotFound: (tag) => {
      throw Error('Probe layer missing: ' + tag.args.get('id'));
    },
  };
  const layers = new ArtemisLayers(hash, source, host);
  // lyevent/lytween lists; lyprop records are simulated effects above.
  const layerCommands = new ArtemisLayerCommands(hash);
  const layerEvents = new ArtemisLayerEvents(layers.scene, layerCommands, {
    slots: (actor) => (actor.events ??= new ArtemisLayerEventSlots()),
  });
  const stage = new ArtemisStage(hash, {
    captureMode: () => 0,
    transitionState: () => transitionState,
    clearTransitionRule: () => effects.push({kind: 'clearTransitionRule', simulation: true}),
    resetTransitionLayerValue: (value) =>
      effects.push({kind: 'resetTransitionValue', value, simulation: true}),
    setTransitionState: (value) => {
      transitionState = value;
    },
    markSceneDirty: () => effects.push({kind: 'sceneDirty', simulation: true}),
    commitLayers: () => layers.commit(),
    refreshState: () => refreshState,
    setRefreshState: (value) => {
      refreshState = value;
    },
  });
  const refuseRunMode = () => {
    throw Error('Unsupported diagnostic Artemis trans run mode owner');
  };
  let transitionTween = null,
    stageRule = null;
  // Rule images use the stage loader; only PNG has a decoded native surface here.
  const ruleSource = new ArtemisImageLoader(readFile, [
    {
      extensions: ['png', 'PNG'],
      decode: async (bytes) => {
        if (![137, 80, 78, 71, 13, 10, 26, 10].every((v, i) => bytes[i] === v)) return null;
        return artemisPngSurface(await decodePng(bytes));
      },
    },
    ...[
      ['jpg', 'jpeg', 'JPG', 'JPEG'],
      ['psd', 'PSD'],
    ].map((extensions) => ({
      extensions,
      decode: async () => {
        throw Error(`Unsupported diagnostic Artemis ${extensions[0]} rule image`);
      },
    })),
  ]);
  const transition = new ArtemisTransition(hash, {
    captureMode: () => 0,
    commit: () => stage.commit(),
    enterRunMode: (mode) => {
      effects.push({kind: 'runMode', mode, simulation: true});
      (runMode?.enter ?? refuseRunMode)(mode);
    },
    releaseRunMode: () => {
      effects.push({kind: 'runModeRelease', simulation: true});
      (runMode?.release ?? refuseRunMode)();
    },
    now: () => runMode?.now() ?? refuseRunMode(),
    setWaitStart: (ms) => effects.push({kind: 'waitStart', ms, simulation: true}),
    skipState: () => runMode?.skipState() ?? refuseRunMode(),
    setTransitionState: (value) => {
      transitionState = value;
    },
    setCrossfade: (value) => effects.push({kind: 'crossfade', value, simulation: true}),
    stageSize: () => {
      if (!runMode?.stageSize) throw Error('Unsupported diagnostic Artemis rule transition');
      return runMode.stageSize();
    },
    loadRule: async (path) => {
      const resource = await ruleSource.load(path);
      const image = resource?.image ?? null;
      effects.push({
        kind: 'ruleLoad',
        path: resource?.path ?? null,
        format: image?.format ?? null,
        width: image?.width ?? null,
        height: image?.height ?? null,
        sha256: image ? createHash('sha256').update(image.pixels).digest('hex') : null,
      });
      return image;
    },
    setRuleImage: (image) => {
      stageRule = image;
      effects.push({kind: 'ruleImage', replaced: true});
    },
    ruleImage: () => {
      const {width, height} = runMode.stageSize();
      // Stage +0x50 is created with the stage at stage size, one gray byte per pixel.
      if (stageRule?.width !== width || stageRule?.height !== height)
        stageRule = {width, height, bytesPerPixel: 1, pixels: new Uint8Array(width * height)};
      effects.push({kind: 'ruleImage', replaced: false});
      return stageRule;
    },
    setVague: () => {},
    setRuleThreshold: () => {},
    registerTween: (tween) => {
      transitionTween = tween;
    },
    reportError: () => {
      throw Error('Unsupported diagnostic Artemis trans error report');
    },
  });
  const tweens = new ArtemisTweenRegistry(hash);
  let tweenSync = false,
    tweenFrames = 0;
  const layerTweens = new ArtemisLayerTweens(hash, layers.scene, tweens, layerCommands, {
    // Per-frame values update the actor geometry without one effect record per frame.
    applyImageProperties(id, actor, patch) {
      actor.display.apply(patch);
      Object.assign(actor.properties, patch);
      tweenFrames++;
    },
    layerNotFound: host.layerNotFound,
    enterRunMode: (mode) => {
      effects.push({kind: 'runMode', mode, simulation: true});
      tweenSync = true;
      (runMode?.enter ?? refuseRunMode)(mode);
    },
    endSyncWait: () => {
      effects.push({kind: 'tweenSyncEnd', simulation: true});
      tweenSync = false;
      (runMode?.release ?? refuseRunMode)();
    },
    deleteLayer: (tag, recordHistory) => {
      effects.push({kind: 'tweenDelete', id: tag.args.get('id'), simulation: true});
      layers.deleteLayer(tag.args.get('id') ?? '', recordHistory);
    },
    emitEvent: (tag) => {
      effects.push({kind: 'tweenEvent', id: tag.args.get('id'), simulation: true});
      if (!runMode?.emit) throw Error('Unsupported diagnostic Artemis tween event owner');
      runMode.emit(tag);
    },
    recordLayerProperties: host.recordLayerProperties,
  });
  return {
    /** Steps every registered layer tween and updates every video at the probe clock. */
    tickTweens: (now) => {
      tweens.tick(now);
      for (const video of videos.keys()) video.update(now);
    },
    /** wait video= frame check: layer `id` is a video layer that is still playing. */
    videoPlaying: (id) => layers.scene.entry(id)?.value?.video?.playing === true,
    get tweenSyncPending() {
      return tweenSync;
    },
    get tweensRegistered() {
      return tweens.size;
    },
    /** The global tween registry shared with text display tweens. */
    tweenRegistry: tweens,
    dispatchTween: (tag) => {
      effects.push({kind: 'tween', name: tag.name, id: tag.args.get('id'), simulation: true});
      return layerTweens.dispatch(tag);
    },
    hasLayer: (id) => !!layers.scene.entry(id),
    /** Runs the registered transition tween from `start` (nonzero uint32) to natural
     * completion and returns the completion tick. */
    finishTransition: (start) => {
      const tween = transitionTween;
      if (!tween || tween.done || !start) throw Error('No pending probe transition');
      const end = (start + tween.milliseconds) >>> 0;
      tween.tick(start);
      tween.tick(end);
      return end;
    },
    get transitionPending() {
      return !!transitionTween && !transitionTween.done;
    },
    attachMessageActor: (name, message, messageOwner) => {
      const actor = {
        id: ++sequence,
        kind: 'message',
        message,
        messageOwner,
        display: new ArtemisDisplayObject(hash),
        wrapper: {alpha: 1},
        properties: {},
      };
      messageOwner.retain(message);
      actors.add(actor);
      if (!layers.attachActor(name, actor))
        throw Error('Probe message scene attachment blocked: ' + name);
      effects.push({kind: 'messageAttach', id: name, simulation: true});
    },
    detachMessageActor: (name) => layers.detachActor(name),
    /** bf210 order: finish the registered transition tween, then replace the scene root. */
    reset: () => {
      transition.reset();
      if (transitionTween?.done) transitionTween = null;
      layers.reset();
      effects.push({kind: 'reset', simulation: true});
    },
    /** Save-object reset of the layer command registry. */
    clearLayerCommands: () => layerCommands.clearAll(),
    /** Save-object +0x68 layer command registry for the scenario save and load. */
    snapshotLayerCommands: () => layerCommands.snapshot(),
    restoreLayerCommands: (snapshot) => layerCommands.restore(snapshot),
    /** Invokes an actor's stored layer event callback; no pointer hit testing is simulated. */
    invokeLayerEvent: (id, type, sink) => {
      const actor = layers.scene.entry(id)?.value;
      if (!actor?.events) throw Error('Probe layer has no events: ' + id);
      if (!actor.events.isEnabled(type)) throw Error('Probe layer event disabled: ' + id);
      return actor.events.invoke(type, sink);
    },
    /** trans runs synchronously except rule loads, which return a promise. */
    dispatchTransition: (tag) => transition.dispatch(tag),
    accepts: (tag) =>
      ['lyc', 'lyprop', 'lydel', 'flip', 'lyevent', 'anime', 'animedel', 'video'].includes(
        tag.name,
      ),
    /** `recordHistory` false is the native replay flag of the scenario loader. */
    dispatch: (tag, recordHistory = true) =>
      tag.name === 'flip'
        ? Promise.resolve(stage.dispatch(tag))
        : tag.name === 'lyevent'
          ? Promise.resolve(layerEvents.dispatch(tag, !recordHistory))
          : layers.dispatch(tag, recordHistory),
    snapshot: () => ({
      mode: 'metadata-only fixture',
      pixelDecode: false,
      gpuPreparation: false,
      tweenFrames,
      presentation: false,
      loads,
      effects,
      layers: layers.scene.entries().map((entry) => ({
        id: entry.id,
        group: entry.acceptsChildren,
        path: entry.value?.path ?? null,
        width: entry.value?.width ?? null,
        height: entry.value?.height ?? null,
        properties: entry.value?.display.properties ?? null,
        // Frame map keys with frame paths; null marks the cycle end.
        animation: entry.value?.animation
          ? {
              ...entry.value.animation.state,
              frames: entry.value.animation
                .entries()
                .map(([time, frame]) => ({time, path: frame?.path ?? null})),
            }
          : null,
        shader: entry.value?.shader
          ? {
              name: entry.value.shader.shaderName,
              constants: entry.value.shader.constantValues(),
              textures: entry.value.shader.textureValues().map((texture) => ({
                name: texture.name,
                path: texture.resource.path,
              })),
            }
          : null,
        video: entry.value?.video
          ? {
              playing: entry.value.video.playing,
              mask: entry.value.video.hasMask,
              ...entry.value.video.frame,
              revision: entry.value.video.revision,
              pixelsSha256: createHash('sha256').update(entry.value.video.pixels).digest('hex'),
            }
          : null,
        events: entry.value?.events
          ? ['click', 'rollover', 'rollout', 'dragin', 'drag', 'dragout'].filter((type) =>
              entry.value.events.callback(type),
            )
          : [],
      })),
      layerCommands: [...layerCommands.snapshot()].map(([id, tags]) => ({
        id,
        commands: tags.map((tag) => Object.fromEntries(tag.args)),
      })),
    }),
    close: () => layers.close(),
  };
}
