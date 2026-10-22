import test from 'node:test';
import assert from 'node:assert/strict';
import {D3d11ChildObject, D3d11Lifetime, D3d11Object} from '../dist/native/d3d11/runtime/com.js';
import {D3d11StateCache} from '../dist/native/d3d11/runtime/states.js';
import {D3d11ContextState} from '../dist/native/d3d11/runtime/context-state.js';
import {
  createBufferStorage,
  createTexture2DStorage,
} from '../dist/native/d3d11/runtime/resources.js';
import {
  createShaderResourceViewStorage,
  createRenderTargetViewStorage,
  createDepthStencilViewStorage,
} from '../dist/native/d3d11/runtime/views.js';

const INVALID = 0x80070057 | 0;
function owner(disposeBindings = () => {}) {
  const lifetime = new D3d11Lifetime(disposeBindings),
    events = [];
  const device = new D3d11Object(lifetime, [], () => events.push('device'), true);
  return {lifetime, device, events};
}
const target = () => ({
  blendEnable: false,
  srcBlend: 0,
  destBlend: 0,
  blendOp: 0,
  srcBlendAlpha: 0,
  destBlendAlpha: 0,
  blendOpAlpha: 0,
  renderTargetWriteMask: 15,
});
const blend = () => ({
  alphaToCoverageEnable: false,
  independentBlendEnable: false,
  renderTarget: Array.from({length: 8}, target),
});
const face = () => ({stencilFailOp: 0, stencilDepthFailOp: 0, stencilPassOp: 0, stencilFunc: 0});
const depth = () => ({
  depthEnable: false,
  depthWriteMask: 0,
  depthFunc: 0,
  stencilEnable: false,
  stencilReadMask: 255,
  stencilWriteMask: 255,
  frontFace: face(),
  backFace: face(),
});
const raster = () => ({
  fillMode: 3,
  cullMode: 1,
  frontCounterClockwise: false,
  depthBias: 0,
  depthBiasClamp: 0,
  slopeScaledDepthBias: 0,
  depthClipEnable: true,
  scissorEnable: false,
  multisampleEnable: false,
  antialiasedLineEnable: false,
});
const sampler = () => ({
  filter: 0,
  addressU: 3,
  addressV: 3,
  addressW: 3,
  mipLodBias: 0,
  maxAnisotropy: 0,
  comparisonFunc: 0,
  borderColor: [0, 0, 0, 0],
  minLod: 0,
  maxLod: Math.fround(3.4028234663852886e38),
});

test('D3D11 state creation interns identical descriptors with independently owned references', () => {
  const host = owner(),
    cache = new D3d11StateCache(host),
    desc = blend();
  const a = cache.createBlendState(desc).value;
  desc.renderTarget[0].renderTargetWriteMask = 0;
  const b = cache.createBlendState(blend()).value;
  assert.equal(a, b);
  const copied = a.getDesc();
  copied.renderTarget[0].renderTargetWriteMask = 7;
  copied.renderTarget.pop();
  assert.equal(b.getDesc().renderTarget.length, 8);
  assert.equal(b.getDesc().renderTarget[0].renderTargetWriteMask, 15);
  assert.ok(Object.isFrozen(a.description.renderTarget[0]));
  assert.equal(a.release(), 1);
  assert.equal(b.release(), 0);
  const c = cache.createBlendState(blend()).value;
  assert.notEqual(c, a);
  c.release();
  host.device.release();
  assert.equal(host.lifetime.closed, true);
});

test('D3D11 state interfaces expose only their own IID and keep device access alive through children', () => {
  const host = owner(),
    cache = new D3d11StateCache(host);
  const state = cache.createDepthStencilState(depth()).value;
  const alias = state.queryInterface('03823EFB-8D8F-4E1C-9AA2-F64BB2CBFDF1');
  assert.equal(alias.value, state);
  alias.value.release();
  assert.equal(state.queryInterface('75b68faa-347d-4159-8f45-a0640f01cd9a').hr, 0x80004002 | 0);
  host.device.release();
  assert.equal(host.lifetime.closed, false);
  assert.equal(state.getDevice(), host.device);
  host.device.release();
  state.release();
  assert.equal(host.lifetime.closed, true);
  assert.deepEqual(host.events, ['device']);
});

