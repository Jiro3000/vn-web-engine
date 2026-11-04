import {test} from 'node:test';
import assert from 'node:assert/strict';
import {YurisCg, YurisLayers} from '../dist/engines/yuris/vm/cg.js';

test('YU-RIS button hit testing reads main window for ONMOUSE2=1', () => {
  const commands = new Map();
  let result;
  const machine = {
    screenWidth: 8,
    screenHeight: 8,
    system: {names: [''], mouseX: Int32Array.of(3, 0, 0, 0), mouseY: Int32Array.of(4, 0, 0, 0)},
    define: (id, fn) => commands.set(id, fn),
    decode() {},
    setInt: (_id, _index, v) => (result = v),
    args: {
      has: (id) => ([0, 22, 33].includes(id) ? 1 : 0),
      text: () => 'BUTTON',
      int: () => 1n,
      variable: [0, 1000],
      variableIndex: [0, 0],
    },
  };
  const layers = new YurisLayers(machine, {}, {});
  layers.install();
  const cg = new YurisCg();
  cg.allocate(2, 2);
  cg.x = 3n;
  cg.y = 4n;
  cg.pixels[3] = 213;
  layers.tree.create('BUTTON', false, 2n, cg);
  commands.get(0x04)();
  assert.equal(result, 213n);
  machine.system.mouseX[0] = 7;
  commands.get(0x04)();
  assert.equal(result, -1n);
});

test('YU-RIS MERGE and MERGE2 preserve straight alpha with native integer rounding and clipping', () => {
  const commands = new Map();
  const values = new Map([
    [34, 1n],
    [12, 0n],
    [13, 0n],
  ]);
  const machine = {
    screenWidth: 8,
    screenHeight: 8,
    system: {names: ['']},
    define: (id, fn) => commands.set(id, fn),
    decode() {},
    commandName: () => 'CGACT',
    argName: () => 'MERGE',
    expression: {intOf: () => 0n},
    args: {
      has: (id) => ([0, 1].includes(id) || values.has(id) ? 1 : 0),
      text: (id) => (id === 0 ? 'SOURCE' : 'DEST'),
      int: (id) => values.get(id) ?? 0n,
    },
  };
  const layers = new YurisLayers(machine, {}, {});
  layers.install();
  const s = new YurisCg(),
    d = new YurisCg();
  s.allocate(2, 1);
  d.allocate(1, 1);
  const source = layers.tree.create('SOURCE', false, 1n, s);
  layers.tree.create('DEST', false, 2n, d);
  s.pixels.set([0, 0, 0, 128, 255, 0, 0, 128]);
  d.pixels.set([0, 0, 0, 128]);
  values.set(12, -1n);
  commands.get(2)();
  assert.deepEqual([...d.pixels], [169, 0, 0, 192]);
  assert.equal(d.masked, 1);
  assert.equal(source.payload, s);
  values.delete(34);
  values.set(35, 1n);
  s.a = 128;
  d.a = 128;
  s.pixels.set([0, 0, 0, 128, 200, 0, 0, 128]);
  d.pixels.set([0, 0, 0, 128]);
  commands.get(2)();
  assert.deepEqual([...d.pixels], [113, 0, 0, 112]);
});

test('YU-RIS TRANSITION clips three layer buffers and preserves MMX/SSE pair versus scalar-tail rounding', () => {
  const commands = new Map();
  let set = 127n;
  const m = {
    screenWidth: 8,
    screenHeight: 8,
    system: {names: [''], simd: true},
    define: (id, fn) => commands.set(id, fn),
    decode() {},
    commandName: () => 'CGACT',
    argName: () => 'SET',
    expression: {intOf: () => set},
    args: {
      has: (id) => ([0, 1, 2, 9, 36].includes(id) ? 1 : 0),
      text: (id) => ['A', 'B', 'OUT'][id] ?? '',
      int: () => 1n,
      type: [0, 1],
      expression: [null, new Uint8Array()],
    },
  };
  const layers = new YurisLayers(m, {}, {});
  layers.install();
  const a = new YurisCg(),
    b = new YurisCg(),
    out = new YurisCg();
  for (const cg of [a, b, out]) cg.allocate(3, 1);
  a.pixels.set([1, 3, 5, 7, 1, 3, 5, 7, 1, 3, 5, 7]);
  b.pixels.set([2, 4, 6, 8, 2, 4, 6, 8, 2, 4, 6, 8]);
  for (const [name, cg] of [
    ['A', a],
    ['B', b],
    ['OUT', out],
  ])
    layers.tree.create(name, false, 1n, cg);
  commands.get(2)();
  assert.deepEqual([...out.pixels], [2, 4, 6, 8, 2, 4, 6, 8, 1, 3, 5, 7]);
  assert.equal(out.masked, 1);
  m.system.simd = false;
  commands.get(2)();
  assert.deepEqual([...out.pixels], [1, 3, 5, 7, 1, 3, 5, 7, 1, 3, 5, 7]);
  set = 256n;
  commands.get(2)();
  assert.deepEqual(out.pixels, b.pixels);
});

