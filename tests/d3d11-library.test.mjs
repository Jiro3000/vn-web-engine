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

test('E-mote native shader programs upload named constants through the public device and retain context-owned bindings', async () => {
  const {EmoteD3d11Program} =
    await import('../dist/native/emotedriver/runtime/render/d3d11-program.js');
  const {sm4SyntheticPipeline} = await import('../tools/lib/sm4-synthetic-fixtures.mjs');
  const host = capabilityContext(),
    loaded = exportsFor(() => host.gl);
  const created = loaded.exports.d3d11CreateDevice(null, 1, 0, 0, null, 7),
    device = created.device,
    ctx = created.immediateContext,
    shaders = sm4SyntheticPipeline(false, true);
  const reflection = (stage, size) => ({
    stage,
    flags: 0,
    creator: 'generated',
    resources: [],
    buffers: [
      {
        name: '$Globals',
        bytes: size,
        flags: 0,
        bufferType: 0,
        slot: 0,
        variables: [
          {
            name: 'value',
            offset: stage === 'vertex' ? 16 : 0,
            bytes: 16,
            flags: 2,
            type: {variableClass: 1, rows: 1, columns: 4},
            defaultValue: null,
          },
        ],
      },
    ],
  });
  const layout = [
    {
      semanticName: 'POSITION',
      semanticIndex: 0,
      format: 6,
      inputSlot: 0,
      alignedByteOffset: 0,
      inputSlotClass: 0,
      instanceDataStepRate: 0,
    },
    {
      semanticName: 'COLOR',
      semanticIndex: 0,
      format: 87,
      inputSlot: 0,
      alignedByteOffset: 12,
      inputSlotClass: 0,
      instanceDataStepRate: 0,
    },
  ];
  const vertex = new EmoteD3d11Program(device, shaders.vertex, reflection('vertex', 32), layout),
    pixel = new EmoteD3d11Program(device, shaders.pixel, reflection('pixel', 16), null);
  let uploads = 0,
    reject = true;
  const original = ctx.updateSubresource;
  ctx.updateSubresource = function (...args) {
    if (reject) throw Error('injected upload failure');
    uploads++;
    return original.apply(this, args);
  };
  assert.equal(vertex.setFloats('missing', [1]), false);
  assert.equal(vertex.setFloats('value', [1], 'missing-buffer'), false);
  assert.throws(() => vertex.setFloats('value', [1, 2, 3, 4, 5]), RangeError);
  vertex.setFloats('value', [-0, 1 / 3, 2, 3]);
  assert.throws(() => vertex.bind(ctx), /injected upload failure/);
  reject = false;
  vertex.bind(ctx);
  vertex.bind(ctx);
  assert.equal(uploads, 1); // Failed upload stayed dirty; an unchanged bind does not upload again.
  const raw = new Uint8Array(16),
    words = new DataView(raw.buffer);
  [0x7fc12345, 0x80000000, 0x00000001, 0xffffffff].forEach((v, i) =>
    words.setUint32(i * 4, v, true),
  );
  pixel.setRaw('value', raw);
  raw.fill(0);
  pixel.bind(ctx);
  pixel.bind(ctx);
  assert.equal(uploads, 2);
  const vsBuffer = ctx.vsGetConstantBuffers(0, 1)[0],
    psBuffer = ctx.psGetConstantBuffers(0, 1)[0],
    vs = ctx.vsGetShader().shader,
    ps = ctx.psGetShader().shader,
    input = ctx.iaGetInputLayout();
  const read = (buffer) => {
    const staging = device.createBuffer(
      bufferDesc({
        byteWidth: buffer.getDesc().byteWidth,
        usage: 3,
        bindFlags: 0,
        cpuAccessFlags: 0x20000,
      }),
      null,
    ).value;
    ctx.copyResource(staging, buffer);
    const mapped = ctx.map(staging, 0, 1, 0);
    assert.equal(mapped.hr, 0);
    const data = mapped.value.data.slice();
    ctx.unmap(staging, 0);
    staging.release();
    return new DataView(data.buffer);
  };
  const vb = read(vsBuffer),
    pb = read(psBuffer);
  assert.equal(vb.getUint32(16, true), 0x80000000);
  assert.equal(vb.getFloat32(20, true), Math.fround(1 / 3));
  assert.deepEqual(
    Array.from({length: 4}, (_, i) => vb.getFloat32(i * 4, true)),
    [0, 0, 0, 0],
  );
  assert.deepEqual(
    Array.from({length: 4}, (_, i) => pb.getUint32(i * 4, true)),
    [0x7fc12345, 0x80000000, 0x00000001, 0xffffffff],
  );
  vertex.dispose();
  pixel.dispose();
  vertex.dispose();
  assert.throws(() => vertex.bind(ctx), /released/);
  assert.throws(() => pixel.setRaw('value', raw), /released/);
  // The real Native context and getter references outlive the program owner's references.
  assert.equal(vs.getDevice(), device);
  device.release();
  assert.equal(vsBuffer.getDesc().byteWidth, 32);
  assert.ok(input && ps);
  ctx.vsSetShader(null, []);
  ctx.psSetShader(null, []);
  ctx.iaSetInputLayout(null);
  ctx.vsSetConstantBuffers(0, [null]);
  ctx.psSetConstantBuffers(0, [null]);
  for (const resource of [vs, ps, input, vsBuffer, psBuffer]) {
    resource.release();
    assert.equal(
      resource.queryInterface('00000000-0000-0000-c000-000000000046').hr,
      0x80004002 | 0,
    );
  }
  ctx.release();
  device.release();
  loaded.loader.dispose();
  assert.ok(host.deleted.every(([, object]) => object === null)); // No rendering or GPU allocation was faked.
});

