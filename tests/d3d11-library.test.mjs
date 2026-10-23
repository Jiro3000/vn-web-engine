import test from 'node:test';
import assert from 'node:assert/strict';
import {NativeLibraryLoader} from '../dist/platform/native-libraries.js';
import {D3D11, D3D11_SDK_VERSION} from '../dist/native/d3d11/contract.js';
import {d3d11WebGl2Library} from '../dist/native/d3d11/library.js';

const INVALID = 0x80070057 | 0,
  UNSUPPORTED = 0x887a0004 | 0,
  REMOVED = 0x887a0005 | 0;
const bufferDesc = (extra = {}) => ({
  byteWidth: 16,
  usage: 0,
  bindFlags: 1,
  cpuAccessFlags: 0,
  miscFlags: 0,
  structureByteStride: 0,
  ...extra,
});
const textureDesc = (extra = {}) => ({
  width: 4,
  height: 4,
  mipLevels: 1,
  arraySize: 1,
  format: 65,
  sampleDesc: {count: 1, quality: 0},
  usage: 0,
  bindFlags: 0x28,
  cpuAccessFlags: 0,
  miscFlags: 0,
  ...extra,
});
function capabilityContext() {
  let lost = false;
  const deleted = [];
  const gl = {
    MAX_TEXTURE_SIZE: 0xd33,
    MAX_DRAW_BUFFERS: 0x8824,
    MAX_COLOR_ATTACHMENTS: 0x8cdf,
    MAX_VIEWPORT_DIMS: 0xd3a,
    MAX_TEXTURE_IMAGE_UNITS: 0x8872,
    CURRENT_PROGRAM: 0x8b8d,
    isContextLost: () => lost,
    getExtension: () => null,
    getParameter: (p) => {
      if (p === gl.MAX_TEXTURE_SIZE) return 16384;
      if (p === gl.MAX_DRAW_BUFFERS || p === gl.MAX_COLOR_ATTACHMENTS) return 8;
      if (p === gl.MAX_VIEWPORT_DIMS) return new Int32Array([16384, 16384]);
      if (p === gl.MAX_TEXTURE_IMAGE_UNITS) return 16;
      if (p === gl.CURRENT_PROGRAM) return null;
      throw Error('Unexpected capability ' + p);
    },
    deleteFramebuffer: (v) => deleted.push(['fbo', v]),
    deleteVertexArray: (v) => deleted.push(['vao', v]),
    deleteBuffer: (v) => deleted.push(['buffer', v]),
    deleteTexture: (v) => deleted.push(['texture', v]),
  };
  return {
    gl,
    deleted,
    lose: () => {
      lost = true;
    },
  };
}
function exportsFor(factory) {
  const loader = new NativeLibraryLoader([d3d11WebGl2Library(factory)], {
    locate: (fileName) => ({kind: 'system', fileName}),
  });
  const result = loader.load('D3D11.DLL');
  assert.equal(result.status, 'loaded');
  const exports = result.library.exports(D3D11);
  assert.ok(exports);
  return {loader, exports, handle: result.library};
}

test('D3D11 system exports validate SDK, driver, flags and ordered feature levels before host creation', () => {
  let calls = 0;
  const host = capabilityContext(),
    loaded = exportsFor(() => {
      calls++;
      return host.gl;
    });
  const create = (changes = {}) => {
    const p = {adapter: null, driver: 1, software: 0, flags: 0, levels: null, sdk: 7, ...changes};
    return loaded.exports.d3d11CreateDevice(
      p.adapter,
      p.driver,
      p.software,
      p.flags,
      p.levels,
      p.sdk,
    );
  };
  assert.equal(D3D11_SDK_VERSION, 7);
  for (const change of [
    {sdk: 6},
    {driver: 0},
    {software: 1},
    {levels: []},
    {levels: [0xbeef]},
    {levels: [0xb100]},
    {adapter: {}, driver: 1},
    {driver: 4, software: 0},
    {flags: NaN},
  ])
    assert.deepEqual(create(change), {
      hr: INVALID,
      device: null,
      featureLevel: 0,
      immediateContext: null,
    });
  assert.equal(create({flags: 2}).hr, 0x887a002d | 0);
  assert.equal(create({flags: 4}).hr, 0x80004001 | 0);
  assert.equal(create({levels: [0x9300]}).hr, UNSUPPORTED);
  assert.equal(calls, 0);
  const result = create({flags: 0x20, levels: [0xa000, 0xb000]});
  assert.equal(result.hr, 0);
  assert.equal(calls, 1);
  assert.equal(result.featureLevel, 0xa000);
  assert.equal(result.device.getFeatureLevel(), 0xa000);
  assert.equal(result.device.getCreationFlags(), 0x20);
  assert.equal(result.immediateContext.getType(), 0);
  assert.equal(result.immediateContext.getContextFlags(), 0);
  result.immediateContext.release();
  result.device.release();
  loaded.loader.free(loaded.handle);
  loaded.loader.dispose();
});

