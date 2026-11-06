import {test} from 'node:test';
import assert from 'node:assert/strict';
import {blendRect} from '../dist/engines/yuris/vm/blend.js';
import {YurisCg, YurisLayers} from '../dist/engines/yuris/vm/cg.js';
import {
  applyCopyLoop,
  applyInitializer,
  applyRowShift,
  copyLoop,
  scanGuardLoop,
  scanInactiveLoop,
  scanInitializer,
  scanRowShift,
  skipGuardLoop,
  skipInactiveLoop,
} from '../dist/engines/yuris/vm/copy-loop.js';
import {YurisExpression} from '../dist/engines/yuris/vm/expression.js';
import {sizeBilinear} from '../dist/engines/yuris/vm/resize.js';
import {bgraDisplayFrame, transitionBgra} from '../dist/graphics/bgra-effects-wasm.js';
import {YurisVariables} from '../dist/engines/yuris/vm/variables.js';

test('YU-RIS SIMD transition retains paired midpoint and odd-tail rounding', () => {
  const width = 513,
    height = 128;
  const stride = (width + 1) * 4;
  const first = Uint8Array.from({length: stride * height}, (_, i) => (i * 31 + 1) & 255);
  const second = Uint8Array.from({length: stride * height}, (_, i) => (i * 17 + 1) & 255);
  const output = new Uint8Array(stride * height);
  const region = (bytes) => ({bytes, offset: 4, stride});
  for (const [weight, sse] of [
    [37, true],
    [128, false],
    [128, true],
    [177, false],
    [256, true],
  ]) {
    assert.equal(
      transitionBgra(region(first), region(second), region(output), width, height, weight, sse),
      true,
    );
    const expected = new Uint8Array(stride * height);
    for (let y = 0; y < height; y++) {
      for (let x = 0; x < width * 4; x++) {
        const i = y * stride + 4 + x;
        const a = first[i],
          b = second[i];
        expected[i] =
          weight !== 128 || x >= (width - 1) * 4
            ? a + (((b - a) * weight) >> 8)
            : sse
              ? (a + b + 1) >> 1
              : (a >> 1) + (b >> 1);
      }
    }
    assert.deepEqual(output, expected);
  }
});

test('YU-RIS image cache preserves byte changes and gives each layer its own pixels', async (t) => {
  const {LegacyImageCodec} = await import('../dist/graphics/legacy-image-codec.js');
  const codec = new LegacyImageCodec();
  const decode = t.mock.method(codec, 'decode', async (data) => ({
    width: 128,
    height: 128,
    pixels: new Uint8Array(128 * 128 * 4).fill(data[0]),
  }));
  const input = Uint8Array.of(31, 8, 13, 0, 7);
  const first = await codec.decodeCached(input, 'image/webp', true, 'image.webp');
  first.pixels[0] = 99;
  await codec.preload(input, 'image/webp', 'image.webp');
  const repeated = await codec.decodeCached(input, 'image/webp', true, 'image.webp');
  assert.equal(repeated.pixels[0], 31);
  assert.equal(decode.mock.callCount(), 1);
  input[4] = 8;
  await codec.decodeCached(input, 'image/webp', true, 'image.webp');
  assert.equal(decode.mock.callCount(), 2);
  input[0] = 42;
  const replacement = await codec.decodeCached(input, 'image/webp', true, 'image.webp');
  assert.equal(replacement.pixels[0], 42);
  assert.equal(decode.mock.callCount(), 3);
});

test('YU-RIS polls independent sound cursors together and uses acknowledged positions', async (t) => {
  const {BrowserLoopingSoundDevice} = await import('../dist/audio/browser-looping-sound.js');
  const {BrowserSpeakerBuffer} = await import('../dist/audio/browser-speaker-buffer.js');
  const requests = [];
  let next = 0;
  t.mock.method(BrowserSpeakerBuffer, 'create', async () => {
    const cursor = ++next * 10;
    return {
      command: async ({kind}) => {
        if (kind !== 'status') return {playing: true, byteCursor: 0};
        return new Promise((resolve) =>
          requests.push(() => resolve({playing: true, byteCursor: cursor})),
        );
      },
      async dispose() {},
    };
  });
  const device = new BrowserLoopingSoundDevice({});
  const format = {channels: 1, sampleRate: 22050, bitsPerSample: 16, byteLength: 32};
  const first = device.createSoundBuffer(format),
    second = device.createSoundBuffer(format);
  const result = device.flush();
  await new Promise(setImmediate);
  assert.equal(requests.length, 2);
  assert.deepEqual([first.playCursor(), second.playCursor()], [0, 0]);
  for (const reply of requests) reply();
  await result;
  assert.deepEqual([first.playCursor(), second.playCursor()], [10, 20]);
  await device.dispose();
});

