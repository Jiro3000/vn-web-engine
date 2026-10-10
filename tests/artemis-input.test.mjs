import test from 'node:test';
import assert from 'node:assert/strict';
import {ArtemisInput} from '../dist/engines/artemis/input.js';
import {ArtemisKeyBindings} from '../dist/engines/artemis/key-bindings.js';
import {ArtemisLua} from '../dist/engines/artemis/lua.js';
import {ArtemisVariables} from '../dist/engines/artemis/variables.js';
import {VirtualKeyState} from '../dist/input/virtual-keys.js';
import {luaText} from '../dist/core/lua51/runtime.js';

const kinds = ['push', 'down', 'downEdge', 'upEdge', 'decide'];
const answers = (input, key) => kinds.filter((kind) => input.query(kind, key));
const sample = (down, extra = {}) => ({down: new Set(down), pointerInside: true, ...extra});

test('Artemis key states follow press, hold, repeat and release across updates', () => {
  const input = new ArtemisInput();
  input.update(1000, sample([13]));
  assert.deepEqual(answers(input, 13), ['push', 'down', 'downEdge', 'decide']);
  input.update(1100, sample([13]));
  assert.deepEqual(answers(input, 13), ['down']);
  // Past the 500 ms repeat delay every held update is a push again.
  input.update(1501, sample([13]));
  assert.deepEqual(answers(input, 13), ['push', 'down']);
  input.update(1520, sample([]));
  assert.deepEqual(answers(input, 13), ['upEdge']);
  input.update(1540, sample([]));
  assert.deepEqual(answers(input, 13), []);
  // A key released and pressed again starts a new press.
  input.update(1560, sample([13]));
  assert.deepEqual(answers(input, 13), ['push', 'down', 'downEdge', 'decide']);
  assert.throws(() => input.query('down', 0x140), /Unsupported Artemis input key/);
});

test('Mouse buttons need the pointer inside; key 1 falls back to the tap key', () => {
  const input = new ArtemisInput();
  input.update(0, sample([1, 2], {pointerInside: false}));
  assert.deepEqual(answers(input, 1), []);
  assert.deepEqual(answers(input, 2), []);
  input.update(10, sample([0x8a], {pointerInside: false}));
  assert.deepEqual(answers(input, 1), ['push', 'down', 'downEdge', 'decide']);
  assert.deepEqual(answers(input, 2), []);
});

test('Wheel notches persist until a push, down or down-edge query sees them', () => {
  const input = new ArtemisInput();
  input.update(0, sample([], {wheel: [137]}));
  // An up-edge query does not consume the notch.
  assert.equal(input.query('upEdge', 137), false);
  assert.equal(input.query('down', 137), true);
  assert.equal(input.query('push', 137), false);
  input.update(10, sample([]));
  assert.equal(input.query('down', 137), false);
  input.update(20, sample([], {wheel: [136]}));
  // Sampled key state never changes a wheel key.
  input.update(30, sample([136]));
  assert.equal(input.query('decide', 136), true);
  assert.equal(input.query('decide', 136), false);
});

test('overrideKey answers with status bits for one update and refuses keys from 0x140', () => {
  const input = new ArtemisInput();
  input.update(0, sample([]));
  assert.equal(input.override(1, 0x3e), true);
  assert.deepEqual(answers(input, 1), kinds);
  // status & 0x3e | 1: bit 2 alone answers down.
  assert.equal(input.override(undefined, 4), true);
  assert.deepEqual(answers(input, 1), ['down']);
  assert.deepEqual(answers(input, 0x13f), ['down']);
  // A cleared override (status -1) falls back to the sampled state; key 1 still answers
  // through the tap key's override.
  assert.equal(input.override(1, -1), true);
  assert.deepEqual(answers(input, 1), ['down']);
  assert.equal(input.override(undefined, -1), true);
  assert.deepEqual(answers(input, 1), []);
  assert.equal(input.override(0x140, 4), false);
  input.override(5, 0x20);
  assert.deepEqual(answers(input, 5), ['decide']);
  input.update(10, sample([]));
  assert.deepEqual(answers(input, 5), []);
});