test('YMV decrypts independently indexed JPEG pairs without mutating input and clamps frame selection', async () => {
  const {Ymv} = await import('../dist/formats/yuris/ymv.js');
  const color = [255, 216, 255, 217],
    alpha = [255, 216, 0, 217],
    data = new Uint8Array(52),
    v = new DataView(data.buffer);
  data.set([89, 83, 77, 86]);
  for (const [o, n] of [
    [4, 1],
    [8, 1],
    [12, 1],
    [16, 2],
    [20, 3],
    [24, 30],
    [32, 44],
    [36, 4],
    [40, 4],
  ])
    v.setUint32(o, n, true);
  for (let i = 0; i < 4; i++) {
    data[44 + i] = color[i] ^ (16 + i);
    data[48 + i] = alpha[i] ^ (16 + i);
  }
  const original = data.slice(),
    movie = new Ymv(data);
  assert.deepEqual(
    [movie.count, movie.width, movie.height, movie.fps, movie.alphaMode],
    [1, 2, 3, 30, 1],
  );
  assert.deepEqual([...movie.frame(-1).color], color);
  assert.deepEqual([...movie.frame(10).alpha], alpha);
  assert.deepEqual(data, original);
  const truncated = data.slice(0, 51);
  assert.throws(() => new Ymv(truncated));
});

test('YU-RIS GRADATION preserves horizontal endpoint rounding and native vertical edge behavior', () => {
  const commands = new Map(),
    values = new Map([
      [9, 1n],
      [10, 3n],
      [61, 1n],
    ]);
  const m = {
    screenWidth: 8,
    screenHeight: 8,
    system: {names: ['']},
    define: (id, fn) => commands.set(id, fn),
    decode() {},
    commandName: () => 'CGACT',
    argName: () => 'GRADATION',
    expression: {intOf: (_type, id) => values.get(id)},
    args: {
      has: (id) => (id === 0 || values.has(id) ? id + 1 : 0),
      text: () => 'A',
      int: (id) => values.get(id),
      type: [],
      expression: Array.from({length: 72}, (_, i) => i - 1),
    },
  };
  const layers = new YurisLayers(m, {}, {}),
    cg = new YurisCg();
  layers.install();
  cg.allocate(5, 5);
  layers.tree.create('A', false, 1n, cg);
  const apply = () => {
    cg.pixels.fill(255);
    commands.get(2)();
    return Array.from({length: 5}, (_, y) =>
      Array.from({length: 5}, (_, x) => cg.pixels[(y * 5 + x) * 4 + 3]),
    );
  };
  assert.deepEqual(apply()[0], [255, 255, 128, 0, 0]);
  assert.equal(cg.masked, 1);
  values.set(9, 3n);
  values.set(10, 1n);
  assert.deepEqual(apply()[0], [0, 0, 127, 255, 255]);
  values.set(9, 2n);
  values.set(10, 2n);
  assert.deepEqual(apply()[0], [255, 255, 255, 0, 0]);
  values.set(9, 1n);
  values.set(10, 3n);
  values.set(61, 2n);
  values.set(12, 1n);
  values.set(14, 3n);
  assert.deepEqual(apply(), [
    [255, 255, 255, 255, 255],
    [255, 0, 0, 0, 0],
    [255, 127, 127, 127, 0],
    [255, 255, 255, 255, 0],
    [255, 255, 255, 255, 255],
  ]);
  values.set(9, 3n);
  values.set(10, 1n);
  assert.deepEqual(apply(), [
    [255, 255, 255, 255, 255],
    [0, 255, 255, 255, 255],
    [0, 128, 128, 128, 255],
    [0, 0, 0, 0, 255],
    [255, 255, 255, 255, 255],
  ]);
});

