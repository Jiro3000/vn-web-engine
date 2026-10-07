/** Read-only geometry fixture for control-flow probing. It never decodes pixels,
 * prepares GPU resources, displays game media or claims production rendering.
 */
import {ArtemisImageLoader} from '../dist/engines/artemis/image-loader.js';
import {ArtemisLayers} from '../dist/engines/artemis/layers.js';
import {ArtemisDisplayObject} from '../dist/engines/artemis/display-object.js';
import {ArtemisStage} from '../dist/engines/artemis/stage.js';
import {artemisRevision} from '../dist/engines/artemis/revision.js';
import {readJpegHeader} from '../dist/formats/jpeg/header.js';

export function createMetadataLayerFixture(hash, readFile) {
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
  return {
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
    accepts: (tag) => ['lyc', 'lyprop', 'lydel', 'flip'].includes(tag.name),
    dispatch: (tag) =>
      tag.name === 'flip' ? Promise.resolve(stage.dispatch(tag)) : layers.dispatch(tag),
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
      })),
    }),
    close: () => layers.close(),
  };
}
