import test from 'node:test';
import assert from 'node:assert/strict';
import {D3d11Lifetime, D3d11Object} from '../dist/native/d3d11/runtime/com.js';
import {D3d11StateCache} from '../dist/native/d3d11/runtime/states.js';

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