test('D3D11 state descriptors retain native float32 values and owned nested arrays', () => {
  const host = owner(),
    cache = new D3d11StateCache(host);
  const desc = sampler();
  desc.minLod = 1 + 2 ** -30;
  desc.mipLodBias = -0;
  const a = cache.createSamplerState(desc).value;
  const b = cache.createSamplerState({...desc, minLod: 1}).value;
  assert.equal(a, b);
  assert.equal(a.getDesc().minLod, 1);
  assert.ok(Object.is(a.getDesc().mipLodBias, -0));
  desc.borderColor[0] = 1;
  const output = a.getDesc();
  output.borderColor[1] = 1;
  assert.deepEqual(a.getDesc().borderColor, [0, 0, 0, 0]);
  const r = cache.createRasterizerState({...raster(), depthBiasClamp: 1 + 2 ** -30}).value;
  assert.equal(r.getDesc().depthBiasClamp, 1);
  a.release();
  b.release();
  r.release();
  host.device.release();
});

test('D3D11 state validation respects inactive fields without accepting invalid active descriptions', () => {
  const host = owner(),
    cache = new D3d11StateCache(host);
  for (const [method, desc] of [
    ['createBlendState', blend()],
    ['createDepthStencilState', depth()],
    ['createRasterizerState', raster()],
    ['createSamplerState', sampler()],
  ]) {
    assert.deepEqual(cache[method](desc, true), {hr: 1, value: null});
    const state = cache[method](desc).value;
    assert.ok(state);
    state.release();
  }
  const badBlend = blend();
  badBlend.renderTarget[0].blendEnable = true;
  assert.equal(cache.createBlendState(badBlend).hr, INVALID);
  const badDepth = depth();
  badDepth.depthEnable = true;
  assert.equal(cache.createDepthStencilState(badDepth).hr, INVALID);
  const badStencil = depth();
  badStencil.stencilEnable = true;
  assert.equal(cache.createDepthStencilState(badStencil).hr, INVALID);
  assert.equal(cache.createSamplerState({...sampler(), filter: 128}).hr, INVALID);
  assert.equal(cache.createSamplerState({...sampler(), filter: 85}).hr, INVALID);
  assert.equal(cache.createSamplerState({...sampler(), maxLod: -1}).hr, INVALID);
  assert.equal(
    cache.createSamplerState({...sampler(), addressU: 4, borderColor: [2, 0, 0, 0]}).hr,
    INVALID,
  );
  assert.equal(cache.createRasterizerState({...raster(), depthBias: 0.5}).hr, INVALID);
  assert.equal(
    cache.createRasterizerState({...raster(), slopeScaledDepthBias: Infinity}).hr,
    INVALID,
  );
  const comparison = cache.createSamplerState({
    ...sampler(),
    filter: 213,
    maxAnisotropy: 16,
    comparisonFunc: 8,
  }).value;
  assert.ok(comparison);
  comparison.release();
  host.device.release();
  assert.equal(host.lifetime.closed, true);
});

test('D3D11 state caches enforce the native per-kind limit and reclaim retired entries', () => {
  const host = owner(),
    cache = new D3d11StateCache(host),
    states = [];
  for (let i = 0; i < 4096; i++)
    states.push(cache.createRasterizerState({...raster(), depthBias: i}).value);
  assert.ok(states.every(Boolean));
  assert.deepEqual(cache.createRasterizerState({...raster(), depthBias: 4096}), {
    hr: 0x887c0001 | 0,
    value: null,
  });
  const alias = cache.createRasterizerState({...raster(), depthBias: 0}).value;
  assert.equal(alias, states[0]);
  alias.release();
  assert.deepEqual(cache.createRasterizerState({...raster(), depthBias: 4096}, true), {
    hr: 1,
    value: null,
  });
  const otherKind = cache.createBlendState(blend()).value;
  assert.ok(otherKind);
  otherKind.release();
  states[0].release();
  const replacement = cache.createRasterizerState({...raster(), depthBias: 4096}).value;
  assert.ok(replacement);
  replacement.release();
  for (const state of states.slice(1)) state.release();
  host.device.release();
  assert.equal(host.lifetime.closed, true);
});

