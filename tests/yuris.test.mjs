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