test('YU-RIS expression reads retain int64 references and low-dword array validation', () => {
  const variables = new YurisVariables(1010);
  const expression = new YurisExpression(variables, {});
  const id = 1001;
  const value = -98765432123456789n;
  variables.get(id).dimensions = [3, 4];
  variables.allocateInt(id, 0n);
  variables.get(id).ints[6] = value;
  const token = (name, ...bytes) => [name.charCodeAt(0), bytes.length, 0, ...bytes];
  const literal = Uint8Array.from(token('M', 34, 65, 66, 67, 34));
  assert.equal(expression.string(literal), 'ABC');
  assert.equal(expression.string(literal), 'ABC');
  literal[4] = 68;
  assert.equal(expression.string(literal), 'DBC');
  const element = (prefix, ...firstIndex) =>
    Uint8Array.of(
      ...token('V', prefix, id & 255, id >>> 8),
      ...firstIndex,
      ...token('B', 2),
      ...token(')'),
    );
  assert.equal(expression.int(element(0, ...token('B', 1))), value);
  assert.equal(expression.float(element(0, ...token('B', 1))), Number(value));
  const row = 1002;
  variables.allocateInt(row, 1n);
  const matrixRead = Uint8Array.of(
    ...token('V', 0x40, id & 255, id >>> 8),
    ...token('H', 0x40, row & 255, row >>> 8),
    ...token(','),
    ...token('B', 2),
    ...token(')', 0),
  );
  assert.equal(expression.int(matrixRead), value);
  assert.equal(expression.float(matrixRead), Number(value));
  assert.equal(expression.lastIndex, 6n);
  const highIndex = token('L', 1, 0, 0, 0, 1, 0, 0, 0);
  assert.equal(expression.int(element(0, ...highIndex)), value);
  assert.equal(expression.int(element(0x60, ...highIndex)), (BigInt(id + 4) << 32n) | 6n);
  assert.throws(
    () => expression.int(element(0, ...token('B', 3))),
    (error) => error.code === 0x1a202,
  );
  const parameter = 0x35;
  variables.get(parameter).dimensions = [16];
  variables.allocateInt(parameter, 0n);
  const system = new YurisExpression(variables, {
    int(id, index, high) {
      assert.deepEqual([id, index, high], [parameter, 2, 0]);
      return value;
    },
  });
  const paramRead = Uint8Array.of(
    ...token('V', 0x40, parameter, 0),
    ...token('B', 2),
    ...token(')', 0),
  );
  assert.equal(system.int(paramRead), value);
  assert.equal(system.lastIndex, 2n);
});

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

test('YU-RIS composes a transparent RGBA PNG over the background', async () => {
  const commands = new Map();
  const machine = {
    screenWidth: 2,
    screenHeight: 1,
    system: {frames: 0n, names: ['W0']},
    define: (id, fn) => commands.set(id, fn),
    decode() {},
    args: {
      has: (id) => ([0, 6, 46].includes(id) ? 1 : 0),
      text: (id) => (id === 0 ? 'OVERLAY' : 'overlay.png'),
      int: () => 2n,
      op: [0, 0],
    },
  };
  const ihdr = new Uint8Array(26);
  ihdr[25] = 6;
  const layers = new YurisLayers(
    machine,
    {resolve: () => ({found: true, path: 'overlay.png', type: 2}), read: async () => ihdr},
    {decodeImage: async () => ({width: 1, height: 1, pixels: Uint8Array.of(0, 0, 0, 0)})},
  );
  layers.install();
  const screen = layers.windowLayers[0];
  const background = new YurisCg();
  background.allocate(2, 1);
  background.pixels.fill(255);
  layers.tree.create('W0/BACKGROUND', false, 1n, background);
  layers.composeSet(screen);
  layers.frameEnd();
  assert.equal(await commands.get(1)(), 0);
  assert.equal(layers.lookup('W0/OVERLAY', false).payload.masked, 1);
  layers.composeSet(screen);
  assert.ok(screen.payload.pixels[0] >= 254);
  assert.equal(screen.payload.pixels[4], 255);
});

test('YU-RIS hidden pixel updates mark composition when used as a transition rule', async () => {
  const commands = new Map();
  const machine = {
    screenWidth: 8,
    screenHeight: 8,
    system: {frames: 0n, names: ['']},
    define: (id, fn) => commands.set(id, fn),
    decode() {},
    args: {
      has: (id) => (id === 0 || id === 51 ? 1 : 0),
      text: (id) => (id === 0 ? 'W0/LAYER' : 'W0/RULE'),
    },
  };
  const layers = new YurisLayers(machine, {}, {});
  layers.install();
  layers.tree.create('W0/LAYER', false, 1n, new YurisCg());
  const hidden = new YurisCg();
  hidden.e = 0;
  const rule = layers.tree.create('W0/RULE', false, 2n, hidden);
  const screen = layers.windowLayers[0].payload;
  layers.frameEnd();
  layers.markPixelsChanged(rule);
  assert.equal(screen.dirty, false);
  await commands.get(1)();
  assert.equal(screen.dirty, true);
  layers.frameEnd();
  layers.markPixelsChanged(rule);
  assert.equal(screen.dirty, true);
});

test('YU-RIS deferred layer pixels survive source writes and are composited when exposed', () => {
  const machine = {screenWidth: 2, screenHeight: 1, system: {frames: 0n, names: ['W0']}};
  const layers = new YurisLayers(machine, {}, {});
  const screen = layers.windowLayers[0];
  const source = new YurisCg(),
    destination = new YurisCg(),
    cover = new YurisCg();
  for (const cg of [source, destination, cover]) cg.allocate(2, 1);
  source.pixels.fill(27);
  cover.pixels.fill(56);
  const lower = layers.tree.create('W0/LOWER', false, 1n, destination);
  layers.tree.create('W0/COVER', false, 2n, cover);
  layers.composeSet(screen);
  layers.frameEnd();
  const input = source.source;
  let writes = 0;
  const write = (target) => {
    target.set(input);
    writes++;
  };
  assert.equal(layers.isCovered(lower), true);
  assert.equal(destination.deferPixelWrite(source, input, write), true);
  assert.equal(destination.deferPixelWrite(source, input, write), true);
  layers.markCoveredPixelWrite(lower);
  layers.composeSet(screen);
  assert.equal(writes, 0);
  assert.equal(screen.payload.dirty, false);
  source.beginPixelWrite();
  input.fill(94);
  assert.equal(writes, 1);
  assert.equal(destination.pixels[0], 27);
  assert.equal(destination.deferPixelWrite(source, input, write), true);
  layers.markCoveredPixelWrite(lower);
  cover.a = 0;
  layers.composeSet(screen);
  assert.equal(writes, 2);
  assert.equal(screen.payload.pixels[0], 94);
});

