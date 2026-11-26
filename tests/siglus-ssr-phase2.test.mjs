import assert from 'node:assert/strict';
import {test} from 'node:test';
import {siglusCos, siglusSin, siglusTostrZen} from '../dist/engines/siglus/math.js';
import {SiglusVm} from '../dist/engines/siglus/vm.js';
import {proceduralWipeMask} from '../dist/engines/siglus/wipe.js';

const i32 = (value) => [value & 0xff, (value >>> 8) & 0xff, (value >>> 16) & 0xff, value >>> 24];
const push = (form, value) => [0x02, ...i32(form), ...i32(value)];
const pushInt = (value) => push(10, value);
const pushStr = (index) => push(20, index);
const elm = (...segments) => [0x08, ...segments.flatMap((s) => pushInt(s))];

function encodeArgList(forms) {
  const out = [...i32(forms.length)];
  for (let i = forms.length - 1; i >= 0; i--) {
    const f = forms[i];
    if (Array.isArray(f)) {
      out.push(...i32(-1), ...encodeArgList(f));
    } else {
      out.push(...i32(f));
    }
  }
  return out;
}

function cmd(alId, forms, namedIds, retForm) {
  return [
    0x30,
    ...i32(alId),
    ...encodeArgList(forms),
    ...i32(namedIds.length),
    ...namedIds.toReversed().flatMap(i32),
    ...i32(retForm),
  ];
}

function makePack(code, strings = []) {
  const scene = {
    name: 'test',
    code: Uint8Array.from(code),
    strings,
    labels: [],
    entries: [0],
    properties: [],
    commands: [],
    commandNames: [],
  };
  return {
    sceneNames: ['test'],
    properties: [],
    propertyNames: [],
    commands: [],
    commandNames: [],
    commandScenes: [],
    scene: () => scene,
  };
}

async function runVm(code, strings = [], onCommand = async () => 0) {
  const calls = [];
  const props = new Map();
  let vmRef;
  const vm = new SiglusVm(
    makePack(code, strings),
    {
      command: async (c) => {
        calls.push(c);
        return onCommand(c, vmRef);
      },
      property: (p, v) => {
        if (p[0] === 83) return undefined;
        const key = p.join('.');
        if (v !== undefined) props.set(key, v);
        return props.get(key);
      },
      message: () => {},
      trace: () => {},
    },
    new AbortController().signal,
  );
  vmRef = vm;
  await vm.run('test', 0);
  return {calls, props, vm};
}

test('Phase 2A math.sin (0x55a556), math.cos (0x55a59d), and math.tostr_zen (0x55a9f7 -> 0x6afd70)', () => {
  // Tenths of a degree: 0 = 0°, 900 = 90°, 1800 = 180°, 2700 = 270°, 3600 = 360°
  assert.equal(siglusSin(0, 1000), 0);
  assert.equal(siglusSin(900, 1000), 1000);
  assert.equal(siglusSin(1800, 1000), 0);
  assert.equal(siglusSin(2700, 1000), -1000);
  assert.equal(siglusSin(300, 1000), 500);
  assert.equal(siglusCos(0, 1000), 1000);
  assert.equal(siglusCos(900, 1000), 0);
  assert.equal(siglusCos(1800, 1000), -1000);
  assert.equal(siglusCos(2700, 1000), 0);
  assert.equal(siglusCos(600, 1000), 499);

  // tostr_zen: ASCII space -> U+3000, 0x21..0x7e -> +0xfee0
  assert.equal(siglusTostrZen(0), '０');
  assert.equal(siglusTostrZen(42), '４２');
  assert.equal(siglusTostrZen(7, 3), '\u3000\u3000７');
  assert.equal(siglusTostrZen(-12, 5), '\u3000\u3000－１２');
  assert.equal(siglusTostrZen(1234, 2), '１２３４');
});