test('E-mote shader construction releases partially created native resources when a later factory fails', async () => {
  const {EmoteD3d11Program} =
    await import('../dist/native/emotedriver/runtime/render/d3d11-program.js');
  const {sm4SyntheticPipeline} = await import('../tools/lib/sm4-synthetic-fixtures.mjs');
  const host = capabilityContext(),
    loaded = exportsFor(() => host.gl),
    created = loaded.exports.d3d11CreateDevice(null, 1, 0, 0, null, 7),
    device = created.device;
  const reflection = {
    stage: 'vertex',
    flags: 0,
    creator: 'generated',
    resources: [],
    buffers: [{name: '$Globals', bytes: 32, flags: 0, bufferType: 0, slot: 0, variables: []}],
  };
  let buffer, layout;
  const failing = {
    createBuffer: (...args) => {
      const r = device.createBuffer(...args);
      buffer = r.value;
      return r;
    },
    createInputLayout: (...args) => {
      const r = device.createInputLayout(...args);
      layout = r.value;
      return r;
    },
    createVertexShader: () => ({hr: INVALID, value: null}),
  };
  const elements = [
    {
      semanticName: 'POSITION',
      semanticIndex: 0,
      format: 6,
      inputSlot: 0,
      alignedByteOffset: 0,
      inputSlotClass: 0,
      instanceDataStepRate: 0,
    },
    {
      semanticName: 'COLOR',
      semanticIndex: 0,
      format: 87,
      inputSlot: 0,
      alignedByteOffset: 12,
      inputSlotClass: 0,
      instanceDataStepRate: 0,
    },
  ];
  assert.throws(
    () =>
      new EmoteD3d11Program(
        failing,
        sm4SyntheticPipeline(false, true).vertex,
        reflection,
        elements,
      ),
    /0x80070057/,
  );
  assert.ok(buffer && layout);
  for (const resource of [buffer, layout])
    assert.equal(
      resource.queryInterface('00000000-0000-0000-c000-000000000046').hr,
      0x80004002 | 0,
    );
  created.immediateContext.release();
  device.release();
  loaded.loader.dispose();
});