test('YU-RIS bulk array loops preserve the final iteration and validate before writing', async () => {
  const {YurisVariables} = await import('../dist/engines/yuris/vm/variables.js');
  const token = (op, ...payload) => ({op: op.charCodeAt(0), payload: Uint8Array.of(...payload)});
  const ref = (op, id) => token(op, 0x40, id & 255, id >>> 8);
  const indexed = (id) => [ref('V', id), ref('H', 48), token(')', 0)];
  const assignment = (target, source) => ({
    command: 0x35,
    args: [
      {op: 0, type: 1, tokens: indexed(target)},
      {op: 0, type: 1, tokens: source},
    ],
  });
  const plan = copyLoop(
    [
      assignment(1001, [token('B', 255)]),
      assignment(1002, [ref('V', 1002), ref('H', 48), ref('H', 1003), token('+'), token(')', 0)]),
      {command: 0x3a},
    ],
    0,
    2,
  );
  assert.ok(plan);
  const variables = new YurisVariables(1003);
  variables.allocateInt(48, 0n);
  for (const id of [1001, 1002]) {
    variables.get(id).dimensions = [10];
    variables.allocateInt(id, 0n);
  }
  const fill = variables.get(1001).ints,
    shifted = variables.get(1002).ints;
  shifted.set(BigInt64Array.from({length: 10}, (_, index) => BigInt(index)));
  variables.allocateInt(1003, 6n);
  assert.equal(applyCopyLoop(plan, variables, 5), false);
  assert.deepEqual([...fill], Array(10).fill(0n));
  variables.allocateInt(1003, 2n);
  assert.equal(applyCopyLoop(plan, variables, 5), true);
  assert.deepEqual([...fill], [0n, -1n, -1n, -1n, -1n, 0n, 0n, 0n, 0n, 0n]);
  assert.deepEqual([...shifted], [0n, 3n, 4n, 5n, 6n, 5n, 6n, 7n, 8n, 9n]);
  const condition = [
    ...indexed(1002),
    token('B', 6),
    token('='),
    ref('H', 1003),
    token('B', 2),
    token('='),
    token('&'),
  ];
  const guard = scanGuardLoop(
    [
      {command: 0x2c, args: [{type: 1, tokens: condition}, {size: 0}, {size: 2}]},
      assignment(1001, [token('B', 255)]),
      {command: 0x30},
      {command: 0x3a},
    ],
    0,
    3,
  );
  assert.ok(guard);
  assert.equal(skipGuardLoop(guard, variables, 1, 9), 3);
  assert.equal(skipGuardLoop(guard, variables, 4, 9), 4);
  assert.equal(skipGuardLoop(guard, variables, 7, 9), 9);
  const clearStrings = copyLoop(
    [
      {
        command: 0x35,
        args: [
          {
            op: 0,
            type: 3,
            tokens: [
              token('V', 0x24, 0xe9, 3),
              ref('H', 48),
              token('B', 1),
              token('-'),
              token(')', 0),
            ],
          },
          {op: 0, type: 3, tokens: [token('M', 34, 34)]},
        ],
      },
      {command: 0x3a},
    ],
    0,
    1,
  );
  assert.ok(clearStrings);
  const strings = new YurisVariables(1001);
  strings.allocateInt(48, 0n);
  strings.get(1001).dimensions = [5];
  strings.allocateString(1001, 'keep');
  assert.equal(applyCopyLoop(clearStrings, strings, 6), false);
  assert.equal(applyCopyLoop(clearStrings, strings, 4), true);
  assert.deepEqual(strings.get(1001).strings, ['', '', '', 'keep', 'keep']);
  const letScalar = (id, source, op = 0) => ({
    command: 0x35,
    args: [
      {op, type: 1, tokens: [ref('H', id)]},
      {op: 0, type: 1, tokens: source},
    ],
  });
  const ifTokens = (tokens, end) => ({
    command: 0x2c,
    args: [{type: 1, tokens}, {size: 0}, {size: end}],
  });
  const nested = scanGuardLoop(
    [
      ifTokens([...indexed(1002), token('B', 0), token('>')], 4),
      ifTokens([...indexed(1002), token('B', 8), token('=')], 3),
      assignment(1001, [token('B', 255)]),
      {command: 0x30},
      {command: 0x30},
      {command: 0x3a},
    ],
    0,
    5,
  );
  assert.equal(nested?.branchDepth, 2);
  assert.equal(skipGuardLoop(nested, variables, 1, 9), 7);
  const rowElement = (id, sigil, previous) => [
    token('V', sigil, id & 255, id >>> 8),
    ref('H', 1003),
    ...(previous ? [token('B', 1), token('-')] : []),
    token(','),
    ref('H', 48),
    token('B', 1),
    token('-'),
    token(')', 0),
  ];
  const rowAssignment = (id, sigil, type) => ({
    command: 0x35,
    args: [
      {op: 0, type, tokens: rowElement(id, sigil, false)},
      {op: 0, type, tokens: rowElement(id, sigil, true)},
    ],
  });
  const rowShift = scanRowShift(
    [
      letScalar(1003, [token('B', 4), ref('H', 48), token('B', 1), token('-'), token('-')]),
      {command: 0x37, args: [{type: 1, tokens: [token('B', 2)]}, {size: 4}]},
      rowAssignment(1001, 0x40, 1),
      rowAssignment(1002, 0x24, 3),
      {command: 0x3a},
      {command: 0x3a},
    ],
    0,
    5,
  );
  assert.ok(rowShift);
  const rows = new YurisVariables(1003);
  rows.allocateInt(48, 0n);
  rows.allocateInt(1003, 0n);
  rows.get(1001).dimensions = [5, 2];
  rows.get(1002).dimensions = [5, 2];
  rows.allocateInt(1001, 0n);
  rows.allocateString(1002, '');
  const rowInts = rows.get(1001).ints,
    rowStrings = rows.get(1002).strings;
  for (let i = 0; i < 10; i++) {
    rowInts[i] = BigInt(i);
    rowStrings[i] = String(i);
  }
  rowStrings[4] = 'a\0b';
  assert.equal(applyRowShift(rowShift, rows, 4), false);
  assert.equal(rowInts[9], 9n);
  rowStrings[4] = '4';
  assert.equal(applyRowShift(rowShift, rows, 4), true);
  assert.deepEqual([...rowInts], [0n, 1n, 2n, 3n, 2n, 3n, 4n, 5n, 6n, 7n]);
  assert.deepEqual(rowStrings, ['0', '1', '2', '3', '2', '3', '4', '5', '6', '7']);
  const wrapped = scanGuardLoop(
    [
      letScalar(1004, [ref('H', 1005), ref('H', 48), token('B', 1), token('-'), token('+')]),
      ifTokens([ref('H', 1004), ref('H', 1006), token('>')], 3),
      letScalar(1004, [ref('H', 1006)], 2),
      {command: 0x30},
      ifTokens([ref('V', 1002), ref('H', 1004), token(')', 0), token('B', 6), token('=')], 6),
      assignment(1001, [token('B', 255)]),
      {command: 0x30},
      {command: 0x3a},
    ],
    0,
    7,
  );
  assert.ok(wrapped);
  const more = new YurisVariables(1006);
  more.allocateInt(48, 0n);
  more.entries[1002] = variables.entries[1002];
  more.allocateInt(1004, 0n);
  more.allocateInt(1005, 8n);
  more.allocateInt(1006, 9n);
  assert.equal(skipGuardLoop(wrapped, more, 1, 9), 5);
  const reversed = scanGuardLoop(
    [
      ifTokens([token('B', 6), ...indexed(1002), token('=')], 2),
      assignment(1001, [token('B', 255)]),
      {command: 0x30},
      {command: 0x3a},
    ],
    0,
    3,
  );
  assert.ok(reversed);
  assert.equal(skipGuardLoop(reversed, variables, 1, 9), 3);
  const alias = scanGuardLoop(
    [
      letScalar(1004, [ref('H', 48), token('B', 1), token('-')]),
      ifTokens([ref('V', 1002), ref('H', 1004), token(')', 0), token('B', 6), token('=')], 3),
      assignment(1001, [token('B', 255)]),
      {command: 0x30},
      {command: 0x3a},
    ],
    0,
    4,
  );
  assert.ok(alias);
  assert.equal(skipGuardLoop(alias, more, 1, 9), 4);
  const above = scanGuardLoop(
    [
      ifTokens([...indexed(1002), token('B', 6), token('>')], 2),
      assignment(1001, [token('B', 255)]),
      {command: 0x30},
      {command: 0x3a},
    ],
    0,
    3,
  );
  assert.ok(above);
  assert.equal(skipGuardLoop(above, variables, 1, 9), 6);
  const indexedGuard = scanGuardLoop(
    [
      ifTokens([...indexed(1002), ref('V', 1002), ref('H', 1003), token(')', 0), token('=')], 2),
      assignment(1001, [token('B', 255)]),
      {command: 0x30},
      {command: 0x3a},
    ],
    0,
    3,
  );
  assert.ok(indexedGuard);
  variables.allocateInt(1003, 4n);
  assert.equal(skipGuardLoop(indexedGuard, variables, 1, 9), 3);
  variables.allocateInt(1003, 9n);
  assert.equal(skipGuardLoop(indexedGuard, variables, 1, 9), 8);
  variables.allocateInt(1003, 10n);
  assert.equal(skipGuardLoop(indexedGuard, variables, 1, 9), 1);
  variables.allocateInt(1003, 2n);
  const membership = scanGuardLoop(
    [
      ifTokens(
        [
          ...indexed(1002),
          token('B', 8),
          token('='),
          ...indexed(1002),
          token('B', 5),
          token('='),
          token('|'),
        ],
        2,
      ),
      assignment(1001, [token('B', 255)]),
      {command: 0x30},
      {command: 0x3a},
    ],
    0,
    3,
  );
  assert.ok(membership);
  assert.equal(skipGuardLoop(membership, variables, 1, 9), 2);
  const arms = [
    {
      command: 0x2c,
      args: [
        {type: 1, tokens: [...indexed(1002), token('B', 8), token('=')]},
        {size: 3},
        {size: 5},
      ],
    },
    assignment(1001, [token('B', 255)]),
    {command: 0x2d, args: []},
    {
      command: 0x0b,
      args: [
        {type: 1, tokens: [...indexed(1002), token('B', 5), token('=')]},
        {size: 0},
        {size: 0},
      ],
    },
    assignment(1001, [token('B', 254)]),
    {command: 0x30},
    {command: 0x3a},
  ];
  const branched = scanGuardLoop(arms, 0, 6);
  assert.equal(branched?.branchDepth, 1);
  assert.equal(skipGuardLoop(branched, variables, 1, 9), 2);
  arms[3] = {...arms[3], args: []};
  assert.equal(scanGuardLoop(arms, 0, 6), null);
  const mapped = [ref('V', 1002), ref('H', 1004), token(')', 0)];
  const inactive = scanInactiveLoop(
    [
      letScalar(1004, [token('B', 1)], 1),
      ifTokens([ref('H', 1004), ref('H', 1006), token('>')], 3),
      {command: 0x38, args: []},
      {command: 0x30},
      letScalar(1005, mapped),
      ifTokens([ref('H', 1003)], 7),
      assignment(1001, [token('B', 255)]),
      {command: 0x30},
      ifTokens([...mapped, token('B', 7), token('=')], 10),
      assignment(1001, [token('B', 255)]),
      {command: 0x30},
      {command: 0x3a},
    ],
    0,
    11,
  );
  assert.ok(inactive);
  more.allocateInt(1003, 1n);
  assert.equal(skipInactiveLoop(inactive, more), 0);
  assert.equal(more.entries[1004].ints[0], 0n);
  more.allocateInt(1003, 0n);
  assert.equal(skipInactiveLoop(inactive, more), 5);
  assert.equal(more.entries[1004].ints[0], 5n);
  assert.equal(more.entries[1005].ints[0], 8n);
  const initializer = scanInitializer(
    [
      {
        command: 0x2b,
        extra: 8,
        args: [{id: 0}, {id: 1, type: 1, tokens: [ref('H', 48)]}],
      },
      {command: 0x3a},
      {
        command: 0x32,
        args: [
          {tokens: [ref('H', 1004)]},
          {type: 1, tokens: [ref('V', 53), token('B', 1), token(')', 0)]},
        ],
      },
      {
        command: 0x35,
        args: [
          {op: 0, type: 1, tokens: [ref('V', 1002), ref('H', 1004), token(')', 0)]},
          {type: 1, tokens: [token('B', 253)]},
        ],
      },
      {
        command: 0x35,
        args: [
          {op: 0, type: 3, tokens: [token('V', 0x24, 233, 3), ref('H', 1004), token(')', 0)]},
          {type: 3, tokens: [token('M', 34, 34)]},
        ],
      },
      {command: 0x4f, extra: 0, args: []},
    ],
    0,
    1,
    2,
  );
  assert.ok(initializer);
  more.allocateInt(53, 0n);
  assert.equal(applyInitializer(initializer, more, 5), false);
  assert.equal(shifted[1], 3n);
  more.get(1001).dimensions = [10];
  more.allocateString(1001, 's');
  assert.equal(applyInitializer(initializer, more, 5), true);
  assert.deepEqual([...shifted.slice(0, 6)], [0n, -3n, -3n, -3n, -3n, 5n]);
  assert.deepEqual(more.get(1001).strings.slice(0, 6), ['s', '', '', '', '', 's']);
});

