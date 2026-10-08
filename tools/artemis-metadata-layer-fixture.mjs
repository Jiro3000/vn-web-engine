/** Read-only geometry fixture for control-flow probing. It never decodes pixels,
 * prepares GPU resources, displays game media or claims production rendering.
 */
import {ArtemisImageLoader} from '../dist/engines/artemis/image-loader.js';
import {ArtemisLayers} from '../dist/engines/artemis/layers.js';
import {ArtemisLayerCommands} from '../dist/engines/artemis/layer-commands.js';
import {ArtemisLayerEventSlots, ArtemisLayerEvents} from '../dist/engines/artemis/layer-events.js';
import {ArtemisDisplayObject} from '../dist/engines/artemis/display-object.js';
import {ArtemisStage} from '../dist/engines/artemis/stage.js';
import {ArtemisTransition} from '../dist/engines/artemis/transition.js';
import {artemisRevision} from '../dist/engines/artemis/revision.js';
import {readJpegHeader} from '../dist/formats/jpeg/header.js';

/** `runMode` supplies the probe's run mode/wait owner for trans; absent owner refuses it. */
export function createMetadataLayerFixture(hash, readFile, runMode = null) {
  artemisRevision(hash);
  const loads = [],
    effects = [],
    actors = new Set();
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
    copyImageLayer(old) {
      if (!actors.has(old)) throw Error('Probe actor released');
      const actor = {
        ...old,
        id: ++sequence,
        display: old.display.copy(),
        properties: {...old.properties},
        events: old.events?.copy(),
      };
      if (actor.kind === 'message') actor.messageOwner.retain(actor.message);
      actors.add(actor);
      return actor;
    },
    applyImageProperties(id, actor, patch) {
      actor.display.apply(patch);
      if (patch.wrapperAlpha !== undefined) actor.wrapper.alpha = patch.wrapperAlpha;
      Object.assign(actor.properties, patch);
      effects.push({kind: 'properties', id, keys: Object.keys(patch), simulation: true});
    },
    releaseImageLayer(actor) {
      if (!actors.delete(actor)) throw Error('Probe actor released twice');
      if (actor.kind === 'message') actor.messageOwner.release(actor.message);
      effects.push({kind: 'release', actor: actor.id});
    },
    clearLayerCommands: (ids) => effects.push({kind: 'clearCommands', ids}),
    resetLayerCommands: (id) => effects.push({kind: 'resetCommands', id}),
    recordLayerProperties: (tag) =>
      effects.push({kind: 'recordProperties', id: tag.args.get('id')}),
    imageLoadFailed: (tag) => {
      throw Error('Probe image metadata missing: ' + tag.args.get('file'));
    },
    layerNotFound: (tag) => {
      throw Error('Probe layer missing: ' + tag.args.get('id'));
    },
  };
  const layers = new ArtemisLayers(hash, source, host);
  // lyevent history only; other layer commands are recorded as simulated effects above.
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
  let transitionTween = null;
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
      throw Error('Unsupported diagnostic Artemis rule transition');
    },
    loadRule: async () => {
      // Rule transitions need decoded gray pixels; this fixture never decodes pixels.
      throw Error('Unsupported diagnostic Artemis rule image decode');
    },
    setRuleImage: () => {},
    ruleImage: () => {
      throw Error('Unsupported diagnostic Artemis rule transition');
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
  return {
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
    /** Invokes an actor's stored layer event callback; no pointer hit testing is simulated. */
    invokeLayerEvent: (id, type, sink) => {
      const actor = layers.scene.entry(id)?.value;
      if (!actor?.events) throw Error('Probe layer has no events: ' + id);
      if (!actor.events.isEnabled(type)) throw Error('Probe layer event disabled: ' + id);
      return actor.events.invoke(type, sink);
    },
    /** trans runs synchronously except rule loads, which return a promise. */
    dispatchTransition: (tag) => transition.dispatch(tag),
    accepts: (tag) => ['lyc', 'lyprop', 'lydel', 'flip', 'lyevent'].includes(tag.name),
    dispatch: (tag) =>
      tag.name === 'flip'
        ? Promise.resolve(stage.dispatch(tag))
        : tag.name === 'lyevent'
          ? Promise.resolve(layerEvents.dispatch(tag))
          : layers.dispatch(tag),
    snapshot: () => ({
      mode: 'metadata-only fixture',
      pixelDecode: false,
      gpuPreparation: false,
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
        events: entry.value?.events
          ? ['click', 'rollover', 'rollout', 'dragin', 'drag', 'dragout'].filter((type) =>
              entry.value.events.callback(type),
            )
          : [],
      })),
      layerEventCommands: [...layerCommands.snapshot()].map(([id, tags]) => ({
        id,
        commands: tags.map((tag) => Object.fromEntries(tag.args)),
      })),
    }),
    close: () => layers.close(),
  };
}