test('YU-RIS AKARUSA saturates brightness and keeps the native cropped alpha origin', () => {
  const commands = new Map(),
    values = new Map([
      [9, 256n],
      [12, 1n],
      [14, 2n],
      [42, 1n],
    ]);
  const m = {
    screenWidth: 8,
    screenHeight: 8,
    system: {names: ['']},
    define: (id, fn) => commands.set(id, fn),
    decode() {},
    commandName: () => 'CGACT',
    argName: () => 'AKARUSA',
    expression: {intOf: (_type, id) => values.get(id)},
    args: {
      has: (id) => (id === 0 || values.has(id) ? id + 1 : 0),
      text: () => 'A',
      int: (id) => values.get(id),
      type: [],
      expression: Array.from({length: 72}, (_, i) => i - 1),
    },
  };
  const layers = new YurisLayers(m, {}, {}),
    cg = new YurisCg();
  layers.install();
  cg.allocate(3, 1);
  layers.tree.create('A', false, 1n, cg);
  cg.pixels.set([1, 2, 3, 10, 100, 150, 200, 20, 255, 0, 127, 30]);
  commands.get(2)();
  assert.deepEqual([...cg.pixels], [228, 255, 255, 10, 255, 128, 255, 20]);
  values.delete(12);
  values.delete(14);
  values.set(9, 0n);
  commands.get(2)();
  assert.deepEqual([...cg.pixels], [100, 127, 127, 10, 127, 0, 127, 20]);
  values.set(9, -1n);
  assert.throws(() => commands.get(2)());
});

test('YMV commands attach shared movie state, clamp frames, compose alpha and release query metadata', async () => {
  const {installYmv} = await import('../dist/engines/yuris/vm/ymv.js');
  const data = new Uint8Array(64),
    view = new DataView(data.buffer);
  for (const [offset, value] of [
    [0, 0x564d5359],
    [4, 1],
    [8, 2],
    [12, 1],
    [16, 2],
    [20, 1],
    [24, 30],
    [32, 56],
    [36, 60],
    [40, 2],
    [44, 2],
    [48, 2],
    [52, 2],
  ])
    view.setUint32(offset, value, true);
  for (let i = 0; i < 2; i++) {
    data.set([(i + 1) ^ 16, 17], 56 + i * 4);
    data.set([(i + 11) ^ 16, 17], 58 + i * 4);
  }
  const commands = new Map(),
    enabled = new Set([0, 2, 3]);
  let frame = 100n,
    stored;
  const m = {
    screenWidth: 8,
    screenHeight: 8,
    system: {names: ['']},
    define: (id, fn) => commands.set(id, fn),
    decode() {},
    instruction: {command: 109},
    commandName: () => 'YMV',
    files: {
      read: async (name) => {
        assert.equal(name, 'fixture.ymv');
        return data;
      },
    },
    setInt: (id, index, value) => {
      assert.equal(id, 1000);
      assert.equal(index, 0n);
      stored = value;
    },
    args: {
      has: (id) => (enabled.has(id) ? id + 1 : 0),
      text: (id) => (id === 0 ? 'A' : 'fixture.ymv'),
      int: () => frame,
      variable: [0, 0, 0, 1000],
      variableIndex: [0n, 0n, 0n, 0n],
    },
  };
  const layers = (m.layers = new YurisLayers(m, {}, {})),
    cg = new YurisCg();
  cg.allocate(1, 1);
  layers.tree.create('A', false, 1n, cg);
  layers.tree.create('ALIAS', false, 2n, cg);
  installYmv(m, {
    decodeImage: async (bytes, type) => {
      assert.equal(type, 3);
      return {
        width: 2,
        height: 1,
        pixels: Uint8Array.of(bytes[0], bytes[0], bytes[0], 255, bytes[0], bytes[0], bytes[0], 255),
      };
    },
  });
  await commands.get(109)();
  assert.deepEqual([...cg.pixels], [2, 2, 2, 12, 2, 2, 2, 12]);
  assert.equal(cg.masked, 1);
  enabled.delete(2);
  frame = -100n;
  await commands.get(109)();
  assert.deepEqual([...cg.pixels], [1, 1, 1, 11, 1, 1, 1, 11]);
  enabled.add(2);
  enabled.delete(3);
  enabled.add(6);
  commands.get(111)();
  assert.equal(stored, 30n);
  commands.get(110)();
  commands.get(111)();
  assert.equal(stored, 0n);
  assert.equal(layers.lookup('ALIAS', false).payload.ymv, null);
});