test('a pipeline-bound D3D11 state is not kept alive by its interning cache after final teardown', () => {
  let binding;
  const host = owner(() => binding.releaseBinding()),
    cache = new D3d11StateCache(host);
  binding = cache.createBlendState(blend()).value;
  binding.retainBinding();
  binding.release();
  assert.equal(binding.live, true);
  host.device.release();
  assert.equal(binding.live, false);
  assert.equal(cache.createBlendState(blend(), true).hr, INVALID);
});

function context() {
  let ctx;
  const host = owner(() => ctx.disposeBindings());
  host.destroyed = [];
  host.resourceDestroyed = (value) => host.destroyed.push(value);
  ctx = new D3d11ContextState(host);
  return {host, ctx, cache: new D3d11StateCache(host)};
}
const buffer = (host, bindFlags) =>
  createBufferStorage(
    host,
    {byteWidth: 32, usage: 0, bindFlags, cpuAccessFlags: 0, miscFlags: 0, structureByteStride: 0},
    null,
  ).value;
const texture = (host, changes = {}) =>
  createTexture2DStorage(
    host,
    {
      width: 8,
      height: 8,
      mipLevels: 0,
      arraySize: 1,
      format: 61,
      sampleDesc: {count: 1, quality: 0},
      usage: 0,
      bindFlags: 0x28,
      cpuAccessFlags: 0,
      miscFlags: 0,
      ...changes,
    },
    null,
  ).value;

test('D3D11 constant-buffer bindings preserve aliases, own getters and atomic rejection of foreign devices', () => {
  const {host, ctx} = context(),
    foreign = context();
  const a = buffer(host, 4),
    other = buffer(foreign.host, 4);
  ctx.vsSetConstantBuffers(0, [a, a]);
  a.release();
  ctx.vsSetConstantBuffers(0, [a, a]);
  assert.throws(() => ctx.vsSetConstantBuffers(0, [null, other]), /foreign/);
  const aliases = ctx.vsGetConstantBuffers(0, 2);
  assert.deepEqual(aliases, [a, a]);
  ctx.clearState();
  assert.deepEqual(host.destroyed, []);
  aliases.forEach((v) => v.release());
  assert.deepEqual(host.destroyed, [a]);
  assert.deepEqual(ctx.vsGetConstantBuffers(14, 0), []);
  assert.throws(() => ctx.psGetConstantBuffers(14, 1), /slots/);
  other.release();
  foreign.ctx.release();
  foreign.host.device.release();
  ctx.release();
  host.device.release();
  assert.equal(host.lifetime.closed, true);
});

test('D3D11 shader and input-layout bindings keep their own interface identities through clear-state', () => {
  const {host, ctx} = context(),
    retired = [];
  const vs = new D3d11ChildObject(host, ['3b301d64-d678-4289-8897-22f8928b72f3'], () =>
    retired.push('vs'),
  );
  const ps = new D3d11ChildObject(host, ['ea82e40d-51dc-4f33-93d4-db7c9125ae8c'], () =>
    retired.push('ps'),
  );
  const layout = new D3d11ChildObject(host, ['e4819ddc-4cf0-4025-bd26-5de82a3e07b7'], () =>
    retired.push('layout'),
  );
  ctx.vsSetShader(vs, []);
  ctx.psSetShader(ps, []);
  ctx.iaSetInputLayout(layout);
  assert.throws(() => ctx.vsSetShader(ps, []), /shader/);
  assert.throws(() => ctx.psSetShader(ps, [{}]), /class instances/);
  vs.release();
  ps.release();
  layout.release();
  const ownedVs = ctx.vsGetShader();
  assert.equal(ownedVs.shader, vs);
  assert.deepEqual(ownedVs.classInstances, []);
  const ownedLayout = ctx.iaGetInputLayout();
  assert.equal(ownedLayout, layout);
  ownedLayout.release();
  ctx.clearState();
  assert.deepEqual(retired, ['ps', 'layout']);
  ownedVs.shader.release();
  assert.deepEqual(retired, ['ps', 'layout', 'vs']);
  ctx.release();
  host.device.release();
});

