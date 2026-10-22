/** Generated SM4 programs and independent expected results; no game code or assets. */
const memory = new DataView(new ArrayBuffer(4));
export function floatWord(n) {
  memory.setFloat32(0, n, true);
  return memory.getUint32(0, true);
}
export function instruction(opcode, operands = [], controls = 0) {
  const words = operands.flat();
  return [((words.length + 1) << 24) | (controls << 11) | opcode, ...words];
}
export function destination(type, index, mask = 15) {
  return [2 | (mask << 4) | (type << 12) | (1 << 20), index];
}
export function source(type, index, swizzle = [0, 1, 2, 3], modifier = 0) {
  const components = swizzle.reduce((n, c, i) => n | (c << (4 + i * 2)), 0),
    token = 2 | 4 | components | (type << 12) | (1 << 20);
  return modifier ? [(token | 0x80000000) >>> 0, 1 | (modifier << 6), index] : [token, index];
}
export function literal(values) {
  const words = values.map(floatWord);
  return [words.length === 1 ? 0x4001 : 0x4002, ...words];
}
export function constant(slot, row) {
  return [0x00208e46, slot, row];
}
export function sampleResource(slot, swizzle = [0, 1, 2, 3]) {
  return source(7, slot, swizzle);
}
export function samplerOperand(slot) {
  return [(6 << 12) | (1 << 20), slot];
}
export function shaderWords({
  body,
  inputs = 1,
  temps = 0,
  constants = [],
  resources = [],
  samplers = [],
  stage = 'pixel',
}) {
  const words = [];
  for (const [slot, vectors] of constants)
    words.push(...instruction(89, [[0x00208f02, slot, vectors]]));
  for (const slot of resources)
    words.push(...instruction(88, [[(7 << 12) | (1 << 20), slot], [0x5555]], 3));
  for (const slot of samplers) words.push(...instruction(90, [samplerOperand(slot)]));
  for (let i = 0; i < inputs; i++)
    words.push(
      ...instruction(stage === 'pixel' ? 98 : 95, [destination(1, i)], stage === 'pixel' ? 2 : 0),
    );
  words.push(...instruction(101, [destination(2, 0)]));
  if (temps) words.push(...instruction(104, [[temps]]));
  words.push(...body.flat(), ...instruction(62));
  return [stage === 'pixel' ? 0x40 : 0x10040, words.length + 2, ...words];
}