test('public D3D11 factories and immediate context preserve owned children after device/context caller release', () => {
  const host = capabilityContext(),
    loaded = exportsFor(() => host.gl),
    created = loaded.exports.d3d11CreateDevice(null, 1, 0, 0, null, 7),
    device = created.device,
    ctx = created.immediateContext;
  assert.equal(created.hr, 0);
  const alias = device.queryInterface('DB6F6DDB-AC77-4E88-8253-819DF9BBF140');
  assert.equal(alias.hr, 0);
  assert.equal(alias.value, device);
  alias.value.release();
  assert.deepEqual(device.createBuffer(bufferDesc(), null, true), {hr: 1, value: null});
  const initial = Uint8Array.from({length: 16}, (_, i) => i),
    source = device.createBuffer(bufferDesc(), {data: initial, rowPitch: 0, slicePitch: 0}).value,
    staging = device.createBuffer(
      bufferDesc({usage: 3, bindFlags: 0, cpuAccessFlags: 0x20000}),
      null,
    ).value;
  initial.fill(99);
  ctx.copyResource(staging, source);
  const mapped = ctx.map(staging, 0, 1, 0);
  assert.equal(mapped.hr, 0);
  assert.deepEqual(
    [...mapped.value.data],
    Array.from({length: 16}, (_, i) => i),
  );
  ctx.unmap(staging, 0);
  const tex = device.createTexture2D(textureDesc(), null).value,
    view = device.createRenderTargetView(tex, null).value;
  assert.ok(tex && view);
  tex.release();
  source.release();
  staging.release();
  assert.equal(device.checkFormatSupport(65).value, 0x2f320);
  assert.equal(device.checkFormatSupport(40).value, 0x11020);
  assert.deepEqual(device.checkFormatSupport(16), {hr: 0, value: 3});
  assert.deepEqual(device.checkFormatSupport(57), {hr: 0, value: 5});
  assert.deepEqual(device.checkFormatSupport(0), {hr: INVALID, value: null});
  device.release();
  ctx.release();
  const reacquired = view.getDevice(),
    resource = view.getResource(),
    context = reacquired.getImmediateContext();
  assert.equal(reacquired, device);
  assert.equal(resource, tex);
  assert.equal(context, ctx);
  assert.equal(context.getDevice(), device);
  device.release();
  resource.release();
  context.release();
  reacquired.release();
  view.release();
  assert.equal(device.queryInterface('db6f6ddb-ac77-4e88-8253-819df9bbf140').hr, 0x80004002 | 0);
  assert.ok(host.deleted.length > 0);
  assert.ok(host.deleted.every(([, object]) => object === null)); // No drawing or GPU allocations were faked.
  loaded.loader.free(loaded.handle);
  loaded.loader.dispose();
});

test('D3D11 creation and resource factories report unavailable or removed devices through HRESULTs', () => {
  for (const [factory, expected] of [
    [() => null, UNSUPPORTED],
    [
      () => {
        throw new RangeError('allocation');
      },
      0x8007000e | 0,
    ],
  ]) {
    const loaded = exportsFor(factory),
      r = loaded.exports.d3d11CreateDevice(null, 1, 0, 0, null, 7);
    assert.equal(r.hr, expected);
    assert.equal(r.device, null);
    loaded.loader.dispose();
  }
  const host = capabilityContext(),
    loaded = exportsFor(() => host.gl),
    r = loaded.exports.d3d11CreateDevice(null, 1, 0, 0, null, 7);
  host.lose();
  assert.equal(r.device.getDeviceRemovedReason(), REMOVED);
  assert.deepEqual(r.device.createBuffer(bufferDesc(), null), {hr: REMOVED, value: null});
  assert.deepEqual(r.device.createTexture2D(textureDesc(), null), {hr: REMOVED, value: null});
  assert.deepEqual(r.immediateContext.map({}, 0, 1, 0), {hr: INVALID, value: null});
  r.immediateContext.release();
  r.device.release();
  assert.equal(loaded.exports.d3d11CreateDevice(null, 1, 0, 0, null, 7).hr, REMOVED);
  loaded.loader.dispose();
});
