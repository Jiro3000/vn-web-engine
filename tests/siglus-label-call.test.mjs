import assert from 'node:assert/strict';
import {test} from 'node:test';
import {SiglusVm} from '../dist/engines/siglus/vm.js';

const word = (value) => [value & 0xff, (value >>> 8) & 0xff, (value >>> 16) & 0xff, value >>> 24];
const push = (form, value) => [2, ...word(form), ...word(value)];
const int = (value) => push(10, value);
const str = (index) => push(20, index);
const local = (list, index) => [8, ...int(83), ...int(list), ...int(-1), ...int(index), 5];
const args = (...forms) => [...word(forms.length), ...forms.toReversed().flatMap(word)];
const call = (...forms) => [48, ...word(0), ...args(...forms), ...word(0), ...word(10)];
const discard = [3, ...word(10)];

test('Siglus label calls bind mixed arguments to the integer and string lists', async () => {
  const start = [
    8,
    ...int(5),
    ...str(0),
    ...int(0),
    ...str(1),
    ...int(42),
    ...str(2),
    ...int(17),
    ...call(20, 10, 20, 10, 20, 10),
    ...discard,
    22,
  ];
  const body = [19, ...word(0), ...args(), ...discard, 22];
  // The nested label gets a separate call frame with its own L and K lists.
  const nested = [8, ...int(74), ...local(1, 0), ...local(0, 0), ...call(20, 10), ...discard, 22];
  const target = [
    8,
    ...int(74),
    ...local(1, 0),
    ...local(0, 0),
    ...local(1, 1),
    ...local(0, 1),
    ...call(20, 10, 20, 10),
    ...discard,
    ...body,
  ];
  const scenes = new Map([
    [
      'main',
      {
        name: 'main',
        code: Uint8Array.from(start),
        strings: ['target', 'first', 'second'],
        entries: [0],
      },
    ],
    [
      'target',
      {
        name: 'target',
        code: Uint8Array.from([...target, ...nested]),
        strings: [],
        entries: [0],
        labels: [target.length],
      },
    ],
  ]);
  const received = [];
  const pack = {scene: (name) => scenes.get(name), commandNames: []};
  const vm = new SiglusVm(
    pack,
    {
      command({args}) {
        received.push(args);
        return 0;
      },
      property() {},
      message() {},
      trace() {},
    },
    new AbortController().signal,
  );
  await vm.run('main');
  assert.deepEqual(received, [
    ['first', 42, 'second', 17],
    ['', 0],
  ]);
});