test('D3D11 input assembler copies layouts and validates a whole binding update before replacing buffers', () => {
  const {host, ctx} = context();
  const vertices = buffer(host, 1),
    indices = buffer(host, 2),
    strides = [16, 0],
    offsets = [4, 8];
  ctx.iaSetVertexBuffers(2, [vertices, vertices], strides, offsets);
  ctx.iaSetIndexBuffer(indices, 57, 2);
  strides[0] = 8;
  offsets[0] = 12;
  vertices.release();
  indices.release();
  assert.throws(
    () => ctx.iaSetVertexBuffers(2, [null, indices], [16, 16], [0, 0]),
    /buffer binding/,
  );
  assert.throws(() => ctx.iaSetVertexBuffers(2, [null], [2049], [0]), /layout/);
  const state = ctx.iaGetVertexBuffers(2, 2);
  assert.deepEqual(state.strides, [16, 0]);
  assert.deepEqual(state.offsets, [4, 8]);
  state.strides[0] = 4;
  state.buffers.forEach((v) => v.release());
  const ib = ctx.iaGetIndexBuffer();
  assert.equal(ib.buffer, indices);
  assert.equal(ib.format, 57);
  assert.equal(ib.offset, 2);
  ib.buffer.release();
  ctx.iaSetPrimitiveTopology(5);
  assert.equal(ctx.iaGetPrimitiveTopology(), 5);
  ctx.clearState();
  assert.equal(ctx.iaGetPrimitiveTopology(), 0);
  assert.deepEqual(ctx.iaGetVertexBuffers(2, 2), {
    buffers: [null, null],
    strides: [0, 0],
    offsets: [0, 0],
  });
  assert.deepEqual(host.destroyed, [vertices, indices]);
  ctx.release();
  host.device.release();
});

test('D3D11 output binding clears only overlapping mip views and rejects duplicate or mismatched render targets atomically', () => {
  const {host, ctx} = context(),
    image = texture(host);
  const srv = (mip) =>
    createShaderResourceViewStorage(host, image, {
      format: 61,
      viewDimension: 4,
      texture2D: {mostDetailedMip: mip, mipLevels: 1},
    }).value;
  const rtv = (mip) =>
    createRenderTargetViewStorage(host, image, {
      format: 61,
      viewDimension: 4,
      texture2D: {mipSlice: mip},
    }).value;
  const a = srv(0),
    b = srv(1),
    out0 = rtv(0),
    out1 = rtv(1);
  const viewport = {topLeftX: 0, topLeftY: 0, width: 8, height: 8, minDepth: 0, maxDepth: 1};
  ctx.rsSetViewports([viewport]);
  ctx.psSetShaderResources(0, [a, b]);
  ctx.omSetRenderTargets([out0], null);
  let reads = ctx.psGetShaderResources(0, 2);
  assert.deepEqual(reads, [null, b]);
  reads[1].release();
  ctx.psSetShaderResources(0, [a]);
  assert.deepEqual(ctx.psGetShaderResources(0, 1), [null]);
  ctx.omSetRenderTargets([out1], null);
  assert.deepEqual(ctx.psGetShaderResources(0, 2), [null, null]);
  assert.throws(() => ctx.omSetRenderTargets([out0, out0], null), /Incompatible/);
  assert.throws(() => ctx.omSetRenderTargets([out0, out1], null), /Incompatible/);
  const outputs = ctx.omGetRenderTargets(2);
  assert.deepEqual(outputs.views, [out1, null]);
  outputs.views[0].release();
  assert.deepEqual(ctx.rsGetViewports(), [viewport]);
  ctx.omSetRenderTargets([], null);
  ctx.psSetShaderResources(0, [a, b]);
  const depthImage = texture(host, {mipLevels: 1, format: 45, bindFlags: 0x40});
  const depthView = createDepthStencilViewStorage(host, depthImage, null).value;
  ctx.omSetRenderTargets([out0], depthView);
  const depthAlias = ctx.omGetRenderTargets(0);
  assert.deepEqual(depthAlias.views, []);
  assert.equal(depthAlias.depthStencilView, depthView);
  depthAlias.depthStencilView.release();
  ctx.clearState();
  for (const v of [a, b, out0, out1, depthView, image, depthImage]) v.release();
  ctx.release();
  host.device.release();
  assert.equal(host.lifetime.closed, true);
});

