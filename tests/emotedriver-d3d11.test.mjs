import test from 'node:test';
import assert from 'node:assert/strict';
import {NativeLibraryLoader} from '../dist/platform/native-libraries.js';
import {EMOTE_DRIVER, EMOTE_DRIVER_D3D11} from '../dist/native/emotedriver/contract.js';
import {emoteDriverD3d11Library} from '../dist/native/emotedriver/library.js';
import {createEmoteMeshKernel} from '../dist/native/emotedriver/runtime/mesh/index.js';
import {buildPsb, emoteWinTree, resource} from './kirikiri-psb-fixtures.mjs';

const SHA = '80d28bd088dda8e97c7c47a9c664e55159f70505b0f9fde3158d8ce2a3e1e051';

/** Alternate D3D11 contract implementation; records synthetic draws, never GPU pixels. */
function nativeHost() {
  const created = [],
    calls = [],
    bindings = new Map();
  let failed = null;
  let depthState = null,
    stencilReference = 0;
  const object = (kind, desc = null, data = null) => {
    const value = {
      kind,
      desc,
      data: data?.slice(),
      references: 1,
      addRef() {
        assert.ok(this.references > 0);
        return ++this.references;
      },
      release() {
        assert.ok(this.references > 0);
        return --this.references;
      },
      getDesc: () => desc,
      getType: () => 3,
    };
    created.push(value);
    return value;
  };
  const factory = (kind, desc, data) =>
    failed === kind ? {hr: -1, value: null} : {hr: 0, value: object(kind, desc, data)};
  const device = object('device');
  for (const kind of [
    'createInputLayout',
    'createVertexShader',
    'createPixelShader',
    'createBlendState',
    'createDepthStencilState',
    'createRasterizerState',
    'createSamplerState',
  ])
    device[kind] = (desc) => factory(kind, desc);
  device.createBuffer = (desc, data) => factory('buffer', desc, data?.data);
  device.createTexture2D = (desc, data) => factory('texture', desc, data?.[0].data);
  for (const [name, kind] of [
    ['createShaderResourceView', 'srv'],
    ['createRenderTargetView', 'rtv'],
    ['createDepthStencilView', 'dsv'],
  ])
    device[name] = (source, desc) => {
      const result = factory(kind, desc);
      if (result.value) {
        source.addRef();
        const view = result.value,
          release = view.release;
        view.getResource = () => {
          source.addRef();
          return source;
        };
        view.release = () => {
          const count = release.call(view);
          if (count === 0) source.release();
          return count;
        };
      }
      return result;
    };
  const context = object('context');
  const clear = () => {
    for (const values of bindings.values()) for (const value of values) value.release();
    bindings.clear();
    depthState = null;
    stencilReference = 0;
  };
  const releaseContext = context.release;
  context.release = () => {
    const count = releaseContext.call(context);
    if (count === 0) clear();
    return count;
  };
  const bind = (key, values) => {
    const next = values.filter(Boolean);
    for (const value of next) value.addRef();
    for (const value of bindings.get(key) ?? []) value.release();
    bindings.set(key, next);
  };
  for (const name of [
    'psSetShaderResources',
    'psSetSamplers',
    'vsSetConstantBuffers',
    'psSetConstantBuffers',
  ])
    context[name] = (slot, values) => bind(name + slot, values);
  for (const name of [
    'iaSetInputLayout',
    'vsSetShader',
    'psSetShader',
    'rsSetState',
    'omSetBlendState',
    'omSetDepthStencilState',
  ])
    context[name] = (value) => bind(name, [value]);
  context.omSetRenderTargets = (views, depth) => bind('targets', [...views, depth]);
  context.omSetDepthStencilState = (value, reference) => {
    bind('omSetDepthStencilState', [value]);
    depthState = value;
    stencilReference = reference >>> 0;
    calls.push({method: 'depthStencil', desc: value?.getDesc(), reference: stencilReference});
  };
  context.omGetDepthStencilState = () => {
    depthState?.addRef();
    return {state: depthState, stencilRef: stencilReference};
  };
  context.iaSetVertexBuffers = (slot, values, strides, offsets) => {
    bind('vertices' + slot, values);
    calls.push({method: 'vertices', bytes: values[0].data.slice(), strides, offsets});
  };
  for (const name of [
    'rsSetViewports',
    'rsSetScissorRects',
    'clearRenderTargetView',
    'clearDepthStencilView',
    'iaSetPrimitiveTopology',
  ])
    context[name] = (...args) => calls.push({method: name, args});
  context.draw = (...args) => calls.push({method: 'draw', args});
  context.updateSubresource = (buffer, _sub, _box, data) => {
    buffer.data = data.slice();
  };
  context.clearState = clear;
  return {
    device,
    context,
    created,
    calls,
    fail: (kind) => {
      failed = kind;
    },
  };
}

