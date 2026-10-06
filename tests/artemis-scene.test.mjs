import test from 'node:test';
import assert from 'node:assert/strict';
import {ArtemisScene} from '../dist/engines/artemis/scene.js';
import {ARTEMIS_3179_EXECUTABLE_SHA256 as revision} from '../dist/engines/artemis/revision.js';

test('Artemis child maps retain each nested structure until recursive commit', () => {
  const scene = new ArtemisScene(revision);
  const old = {image: 'old'},
    replacement = {image: 'replacement'};
  assert.equal(scene.set('bg.2', old), true);
  assert.equal(scene.entry('bg', 'retained'), undefined);
  scene.commit();
  scene.set('bg.2', replacement);
  scene.set('bg.10', 'new');
  assert.equal(scene.entry('bg.2').value, replacement);
  assert.equal(scene.entry('bg.2', 'retained').value, old);
  assert.equal(scene.entry('bg.10', 'retained'), undefined);
  assert.deepEqual(
    scene.entries().map((x) => x.id),
    ['bg', 'bg.2', 'bg.10'],
  );
  scene.remove('bg.2');
  assert.equal(scene.entry('bg.2'), undefined);
  assert.equal(scene.entry('bg.2', 'retained').value, old);
  scene.commit();
  assert.deepEqual(scene.entries('retained'), scene.entries());
  scene.set('bg', 'whole group replacement');
  assert.equal(scene.entry('bg.10'), undefined);
  assert.equal(scene.entry('bg.10', 'retained').value, 'new');
});

test('Artemis numeric child keys preserve first spelling and use signed integer order', () => {
  const scene = new ArtemisScene(revision);
  for (const id of ['10', '2', '-3', '00', '+group', 'name']) scene.set(id, id);
  scene.set('-', 'zero replacement');
  scene.set('-0', 'another zero');
  scene.set('02', 'two replacement');
  assert.deepEqual(
    scene.entries().map((x) => x.id),
    ['+group', '-3', '00', '2', '10', 'name'],
  );
  assert.equal(scene.entry('0').id, '00');
  assert.equal(scene.entry('0').value, 'another zero');
  assert.equal(scene.entry('002').id, '2');
  assert.equal(scene.remove('0002'), true);
  assert.equal(scene.entry('2'), undefined);
});

test('Artemis group deletion keeps empty ancestors and refuses traversal through leaves', () => {
  const scene = new ArtemisScene(revision);
  scene.set('bg', 'group image', true);
  scene.set('bg.child', 'child');
  assert.equal(scene.entry('bg').value, 'group image');
  scene.remove('bg.child');
  assert.equal(scene.entry('bg').value, 'group image');
  assert.equal(scene.remove('missing.child'), false);
  assert.equal(scene.entry('missing'), undefined);
  scene.set('leaf', 'opaque', false);
  assert.equal(scene.set('leaf.child', 'ignored'), false);
  assert.equal(scene.remove('leaf.child'), false);
  assert.equal(scene.entry('leaf.child'), undefined);
  assert.equal(scene.remove('leaf'), true);
});

test('Artemis UTF-8 child ordering and empty dotted components are explicit', () => {
  const scene = new ArtemisScene(revision);
  scene.set('\u{10000}', 'astral');
  scene.set('\ue000', 'BMP');
  scene.set('.child.', 'empty components');
  assert.deepEqual(
    scene.entries().map((x) => x.id),
    ['', '.child', '.child.', '\ue000', '\u{10000}'],
  );
  assert.equal(scene.entry('.child.').value, 'empty components');
});

test('Artemis scene refuses unproved comparator cases before mutating any parent', () => {
  const scene = new ArtemisScene(revision);
  assert.throws(() => new ArtemisScene('unknown'), /Unsupported Artemis executable/);
  for (const id of [
    'parent.1a',
    'parent.2147483648',
    'parent.-2147483649',
    'parent.\ud800',
    'parent.\0',
  ])
    assert.throws(() => scene.set(id, 'bad'), /Unsupported|Invalid/);
  assert.throws(() => scene.set(Array(257).fill('x').join('.'), 'bad'), /depth limit/);
  assert.deepEqual(scene.entries(), []);
  scene.set('2147483647', 'max');
  scene.set('-2147483648', 'min');
  assert.deepEqual(
    scene.entries().map((x) => x.value),
    ['min', 'max'],
  );
});