export function sm4SyntheticFixtures() {
  const cases = [],
    o = (mask = 15) => destination(2, 0, mask),
    r = (n, mask = 15) => destination(0, n, mask),
    v = (n, sw, mod) => source(1, n, sw, mod);
  const add = (name, program, inputs, expected, extra = {}) =>
    cases.push({
      name,
      words: shaderWords(program),
      inputs: inputs.map((a) => a.map(floatWord)),
      expected: expected.map(floatWord),
      ...extra,
    });
  const unary = (name, opcode, inputs, expected, extra = {}) =>
    add(name, {body: [instruction(opcode, [o(), v(0)])]}, [inputs], expected, extra);
  cases.push({
    name: 'raw-move-bits',
    words: shaderWords({body: [instruction(54, [o(), v(0)])]}),
    inputs: [[0x80000000, 0x7fc01234, 1, 0x3f000000]],
    expected: [0x80000000, 0x7fc01234, 1, 0x3f000000],
  });
  add(
    'modifier-swizzle-and-masked-alias',
    {
      temps: 1,
      body: [
        instruction(54, [r(0), v(0, undefined, 2)]),
        instruction(54, [r(0, 3), source(0, 0, [1, 0, 2, 3])]),
        instruction(54, [o(), source(0, 0, undefined, 1)]),
      ],
    },
    [[-0, -2, -3, 4]],
    [-2, -0, -3, -4],
  );
  cases.push({
    name: 'movc-raw-condition',
    words: shaderWords({inputs: 3, body: [instruction(55, [o(), v(0), v(1), v(2)])]}),
    inputs: [[0x80000000, 0, 1, 0], [1, 2, 3, 4].map(floatWord), [5, 6, 7, 8].map(floatWord)],
    expected: [1, 6, 3, 8].map(floatWord),
  });
  add(
    'mad-dot-masked-multiply',
    {
      inputs: 3,
      temps: 1,
      body: [
        instruction(50, [r(0), v(0), v(1), v(2)]),
        instruction(16, [o(1), source(0, 0), literal([2])]),
        instruction(56, [o(14), source(0, 0), v(0)]),
      ],
    },
    [
      [1.5, -2, 0.25, 4],
      [2, 3, 4, -1],
      [0.5, 0.5, 0.5, 0.5],
    ],
    [-1, 11, 0.375, -14],
  );
  add(
    'less-than-unordered',
    {inputs: 2, body: [instruction(49, [o(), v(0), v(1)])]},
    [
      [NaN, -0, -1, Infinity],
      [0, 0, 0, Infinity],
    ],
    [0, 0, NaN, 0],
    {expected: [0, 0, 0xffffffff, 0]},
  );
  add(
    'greater-equal-unordered',
    {inputs: 2, body: [instruction(29, [o(), v(0), v(1)])]},
    [
      [NaN, -0, -1, Infinity],
      [0, 0, 0, Infinity],
    ],
    [0, NaN, 0, NaN],
    {expected: [0, 0xffffffff, 0, 0xffffffff]},
  );
  add(
    'min-nan-selection',
    {inputs: 2, body: [instruction(51, [o(), v(0), v(1)])]},
    [
      [NaN, 1, -Infinity, Infinity],
      [2, NaN, 4, 3],
    ],
    [2, 1, -Infinity, 3],
  );
  add(
    'max-nan-selection',
    {inputs: 2, body: [instruction(52, [o(), v(0), v(1)])]},
    [
      [NaN, 1, -Infinity, Infinity],
      [2, NaN, 4, 3],
    ],
    [2, 1, 4, Infinity],
  );
  add(
    'saturate-nan',
    {body: [instruction(54, [o(), v(0)], 4)]},
    [[-Infinity, NaN, 0.25, 2]],
    [0, 0, 0.25, 1],
  );
  cases.push({
    name: 'arithmetic-denorm-flush',
    words: shaderWords({body: [instruction(56, [o(), v(0), literal([1])])]}),
    inputs: [[1, 0x80000001, 0x007fffff, 0x807fffff]],
    expected: [0, 0x80000000, 0, 0x80000000],
  });
  add(
    'divide-special',
    {inputs: 2, body: [instruction(14, [o(), v(0), v(1)])]},
    [
      [1, -1, 0, Infinity],
      [0, -0, 0, Infinity],
    ],
    [Infinity, Infinity, NaN, NaN],
    {nanLanes: [2, 3]},
  );
  unary('log-special', 47, [-0, -1, 1, Infinity], [-Infinity, NaN, 0, Infinity], {nanLanes: [1]});
  unary('rsq-special', 68, [-0, -1, 4, Infinity], [-Infinity, NaN, 0.5, 0], {
    nanLanes: [1],
    maxUlp: 4,
  });
  unary('exp-special', 25, [-Infinity, 0, 1, NaN], [0, 1, 2, NaN], {nanLanes: [3]});
  unary('floor-signed-zero', 65, [-1.5, -0, 0.5, 2], [-2, -0, 0, 2]);
  add(
    'constant-buffer-zero-fill',
    {
      inputs: 0,
      constants: [[0, 2]],
      temps: 1,
      body: [
        instruction(54, [r(0), constant(0, 0)]),
        instruction(0, [o(), source(0, 0), constant(0, 1)]),
      ],
    },
    [],
    [1, 2, 3, 4],
    {constants: {0: [1, 2, 3, 4].map(floatWord)}},
  );
  for (const [mode, bits, discarded] of [
    [0, 0, true],
    [0, 0x80000000, false],
    [128, 1, true],
    [128, 0, false],
  ]) {
    const cond = [2 | 8 | (1 << 12) | (1 << 20), 0];
    cases.push({
      name: `discard-${mode}-${bits}`,
      words: shaderWords({
        body: [instruction(13, [cond], mode), instruction(54, [o(), literal([1, 2, 3, 4])])],
      }),
      inputs: [[bits, 0, 0, 0]],
      expected: [1, 2, 3, 4].map(floatWord),
      discarded,
    });
  }
  add(
    'resource-swizzle',
    {
      resources: [0],
      samplers: [0],
      body: [instruction(69, [o(), v(0), sampleResource(0, [3, 2, 1, 0]), samplerOperand(0)])],
    },
    [[0.5, 0.5, 0, 0]],
    [1, 0.75, 0.5, 0.25],
    {textures: {0: {width: 1, height: 1, data: [0.25, 0.5, 0.75, 1]}}},
  );
  add(
    'independent-sampler-pairs',
    {
      resources: [0],
      samplers: [0, 1],
      temps: 2,
      body: [
        instruction(69, [r(0), v(0), sampleResource(0), samplerOperand(0)]),
        instruction(69, [r(1), v(0), sampleResource(0), samplerOperand(1)]),
        instruction(0, [o(), source(0, 0), source(0, 1)]),
      ],
    },
    [[0.5, 0.5, 0, 0]],
    [0.5, 1.5, 0, 2],
    {
      textures: {0: {width: 2, height: 1, bytes: [255, 0, 0, 255, 0, 255, 0, 255]}},
      samplers: {0: 'nearest', 1: 'linear'},
    },
  );
  return cases;
}