test('YU-RIS DIALOG preserves modal flags, response mapping, input capacity and native FILEOPEN no-op', async () => {
  const {installDialog} = await import('../dist/engines/yuris/vm/dialog.js');
  let handler,
    result = 6,
    stored,
    string,
    request,
    shown = 0;
  const values = new Map([
    [0, 'Caption'],
    [1, 'Question'],
    [9, 'Initial'],
    [11, 0n],
    [14, 1n],
    [18, 3n],
    [19, 4n],
  ]);
  const machine = {
    define: (_id, fn) => (handler = fn),
    decode() {},
    input: {show: () => shown++, applyCursor() {}},
    setInt: (id, index, value) => {
      assert.equal(id, 1011);
      assert.equal(index, 0n);
      stored = value;
    },
    setString: (id, index, value) => {
      assert.equal(id, 1010);
      assert.equal(index, 0n);
      string = value;
    },
    args: {
      has: (id) => (values.has(id) ? id + 1 : 0),
      text: (id) => values.get(id),
      int: (id) => values.get(id),
      variable: Array.from({length: 50}, (_, i) => 999 + i),
      variableIndex: Array(50).fill(0n),
    },
  };
  installDialog(machine, {
    dialogMessage: async (...args) => {
      request = args;
      return result;
    },
    dialogInput: async (...args) => {
      request = args;
      return 'x'.repeat(5000);
    },
  });
  await handler();
  assert.deepEqual(request, ['Question', 'Caption', 0x214]);
  assert.equal(stored, 1n);
  result = 7;
  await handler();
  assert.equal(stored, 2n);
  values.set(15, 1n);
  result = 2;
  await handler();
  assert.equal(stored, 3n);
  values.delete(15);
  values.delete(14);
  values.set(13, 1n);
  await handler();
  assert.equal(stored, 2n);
  values.set(16, 1n);
  values.set(17, 50n);
  values.set(10, '');
  await handler();
  assert.deepEqual(request, ['Question', 'Caption', 'Initial', 50]);
  assert.equal(stored, 1n);
  assert.equal(string.length, 4095);
  const before = shown;
  values.set(20, 1n);
  await handler();
  assert.equal(shown, before);
});

test('YU-RIS MOVIE uses physical files, native volume, resize notifications and MPEG codec probes', async () => {
  const {YurisMovie} = await import('../dist/engines/yuris/vm/movie.js');
  const commands = new Map(),
    values = new Map([[0, 'movie.ypf']]);
  let file = Uint8Array.of(0, 0, 1, 186, 0x21),
    playing = false,
    request,
    stored,
    gain;
  const m = {
    define: (id, fn) => commands.set(id, fn),
    decode() {},
    windows: {windows: [{width: 640, height: 480}]},
    system: {string68: ''},
    setInt: (id, index, value) => {
      assert.equal(id, 1000);
      assert.equal(index, 0n);
      stored = value;
    },
    args: {
      has: (id) => (values.has(id) ? id + 1 : 0),
      text: (id) => values.get(id),
      int: (id) => values.get(id),
      variable: [0, 0, 0, 0, 0, 0, 0, 0, 1000],
      variableIndex: Array(9).fill(0n),
    },
  };
  const movie = new YurisMovie(
    m,
    {
      readFile: async (name) => {
        assert.ok(['movie.ypf', 'missing'].includes(name));
        return name === 'missing' ? null : file;
      },
    },
    {
      moviePlay: async (data, rect, volume) => {
        playing = true;
        request = {data, rect, volume};
      },
      moviePlaying: () => playing,
      movieVolume: (value) => (gain = value),
      moviePosition: (rect) => (request.rect = rect),
      movieStop: () => (playing = false),
      movieClose: () => (playing = false),
    },
  );
  await commands.get(70)();
  values.clear();
  values.set(6, 128n);
  await commands.get(70)();
  assert.ok(Math.abs(gain - 0.25) < 0.0001);
  values.clear();
  values.set(1, 1n);
  await commands.get(70)();
  assert.equal(movie.playing, true);
  assert.deepEqual(request.rect, {
    x: 0,
    y: 0,
    width: 640,
    height: 480,
    clientWidth: 640,
    clientHeight: 480,
  });
  m.windows.windows[0].width = 1280;
  movie.poll();
  assert.equal(request.rect.clientWidth, 1280);
  playing = false;
  movie.poll();
  assert.equal(movie.playing, false);
  values.clear();
  values.set(6, 'movie.ypf');
  values.set(7, 0n);
  await commands.get(72)();
  assert.equal(stored, 1n);
  file = Uint8Array.of(0, 0, 1, 186, 0x44);
  await commands.get(72)();
  assert.equal(stored, 2n);
  file = Uint8Array.of(0, 0, 0, 32, 102, 116, 121, 112);
  await commands.get(72)();
  assert.equal(stored, 255n);
  values.set(6, 'missing');
  await commands.get(72)();
  assert.equal(stored, 0n);
  await commands.get(71)();
  values.clear();
  values.set(5, 1n);
  values.set(7, 0n);
  await commands.get(72)();
  assert.equal(stored, 256n);
});