test('Artemis native selection uses the requested prefix and only expands groups', () => {
  const scene = new ArtemisScene(revision);
  scene.set('2', undefined, true);
  scene.set('2.10', 'image');
  scene.set('2.3', undefined, true);
  scene.set('2.3.name', 'nested image');
  assert.deepEqual(
    scene.select('02').map((x) => x.id),
    ['02', '02.3', '02.3.name', '02.10'],
  );
  assert.deepEqual(
    scene.select('2.10').map((x) => x.id),
    ['2.10'],
  );
  assert.deepEqual(scene.select('missing'), []);
  assert.equal(scene.set('2.10.child', 'blocked'), false);
  scene.commit();
  scene.remove('02');
  assert.deepEqual(scene.select('2'), []);
  assert.equal(scene.entry('2.3.name', 'retained').value, 'nested image');
});

function command(name, args = {}) {
  return {kind: 'tag', name, sourceLine: 7, args: new Map(Object.entries(args))};
}

async function layerFixture(readFile, extraHost = {}) {
  const {ArtemisLayers} = await import('../dist/engines/artemis/layers.js');
  const {createArtemisImageLoader} = await import('../dist/engines/artemis/image-loader.js');
  const events = [];
  let next = 0;
  const layers = new ArtemisLayers(revision, createArtemisImageLoader(revision, readFile), {
    creationMode: () => 0,
    createImageLayer(resource, anchor) {
      const actor = {number: ++next, resource, anchor};
      events.push(['create', actor.number, anchor]);
      return actor;
    },
    copyImageLayer(actor) {
      const copy = {...actor, number: ++next, properties: {...actor.properties}};
      events.push(['copy', actor.number, copy.number]);
      return copy;
    },
    applyImageProperties(id, actor, properties) {
      actor.properties = {...actor.properties, ...properties};
      events.push(['properties', id]);
    },
    recordLayerProperties: (tag) => events.push(['record', tag.args.get('id')]),
    layerNotFound: (tag) => events.push(['missing', tag.args.get('id')]),
    releaseImageLayer: (actor) => events.push(['release', actor.number]),
    clearLayerCommands: (ids) => events.push(['clear', [...ids]]),
    resetLayerCommands: (id) => events.push(['reset', id]),
    imageLoadFailed: (tag) => events.push(['error', tag.args.get('file')]),
    ...extraHost,
  });
  return {layers, events};
}

async function syntheticImage() {
  const {png} = await import('./png-fixtures.mjs');
  return png({width: 2, height: 1, raw: Buffer.from([0, 255, 0, 0, 0, 0, 255, 0, 128])});
}