test('YU-RIS normal layer blits preserve cropped BGRA and native mask rounding', () => {
  const pixels = Uint8Array.from({length: 6 * 4 * 4}, (_, i) => (i * 37 + 19) & 255);
  for (const [i, alpha] of [0, 1, 128, 255].entries()) pixels[(7 + i) * 4 + 3] = alpha;
  for (const [masked, a] of [
    [false, 256],
    [false, 157],
    [true, 256],
    [true, 157],
  ]) {
    const dst = Uint8Array.from({length: 7 * 4 * 4}, (_, i) => (i * 23 + 241) & 255);
    const expected = dst.slice();
    for (let y = 0; y < 2; y++) {
      for (let x = 0; x < 4; x++) {
        const from = ((y + 1) * 6 + x + 1) * 4,
          to = (y * 7 + x + 2) * 4;
        const weight = masked ? 1 + Math.floor((pixels[from + 3] * a) / 256) : a;
        for (let c = 0; c < (masked ? 3 : 4); c++)
          expected[to + c] += Math.floor(((pixels[from + c] - expected[to + c]) * weight) / 256);
      }
    }
    blendRect(dst, 7, 2, 0, {pixels, width: 6, mode: 0, a, masked}, 1, 1, 4, 2, null);
    assert.deepEqual(dst, expected);
  }
});