test('Virtual keys report a press released between two samples once', () => {
  const keys = new VirtualKeyState();
  keys.press(1);
  keys.release(1);
  assert.deepEqual([...keys.sample()], [1]);
  assert.deepEqual([...keys.sample()], []);
  keys.press(13);
  assert.deepEqual([...keys.sample()], [13]);
  assert.deepEqual([...keys.sample()], [13]);
  keys.releaseAll();
  assert.deepEqual([...keys.sample()], []);
});

test('var system=unixtime and system=date read the host clock as 32-bit local time', () => {
  let now = 1_700_000_000_999;
  const variables = new ArtemisVariables({
    stageSize: () => ({width: 1, height: 1}),
    now: () => now,
  });
  const tag = (args) => ({kind: 'tag', name: 'var', sourceLine: -1, args: new Map(args)});
  const fields = (name) =>
    ['year', 'month', 'day', 'hour', 'minute', 'second'].map((field) =>
      luaText(variables.read(`${name}.${field}`)),
    );
  const local = (seconds) => {
    const date = new Date(seconds * 1000);
    return [
      date.getFullYear(),
      date.getMonth() + 1,
      date.getDate(),
      date.getHours(),
      date.getMinutes(),
      date.getSeconds(),
    ].map(String);
  };
  variables.dispatch(
    tag([
      ['name', 't.now'],
      ['system', 'unixtime'],
    ]),
  );
  assert.equal(luaText(variables.read('t.now')), '1700000000');
  variables.dispatch(
    tag([
      ['name', 't.d'],
      ['system', 'date'],
    ]),
  );
  assert.deepEqual(fields('t.d'), local(1_700_000_000));
  // The unixtime argument is read with atoi and reinterpreted as unsigned.
  variables.dispatch(
    tag([
      ['name', 't.e'],
      ['system', 'date'],
      ['unixtime', ' -1x'],
    ]),
  );
  assert.deepEqual(fields('t.e'), local(0xffffffff));
  // _time64 is stored through the 32-bit integer setter.
  now = 0x80000000 * 1000;
  variables.dispatch(
    tag([
      ['name', 't.now'],
      ['system', 'unixtime'],
    ]),
  );
  assert.equal(luaText(variables.read('t.now')), '-2147483648');
  variables.pushLocal();
  variables.dispatch(
    tag([
      ['name', 't.l'],
      ['system', 'date'],
      ['writelocal', '1'],
    ]),
  );
  assert.deepEqual(fields('t.l'), local(0x80000000));
  variables.popLocal();
  assert.equal(variables.lookup('t.l.year'), undefined);
});

test('Lua input, script status, frame and touch bindings check argument types natively', () => {
  const input = new ArtemisInput();
  input.update(0, sample([13]));
  const reports = [],
    statuses = [],
    holds = [];
  let status = 1;
  const lua = new ArtemisLua({
    readFile: () => null,
    fileExists: () => false,
    now: () => 0,
    variable: () => '',
    tag: () => {},
    enqueueTag: () => {},
    reportError: (message) => reports.push(Buffer.from(message)),
    input,
    scriptStatus: () => status,
    setScriptStatus: (mode) => statuses.push(mode),
    frameNumber: () => 0x80000005,
    touch: {count: () => 2, setHold: (enabled) => holds.push(enabled)},
  });
  // `<name>の引数が不正です` in code page 932.
  const argumentError = (name) =>
    Buffer.concat([Buffer.from(name), Buffer.from('82cc88f8909482aa957390b382c582b7', 'hex')]);
  try {
    lua.vm.execute(
      new TextEncoder().encode(`p = engine:isPush(13); d = engine:isDecide(13.9)
        u = engine:isUpEdge(13); bad = engine:isDown('13')
        engine:overrideKey{key=13, status=16}; o = engine:isUpEdge(13)
        engine:overrideKey(13)
        engine:overrideKey{key=0x140, status=4}
        s = engine:getScriptStatus(); engine:setScriptStatus(4.7); engine:setScriptStatus('0')
        f = engine:getFrameNumber(); t = engine:getTouchCount()
        engine:setUseTouchHold(true); engine:setUseTouchHold(1)`),
      'input',
    );
    assert.deepEqual(
      ['p', 'd', 'u', 'bad', 'o', 's', 'f', 't'].map((name) => lua.vm.getGlobal(name)),
      [true, true, false, null, true, 1, 5, 2],
    );
    assert.deepEqual(statuses, [4]);
    assert.deepEqual(holds, [true]);
    assert.deepEqual(reports, [
      argumentError('isDown'),
      argumentError('overrideKey'),
      argumentError('overrideKey'),
      argumentError('setScriptStatus'),
      argumentError('setUseTouchHold'),
    ]);
  } finally {
    lua.close();
  }
});