function shaderStandins() {
  const reflection = (stage) => ({
    stage,
    flags: 0,
    creator: 'synthetic',
    buffers: [],
    resources: [],
  });
  return {
    vertex: Array.from({length: 12}, (_, i) => Uint8Array.of(i)),
    pixel: Array.from({length: 2077}, () => new Uint8Array()),
    vertexReflection: Array.from({length: 12}, () => reflection('vertex')),
    pixelReflection: Array.from({length: 2077}, () => reflection('pixel')),
    inputLayouts: Array.from({length: 12}, () => []),
  };
}

/** A synthetic PSB with one image and a real scalar stereo parameter. */
function imageFile({variableFrame = -30, maskType = 0} = {}) {
  const tree = emoteWinTree(),
    motion = tree.object.all_parts.motion.base;
  const layer = structuredClone(motion.layer[0]);
  Object.assign(layer, {
    type: 0,
    objTriPriority: 0,
    stencilType: 0,
    label: 'image',
    children: [],
    frameList: [
      {time: 0, type: 3, content: {mask: 2, src: 'tex', icon: 'eye', coord: [0, 0, 0]}},
      {time: 61, type: 2, content: {mask: 2, src: 'tex', icon: 'eye', coord: [61, 0, 0]}},
    ],
  });
  motion.layer = [layer];
  motion.priority = [
    {time: 0, type: 1, content: [0]},
    {time: 61, type: 1, content: null},
  ];
  motion.layerIndexMap = {image: 0};
  if (maskType) {
    const mask = {
      ...structuredClone(layer),
      type: 12,
      label: 'mask',
      stencilType: maskType,
      stencilCompositeMaskLayerList: [],
      children: [layer],
    };
    motion.layer = [mask];
    motion.layerIndexMap = {mask: 0, image: 1};
    motion.priority = [
      {time: 0, type: 1, content: [0, 1]},
      {time: 61, type: 1, content: null},
    ];
  }
  Object.assign(tree.source.tex.texture, {
    type: 'RGBA8',
    width: 4,
    height: 4,
    pixel: resource(new Uint8Array(64).fill(255)),
  });
  delete tree.source.tex.texture.mipMap;
  delete tree.source.tex.texture.mipMapLevel;
  Object.assign(tree.source.tex.icon.eye, {
    left: 0,
    top: 0,
    width: 2,
    height: 2,
    originX: 0,
    originY: 0,
    resolution: 1,
  });
  tree.metadata = {
    format: 'emote',
    version: 1,
    base: {chara: 'all_parts', motion: 'base'},
    mirror: 0,
    scale: 1,
    bustControl: [],
    hairControl: [],
    partsControl: [],
    eyeControl: [],
    eyebrowControl: [],
    mouthControl: [],
    transitionControl: [],
    clampControl: [],
    mirrorControl: {variableMatchList: []},
    timelineControl: [],
    stereovisionControl: {variableMatchList: ['head_LR']},
    variableList: [{label: 'head_LR', frameList: [{label: 'left', frame: variableFrame}]}],
  };
  return buildPsb(tree);
}

function load(wasm) {
  const kernel = createEmoteMeshKernel({driverSha256: SHA, wasm});
  assert.equal(kernel.accelerated, wasm);
  const loader = new NativeLibraryLoader(
    [emoteDriverD3d11Library({shaders: shaderStandins(), kernel})],
    {
      locate: (fileName) => ({kind: 'image', fileName, sha256: SHA}),
    },
  );
  const loaded = loader.load('emotedriver.dll');
  assert.equal(loaded.status, 'loaded');
  return {loader, library: loaded.library, exports: loaded.library.exports(EMOTE_DRIVER_D3D11)};
}