test('CGACT TEXT shares the measured DIB, reproduces mono backgrounds and AA straight-alpha blending, then continues to COPY2', async () => {
  const {YurisFonts} = await import('../dist/engines/yuris/vm/font.js');
  const commands = new Map(),
    values = new Map([
      [11, '\x81\x40'],
      [64, 1n],
    ]),
    requests = [];
  const m = {
    screenWidth: 16,
    screenHeight: 16,
    system: {names: ['']},
    define: (id, fn) => commands.set(id, fn),
    decode() {},
    commandName: () => 'CGACT',
    argName: () => 'TEXT',
    expression: {intOf: (_type, id) => values.get(id) ?? 0n},
    args: {
      has: (id) => (id === 0 || values.has(id) ? id + 1 : 0),
      text: (id) => (id === 0 ? 'SOURCE' : id === 1 ? 'DEST' : values.get(id)),
      int: (id) => values.get(id),
      type: [],
      expression: Array.from({length: 73}, (_, i) => i - 1),
    },
  };
  m.fonts = new YurisFonts({
    fontFamilies: () => [{name: 'Synthetic', pitchAndFamily: 1, script: 'Japanese'}],
    textOut: (request) => {
      requests.push(request);
      const bits = new Uint8Array((request.cell * request.cell) / 8).fill(255),
        stride = request.cell / 8;
      if (request.height === 16) {
        for (let y = 0; y < 2; y++)
          for (let x = 0; x < 4; x++) bits[y * stride + (x >> 3)] &= ~(128 >> (x & 7));
      } else bits[0] &= 127;
      return bits;
    },
  });
  const f = m.fonts;
  f.sx[0] = f.sy[0] = 4;
  f.color[0] = f.color2[0] = 0xff0000;
  f.antialiasing[0] = 0;
  const layers = new YurisLayers(m, {}, {}),
    source = new YurisCg(),
    dest = new YurisCg();
  layers.install();
  source.allocate(8, 8);
  dest.allocate(1, 1);
  layers.tree.create('SOURCE', false, 1n, source);
  layers.tree.create('DEST', false, 2n, dest);
  commands.get(2)();
  assert.deepEqual([...source.pixels.subarray(0, 8)], [0, 0, 255, 255, 0, 0, 0, 255]);
  assert.equal(requests.length, 1);
  assert.equal(requests[0].text, '\x81\x40');
  assert.equal(source.masked, 1);
  f.antialiasing[0] = 1;
  f.drawMode[0] = 1;
  for (let i = 0; i < source.pixels.length; i += 4) source.pixels.set([50, 60, 70, 128], i);
  values.set(1, 1n);
  values.set(66, 1n);
  commands.get(2)();
  assert.deepEqual([...source.pixels.subarray(0, 4)], [14, 17, 203, 200]);
  assert.deepEqual(dest.pixels, source.pixels);
  assert.equal(requests.length, 2);
  assert.equal(layers.textBuffer, 0);
  values.delete(1);
  values.delete(66);
  values.delete(11);
  assert.equal(commands.get(2)(), -1);
});