test('YU-RIS accelerated bilinear resize matches both scalar rounding paths byte for byte', () => {
  const stride = 7,
    rows = 5;
  const source = Uint8Array.from({length: stride * rows * 4}, (_, i) => (i * 73 + 191) & 255);
  const unaligned = new Uint8Array(source.length + 1).subarray(1);
  unaligned.set(source);
  for (const simd of [false, true]) {
    for (const [fx, fy, fx2, fy2, fsx, fsy] of [
      [0, 0, 600, 400, 700, 500],
      [21, 19, 592, 399, 400, 310],
      [-150, -85, 776, 521, 930, 815],
      [0, 40, 614, 468, 700, 850],
      [500, 400, 700, 500, 300, 200],
      [32, 55, 600, 430, 100, 100],
    ]) {
      const packed = new Uint8Array(Math.trunc(fsx / 100) * Math.trunc(fsy / 100) * 4).fill(133);
      const scalar = packed.slice();
      sizeBilinear(packed, source, stride, rows, fx, fy, fx2, fy2, fsx, fsy, simd);
      sizeBilinear(scalar, unaligned, stride, rows, fx, fy, fx2, fy2, fsx, fsy, simd);
      assert.deepEqual(packed, scalar);
    }
  }
});

test('YU-RIS large BGRA blits and bilinear crops preserve scalar results', () => {
  const stride = 306,
    rows = 289,
    width = 257,
    height = 257;
  const source = Uint8Array.from(
    {length: stride * rows * 4},
    (_, i) => (Math.imul(i, 71) ^ (i >>> 6)) & 255,
  );
  const unaligned = new Uint8Array(source.length + 2).subarray(1);
  unaligned.set(source);
  for (const simd of [false, true]) {
    const fast = new Uint8Array(width * height * 4);
    const slow = fast.slice();
    sizeBilinear(fast, source, stride, rows, 23, 59, 30025, 28074, width * 100, height * 100, simd);
    sizeBilinear(
      slow,
      unaligned,
      stride,
      rows,
      23,
      59,
      30025,
      28074,
      width * 100,
      height * 100,
      simd,
    );
    assert.deepEqual(fast, slow);
    const partial = new Uint8Array(fast.length).fill(177);
    const expected = partial.slice();
    const clip = [18, 23, 51, 62];
    for (let y = clip[1]; y <= clip[3]; y++) {
      const from = (y * width + clip[0]) * 4;
      expected.set(fast.subarray(from, (y * width + clip[2] + 1) * 4), from);
    }
    sizeBilinear(
      partial,
      source,
      stride,
      rows,
      23,
      59,
      30025,
      28074,
      width * 100,
      height * 100,
      simd,
      undefined,
      clip,
    );
    assert.deepEqual(partial, expected);
    const targetWidth = width + 11;
    const direct = new Uint8Array(targetWidth * (height + 5) * 4).fill(177);
    const output = {stride: targetWidth, x: 5, y: 3};
    const copied = sizeBilinear(
      direct,
      source,
      stride,
      rows,
      23,
      59,
      30025,
      28074,
      width * 100,
      height * 100,
      simd,
      undefined,
      [0, 0, width - 1, height - 1],
      output,
    );
    const wanted = new Uint8Array(direct.length).fill(177);
    if (copied)
      for (let y = 0; y < height; y++)
        wanted.set(
          fast.subarray(y * width * 4, (y + 1) * width * 4),
          ((y + 3) * targetWidth + 5) * 4,
        );
    assert.deepEqual(direct, wanted);
  }
  for (const [fy, revision] of [
    [59, 1],
    [189, 1],
    [244, 1],
    [51, 2],
    [377, 2],
    [511, 2],
  ]) {
    if (fy === 51) {
      source.fill(54, 0, stride * 12 * 4);
      unaligned.set(source);
    }
    const fast = new Uint8Array(width * height * 4);
    const slow = fast.slice();
    sizeBilinear(
      fast,
      source,
      stride,
      rows,
      23,
      fy,
      30025,
      28074,
      width * 100,
      height * 100,
      true,
      revision,
    );
    sizeBilinear(
      slow,
      unaligned,
      stride,
      rows,
      23,
      fy,
      30025,
      28074,
      width * 100,
      height * 100,
      true,
    );
    assert.deepEqual(fast, slow);
  }
  for (const masked of [false, true]) {
    const fast = new Uint8Array((width + 1) * height * 4).fill(171),
      slow = fast.slice();
    const opacity = 157;
    for (let y = 0; y < height; y++) {
      for (let x = 0; x < width; x++) {
        const i = ((y + 1) * stride + x + 2) * 4,
          d = (y * (width + 1) + x + 1) * 4;
        const w = masked ? 1 + ((source[i + 3] * opacity) >> 8) : opacity;
        for (let c = 0; c < (masked ? 3 : 4); c++)
          slow[d + c] += ((source[i + c] - slow[d + c]) * w) >> 8;
      }
    }
    blendRect(
      fast,
      width + 1,
      1,
      0,
      {pixels: source, width: stride, mode: 0, a: opacity, masked},
      2,
      1,
      width,
      height,
      null,
    );
    assert.deepEqual(fast, slow);
  }
  const weights = Int32Array.from({length: 256}, (_, i) => i * 2 - 254);
  const pixels = Uint8Array.from(source, (value, i) => value ^ (i & 255));
  for (const masked of [false, true]) {
    for (const a of [157, 256]) {
      const fast = new Uint8Array((width + 1) * height * 4).fill(171);
      const both = new Uint8Array(fast.length + source.length);
      const slow = both.subarray(0, fast.length);
      const sameBufferSource = both.subarray(fast.length);
      slow.set(fast);
      sameBufferSource.set(source);
      const rule = {pixels, weights};
      blendRect(
        fast,
        width + 1,
        1,
        0,
        {pixels: source, width: stride, mode: 0, a, masked},
        2,
        1,
        width,
        height,
        rule,
      );
      blendRect(
        slow,
        width + 1,
        1,
        0,
        {pixels: sameBufferSource, width: stride, mode: 0, a, masked},
        2,
        1,
        width,
        height,
        rule,
      );
      assert.deepEqual(fast, slow);
      const surface = new YurisCg();
      surface.allocate(width + 1, height, true);
      const resident = surface.pixels.fill(171);
      blendRect(
        resident,
        width + 1,
        1,
        0,
        {pixels: source, width: stride, mode: 0, a, masked},
        2,
        1,
        width,
        height,
        rule,
      );
      assert.deepEqual(resident, slow);
    }
  }
  const surface = new YurisCg();
  surface.allocate(width, height, true);
  const display = bgraDisplayFrame(surface.pixels, width, height);
  if (display) {
    surface.pixels.set([12, 34, 56, 78], (width + 1) * 4);
    assert.equal(display.update(1, 1, 7, 2), 1 | (2 << 16));
    assert.deepEqual(
      [...display.pixels.subarray((width + 1) * 4, (width + 2) * 4)],
      [56, 34, 12, 255],
    );
    assert.equal(display.update(1, 1, 7, 2), 0);
    assert.equal(display.pixels[3], 0);
    surface.pixels[(2 * width + 7) * 4] = 32;
    assert.equal(display.update(1, 1, 7, 2), 2 | (2 << 16));
  }
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
  values.delete(64);
  const before = source.pixels.slice();
  values.set(1, 1n);
  values.set(57, 1n);
  values.set(12, 2n);
  values.set(13, 1n);
  values.set(14, 4n);
  values.set(15, 2n);
  assert.equal(commands.get(2)(), 0);
  assert.deepEqual(source.pixels, before);
  assert.deepEqual([dest.width, dest.height], [3, 2]);
  for (let y = 0; y < 2; y++) {
    for (let x = 0; x < 3; x++) {
      const at = ((y + 1) * 8 + x + 2) * 4;
      const out = (y * 3 + x) * 4;
      assert.deepEqual(
        [...dest.pixels.subarray(out, out + 4)],
        [255 - before[at], 255 - before[at + 1], 255 - before[at + 2], before[at + 3]],
      );
    }
  }
  values.clear();
  values.set(60, 1n);
  values.set(9, 0x80112233n);
  assert.equal(commands.get(2)(), 0);
  assert.deepEqual([...source.pixels], Array(64).fill([0x33, 0x22, 0x11, 0x80]).flat());
  assert.equal(source.masked, 1);
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

test('YU-RIS menu commands build ordered snapshots, retain query precedence and dispatch LOWORD codes', async () => {
  const {YurisMenus} = await import('../dist/engines/yuris/vm/menu.js');
  const commands = new Map(),
    values = new Map(),
    ops = new Uint8Array(100),
    calls = [];
  let result,
    type = 1;
  const m = {
    system: {names: ['W0', '', '', 'M0'], value84: 0n},
    input: {cursorX: 23, cursorY: 41},
    define: (id, fn) => commands.set(id, fn),
    decode() {},
    commandName: (id) => (id === 0x69 ? 'WINDOW' : 'MENU'),
    variables: {get: () => ({type})},
    setInt: (_id, _index, v) => {
      if (type === 3) throw Error('Numeric query into a string');
      result = v;
    },
    setString: (_id, _index, v) => {
      result = v;
    },
    args: {
      has: (id) => (values.has(id) ? id + 1 : 0),
      text: (id) => values.get(id) ?? '',
      int: (id) => values.get(id) ?? 0n,
      op: ops,
      variable: new Uint32Array(100).fill(1000),
      variableIndex: new BigInt64Array(100),
    },
  };
  const host = {
    contextMenu: (...args) => calls.push(args),
    setWindowMenu: (...args) => calls.push(args),
    setTray() {},
  };
  const menus = new YurisMenus(m, host);
  const run = (id, args) => {
    values.clear();
    for (const [k, v] of Object.entries(args)) values.set(+k, v);
    return commands.get(id)();
  };
  run(0x3e, {0: 'Tools/', 1: 'Tools', 2: 10n});
  run(0x3e, {0: 'Tools/B', 1: 'B', 2: 20n, 6: 2n});
  run(0x3e, {0: 'Tools/A', 1: 'A', 2: 10n, 4: 0n, 5: 1n, 6: 0x112345678n});
  run(0x3e, {0: 'Tools/Hidden', 1: 'Hidden', 2: 15n, 3: 0n});
  run(0x3e, {0: 'Tools/Separator', 1: '', 2: 30n});
  run(0x3f, {0: 'Tools/', 1: 1n});
  const [items, x, y, select] = calls.at(-1);
  assert.deepEqual(
    items.map((x) => [x.label, x.enabled, x.checked, x.code]),
    [
      ['A', false, true, 0x12345678],
      ['B', true, false, 2],
      ['', false, false, 0],
    ],
  );
  assert.deepEqual([x, y], [23, 41]);
  select(items[0].code);
  assert.equal(m.system.value84, 0x5678n);
  run(0x3e, {0: 'Tools/A', 1: 'Changed', 3: 255n, 5: 254n});
  assert.equal(items[0].label, 'A'); // SetMenu captures state; later mutations do not update it.
  run(0x41, {0: 'out', 1: 'Tools/A', 4: 1n, 5: 1n, 8: 1n});
  assert.equal(result, -1n);
  run(0x41, {0: 'out', 1: 'Tools/A', 7: 1n});
  assert.equal(result, -2n);
  run(0x41, {0: 'out', 1: 'Tools/A', 8: 1n});
  assert.equal(result, 0x112345678n);
  type = 3;
  run(0x41, {0: 'out', 1: 'Tools/A', 2: 1n});
  assert.equal(result, 'Changed');
  run(0x41, {0: 'out', 1: 'Missing', 2: 1n});
  assert.equal(result, '');
  type = 1;
  run(0x41, {0: 'out', 1: 'Missing', 8: 1n});
  assert.equal(result, 0n);
  ops[3] = 1;
  run(0x3e, {0: 'Tools/B', 2: 0x80000000n});
  ops[3] = 0;
  run(0x41, {0: 'out', 1: 'Tools/B', 4: 1n});
  assert.equal(result, -2147483628n);
  ops[3] = 2;
  run(0x3e, {0: 'Tools/B', 2: 1n});
  ops[3] = 0;
  run(0x41, {0: 'out', 1: 'Tools/B', 4: 1n});
  assert.equal(result, 1n);
  assert.throws(
    () => run(0x3e, {0: 'Missing', 2: 1n}),
    (e) => e.code === 0x187a4,
  );
  assert.throws(
    () => run(0x3e, {0: 'Missing', 1: 'New'}),
    (e) => e.code === 0x18790,
  );
  menus.windowMenu(0, 'Tools/');
  assert.equal(calls.at(-1)[1].length, 3);
  menus.windowMenu(0, '');
  assert.deepEqual(calls.at(-1)[1], []);
  assert.throws(
    () => menus.windowMenu(0, 'Missing/'),
    (e) => e.code === 0x18b82,
  );
  run(0x40, {0: 'Tools/'});
  run(0x41, {0: 'out', 1: 'Tools/A', 3: 1n});
  assert.equal(result, 0n);
});

test('YU-RIS numbered opacity updates stay inside the selected layer set and range', () => {
  const layers = new YurisLayers(
    {screenWidth: 16, screenHeight: 16, system: {names: ['W0']}},
    {},
    {},
  );
  const leaf = (path) => {
    const cg = new YurisCg();
    cg.allocate(2, 2);
    layers.tree.create(path, false, 1n, cg);
    return cg;
  };
  const inside = leaf('W0/SPR101');
  const outside = leaf('W0/SPR103');
  const other = leaf('SPR101');
  inside.lint2 = 123n;
  assert.equal(layers.readLint2('SPR101'), 123n);
  assert.equal(layers.readLint2('SPR102'), 0n);
  layers.clearOpacityRange('SPR', 101, 2);
  assert.deepEqual([inside.a, outside.a, other.a], [0, 256, 256]);
  assert.equal(layers.redraw, true);
});

test('YU-RIS node paths preserve navigation, spaces and multibyte separators', async () => {
  const {YurisTree, resolveNodePath} = await import('../dist/engines/yuris/vm/nodes.js');
  assert.deepEqual(resolveNodePath('ROOT', 'images/button/'), {
    path: 'ROOT/images/button',
    group: true,
  });
  assert.deepEqual(resolveNodePath('ROOT', 'images/./button/'), {
    path: 'ROOT/images/button',
    group: true,
  });
  assert.deepEqual(resolveNodePath('ROOT', 'plain label'), {
    path: 'ROOT/plain label',
    group: false,
  });
  assert.throws(
    () => resolveNodePath('ROOT', 'images/plain label'),
    (e) => e.code === 0x18792,
  );
  const tree = new YurisTree();
  tree.create('ROOT', true, 1n);
  const path = resolveNodePath('ROOT', '\x81/button').path;
  const leaf = tree.create(path, false, 1n);
  assert.equal(tree.lookup(path, 0), leaf);
});

test('YU-RIS TRAY keeps icon ownership, menu snapshots and missing-layer early returns', async () => {
  const {YurisMenus} = await import('../dist/engines/yuris/vm/menu.js');
  const {YurisTree} = await import('../dist/engines/yuris/vm/nodes.js');
  const commands = new Map(),
    values = new Map(),
    calls = [];
  const m = {
    system: {names: ['W0', '', '', 'M0'], value84: 0n},
    windows: {windows: [{active: false}]},
    layers: {tree: new YurisTree()},
    define: (id, fn) => commands.set(id, fn),
    decode() {},
    commandName: () => 'MENU',
    messageBox() {
      throw new Error('Unexpected icon diagnostic');
    },
    args: {
      has: (id) => (values.has(id) ? id + 1 : 0),
      text: (id) => values.get(id) ?? '',
      int: (id) => values.get(id) ?? 0n,
      op: new Uint8Array(100),
    },
  };
  const menus = new YurisMenus(m, {
    setTray: (...args) => calls.push(args),
    contextMenu() {},
    setWindowMenu() {},
  });
  const run = (id, args) => {
    values.clear();
    for (const [k, v] of Object.entries(args)) values.set(+k, v);
    return commands.get(id)();
  };
  run(0x3e, {0: 'Tray/', 1: 'Tray', 2: 1n});
  run(0x3e, {0: 'Tray/Back', 1: 'Back', 2: 1n, 6: 1001n});
  run(0x64, {0: 1n, 1: 'Caption', 2: 'Missing', 3: 'Tray/'});
  assert.equal(calls.length, 0);
  m.layers.tree.create('W0', true, 1n, {});
  const pixels = new Uint8Array(16 * 16 * 4).fill(127);
  m.layers.tree.create('W0/Icon', false, 1n, {width: 16, height: 16, pixels});
  run(0x64, {0: 1n, 1: 'Caption', 2: 'Icon', 3: 'Tray/'});
  const [tray, select, activate] = calls.at(-1);
  assert.equal(tray.label, 'Caption');
  assert.equal(tray.items[0].code, 1001);
  assert.equal(tray.icon.width, 16);
  assert.notEqual(tray.icon.pixels, pixels);
  pixels.fill(0);
  assert.equal(tray.icon.pixels[0], 127);
  select(1001);
  assert.equal(m.system.value84, 1001n);
  activate();
  assert.equal(m.windows.windows[0].active, true);
  const count = calls.length;
  run(0x64, {1: 'Later'});
  assert.equal(calls.length, count);
  run(0x64, {0: 0n});
  assert.equal(calls.at(-1)[0], null);
});

test('YU-RIS scenario loading restores voice commands embedded in Japanese ML.TEXT', async () => {
  const {installText} = await import('../dist/engines/yuris/vm/text.js');
  const voice = String.raw`\VO2(CUE_B)\VO3(CUE_C)\VO4()`;
  const text = String.raw`\X30` + '\x81\x5c' + 'text';
  const original = String.raw`\VO(CUE_A)\ML.TEXT("first","` + voice + text + '")';
  const repaired = String.raw`\VO(CUE_A)` + voice + String.raw`\ML.TEXT("first","` + text + '")';
  const midText = String.raw`\ML.TEXT("first","literal \VO2(CUE_D)")`;
  const lines = [original, '// ' + original, '/*', original, '*/ ' + original, midText];
  const handlers = new Map();
  const stored = [];
  const m = {
    project: {
      labels: {
        labels: [
          {script: 5, position: 7},
          {script: 6, position: 0},
        ],
      },
    },
    label: (name) =>
      ['es.SCENARIO.LOAD', 'es.ScenarioMacro.ML.TEXT'].indexOf(Buffer.from(name).toString()),
    task: {script: 5},
    position: 8,
    define: (id, fn) => handlers.set(id, fn),
    decode() {},
    args: {has: (id) => (id < 2 ? id + 1 : 0), variable: [0, 0, 42], text: () => 'scene.txt'},
    files: {exists: () => true, read: async () => Buffer.from(lines.join('\r\n'), 'latin1')},
    variables: {get: () => ({dimensions: [16]})},
    setString: (id, index, value) => {
      assert.equal(id, 42);
      stored[Number(index)] = value;
    },
  };
  installText(m);
  await handlers.get(0x62)();
  assert.deepEqual(
    stored,
    [repaired, lines[1], lines[2], original, '*/ ' + repaired, midText]
      .map((line) => line + '\r')
      .concat('', ''),
  );
  m.position++;
  await handlers.get(0x62)();
  assert.deepEqual(stored, lines.map((line) => line + '\r').concat('', ''));
});

test('YU-RIS lookahead reads PNG hints through one dialogue and stops at choices', async () => {
  const {YurisSceneLookahead} = await import('../dist/engines/yuris/vm/scene-lookahead.js');
  const entries = [];
  const source = [
    String.raw`\ML.TEXT("first","quoted \SEL.GO()")`,
    String.raw`\T(T_ABC_1A0100,250)`,
    String.raw`\ML.S(A,ev/name,250)`,
    String.raw`\ML.TEXT("second","second")`,
    String.raw`\S(B,ev/unknown,250)`,
    String.raw`\SEL.GO()`,
    String.raw`\ML.TEXT("third","third")`,
  ];
  for (const [id, ints] of [
    [1157, [1n]],
    [3039, [1n]],
    [3040, [0n]],
    [2930, [2n]],
    [2931, [2n, 5n]],
    [1176, new BigInt64Array(256)],
  ])
    entries[id] = {ints, dimensions: [256, 1]};
  entries[3038] = {strings: ['scenario.txt']};
  entries[2899] = {strings: source};
  entries[2932] = {strings: ['cg/stand/m_050/irrelevant', 'cg/ev/unknown']};
  let time = 0;
  const lookahead = new YurisSceneLookahead({variables: {entries}, now: () => time});
  lookahead.observeImage('cg\\stand\\m_040\\t_abc\\t_abc_1a\\t_abc_1a0100.png');
  assert.equal(lookahead.update(), undefined);
  time = 61;
  assert.deepEqual(lookahead.update(), [
    'cg/stand/m_040/T_ABC/T_ABC_1A/T_ABC_1A0100',
    'cg/ev/name_c',
  ]);
  assert.equal(lookahead.update(), undefined);
  entries[3039].ints[0] = 4n;
  entries[3040].ints[0] = 3n;
  assert.deepEqual(lookahead.update(), []);
  assert.equal(entries[3039].ints[0], 4n);
  assert.equal(source.length, 7);
});