test('x64 native exports retain independent player cores and shared clone resources on both kernels', () => {
  for (const wasm of [false, true]) {
    const host = nativeHost(),
      loaded = load(wasm);
    assert.equal(loaded.library.exports(EMOTE_DRIVER), null);
    assert.equal(loaded.exports.emoteGetSDKVersion(), '3.9.8');
    assert.equal(loaded.exports.emoteGetBuildDateTime(), '2022/12/28-13:02:35');
    const device = loaded.exports.emoteCreate(host);
    assert.equal(host.device.references, 2);
    assert.equal(host.context.references, 2);
    const bytes = imageFile(),
      before = bytes.slice(),
      player = device.createPlayer(bytes);
    assert.ok(player);
    assert.deepEqual(bytes, before);
    assert.equal(device.refCount(), 2);
    assert.equal(player.refCount(), 1);
    assert.equal(player.getSmoothing(), true);
    assert.equal(host.created.filter((r) => r.kind === 'texture').length, 1);
    player.setVariable('head_LR', 4, 0, 0);
    player.setCoord(12, -4, 0, 0);
    player.progress(0);
    const resources = host.created.length,
      clone = player.clone();
    assert.equal(host.created.length, resources);
    assert.equal(device.refCount(), 3);
    assert.equal(clone.getVariable('head_LR'), 4);
    assert.deepEqual(clone.getCoord(), {x: 12, y: -4});
    clone.setVariable('head_LR', 8, 0, 0);
    assert.equal(player.getVariable('head_LR'), 4);
    clone.setSmoothing(false);
    assert.equal(player.getSmoothing(), false);
    clone.startRecordAPILog();
    clone.setCoord(1, 2, 0, 0);
    assert.match(clone.getAPILog(), /^SetCoord 1\.000000 2\.000000 /);
    assert.equal(player.getAPILog(), '');
    clone.initCore();
    assert.equal(clone.getVariable('head_LR'), 0);
    assert.equal(clone.getAPILog(), '');
    assert.equal(clone.getSmoothing(), false);
    assert.equal(host.created.length, resources);
    clone.assignState(player);
    assert.equal(clone.getVariable('head_LR'), 4);
    assert.equal(player.addRef(), 2);
    assert.equal(player.release(), 1);
    assert.equal(device.release(), 2);
    assert.equal(player.release(), 0);
    clone.progress(1);
    assert.equal(clone.getVariable('head_LR'), 4);
    assert.equal(clone.release(), 0);
    assert.equal(device.refCount(), 0);
    assert.equal(host.device.references, 1);
    assert.equal(host.context.references, 1);
    assert.ok(host.created.slice(2).every((r) => r.references === 0));
    assert.throws(() => clone.progress(0), /released/);
    loaded.loader.dispose();
    host.context.release();
    host.device.release();
  }
});

test('x64 public Render uses the selected evaluated clip and caller target without advancing clocks', () => {
  const host = nativeHost(),
    loaded = load(false),
    device = loaded.exports.emoteCreate(host);
  const player = device.createPlayer(imageFile());
  const texture = host.device.createTexture2D({width: 32, height: 24}, null).value;
  const view = host.device.createRenderTargetView(texture, null).value;
  device.setRenderTarget(view, null);
  assert.equal(host.calls.length, 0);
  assert.equal(view.references, 2);
  player.setStereovisionEnabled(true);
  player.progress(0);
  player.startRecordAPILog();
  player.setStereovisionRenderScreen(0);
  player.render();
  const first = host.calls.find((r) => r.method === 'vertices').bytes;
  assert.equal(host.calls.filter((r) => r.method === 'rsSetViewports').length, 0);
  host.calls.length = 0;
  player.setStereovisionRenderScreen(1);
  player.render();
  assert.notDeepEqual(host.calls.find((r) => r.method === 'vertices').bytes, first);
  assert.equal(player.getAPILog(), '');
  assert.equal(host.calls.filter((r) => r.method === 'draw').length, 1);
  const count = host.created.length;
  player.hide();
  player.progress(0);
  host.calls.length = 0;
  player.render();
  assert.equal(host.calls.filter((r) => r.method === 'draw').length, 0);
  assert.equal(host.created.length, count);
  player.release();
  device.release();
  host.context.clearState();
  view.release();
  texture.release();
  assert.ok(host.created.slice(2).every((r) => r.references === 0));
  loaded.loader.dispose();
  host.context.release();
  host.device.release();
});

test('x64 file groups use the last motion metadata and retain their resource clock across clone and InitCore', () => {
  const host = nativeHost(),
    loaded = load(false),
    device = loaded.exports.emoteCreate(host);
  const now = Date.now;
  let seeds = 0;
  Date.now = () => {
    seeds++;
    return 1700000000123;
  };
  try {
    const player = device.createPlayers([imageFile(), imageFile({variableFrame: 14})]);
    assert.equal(seeds, 1);
    assert.equal(player.getVariableFrameValueAt(0, 0), 14);
    const clone = player.clone();
    clone.initCore();
    assert.equal(seeds, 1);
    const other = device.createPlayer(imageFile());
    assert.equal(seeds, 2);
    assert.equal(other.getVariableFrameValueAt(0, 0), -30);
    assert.equal(host.created.filter((r) => r.kind === 'texture').length, 3);
    player.release();
    clone.release();
    other.release();
    device.release();
    assert.ok(host.created.slice(2).every((r) => r.references === 0));
  } finally {
    Date.now = now;
  }
  loaded.loader.dispose();
  host.context.release();
  host.device.release();
});