test('CGACT TEXT retains native gradient rotations, whole-box rejection and right/up/center/down/left stroke order', async () => {
  const {YurisFonts} = await import('../dist/engines/yuris/vm/font.js');
  const {drawCgText} = await import('../dist/engines/yuris/vm/glyph.js');
  let full = true;
  const fonts = new YurisFonts({
    fontFamilies: () => [{name: 'Synthetic', pitchAndFamily: 1, script: 'Japanese'}],
    textOut: (r) => {
      const bits = new Uint8Array((r.cell * r.cell) / 8).fill(255),
        stride = r.cell / 8;
      if (full) {
        for (let y = 0; y < r.height; y++)
          for (let x = 0; x < r.height; x++) bits[y * stride + (x >> 3)] &= ~(128 >> (x & 7));
      } else bits[0] &= 127;
      return bits;
    },
  });
  fonts.sx[0] = fonts.sy[0] = 4;
  fonts.color[0] = 0;
  fonts.color2[0] = 0xffffff;
  const cg = new YurisCg();
  cg.allocate(12, 12);
  const node = {payload: cg};
  let dirty = 0;
  const layers = {textBuffer: 0, markDirty: () => dirty++};
  drawCgText(layers, fonts, node, '\x81\x40', 0, 0, 0);
  assert.deepEqual(
    [0, 1, 2, 3].map((x) => cg.pixels[x * 4]),
    [0, 85, 170, 255],
  );
  fonts.rotation[0] = 1;
  drawCgText(layers, fonts, node, '\x81\x40', 0, 0, 0);
  assert.deepEqual(
    [0, 1, 2, 3].map((x) => cg.pixels[x * 4]),
    [255, 170, 85, 0],
  );
  const previous = cg.pixels.slice(),
    before = dirty;
  cg.masked = 0;
  drawCgText(layers, fonts, node, '\x81\x40', 10, 0, 0);
  assert.deepEqual(cg.pixels, previous);
  assert.equal(dirty, before);
  assert.equal(cg.masked, 1);
  fonts.rotation[0] = 0;
  fonts.gradation[0] = 5;
  fonts.color[0] = 5;
  fonts.color2[0] = 0;
  drawCgText(layers, fonts, node, '\x81\x40', 0, 0, 0);
  assert.deepEqual(
    [
      [0, 0],
      [0, 3],
      [3, 0],
      [3, 3],
    ].map(([x, y]) => cg.pixels[(y * 12 + x) * 4]),
    [5, 3, 3, 0],
  );
  cg.pixels.fill(0);
  fonts.rotation[0] = 0;
  fonts.antialiasing[0] = 0;
  fonts.color[0] = fonts.color2[0] = 0xff0000;
  full = false;
  drawCgText(layers, fonts, node, '\x81\x40', 4, 4, 1);
  const colored = [];
  for (let y = 0; y < 12; y++)
    for (let x = 0; x < 12; x++) if (cg.pixels[(y * 12 + x) * 4 + 2]) colored.push([x, y]);
  assert.deepEqual(colored, [
    [4, 3],
    [3, 4],
  ]);
  cg.pixels.fill(0);
  drawCgText(layers, fonts, node, '\x81\x40', 4, 4, 11);
  const shadow = [];
  for (let y = 0; y < 12; y++)
    for (let x = 0; x < 12; x++) if (cg.pixels[(y * 12 + x) * 4 + 2]) shadow.push([x, y]);
  assert.deepEqual(shadow, [
    [5, 4],
    [4, 5],
    [5, 5],
  ]);
});