test('E-mote native shader bank selects disjoint native tables and unwinds every partially built program', async () => {
  const {
    EmoteD3d11Shaders,
    emoteD3d11BasicShader,
    emoteD3d11BufferedShader,
    emoteD3d11MaskShader,
    emoteD3d11AlphaShader,
  } = await import('../dist/native/emotedriver/runtime/render/d3d11-shaders.js');
  const slots = new Set([2040, 2041]);
  for (let k = 0; k < 5; k++) {
    for (const a of [0, 4, 8])
      for (let m = 0; m < 4; m++) {
        for (const f of [0, 3, 6, 9, 12])
          for (let b = 0; b < 3; b++) {
            const index = emoteD3d11BasicShader(k, a, m, f, b);
            assert.ok(!slots.has(index));
            slots.add(index);
          }
        for (let n = 0; n < 19; n++) {
          const index = emoteD3d11BufferedShader(k, a, m, n);
          assert.ok(!slots.has(index));
          slots.add(index);
        }
      }
    for (const alpha of [false, true])
      for (const pass of [0, 1, 2]) {
        const index = emoteD3d11MaskShader(k, alpha, pass);
        assert.ok(!slots.has(index));
        slots.add(index);
      }
    const index = emoteD3d11AlphaShader(k);
    assert.ok(!slots.has(index));
    slots.add(index);
  }
  assert.deepEqual(
    [...slots].sort((a, b) => a - b),
    Array.from({length: 2077}, (_, i) => i),
  );
  assert.equal(emoteD3d11BasicShader(1, 4, 0, 0, 0), 240);
  assert.equal(emoteD3d11BufferedShader(4, 8, 3, 18), 2039);
  assert.equal(emoteD3d11MaskShader(4, true, 2), 2071);
  for (const args of [
    [5, 0, 0, 0, 0],
    [0, 3, 0, 0, 0],
    [0, 0, 4, 0, 0],
    [0, 0, 0, 2, 0],
    [0, 0, 0, 0, 3],
  ])
    assert.throws(() => emoteD3d11BasicShader(...args), RangeError);
  const created = [];
  let failAt = Infinity;
  const make = () => {
    if (created.length === failAt) return {hr: INVALID, value: null};
    const resource = {
      references: 1,
      release() {
        return --this.references;
      },
    };
    created.push(resource);
    return {hr: 0, value: resource};
  };
  // Contract factory stand-in: only resource ownership is tested here, never GPU work.
  const initialized = [];
  const device = {
    createInputLayout: make,
    createVertexShader: (bytes) => {
      initialized.push(bytes[0]);
      return make();
    },
    createPixelShader: make,
  };
  const reflection = (stage) => ({
    stage,
    flags: 0,
    creator: 'generated',
    buffers: [],
    resources: [],
  });
  const blobs = {
    vertex: Array.from({length: 12}, (_, i) => Uint8Array.of(i)),
    pixel: Array(2077).fill(new Uint8Array()),
    vertexReflection: Array.from({length: 12}, () => reflection('vertex')),
    pixelReflection: Array.from({length: 2077}, () => reflection('pixel')),
    inputLayouts: Array.from({length: 12}, () => []),
  };
  const bank = new EmoteD3d11Shaders(device, blobs);
  assert.deepEqual(initialized, [3, 0, 4, 5, 1, 2, 9, 6, 10, 11, 7, 8]);
  assert.notEqual(bank.vertex(0), bank.vertex(11));
  assert.notEqual(bank.pixel(0), bank.pixel(2076));
  assert.throws(() => bank.pixel(2077), RangeError);
  bank.dispose();
  bank.dispose();
  assert.ok(created.every((r) => r.references === 0));
  assert.throws(() => bank.vertex(0), /released/);
  created.length = 0;
  failAt = 2100; // Failure at the last pixel factory after every earlier stage exists.
  assert.throws(() => new EmoteD3d11Shaders(device, blobs), /resource creation failed/);
  assert.equal(created.length, 2100);
  assert.ok(created.every((r) => r.references === 0));
});
