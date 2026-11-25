import assert from 'node:assert/strict';
import {test} from 'node:test';
import {SiglusPlayer} from '../dist/engines/siglus/player.js';
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

test('entering the menu resets startup objects on both pages before the title wipe', async () => {
  const invoke = (path, operands = [], forms = []) => [
    8,
    ...path.flatMap(int),
    ...operands.flat(),
    ...call(...forms),
    ...discard,
  ];
  const create = (slot) => invoke([37, 2, -1, slot, 38], [str(0), int(1)], [20, 10]);
  const wipe = invoke([7], [int(0), int(500)], [10, 10]);
  const scenes = {
    startup: {
      name: 'startup',
      code: Uint8Array.from([...create(32), ...wipe, ...wipe, ...invoke([3]), 22]),
      strings: ['startup-notice'],
      entries: [0],
    },
    title: {
      name: 'title',
      code: Uint8Array.from([...create(0), ...wipe, 22]),
      strings: ['title-art'],
      entries: [0],
    },
  };
  const presented = [];
  const player = Object.create(SiglusPlayer.prototype);
  Object.assign(player, {
    startScene: 'startup',
    game: {
      config: new Map([['MENU_SCENE', '"title", 0']]),
      pack: {scene: (name) => scenes[name], commandNames: []},
    },
    controller: new AbortController(),
    audio: {resume() {}},
    display: {
      prepare() {},
      setMessageFilter() {},
      finishWipe() {},
      closeMessage() {},
      objectGraphic() {},
      show(objects) {
        presented.push(objects.filter(({visible}) => visible).map(({name}) => name));
      },
    },
    objects: [new Map(), new Map()],
    dayStage: false,
    usesWipeCopy: false,
    cgTable: new Map(),
    activeGroups: new Set(),
    cancelGroups: new Set(),
    frameActions: new Map(),
    frameActionCounters: new Map(),
    objectMovies: new Set(),
    options: new Map(),
    openSaveStore() {},
    applyMessageFont() {},
    applyScreenSettings() {},
    loadCgTable() {},
  });

  await player.start();

  assert.deepEqual(presented, [['startup-notice'], ['startup-notice'], ['title-art']]);
  for (const page of player.objects) assert.equal(page.has(32), false);
});
