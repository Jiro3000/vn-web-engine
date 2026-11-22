import assert from 'node:assert/strict';
import {test} from 'node:test';
import {layoutSelbtnItems, parseSelbtnArgs, readSelbtnTemplate} from '../dist/engines/siglus/selbtn.js';
import {SiglusVm} from '../dist/engines/siglus/vm.js';
import {g00MaskValues, selectPcmEventIndex, wipeSoftness, wipeSoftnessTable} from '../dist/engines/siglus/wipe.js';

const i32 = (value) => [value & 0xff, (value >>> 8) & 0xff, (value >>> 16) & 0xff, value >>> 24];
const push = (form, value) => [0x02, ...i32(form), ...i32(value)];
const pushInt = (value) => push(10, value);
const pushStr = (index) => push(20, index);
const pop = (form) => [0x03, ...i32(form)];
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

function cmd(alId, forms, namedIds, retForm, trailingReadFlag) {
  const out = [
    0x30,
    ...i32(alId),
    ...encodeArgList(forms),
    ...i32(namedIds.length),
    ...namedIds.toReversed().flatMap(i32),
    ...i32(retForm),
  ];
  if (trailingReadFlag !== undefined) out.push(...i32(trailingReadFlag));
  return out;
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
        // Let SiglusVm own call-local storage (root 83 = cur_call) directly.
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

test('VM-GAP-01: trailing 4-byte readFlag is consumed for all 11 global roots and mwnd members, but NOT object members', async () => {
  const globalReadFlagRoots = [0x0c, 0x12, 0x13, 0x4c, 0x4d, 0x5a, 0x5b, 0x64, 0x65, 0x66, 0x7f];
  const code = [];
  for (let i = 0; i < globalReadFlagRoots.length; i++) {
    code.push(...elm(globalReadFlagRoots[i]), ...cmd(0, [], [], 0, 100 + i));
  }
  // mwnd member 0x1b (koe_play_wait_key) on front.mwnd[0]
  code.push(...elm(38, 3, -1, 0, 0x1b), ...cmd(0, [], [], 0, 777));
  // Negative control: front.object[0] member 0x4c (76 = x_eve? NO readFlag!)
  code.push(...elm(38, 2, -1, 0, 0x4c), ...cmd(0, [], [], 0));
  code.push(0x16);

  const {calls} = await runVm(code);
  assert.equal(calls.length, globalReadFlagRoots.length + 2);
  for (let i = 0; i < globalReadFlagRoots.length; i++) {
    assert.equal(calls[i].path[0], globalReadFlagRoots[i]);
    assert.equal(calls[i].readFlag, 100 + i);
  }
  assert.deepEqual(calls[globalReadFlagRoots.length].path, [38, 3, -1, 0, 0x1b]);
  assert.equal(calls[globalReadFlagRoots.length].readFlag, 777);
  assert.deepEqual(calls[globalReadFlagRoots.length + 1].path, [38, 2, -1, 0, 0x4c]);
  assert.equal(calls[globalReadFlagRoots.length + 1].readFlag, undefined);
});

test('VM-GAP-02: heterogeneous nested list(-1) arguments [str, int, int] decode cleanly', async () => {
  const code = [
    ...elm(52, -1, 0, 2),
    ...pushInt(10),
    ...pushStr(0),
    ...pushInt(1000),
    ...pushInt(2000),
    ...cmd(1, [10, [20, 10, 10]], [], 0),
    0x16,
  ];
  const {calls} = await runVm(code, ['bgv_sample']);
  assert.equal(calls.length, 1);
  assert.deepEqual(calls[0].args, [10, ['bgv_sample', 1000, 2000]]);
});

test('VM-GAP-03: CD_POP(void(0)) is a no-op and retForm=void(0) pushes nothing onto the stack', async () => {
  let depthAfterVoidCalls = -1;
  const code = [
    // Two unpopped void commands (like global.msg_block)
    ...elm(84), ...cmd(0, [], [], 0),
    ...elm(84), ...cmd(0, [], [], 0),
    // One void command followed by CD_POP(void(0))
    ...elm(84), ...cmd(0, [], [], 0), ...pop(0),
    // Probe command inspecting stack depth
    ...elm(36), ...cmd(0, [], [], 10), ...pop(10),
    0x16,
  ];
  await runVm(code, [], async (c, vm) => {
    if (c.path[0] === 36) depthAfterVoidCalls = vm.checkpoint().frames[0].stack.length;
    return 0;
  });
  assert.equal(depthAfterVoidCalls, 0);
});

test('VM-GAP-04: OPERATE_2 handles / 0 === 0, % 0 === 0, signed int32 >>>, and str * int repetition', async () => {
  const assignGlobalInt = (slot, lhs, rhs, op) => [
    ...elm(23, -1, slot),
    ...pushInt(lhs),
    ...pushInt(rhs),
    0x22, ...i32(10), ...i32(10), op,
    0x20, ...i32(13), ...i32(10), ...i32(1),
  ];
  const assignGlobalStrMul = (slot, strIdx, count) => [
    ...elm(34, -1, slot),
    ...pushStr(strIdx),
    ...pushInt(count),
    0x22, ...i32(20), ...i32(10), 0x03,
    0x20, ...i32(23), ...i32(20), ...i32(1),
  ];
  const code = [
    ...assignGlobalInt(0, 10, 0, 0x04), // 10 / 0 === 0
    ...assignGlobalInt(1, 10, 0, 0x05), // 10 % 0 === 0
    ...assignGlobalInt(2, -1, 0, 0x36), // (-1) >>> 0 === -1 (signed int32)
    ...assignGlobalInt(3, -1, 1, 0x36), // (-1) >>> 1 === 2147483647
    ...assignGlobalStrMul(0, 0, 3), // "ab" * 3 === "ababab"
    ...assignGlobalStrMul(1, 0, 0), // "ab" * 0 === ""
    ...assignGlobalStrMul(2, 0, -2), // "ab" * -2 === ""
    0x16,
  ];
  const {props} = await runVm(code, ['ab']);
  assert.equal(props.get('23.-1.0'), 0);
  assert.equal(props.get('23.-1.1'), 0);
  assert.equal(props.get('23.-1.2'), -1);
  assert.equal(props.get('23.-1.3'), 2147483647);
  assert.equal(props.get('34.-1.0'), 'ababab');
  assert.equal(props.get('34.-1.1'), '');
  assert.equal(props.get('34.-1.2'), '');
});

test('Phase 1 VM refs & intlist: retForm=23 strref (global.namae), vm.assign intref (get_calendar), intlist clear/init/resize, global S string method', async () => {
  const code = [
    // 1) global.namae("％Ａ") = "Hero" then read back into global.S[0]
    ...elm(108), ...pushStr(0), ...cmd(0, [20], [], 23),
    ...pushStr(1),
    0x20, ...i32(23), ...i32(20), ...i32(1),
    ...elm(34, -1, 0),
    ...elm(108), ...pushStr(0), ...cmd(0, [20], [], 23),
    0x05, // CD_PROPERTY on strref [108, 0]
    0x20, ...i32(23), ...i32(20), ...i32(1),

    // 2) global.S[0].cnt() (member 5) -> store in global.A[0]
    ...elm(23, -1, 0),
    ...elm(34, -1, 0, 5), ...cmd(0, [], [], 10),
    0x20, ...i32(13), ...i32(10), ...i32(1),

    // 3) system.get_calendar(&A[1]) using vm.assign(refPath, val)
    ...elm(92, 14), ...elm(23, -1, 1), ...cmd(0, [13], [], 0),

    // 4) global.Z[0..2] = 7 then Z.clear(0, 1) -> Z[0]=0, Z[1]=0, Z[2]=7
    ...elm(31, -1, 0), ...pushInt(7), 0x20, ...i32(13), ...i32(10), ...i32(1),
    ...elm(31, -1, 1), ...pushInt(7), 0x20, ...i32(13), ...i32(10), ...i32(1),
    ...elm(31, -1, 2), ...pushInt(7), 0x20, ...i32(13), ...i32(10), ...i32(1),
    ...elm(31, 8), ...pushInt(0), ...pushInt(1), ...cmd(0, [10, 10], [], 0),

    // 5) cur_call.L[0] = 99 then cur_call.L.init() -> L[0] === 0; store L[0] into A[2]
    ...elm(83, 0, -1, 0), ...pushInt(99), 0x20, ...i32(13), ...i32(10), ...i32(1),
    ...elm(83, 0, 10), ...cmd(0, [], [], 0),
    ...elm(23, -1, 2), ...elm(83, 0, -1, 0), 0x05, 0x20, ...i32(13), ...i32(10), ...i32(1),

    // 6) Declare call-local intlist (propId 0x7d000000, size 2), resize to 5, write [4]=42, read into A[3]
    ...pushInt(2), 0x07, ...i32(11), ...i32(0),
    ...elm(83, 0x7d000000, 2), ...pushInt(5), ...cmd(0, [10], [], 0),
    ...elm(83, 0x7d000000, -1, 4), ...pushInt(42), 0x20, ...i32(13), ...i32(10), ...i32(1),
    ...elm(23, -1, 3), ...elm(83, 0x7d000000, -1, 4), 0x05, 0x20, ...i32(13), ...i32(10), ...i32(1),
    0x16,
  ];

  const {props} = await runVm(code, ['％Ａ', 'Hero'], async (c, vm) => {
    if (c.path.length === 1 && c.path[0] === 108) return [108, 0];
    if (c.path.length === 2 && c.path[0] === 92 && c.path[1] === 14) {
      vm.assign(c.args[0], 2026);
      return 0;
    }
    return 0;
  });

  assert.equal(props.get('108.0'), 'Hero');
  assert.equal(props.get('34.-1.0'), 'Hero');
  assert.equal(props.get('23.-1.0'), 4);
  assert.equal(props.get('23.-1.1'), 2026);
  assert.equal(props.get('31.-1.0'), 0);
  assert.equal(props.get('31.-1.1'), 0);
  assert.equal(props.get('31.-1.2'), 7);
  assert.equal(props.get('23.-1.2'), 0);
  assert.equal(props.get('23.-1.3'), 42);
});

test('Phase 1 SELBTN parsing and 0x5b0d60 layout contracts', () => {
  const parsed = parseSelbtnArgs(['Choice A', 1, 2, 'Choice B', 'Disabled', 0, -1], []);
  assert.equal(parsed.templateNo, 0);
  assert.deepEqual(parsed.items, [
    {text: 'Choice A', dispFlag: 1, colorMode: 2, index: 0},
    {text: 'Choice B', dispFlag: 1, colorMode: -1, index: 1},
    {text: 'Disabled', dispFlag: 0, colorMode: -1, index: 2},
  ]);

  const cfg = new Map([
    ['SELBTN.000.BASE_FILE', '"_mw00_sel"'],
    ['SELBTN.000.BASE_POS', '1000, 500'],
    ['SELBTN.000.REP_POS', '0, 100'],
    ['SELBTN.000.ALIGN', '1, 1'],
    ['SELBTN.000.MOJI_SIZE', '36'],
    ['SELBTN.000.MOJI_POS', '0, 50'],
    ['SELBTN.000.MOJI_ALIGN', '1, 1'],
  ]);
  const tpl = readSelbtnTemplate(cfg, 0);
  assert.equal(tpl.baseFile, '_mw00_sel');
  assert.equal(tpl.alignX, 1);
  assert.equal(tpl.alignY, 1);

  const layout = layoutSelbtnItems(parsed.items, tpl, 400, 80);
  // 2 visible items (Disabled has dispFlag=0), repY=100, height=80 -> totalHeight=180, centered around (1000, 500)
  assert.deepEqual(
    layout.map(({item, x, y}) => ({index: item.index, text: item.text, x, y})),
    [
      {index: 0, text: 'Choice A', x: 800, y: 410},
      {index: 1, text: 'Choice B', x: 800, y: 510},
    ],
  );
});

test('Phase 1 mask wipe softness (0x61c210), luminance extraction, and pcmevent half-weight anti-repeat (0x5f9fa0)', () => {
  assert.deepEqual([...wipeSoftnessTable], [0, 0.5, 0.75, 0.875, 0.9375, 0.96875, 0.984375, 0.9921875, 1]);
  assert.equal(wipeSoftness(0), 0);
  assert.equal(wipeSoftness(1), 0.5);
  assert.equal(wipeSoftness(99), 1);

  // BGRA: pixel 0 = black (0,0,0,255), pixel 1 = white (255,255,255,255)
  const bgra = new Uint8Array([0, 0, 0, 255, 255, 255, 255, 255]);
  assert.deepEqual([...g00MaskValues(bgra, 2, 1, false)], [0, 255]);
  assert.deepEqual([...g00MaskValues(bgra, 2, 1, true)], [255, 0]);

  // 0x5f9fa0 anti-repeat: [10, 10, 10] with previousIndex=1 -> weights [20, 10, 20], total 50
  assert.equal(selectPcmEventIndex([10, 10, 10], 1, () => 0.0), 0); // r=0 -> [0..20)
  assert.equal(selectPcmEventIndex([10, 10, 10], 1, () => 0.41), 1); // r=20 -> [20..30)
  assert.equal(selectPcmEventIndex([10, 10, 10], 1, () => 0.61), 2); // r=30 -> [30..50)
});