test('Artemis image commands retain replaced actors, clear subtree registrations and release on commit', async () => {
  const image = await syntheticImage();
  const {layers, events} = await layerFixture(async (path) =>
    path === 'synthetic.png' ? image : null,
  );
  try {
    assert.equal(await layers.dispatch(command('unrelated')), false);
    await layers.dispatch(
      command('lyc', {id: 'bg.2', file: 'synthetic', alpha: '0', anchorx: '99'}),
    );
    const old = layers.scene.entry('bg.2').value;
    assert.deepEqual(old.anchor, {x: 1, y: 0.5});
    assert.deepEqual([...old.resource.image.pixels], [255, 0, 0, 0, 0, 255, 0, 128]);
    layers.commit();
    await layers.dispatch(command('lyc', {id: 'bg.02', file: 'synthetic'}));
    assert.equal(layers.scene.entry('bg.2', 'retained').value, old);
    assert.deepEqual(
      events.map((x) => x.slice(0, 2)),
      [
        ['create', 1],
        ['reset', 'bg.2'],
        ['create', 2],
        ['clear', ['bg.02']],
        ['reset', 'bg.02'],
      ],
    );
    await layers.dispatch(command('lyc', {id: 'bg.2', file: 'missing'}));
    assert.equal(layers.scene.entry('bg.2').value.number, 2);
    assert.deepEqual(events.at(-1), ['error', 'missing']);
    layers.commit();
    assert.deepEqual(events.at(-1), ['release', 1]);
    await layers.dispatch(command('lydel', {id: 'bg'}));
    assert.equal(layers.scene.entry('bg'), undefined);
    assert.deepEqual(events.at(-1), ['clear', ['bg', 'bg.02']]);
    layers.commit();
    assert.deepEqual(events.at(-1), ['release', 2]);
    await layers.dispatch(command('lyc', {id: 'leaf', file: 'synthetic'}));
    await layers.dispatch(command('lyc', {id: 'leaf.blocked', file: 'synthetic'}));
    assert.equal(layers.scene.entry('leaf.blocked'), undefined);
    assert.deepEqual(events.at(-1), ['release', 4]);
  } finally {
    layers.close();
  }
  assert.deepEqual(events.at(-1), ['release', 3]);
  layers.close();
  await assert.rejects(() => layers.dispatch(command('lydel')), /closed/);
});

test('Artemis image command cancellation rejects stale completions and copies pending tag arguments', async () => {
  const image = await syntheticImage();
  const readers = [];
  const {layers, events} = await layerFixture((path) => {
    if (path === 'old' || path === 'new')
      return new Promise((resolve) => readers.push({path, resolve}));
    return Promise.resolve(null);
  });
  const first = command('lyc', {id: 'old', file: 'old'});
  const pending = layers.dispatch(first);
  first.args.set('id', 'mutated');
  await assert.rejects(() => layers.dispatch(command('lydel', {id: 'old'})), /already pending/);
  layers.cancelPending();
  const current = layers.dispatch(command('lyc', {id: 'new', file: 'new'}));
  readers[0].resolve(image);
  await assert.rejects(() => pending, /cancelled/);
  assert.deepEqual(events, []);
  readers[1].resolve(image);
  await current;
  assert.equal(layers.scene.entry('new').value.number, 1);
  assert.equal(layers.scene.entry('old'), undefined);
  assert.equal(layers.scene.entry('mutated'), undefined);
  await assert.rejects(
    () => layers.dispatch(command('lyc', {id: 'bad', file: 'missing', rule: ''})),
    /rule surface/,
  );
  await assert.rejects(
    () =>
      layers.dispatch(
        command('lyc', {id: 'bad', file: 'missing', width: '-2', height: '1', color: 'ffffff'}),
      ),
    /solid surface dimension/,
  );
  layers.close();
  const capture = await layerFixture(async () => null, {creationMode: () => 1});
  await assert.rejects(() => capture.layers.dispatch(command('lyc')), /capture-mode/);
  assert.deepEqual(capture.events, []);
  capture.layers.close();
});

test('Artemis suspended Lua drives actual image-backed lyc and resumes after scene insertion', async () => {
  const {ArtemisLua} = await import('../dist/engines/artemis/lua.js');
  const {ArtemisScript} = await import('../dist/engines/artemis/script.js');
  const image = await syntheticImage();
  const {layers} = await layerFixture(async (path) => (path === 'synthetic.png' ? image : null));
  const source = new TextEncoder().encode(
    `[lua]function prepare(e) e:tag{'lyc',id='2',file='synthetic'}; finished=true end[/lua][calllua function="prepare"][stop]`,
  );
  let script, pending;
  const lua = new ArtemisLua({
    readFile: () => source,
    fileExists: () => true,
    now: () => 0,
    variable: () => '0',
    suspendableTags: true,
    tag: (tag) => script.executeTag(tag),
    enqueueTag: () => {},
  });
  script = new ArtemisScript(lua, {
    readFile: () => source,
    dispatch: (tag) => {
      if (tag.name === 'lyc') {
        pending = layers.dispatch(tag);
        return 'suspended';
      }
      if (tag.name === 'stop') return 'stopped';
      throw new Error('unsupported tag');
    },
  });
  try {
    script.load('boot');
    assert.equal(script.run(), 'waiting');
    assert.equal(layers.scene.entry('2'), undefined);
    assert.equal(lua.vm.getGlobal('finished'), null);
    assert.equal(await pending, true);
    script.resumeLua();
    assert.equal(script.run(), 'stopped');
    assert.equal(lua.vm.getGlobal('finished'), true);
    assert.equal(layers.scene.entry('2').value.resource.image.width, 2);
  } finally {
    lua.close();
    layers.close();
  }
});