test('D3D11 context state getters copy values, retain interfaces and restore every covered default on clear', () => {
  const {host, ctx, cache} = context();
  const blendState = cache.createBlendState(blend()).value,
    depthState = cache.createDepthStencilState(depth()).value;
  const rasterState = cache.createRasterizerState(raster()).value,
    samplerState = cache.createSamplerState(sampler()).value;
  const factor = [0.1, 0.2, 0.3, 0.4];
  ctx.omSetBlendState(blendState, factor, 0x55);
  ctx.omSetDepthStencilState(depthState, 0x1234);
  ctx.rsSetState(rasterState);
  ctx.psSetSamplers(3, [samplerState]);
  factor[0] = 1;
  ctx.rsSetScissorRects([{left: -2, top: 3, right: 7, bottom: 9}]);
  const rects = ctx.rsGetScissorRects();
  rects[0].right = 1;
  assert.equal(ctx.rsGetScissorRects()[0].right, 7);
  const b = ctx.omGetBlendState();
  assert.deepEqual(b.blendFactor, [0.1, 0.2, 0.3, 0.4].map(Math.fround));
  b.state.release();
  const d = ctx.omGetDepthStencilState();
  assert.equal(d.stencilRef, 0x1234);
  d.state.release();
  const r = ctx.rsGetState();
  assert.equal(r, rasterState);
  r.release();
  const s = ctx.psGetSamplers(3, 1);
  assert.equal(s[0], samplerState);
  s[0].release();
  assert.throws(() => ctx.omSetBlendState(blendState, [NaN, 0, 0, 0], 0), /factors/);
  for (const state of [blendState, depthState, rasterState, samplerState]) state.release();
  ctx.clearState();
  assert.deepEqual(ctx.omGetBlendState(), {
    state: null,
    blendFactor: [1, 1, 1, 1],
    sampleMask: 0xffffffff,
  });
  assert.deepEqual(ctx.omGetDepthStencilState(), {state: null, stencilRef: 0});
  assert.equal(ctx.rsGetState(), null);
  assert.deepEqual(ctx.psGetSamplers(3, 1), [null]);
  assert.deepEqual(ctx.rsGetScissorRects(), []);
  assert.deepEqual(ctx.rsGetViewports(), []);
  assert.equal(ctx.getType(), 0);
  assert.equal(ctx.getContextFlags(), 0);
  ctx.release();
  host.device.release();
});

test('D3D11 context teardown releases all bound resources and resets state even if multiple host disposals throw', () => {
  const {host, ctx} = context();
  host.resourceDestroyed = (resource) => {
    host.destroyed.push(resource);
    throw new Error('host disposal');
  };
  const a = buffer(host, 4),
    b = buffer(host, 4);
  ctx.vsSetConstantBuffers(0, [a, b]);
  a.release();
  b.release();
  assert.throws(
    () => ctx.clearState(),
    (e) => e instanceof AggregateError && e.errors.length === 2,
  );
  assert.deepEqual(host.destroyed, [a, b]);
  assert.deepEqual(ctx.vsGetConstantBuffers(0, 2), [null, null]);
  ctx.release();
  host.device.release();
  assert.equal(host.lifetime.closed, true);
});

test('last device/context release retires bound buffers, views and states without an explicit clear', () => {
  const {host, ctx, cache} = context(),
    constants = buffer(host, 4),
    image = texture(host);
  const view = createShaderResourceViewStorage(host, image, null).value;
  const state = cache.createBlendState(blend()).value;
  ctx.vsSetConstantBuffers(0, [constants]);
  ctx.psSetConstantBuffers(0, [constants]);
  ctx.psSetShaderResources(0, [view]);
  ctx.omSetBlendState(state, null, 0xffffffff);
  constants.release();
  image.release();
  view.release();
  state.release();
  ctx.release();
  assert.deepEqual(host.destroyed, []);
  assert.equal(view.live, true);
  assert.equal(state.live, true);
  host.device.release();
  assert.equal(host.lifetime.closed, true);
  assert.deepEqual(host.destroyed, [constants, image]);
  assert.equal(view.live, false);
  assert.equal(state.live, false);
  assert.throws(() => ctx.psGetShaderResources(0, 1), /released/);
});