test('Roles answer through their keys; Alt+Enter does not decide an Enter role', () => {
  const bindings = new ArtemisKeyBindings();
  const keyconfig = (role, keys) =>
    bindings.dispatch({
      kind: 'tag',
      name: 'keyconfig',
      sourceLine: -1,
      args: new Map([
        ['role', String(role)],
        ['keys', keys],
      ]),
    });
  keyconfig(0, '1,13,137');
  keyconfig(1, '2');
  const input = new ArtemisInput();
  const role = (id, kind) => bindings.roleActive(id, kind, (k, key) => input.query(k, key));
  input.update(0, sample([1]));
  assert.deepEqual([role(0, 'decide'), role(0, 'down'), role(1, 'decide')], [true, true, false]);
  input.update(10, sample([1]));
  assert.deepEqual([role(0, 'decide'), role(0, 'down')], [false, true]);
  input.update(20, sample([], {wheel: [137]}));
  assert.equal(role(0, 'decide'), true);
  assert.equal(role(0, 'decide'), false);
  input.update(30, sample([13, 0x12]));
  assert.deepEqual([role(0, 'decide'), role(0, 'down')], [false, true]);
  input.update(40, sample([]));
  input.update(50, sample([13]));
  assert.equal(role(0, 'decide'), true);
});

test('var system=length stores source bytes, or UTF-8 characters for mode 1', () => {
  const variables = new ArtemisVariables({stageSize: () => ({width: 1, height: 1})});
  const length = (name, args, bytes) =>
    variables.dispatch({
      kind: 'tag',
      name: 'var',
      sourceLine: -1,
      args: new Map([
        ['name', name],
        ['system', 'length'],
        ...(bytes ? [['source', new TextDecoder().decode(bytes)]] : []),
        ...args,
      ]),
      // A tag's raw argument bytes accompany its decoded text.
      ...(bytes ? {bytes: new Map([['source', bytes]])} : {}),
    });
  const read = (name) => luaText(variables.read(name));
  length('t.b', [['source', 'Aあ\n']]);
  length('t.z', [
    ['source', 'Aあ\n'],
    ['mode', '0'],
  ]);
  length('t.c', [
    ['source', 'Aあ\n'],
    ['mode', '1'],
  ]);
  assert.deepEqual([read('t.b'), read('t.z'), read('t.c')], ['5', '5', '3']);
  // Mode 1 stops at NUL, counts a stray continuation byte once and skips by the lead byte.
  length('t.r', [['mode', '1']], Uint8Array.of(0x80, 0xe3, 0x81, 0x82, 0x41, 0, 0x41));
  assert.equal(read('t.r'), '3');
  // Any other mode leaves the variable alone.
  length('t.c', [
    ['source', 'x'],
    ['mode', '2'],
  ]);
  assert.equal(read('t.c'), '3');
  assert.throws(
    () => length('t.e', [['mode', '1']], Uint8Array.of(0x41, 0xe3, 0x81)),
    /ends inside a character/,
  );
});