test('Artemis image properties copy the inner actor once per commit and retain newly inserted old state', async () => {
  const image = await syntheticImage();
  const {layers, events} = await layerFixture(async (path) =>
    path === 'synthetic.png' ? image : null,
  );
  try {
    await layers.dispatch(command('lyc', {id: '2', file: 'synthetic'}));
    const first = layers.scene.entry('2').value;
    await layers.dispatch(
      command('lyprop', {
        id: '02',
        left: ' 12.5px',
        top: '-.25',
        alpha: '128.3',
        xscale: '50',
        reversex: '00',
      }),
    );
    const second = layers.scene.entry('2').value;
    assert.notEqual(second, first);
    assert.deepEqual(second.properties, {
      left: 12.5,
      top: -0.25,
      alpha: 0.5031372904777527,
      wrapperAlpha: 0.5031372308731079,
      xscale: 0.5,
      reversex: true,
    });
    assert.equal(first.properties, undefined);
    assert.equal(layers.scene.entry('2', 'retained'), undefined);
    assert.equal(layers.scene.payloads().has(first), true);
    assert.equal(
      events.some((x) => x[0] === 'release'),
      false,
    );
    await layers.dispatch(command('lyprop', {id: '2', yscale: '25', reversex: '0', visible: ''}));
    assert.equal(layers.scene.entry('2').value, second);
    assert.deepEqual(
      events.filter((x) => x[0] === 'copy'),
      [['copy', 1, 2]],
    );
    assert.equal(second.properties.reversex, false);
    assert.equal(second.properties.visible, true);
    layers.commit();
    assert.deepEqual(events.at(-1), ['release', 1]);
    await layers.dispatch(command('lyprop', {id: '2', rotate: '90'}));
    const third = layers.scene.entry('2').value;
    assert.notEqual(third, second);
    assert.equal(layers.scene.entry('2', 'retained').value, second);
    assert.equal(second.properties.rotate, undefined);
    assert.equal(third.properties.rotate, 90);
    const before = events.length;
    await assert.rejects(
      () => layers.dispatch(command('lyprop', {id: '2', shader: 'unsupported'})),
      /property shader/,
    );
    assert.equal(events.length, before);
    await layers.dispatch(command('lyprop', {id: 'missing', left: '0'}));
    assert.deepEqual(events.at(-1), ['missing', 'missing']);
    await assert.rejects(
      () => layers.dispatch(command('lyprop', {id: '!', left: '0'})),
      /group\/shader/,
    );
    await assert.rejects(
      () => layers.dispatch(command('lyprop', {id: '~shader', left: '0'})),
      /group\/shader/,
    );
  } finally {
    layers.close();
  }
  assert.deepEqual(events.slice(-2), [
    ['release', 2],
    ['release', 3],
  ]);
});