test('CGACT ROTATION keeps native cardinal edges, buffer reuse, alias feedback and coordinate errors', () => {
  const commands = new Map(),
    values = new Map([
      [29, 1n],
      [9, 90n],
    ]);
  const m = {
    instruction: {command: 2},
    screenWidth: 16,
    screenHeight: 16,
    system: {names: ['']},
    define: (id, fn) => commands.set(id, fn),
    decode() {},
    commandName: () => 'CGACT',
    argName: () => 'ROTATION',
    expression: {intOf: (_type, id) => values.get(id) ?? 0n},
    args: {
      has: (id) => (id === 0 || values.has(id) ? id + 1 : 0),
      text: (id) => (id === 0 ? 'SOURCE' : 'DEST'),
      int: (id) => values.get(id) ?? 0n,
      type: [],
      expression: Array.from({length: 73}, (_, i) => i - 1),
    },
  };
  const layers = new YurisLayers(m, {}, {}),
    source = new YurisCg(),
    dest = new YurisCg();
  layers.install();
  source.allocate(4, 4);
  dest.allocate(2, 8);
  layers.tree.create('SOURCE', false, 1n, source);
  const dnode = layers.tree.create('DEST', false, 2n, dest);
  const reset = () => {
    source.allocate(4, 4);
    source.masked = 0;
    for (let i = 0; i < 16; i++) source.pixels.set([i + 1, 44, 55, 201], i * 4);
  };
  const blue = (cg) => Array.from({length: 16}, (_, i) => cg.pixels[i * 4]);
  reset();
  commands.get(2)();
  assert.deepEqual(blue(source), [0, 0, 0, 0, 4, 8, 12, 0, 3, 7, 11, 0, 2, 6, 10, 0]);
  assert.equal(source.masked, 1);
  reset();
  values.set(29, 2n);
  commands.get(2)();
  assert.deepEqual(blue(source), [5, 9, 13, 0, 4, 8, 12, 0, 3, 7, 11, 0, 2, 6, 10, 0]);
  reset();
  values.set(29, 1n);
  values.set(9, 180n);
  values.set(1, 1n);
  const buffer = dest.pixels;
  commands.get(2)();
  assert.deepEqual(
    blue(dest),
    Array.from({length: 16}, (_, i) => 16 - i),
  );
  assert.equal(dest.pixels, buffer);
  assert.deepEqual([dest.width, dest.height, dest.masked], [2, 8, 0]);
  reset();
  dnode.payload = source;
  commands.get(2)();
  assert.deepEqual(blue(source), [16, 15, 14, 13, 12, 11, 10, 9, 9, 10, 11, 12, 13, 14, 15, 16]);
  values.set(12, 0n);
  assert.throws(
    () => commands.get(2)(),
    (error) => error.code === 0x18ba2,
  );
});

test('ROTATION safe and preserve modes cover every quadrant and retain signed angle behavior', async () => {
  const {rotateCg} = await import('../dist/engines/yuris/vm/rotation.js');
  const source = new YurisCg(),
    dest = new YurisCg();
  source.allocate(32, 32);
  dest.allocate(32, 32);
  source.pixels.fill(111);
  const src = {payload: source},
    dst = {payload: dest},
    layers = {markDirty() {}};
  for (const angle of [30, 120, 210, 300]) {
    dest.pixels.fill(77);
    rotateCg(layers, src, dst, true, angle, 11);
    for (let y = 0; y < 32; y++)
      assert.deepEqual(
        [...dest.pixels.subarray((y * 32 + 31) * 4, (y * 32 + 32) * 4)],
        [0, 0, 0, 0],
      );
    dest.pixels.fill(77);
    rotateCg(layers, src, dst, true, angle, 12);
    for (let y = 0; y < 32; y++)
      assert.deepEqual(
        [...dest.pixels.subarray((y * 32 + 31) * 4, (y * 32 + 32) * 4)],
        [77, 77, 77, 77],
      );
    assert.equal(dest.masked, 1);
  }
  dest.pixels.fill(77);
  rotateCg(layers, src, dst, true, -30, 11);
  assert.ok(dest.pixels.every((v) => v === 77));
  rotateCg(layers, src, dst, true, 360000000, 11);
  assert.deepEqual(dest.pixels, source.pixels);
  assert.equal(dest.masked, source.masked);
  source.width = 8193;
  assert.throws(
    () => rotateCg(layers, src, null, false, 0, 11),
    (error) => error.code === 0x186aa && error.prefix === false,
  );
});

test('browser virtual keys keep both Ctrl sides and the aggregate held independently of pointer buttons', async () => {
  const {setWindowsVirtualKey} = await import('../dist/input/windows-virtual-keys.js');
  const state = new Uint8Array(256);
  state[1] = 128;
  const event = (code, location = 0, keyCode = 17) => ({keyCode, code, location});
  assert.equal(setWindowsVirtualKey(state, event('ControlLeft', 1), true), 17);
  assert.deepEqual([state[17], state[162], state[163]], [128, 128, 0]);
  setWindowsVirtualKey(state, event('ControlRight', 2), true);
  setWindowsVirtualKey(state, event('ControlLeft', 1), false);
  assert.deepEqual([state[17], state[162], state[163]], [128, 0, 128]);
  setWindowsVirtualKey(state, event('ControlRight', 2), false);
  assert.deepEqual([state[17], state[162], state[163]], [0, 0, 0]);
  setWindowsVirtualKey(state, event('', 2, 16), true);
  assert.deepEqual([state[16], state[160], state[161]], [128, 0, 128]);
  setWindowsVirtualKey(state, event('AltLeft', 1, 18), true);
  assert.equal(state[164], 128);
  assert.equal(state[18], 128);
  assert.equal(state[1], 128);
});