test('x64 public construction failures retire partially created native resources', () => {
  const loaded = load(false),
    host = nativeHost();
  host.fail('createPixelShader');
  assert.throws(() => loaded.exports.emoteCreate(host), /resource creation failed/);
  assert.equal(host.device.references, 1);
  assert.equal(host.context.references, 1);
  assert.ok(host.created.slice(2).every((r) => r.references === 0));
  host.fail(null);
  const device = loaded.exports.emoteCreate(host);
  const before = host.created.length;
  host.fail('texture');
  assert.throws(() => device.createPlayer(imageFile()), /texture creation failed/);
  assert.equal(device.refCount(), 1);
  assert.ok(host.created.slice(before).every((r) => r.references === 0));
  device.release();
  loaded.loader.dispose();
  host.context.release();
  host.device.release();
});

test('native mask-mode words are shared by live devices and reset with their DLL motion state', () => {
  const loaded = load(false),
    host = nativeHost();
  const a = loaded.exports.emoteCreate(host),
    b = loaded.exports.emoteCreate(host);
  assert.equal(a.getMaskMode(), 1);
  a.setMaskMode(0);
  assert.equal(b.getMaskMode(), 0);
  b.setMaskMode(0x100000001);
  assert.equal(a.getMaskMode(), 1);
  a.setMaskMode(0xffffffff);
  assert.equal(b.getMaskMode(), -1);
  const isolated = load(false),
    other = isolated.exports.emoteCreate(host);
  assert.equal(other.getMaskMode(), 1);
  other.release();
  isolated.loader.dispose();
  a.release();
  b.release();
  const fresh = loaded.exports.emoteCreate(host);
  assert.equal(fresh.getMaskMode(), 1);
  fresh.release();
  loaded.loader.dispose();
  host.context.release();
  host.device.release();
  assert.ok(host.created.slice(2).every((r) => r.references === 0));
});

test('public stencil masks clear and count through the native depth-stencil and alpha shaders', () => {
  for (const maskType of [1, 2]) {
    const host = nativeHost(),
      loaded = load(false),
      device = loaded.exports.emoteCreate(host);
    const player = device.createPlayer(imageFile({maskType}));
    const texture = host.device.createTexture2D({width: 4, height: 4, format: 28}, null).value;
    const view = host.device.createRenderTargetView(texture, null).value;
    const depth = host.device.createTexture2D({width: 4, height: 4, format: 45}, null).value;
    const dsv = host.device.createDepthStencilView(depth, {
      format: 45,
      viewDimension: 3,
      flags: 0,
      mipSlice: 0,
    }).value;
    device.setRenderTarget(view, dsv);
    device.setMaskMode(0);
    player.progress(0);
    player.render();
    assert.ok(
      host.calls.some(
        (c) =>
          c.method === 'clearDepthStencilView' &&
          c.args[1] === 2 &&
          c.args[3] === (maskType === 2 ? 1 : 0),
      ),
    );
    const states = host.calls.filter((c) => c.method === 'depthStencil');
    assert.ok(
      states.some(
        (c) =>
          c.desc?.stencilEnable &&
          c.desc.frontFace.stencilFunc === 3 &&
          c.desc.frontFace.stencilPassOp === (maskType === 1 ? 7 : 8) &&
          c.reference === (maskType === 2 ? 1 : 0),
      ),
    );
    assert.ok(
      states.some(
        (c) => c.desc?.stencilEnable && c.desc.frontFace.stencilPassOp === 1 && c.reference === 1,
      ),
    );
    assert.equal(states.at(-1).desc.stencilEnable, false);
    const draw = host.context.draw;
    host.context.draw = () => {
      throw new Error('synthetic stencil draw failure');
    };
    assert.throws(() => player.render(), /stencil draw failure/);
    assert.equal(
      host.calls.filter((c) => c.method === 'depthStencil').at(-1).desc.stencilEnable,
      false,
    );
    host.context.draw = draw;
    device.setMaskMode(99);
    assert.equal(device.getMaskMode(), 99);
    assert.throws(() => player.render(), /mask mode 99/);
    device.setMaskMode(0);
    player.render();
    player.release();
    device.release();
    host.context.clearState();
    dsv.release();
    depth.release();
    view.release();
    texture.release();
    assert.ok(host.created.slice(2).every((r) => r.references === 0));
    loaded.loader.dispose();
    host.context.release();
    host.device.release();
  }
});