test('Artemis layer number conversion preserves decimal prefixes, float32 boundaries and omission', async () => {
  const {artemisLayerProperties} = await import('../dist/engines/artemis/layer-properties.js');
  assert.deepEqual(artemisLayerProperties(new Map([['id', '2']])), {});
  const patch = artemisLayerProperties(
    new Map(
      Object.entries({
        left: '16777217 trailing',
        top: '-0',
        alpha: '510',
        xscale: '1e2%',
        yscale: 'junk',
        rotate: '',
        reversey: '0',
        visible: ' 0',
      }),
    ),
  );
  assert.equal(patch.left, 16777216);
  assert.equal(Object.is(patch.top, -0), true);
  assert.equal(patch.alpha, 2);
  assert.equal(patch.wrapperAlpha, 2);
  assert.equal(patch.xscale, 1);
  assert.equal(patch.yscale, 0);
  assert.equal(patch.rotate, 0);
  assert.equal(patch.reversey, false);
  assert.equal(patch.visible, true);
  for (const value of ['0x1p2', 'nan', 'Infinity', '1e39'])
    assert.throws(() => artemisLayerProperties(new Map([['left', value]])), /property number/);
});

test('Artemis missing-image fallback preserves native RGB/ARGB color forms and decimal dimensions', async () => {
  const {layers, events} = await layerFixture(async () => null);
  try {
    for (const [color, format, expected] of [
      ['123456', 1, [18, 52, 86, 255]],
      ['0x123456', 1, [18, 52, 86, 255]],
      ['0X123456', 1, [18, 52, 86, 255]],
      ['00123456', 2, [18, 52, 86, 0]],
      ['0x80123456', 2, [18, 52, 86, 128]],
      ['f', 2, [0, 0, 15, 0]],
      ['-ff', 2, [255, 255, 1, 255]],
      ['100000000', 2, [255, 255, 255, 255]],
      ['雪雪', 1, [0, 0, 0, 255]],
    ]) {
      await layers.dispatch(
        command('lyc', {id: 'solid', file: 'missing', width: ' 2pixels', height: '1', color}),
      );
      const resource = layers.scene.entry('solid').value.resource;
      assert.equal(resource.surfaceFormat, format);
      assert.deepEqual([...resource.image.pixels], [...expected, ...expected]);
      assert.deepEqual(layers.scene.entry('solid').value.anchor, {x: 1, y: 0.5});
    }
    assert.equal(
      events.some((x) => x[0] === 'error'),
      false,
    );
    await layers.dispatch(
      command('lyc', {id: 'partial', file: 'missing', width: '2', height: '1'}),
    );
    assert.equal(layers.scene.entry('partial'), undefined);
    assert.deepEqual(events.at(-1), ['error', 'missing']);
  } finally {
    layers.close();
  }
});

test('Artemis solid fallback snapshots arguments before its asynchronous file miss', async () => {
  let resolve;
  const {layers} = await layerFixture((path) =>
    path === 'missing'
      ? new Promise((done) => {
          resolve = done;
        })
      : Promise.resolve(null),
  );
  const tag = command('lyc', {
    id: 'solid',
    file: 'missing',
    width: '2',
    height: '1',
    color: '123456',
  });
  const pending = layers.dispatch(tag);
  tag.args.set('width', '9');
  tag.args.set('color', 'ffffff');
  resolve(null);
  try {
    await pending;
    const image = layers.scene.entry('solid').value.resource.image;
    assert.equal(image.width, 2);
    assert.deepEqual([...image.pixels.slice(0, 4)], [18, 52, 86, 255]);
  } finally {
    layers.close();
  }
});

test('Shared solid image allocation preserves straight transparent RGB and rejects native allocation overflow', async () => {
  const {createSolidImage} = await import('../dist/graphics/solid-image.js');
  const image = createSolidImage(3, 2, [12, 34, 56, 0]);
  assert.deepEqual([...image.pixels], Array(6).fill([12, 34, 56, 0]).flat());
  assert.equal(createSolidImage(0, 1, [0, 0, 0, 255]).pixels.length, 0);
  for (const [w, h] of [
    [-1, 1],
    [1.5, 1],
    [0x80000000, 0],
    [0x20000000, 1],
  ])
    assert.throws(() => createSolidImage(w, h, [0, 0, 0, 0]), /dimensions/);
  assert.throws(() => createSolidImage(1, 1, [256, 0, 0, 0]), /RGBA color/);
});