test('Phase 2A VM string.mid_len (member 8) and string.get_code (member 13) match native 0x55e680', async () => {
  // Use cur_call.K[0] = "A雨B音C" (root 83, member 1, -1, index 0)
  // Assign cur_call.K[0] = "A雨B音C" via CD_ASSIGN (0x20, leftForm=20, rightForm=20, alId=1)
  const assignStr = (idx, strId) => [
    ...elm(83, 1, -1, idx),
    ...pushStr(strId),
    0x20,
    ...i32(20),
    ...i32(20),
    ...i32(1),
  ];

  // Probe helper: pass result to host command root 999 so we capture exact return values
  const probeStr = (strMethod, intArgs) => [
    ...elm(999),
    ...elm(83, 1, -1, 0, strMethod),
    ...intArgs.flatMap(pushInt),
    ...cmd(0, intArgs.map(() => 10), [], 20),
    ...cmd(0, [20], [], 0),
  ];
  const probeInt = (strMethod, intArgs) => [
    ...elm(999),
    ...elm(83, 1, -1, 0, strMethod),
    ...intArgs.flatMap(pushInt),
    ...cmd(0, intArgs.map(() => 10), [], 10),
    ...cmd(0, [10], [], 0),
  ];

  const code = [
    ...assignStr(0, 0), // "A雨B音C": widths A(1), 雨(2), B(1), 音(2), C(1)
    ...probeStr(8, [0, 1]), // "A" (1 col)
    ...probeStr(8, [0, 2]), // "A" (next char '雨' would make 3 > 2)
    ...probeStr(8, [0, 3]), // "A雨" (3 cols)
    ...probeStr(8, [1, 3]), // "雨B" (3 cols)
    ...probeStr(8, [1, 4]), // "雨B" (next char '音' would make 5 > 4)
    ...probeStr(8, [1, 5]), // "雨B音" (5 cols)
    ...probeInt(13, [0]), // 'A' = 65
    ...probeInt(13, [1]), // '雨' = 0x96e8 = 38632
    ...probeInt(13, [-1]), // out of bounds -> 0
    ...probeInt(13, [99]), // out of bounds -> 0
    0x16,
  ];

  const {calls} = await runVm(code, ['A雨B音C']);
  const results = calls.map((c) => c.args[0]);
  assert.deepEqual(results, ['A', 'A', 'A雨', '雨B', '雨B', '雨B音', 65, 0x96e8, 0, 0]);
});

test('Phase 2A VM readIntList / writeIntList round-trips global and call-local intlists', async () => {
  // Set cur_call.L[0..3] = [10, 20, 30, 40] via cur_call.L.sets(0, 10, 20, 30, 40) (83.0.1)
  const code = [
    ...elm(83, 0, 1),
    ...pushInt(0),
    ...pushInt(10),
    ...pushInt(20),
    ...pushInt(30),
    ...pushInt(40),
    ...cmd(0, [10, 10, 10, 10, 10], [], 0),
    // Trigger host command 999 with intlist reference to cur_call.L (form 14)
    ...elm(999),
    ...elm(83, 0),
    ...cmd(0, [14], [], 0),
    0x16,
  ];

  let snapshotBefore;
  let snapshotAfter;
  await runVm(code, [], async (c, vm) => {
    const refPath = c.args[0];
    snapshotBefore = vm.readIntList(refPath, 0, 4);
    vm.writeIntList(refPath, 1, [77, 88]);
    snapshotAfter = vm.readIntList(refPath, 0, 4);
    return 0;
  });

  assert.deepEqual(snapshotBefore, [10, 20, 30, 40]);
  assert.deepEqual(snapshotAfter, [10, 77, 88, 40]);
});

test('Phase 2D proceduralWipeMask supports all 21 verified SSR wipe types', () => {
  // Crossfade / simple blend types (0, 1, 900) return undefined (direct blend without alpha mask)
  assert.equal(proceduralWipeMask(0, 32, 24, []), undefined);
  assert.equal(proceduralWipeMask(1, 32, 24, []), undefined);
  assert.equal(proceduralWipeMask(900, 32, 24, []), undefined);

  // All 18 procedural mask wipe types observed across SSR Scene.pck
  const maskTypes = [10, 11, 60, 70, 72, 73, 80, 81, 83, 100, 101, 102, 110, 120, 150, 200, 214, 220];
  for (const type of maskTypes) {
    const mask = proceduralWipeMask(type, 32, 24, [16, 1, 0, 0]);
    assert.ok(mask, `Expected procedural mask for SSR wipe type ${type}`);
    assert.equal(mask.width, 32);
    assert.equal(mask.height, 24);
    assert.equal(mask.values.length, 32 * 24);
    assert.ok(mask.softness >= 0 && mask.softness <= 255, `Invalid softness ${mask.softness} for type ${type}`);
  }

  // Directional check (255 reveals first, matching fanWipeMask/animateFanWipe):
  // type 100 dir=0 (left->right) vs dir=1 (right->left)
  const lr = proceduralWipeMask(100, 16, 8, [0, 0]);
  const rl = proceduralWipeMask(100, 16, 8, [0, 1]);
  assert.ok(lr && rl);
  assert.equal(lr.values[0], 255);
  assert.equal(lr.values[15], 0);
  assert.equal(rl.values[0], 0);
  assert.equal(rl.values[15], 255);

  // Iris / box wipe (120): center reveals first (255) > corner (0), reversed center (0) < corner (255)
  const iris = proceduralWipeMask(120, 17, 17, [0, 0]);
  const irisRev = proceduralWipeMask(120, 17, 17, [0, 1]);
  assert.ok(iris && irisRev);
  assert.equal(iris.values[8 * 17 + 8], 255);
  assert.equal(iris.values[0], 0);
  assert.equal(irisRev.values[8 * 17 + 8], 0);
  assert.equal(irisRev.values[0], 255);
});
