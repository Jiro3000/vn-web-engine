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

test('Artemis native display state applies centered scale/reversal and composes a parent matrix', async () => {
  const {ArtemisDisplayObject, artemisDisplayPoint} =
    await import('../dist/engines/artemis/display-object.js');
  const object = new ArtemisDisplayObject(revision);
  assert.deepEqual(object.properties, {
    left: 0,
    top: 0,
    alpha: 1,
    anchorx: 0,
    anchory: 0,
    xscale: 1,
    yscale: 1,
    rotate: 0,
    reversex: false,
    reversey: false,
    visible: true,
  });
  object.apply({left: 10, top: 20, anchorx: 1, anchory: 2, xscale: 2, yscale: 0.5});
  assert.deepEqual([...object.matrix()], [2, 0, 9, 0, 0.5, 21]);
  assert.deepEqual(artemisDisplayPoint(object.matrix(), 2, 4), [13, 23]);
  object.apply({reversex: true, reversey: true});
  assert.deepEqual([...object.matrix()], [-2, 0, 13, 0, -0.5, 23]);
  const copy = object.copy();
  copy.apply({visible: false, alpha: 0.25});
  assert.equal(object.properties.visible, true);
  assert.equal(object.properties.alpha, 1);
  assert.equal(copy.properties.visible, false);
  assert.equal(copy.properties.alpha, 0.25);
  const child = new ArtemisDisplayObject(revision);
  child.apply({left: 1, top: 2});
  assert.deepEqual([...child.matrix(new Float32Array([2, 3, 4, 5, 6, 7]))], [2, 3, 12, 5, 6, 24]);
});

test('Artemis matrix keeps native float32 cancellation and strictly snaps below FLT_EPSILON', async () => {
  const {ArtemisDisplayObject} = await import('../dist/engines/artemis/display-object.js');
  const object = new ArtemisDisplayObject(revision);
  object.apply({left: 16777216, anchorx: 1});
  assert.equal(object.matrix()[2], 16777215);
  const small = new ArtemisDisplayObject(revision);
  const epsilon = 2 ** -23;
  assert.deepEqual(
    [...small.matrix(new Float32Array([epsilon, epsilon / 2, 0, -epsilon / 2, 1, -0]))],
    [epsilon, 0, 0, 0, 1, 0],
  );
  small.apply({xscale: 0.5});
  assert.equal(small.matrix(new Float32Array([epsilon, 0, 0, 0, 1, 0]))[0], 0);
  assert.throws(() => new ArtemisDisplayObject('unknown'), /executable/);
  assert.throws(() => small.apply({left: Infinity}), /display value/);
  assert.throws(() => small.matrix(new Float32Array(5)), /parent matrix/);
});

test('Artemis nonzero rotation requires native float trig and supplies float32 radians', async () => {
  const {ArtemisDisplayObject, artemisDisplayPoint} =
    await import('../dist/engines/artemis/display-object.js');
  const object = new ArtemisDisplayObject(revision);
  object.apply({rotate: 90, anchorx: 1, anchory: 1});
  assert.throws(() => object.matrix(), /trigonometry owner/);
  let radians;
  const matrix = object.matrix(undefined, (angle) => {
    radians = angle;
    return {sin: 1, cos: 0};
  });
  assert.equal(radians, 1.5707963705062866);
  assert.deepEqual([...matrix], [0, -1, 2, 1, 0, 0]);
  assert.deepEqual(artemisDisplayPoint(matrix, 2, 0), [2, 2]);
  assert.deepEqual(artemisDisplayPoint(matrix, 0, 2), [0, 0]);
  assert.throws(() => object.matrix(undefined, () => ({sin: NaN, cos: 1})), /trigonometry/);
});

const straightBlend = {
  color: {source: 'source-alpha', destination: 'inverse-source-alpha', operation: 'add'},
  alpha: {source: 'one', destination: 'inverse-source-alpha', operation: 'add'},
};
async function rasterFixture(rasterPolicy = {filter: 'nearest', blend: straightBlend}) {
  const {ArtemisImageGraphics} = await import('../dist/engines/artemis/image-graphics.js');
  const {ArtemisLayers} = await import('../dist/engines/artemis/layers.js');
  const {createArtemisImageLoader} = await import('../dist/engines/artemis/image-loader.js');
  const image = await syntheticImage(),
    prepared = [],
    invalidated = [],
    frames = [],
    effects = [];
  let rejectUpload = false;
  const target = {
    width: 4,
    height: 2,
    prepareImage(image) {
      if (rejectUpload) throw new Error('synthetic upload failure');
      prepared.push(image);
    },
    invalidate: (image) => invalidated.push(image),
    draw(list, resolve) {
      frames.push({list, images: list.commands.map((command) => resolve(command.texture))});
    },
  };
  const graphics = new ArtemisImageGraphics(
    revision,
    target,
    {
      creationMode: () => 0,
      clearLayerCommands: (ids) => effects.push(['clear', ...ids]),
      resetLayerCommands: (id) => effects.push(['reset', id]),
      recordLayerProperties: (tag) => effects.push(['record', tag.args.get('id')]),
      imageLoadFailed: (tag) => effects.push(['missing image', tag.args.get('file')]),
      layerNotFound: (tag) => effects.push(['missing layer', tag.args.get('id')]),
    },
    rasterPolicy,
  );
  const layers = new ArtemisLayers(
    revision,
    createArtemisImageLoader(revision, async (path) => (path === 'synthetic.png' ? image : null)),
    graphics,
  );
  return {
    graphics,
    layers,
    prepared,
    invalidated,
    frames,
    effects,
    setRejectUpload: (value) => {
      rejectUpload = value;
    },
  };
}

test('Artemis raster owner prepares real decoded images, shares actor copies and emits committed normalized quads', async () => {
  const {graphics, layers, prepared, invalidated, frames} = await rasterFixture();
  try {
    await layers.dispatch(command('lyc', {id: '2', file: 'synthetic'}));
    const old = layers.scene.entry('2').value;
    assert.equal(prepared.length, 1);
    assert.equal(graphics.drawCommitted(layers.scene).commands.length, 0);
    layers.commit();
    const initial = graphics.drawCommitted(layers.scene).commands[0];
    assert.equal(initial.topology, 'triangle-strip');
    assert.equal(initial.normalizedUV, true);
    assert.deepEqual(
      [...initial.vertices].filter((_, i) => i % 9 < 2),
      [-1, 1, 0, 1, -1, 0, 0, 0],
    );
    assert.deepEqual(
      [...initial.vertices].filter((_, i) => i % 9 >= 7),
      [0, 0, 1, 0, 0, 1, 1, 1],
    );
    assert.deepEqual([...frames.at(-1).images[0].pixels], [255, 0, 0, 0, 0, 255, 0, 128]);
    await layers.dispatch(
      command('lyprop', {id: '02', left: '1', top: '1', alpha: '128.3', reversex: '1'}),
    );
    const edited = layers.scene.entry('2').value;
    assert.equal(edited.texture, old.texture);
    assert.equal(prepared.length, 1);
    assert.equal(edited.wrapper, old.wrapper);
    assert.equal(old.wrapper.alpha, 0.5031372308731079);
    assert.equal(old.display.properties.alpha, 1);
    assert.equal(graphics.drawCommitted(layers.scene).commands[0].vertices[6], 1);
    layers.commit();
    const visible = graphics.drawCommitted(layers.scene).commands[0];
    assert.deepEqual(
      [...visible.vertices].filter((_, i) => i % 9 < 2),
      [0.5, 0, -0.5, 0, 0.5, -1, -0.5, -1],
    );
    assert.equal(visible.vertices[6], 0.5031372904777527);
    assert.equal(invalidated.length, 0);
    await layers.dispatch(command('lydel', {id: '2'}));
    assert.equal(graphics.drawCommitted(layers.scene).commands.length, 1);
    layers.commit();
    assert.equal(invalidated.length, 1);
    assert.equal(invalidated[0], prepared[0]);
    assert.equal(graphics.drawCommitted(layers.scene).commands.length, 0);
    assert.throws(() => graphics.image(old.texture), /released/);
    assert.throws(() => graphics.copyImageLayer(old), /not owned|released/);
  } finally {
    layers.close();
  }
});

test('Artemis raster upload refusal preserves the old scene and hidden images retain resource ownership', async () => {
  const {graphics, layers, prepared, invalidated, setRejectUpload} = await rasterFixture();
  try {
    await layers.dispatch(command('lyc', {id: 'image', file: 'synthetic'}));
    layers.commit();
    const original = layers.scene.entry('image').value;
    setRejectUpload(true);
    await assert.rejects(
      () => layers.dispatch(command('lyc', {id: 'image', file: 'synthetic'})),
      /upload failure/,
    );
    assert.equal(layers.scene.entry('image').value, original);
    assert.equal(invalidated.length, 0);
    setRejectUpload(false);
    await layers.dispatch(command('lyprop', {id: 'image', visible: '0', rotate: '90'}));
    layers.commit();
    assert.equal(graphics.drawCommitted(layers.scene).commands.length, 0);
    assert.equal(prepared.length, 1);
    assert.equal(invalidated.length, 0);
    await layers.dispatch(command('lyprop', {id: 'image', visible: '1'}));
    layers.commit();
    assert.throws(() => graphics.drawCommitted(layers.scene), /trigonometry owner/);
    await layers.dispatch(command('lyprop', {id: 'image', rotate: '0', alpha: '0'}));
    layers.commit();
    assert.equal(graphics.drawCommitted(layers.scene).commands.length, 0);
    assert.equal(invalidated.length, 0);
  } finally {
    layers.close();
  }
  assert.equal(invalidated.length, 1);
});

test('Artemis rendering descends child keys within each group while selection remains ascending', () => {
  const scene = new ArtemisScene(revision);
  scene.set('2.2', '2.2');
  scene.set('2.10', '2.10');
  scene.set('10', '10');
  scene.set('-3', '-3');
  scene.commit();
  assert.deepEqual(
    scene.drawEntries().map((entry) => entry.id),
    ['10', '2', '2.10', '2.2', '-3'],
  );
  assert.deepEqual(
    scene.select('2').map((entry) => entry.id),
    ['2', '2.2', '2.10'],
  );
});

test('Artemis raster layering paints the lower numeric id after the higher background id', async () => {
  const {graphics, layers, prepared} = await rasterFixture();
  try {
    await layers.dispatch(
      command('lyc', {id: '-1', file: 'missing', width: '4', height: '2', color: 'ff0000'}),
    );
    await layers.dispatch(
      command('lyc', {id: '0', file: 'missing', width: '4', height: '2', color: '00ff00'}),
    );
    layers.commit();
    const list = graphics.drawCommitted(layers.scene);
    assert.equal(graphics.image(list.commands[0].texture), prepared[1]);
    assert.equal(graphics.image(list.commands[1].texture), prepared[0]);
  } finally {
    layers.close();
  }
});

test('Artemis flip commits real retained image resources, marks presentation dirty and promotes nonzero refresh state', async () => {
  const {ArtemisStage} = await import('../dist/engines/artemis/stage.js');
  const {graphics, layers, prepared, invalidated} = await rasterFixture();
  const effects = [];
  let transition = 0,
    dirty = false,
    refresh = 1,
    capture = 0;
  const stage = new ArtemisStage(revision, {
    captureMode: () => capture,
    transitionState: () => transition,
    clearTransitionRule: () => {
      throw new Error('unexpected transition cleanup');
    },
    resetTransitionLayerValue: () => {
      throw new Error('unexpected transition cleanup');
    },
    setTransitionState: (value) => {
      transition = value;
      effects.push(['transition', value]);
    },
    markSceneDirty: () => {
      dirty = true;
      effects.push(['dirty']);
    },
    commitLayers: () => {
      effects.push(['commit', dirty]);
      layers.commit();
    },
    refreshState: () => refresh,
    setRefreshState: (value) => {
      refresh = value;
      effects.push(['refresh', value]);
    },
  });
  try {
    await layers.dispatch(command('lyc', {id: '2', file: 'synthetic'}));
    assert.equal(graphics.drawCommitted(layers.scene).commands.length, 0);
    assert.equal(stage.dispatch(command('flip', {ignored: 'native ignores tag arguments'})), true);
    assert.equal(graphics.drawCommitted(layers.scene).commands.length, 1);
    assert.deepEqual(effects, [['transition', 0], ['dirty'], ['commit', true], ['refresh', 2]]);
    await layers.dispatch(command('lyc', {id: '2', file: 'synthetic'}));
    assert.equal(invalidated.length, 0);
    stage.dispatch(command('flip'));
    assert.equal(invalidated[0], prepared[0]);
    capture = 1;
    const before = effects.length;
    await layers.dispatch(command('lydel', {id: '2'}));
    stage.dispatch(command('flip'));
    assert.equal(effects.length, before);
    assert.equal(graphics.drawCommitted(layers.scene).commands.length, 1);
    capture = 0;
    refresh = 0;
    stage.dispatch(command('flip'));
    assert.equal(graphics.drawCommitted(layers.scene).commands.length, 0);
    assert.equal(refresh, 0);
  } finally {
    layers.close();
  }
});

test('Artemis flip clears transition rule/value before commit and reads refresh state after owner effects', async () => {
  const {ArtemisStage} = await import('../dist/engines/artemis/stage.js');
  const effects = [];
  let transition = 2,
    rule = 'mask',
    value = 0,
    refresh = 1;
  const stage = new ArtemisStage(revision, {
    captureMode: () => 0,
    transitionState: () => transition,
    clearTransitionRule: () => {
      rule = null;
      effects.push(['rule', rule]);
    },
    resetTransitionLayerValue: (next) => {
      value = next;
      effects.push(['value', value]);
    },
    setTransitionState: (next) => {
      transition = next;
      effects.push(['transition', next]);
    },
    markSceneDirty: () => effects.push(['dirty']),
    commitLayers: () => {
      effects.push(['commit', rule, value]);
      refresh = 0;
    },
    refreshState: () => refresh,
    setRefreshState: (next) => {
      refresh = next;
      effects.push(['refresh', next]);
    },
  });
  assert.equal(stage.dispatch(command('not flip')), false);
  assert.equal(stage.dispatch(command('flip')), true);
  assert.deepEqual(effects, [
    ['rule', null],
    ['value', 0xffffffff],
    ['transition', 0],
    ['dirty'],
    ['commit', null, 0xffffffff],
  ]);
  assert.equal(refresh, 0);
});

test('Artemis layer command history coalesces the newest matching name across intervening commands', async () => {
  const {ArtemisLayerCommands} = await import('../dist/engines/artemis/layer-commands.js');
  const store = new ArtemisLayerCommands(revision);
  const first = command('lyprop', {id: '2', left: '10', alpha: '128'});
  store.record(first);
  first.args.set('left', 'external mutation');
  store.record(command('lyevent', {id: '2', event: 'click', label: 'clicked'}));
  store.record({...command('lyprop', {id: '2', top: '20'}), sourceLine: 99});
  const history = store.commands('2');
  assert.equal(history.length, 2);
  assert.deepEqual(Object.fromEntries(history[0].args), {
    id: '2',
    left: '10',
    alpha: '128',
    top: '20',
  });
  assert.equal(history[0].sourceLine, 7);
  assert.equal(history[1].name, 'lyevent');
  history[0].args.set('left', 'returned snapshot mutation');
  assert.equal(store.commands('2')[0].args.get('left'), '10');
  store.record(command('lyprop', {top: 'missing id'}));
  assert.equal(store.snapshot().size, 1);
});

test('Artemis keyed layer command coalescing requires every selected argument and preserves separate raw ids', async () => {
  const {ArtemisLayerCommands} = await import('../dist/engines/artemis/layer-commands.js');
  const store = new ArtemisLayerCommands(revision),
    keys = new Set(['event', 'key']);
  store.record(command('lyevent', {id: '2', event: 'click', key: '1', label: 'first'}), keys);
  store.record(command('lyevent', {id: '2', event: 'click', key: '2', label: 'other'}), keys);
  store.record(command('lyevent', {id: '2', event: 'click', key: '1', label: 'updated'}), keys);
  assert.deepEqual(
    store.commands('2').map((tag) => tag.args.get('label')),
    ['updated', 'other'],
  );
  store.record(
    command('lyevent', {id: '2', event: 'click', label: 'missing comparison key'}),
    keys,
  );
  assert.equal(store.commands('2').length, 3);
  store.record(command('lyprop', {id: '02', left: 'separate bucket'}));
  store.clear(['02']);
  assert.equal(store.commands('02'), undefined);
  assert.equal(store.commands('2').length, 3);
  store.reset('2');
  assert.deepEqual(store.commands('2'), []);
  store.reset('\u{10000}');
  store.reset('\ue000');
  assert.deepEqual([...store.snapshot().keys()], ['2', '\ue000', '\u{10000}']);
});

async function surfaceFixture(budget = 16n, overrides = {}) {
  const {ArtemisSurfaceCache} = await import('../dist/engines/artemis/surface-cache.js');
  const {createSolidImage} = await import('../dist/graphics/solid-image.js');
  const loaded = [],
    prepared = [],
    disposed = [];
  const source = overrides.source ?? {
    async load(name) {
      loaded.push(name);
      if (name === 'missing') return null;
      return {path: `${name}.png`, image: createSolidImage(1, 1, [10, 20, 30, 255])};
    },
  };
  const cache = new ArtemisSurfaceCache(revision, budget, source, {
    storageBytes: () => 8, // Explicit native-size fixture, independent of four RGBA bytes.
    prepare: (resource) => prepared.push(resource),
    dispose: (resource) => disposed.push(resource),
    ...overrides.owner,
  });
  return {cache, loaded, prepared, disposed};
}

test('Artemis surface loans share active and idle resources using exact requested names', async () => {
  const {cache, loaded, prepared, disposed} = await surfaceFixture();
  const a = await cache.load('日本/😀'),
    b = await cache.load('日本/😀');
  assert.equal(a.image, b.image);
  assert.notEqual(a.lease, b.lease);
  assert.equal(cache.bytesUsed, 8n);
  a.lease.release();
  a.lease.release();
  assert.equal(disposed.length, 0);
  const c = await cache.load('日本/😀');
  assert.equal(c.image, b.image);
  b.lease.release();
  c.lease.release();
  const revived = await cache.load('日本/😀');
  assert.equal(revived.image, a.image);
  assert.deepEqual(loaded, ['日本/😀']);
  assert.equal(prepared.length, 1);
  const explicit = await cache.load('日本/😀.png');
  assert.notEqual(explicit.image, a.image); // Requested key, not decoder candidate path.
  revived.lease.release();
  explicit.lease.release();
  cache.close();
  cache.close();
  assert.equal(disposed.length, 2);
  assert.equal(cache.bytesUsed, 0n);
  await assert.rejects(cache.load('later'), /closed/);
});

test('Artemis surface budget trims oldest idle entries before a miss, without reserving its size', async () => {
  const {cache, loaded, disposed} = await surfaceFixture();
  const a = await cache.load('a'),
    b = await cache.load('b');
  a.lease.release();
  b.lease.release();
  const promoted = await cache.load('a');
  promoted.lease.release(); // FIFO now b, a.
  const c = await cache.load('c');
  assert.equal(cache.bytesUsed, 24n); // Native allows the new active resource to exceed budget.
  assert.equal(disposed.length, 0);
  const activeHit = await cache.load('c');
  assert.equal(cache.bytesUsed, 24n); // Neither a hit nor promotion trims.
  activeHit.lease.release();
  const missing = await cache.load('missing');
  assert.equal(missing, null);
  assert.deepEqual(
    disposed.map((x) => x.path),
    ['b.png'],
  );
  assert.equal(cache.bytesUsed, 16n);
  const idleHit = await cache.load('a');
  assert.deepEqual(loaded, ['a', 'b', 'c', 'missing']);
  c.lease.release();
  idleHit.lease.release();
  cache.close();
  assert.equal(cache.bytesUsed, 0n);
});

test('Artemis releases the newly unloaned surface while over budget and preserves active borrowers on close', async () => {
  const {cache, disposed} = await surfaceFixture(8n);
  const a = await cache.load('a'),
    b = await cache.load('b');
  cache.trim(); // Both active; neither can be evicted.
  assert.equal(cache.bytesUsed, 16n);
  b.lease.release();
  assert.deepEqual(
    disposed.map((x) => x.path),
    ['b.png'],
  );
  cache.close();
  assert.equal(cache.bytesUsed, 8n);
  assert.equal(a.image.pixels[0], 10);
  a.lease.release();
  a.lease.release();
  assert.equal(cache.bytesUsed, 0n);
  assert.deepEqual(
    disposed.map((x) => x.path),
    ['b.png', 'a.png'],
  );
});

test('Artemis surface load failures, shutdown during decoding and unsupported names leave no loans', async () => {
  const {ArtemisSurfaceCache} = await import('../dist/engines/artemis/surface-cache.js');
  assert.throws(
    () => new ArtemisSurfaceCache('unknown', 0n, {}, {}),
    /Unsupported Artemis executable/,
  );
  assert.throws(() => new ArtemisSurfaceCache(revision, -1n, {}, {}), /budget/);
  const failed = await surfaceFixture(0n, {
    owner: {
      prepare() {
        throw Error('GPU failure');
      },
    },
  });
  await assert.rejects(failed.cache.load('a'), /GPU failure/);
  assert.equal(failed.disposed.length, 1);
  assert.equal(failed.cache.bytesUsed, 0n);
  await assert.rejects(failed.cache.load('a'), /GPU failure/); // Failed resources are not cached.
  assert.equal(failed.loaded.length, 2);
  for (const name of ['nul\0', '\ud800', '\udc00'])
    await assert.rejects(failed.cache.load(name), /surface name/);
  assert.equal(failed.loaded.length, 2);
  let finish;
  const pending = await surfaceFixture(8n, {
    source: {
      load: () =>
        new Promise((resolve) => {
          finish = resolve;
        }),
    },
  });
  const loading = pending.cache.load('pending');
  await assert.rejects(pending.cache.load('another'), /overlapping/);
  pending.cache.close();
  finish({path: 'pending', image: {width: 1, height: 1, pixels: new Uint8Array(4)}});
  await assert.rejects(loading, /closed during load/);
  assert.equal(pending.prepared.length, 0);
  assert.equal(pending.disposed.length, 1);
  assert.equal(pending.cache.bytesUsed, 0n);
});

async function cachedLayerFixture(budget = 0n, source) {
  const {ArtemisImageGraphics} = await import('../dist/engines/artemis/image-graphics.js');
  const {ArtemisLayers} = await import('../dist/engines/artemis/layers.js');
  const f = await surfaceFixture(budget, source ? {source} : {});
  const target = {width: 4, height: 2, prepareImage() {}, invalidate() {}, draw() {}};
  const graphics = new ArtemisImageGraphics(
    revision,
    target,
    {
      creationMode: () => 0,
      clearLayerCommands() {},
      resetLayerCommands() {},
      recordLayerProperties() {},
      imageLoadFailed() {},
      layerNotFound() {},
    },
    {filter: 'nearest', blend: straightBlend},
  );
  return {...f, graphics, layers: new ArtemisLayers(revision, f.cache, graphics)};
}

test('Artemis cache loans belong to outer wrappers across current/retained actor copies and multiple layers', async () => {
  const {cache, layers, loaded, disposed} = await cachedLayerFixture();
  await layers.dispatch(command('lyc', {id: '1', file: 'a'}));
  layers.commit();
  await layers.dispatch(command('lyprop', {id: '1', left: '2'}));
  await layers.dispatch(command('lyc', {id: '2', file: 'a'}));
  assert.equal(loaded.length, 1);
  assert.equal(cache.bytesUsed, 8n);
  await layers.dispatch(command('lydel', {id: '1'}));
  assert.equal(disposed.length, 0);
  layers.commit(); // Releases both versions of wrapper 1; wrapper 2 keeps its own loan.
  assert.equal(disposed.length, 0);
  await layers.dispatch(command('lydel', {id: '2'}));
  assert.equal(disposed.length, 0);
  layers.commit();
  assert.equal(disposed.length, 1);
  assert.equal(cache.bytesUsed, 0n);
  layers.close();
  cache.close();
});

test('Artemis cancelled and rejected layer creation releases the cache loan exactly once', async () => {
  let finish;
  const f = await cachedLayerFixture(0n, {
    load: () =>
      new Promise((resolve) => {
        finish = resolve;
      }),
  });
  const pending = f.layers.dispatch(command('lyc', {id: '1', file: 'pending'}));
  f.layers.cancelPending();
  finish({path: 'pending', image: {width: 1, height: 1, pixels: new Uint8Array(4)}});
  await assert.rejects(pending, /cancelled/);
  assert.equal(f.disposed.length, 1);
  assert.equal(f.cache.bytesUsed, 0n);
  f.layers.close();
  f.cache.close();

  const rejected = await cachedLayerFixture();
  rejected.graphics.createImageLayer = () => {
    throw Error('actor allocation failed');
  };
  await assert.rejects(
    rejected.layers.dispatch(command('lyc', {id: '1', file: 'a'})),
    /allocation failed/,
  );
  assert.equal(rejected.disposed.length, 1);
  assert.equal(rejected.cache.bytesUsed, 0n);
  rejected.layers.close();
  rejected.cache.close();
});

test('Artemis ordinary GPU policy preserves native alpha writes, transparent fragments and clear color', async () => {
  const {createArtemisOrdinaryGpuRaster} = await import('../dist/engines/artemis/gpu-raster.js');
  assert.throws(() => createArtemisOrdinaryGpuRaster('unknown'), /Unsupported Artemis executable/);
  const policy = createArtemisOrdinaryGpuRaster(revision);
  const {layers, graphics} = await rasterFixture(policy);
  try {
    await layers.dispatch(command('lyc', {id: '1', file: 'synthetic'}));
    layers.commit();
    const list = graphics.drawCommitted(layers.scene),
      draw = list.commands[0];
    assert.deepEqual(list.clearColor, [0, 0, 0, 0]);
    assert.equal(draw.filter, 'linear');
    assert.equal(draw.discardTransparent, false);
    assert.deepEqual(draw.blendState.alpha, {
      source: 'source-alpha',
      destination: 'one',
      operation: 'add',
    });
    assert.deepEqual(draw.blendState.color, {
      source: 'source-alpha',
      destination: 'inverse-source-alpha',
      operation: 'add',
    });
  } finally {
    layers.close();
  }
});

test('Artemis layer mode updates preserve the retained raster state and ignore unknown native spellings', async () => {
  const {createArtemisOrdinaryGpuRaster} = await import('../dist/engines/artemis/gpu-raster.js');
  const {layers, graphics} = await rasterFixture(createArtemisOrdinaryGpuRaster(revision));
  try {
    await layers.dispatch(command('lyc', {id: '1', file: 'synthetic'}));
    layers.commit();
    const old = layers.scene.entry('1').value;
    await layers.dispatch(command('lyprop', {id: '1', layermode: 'multiply'}));
    assert.equal(old.raster.layerMode, 'normal');
    assert.equal(layers.scene.entry('1').value.raster.layerMode, 'multiply');
    assert.equal(graphics.drawCommitted(layers.scene).commands[0].fragment, undefined);
    layers.commit();
    assert.match(graphics.drawCommitted(layers.scene).commands[0].fragment, /1\.0-s\.a/);
    await layers.dispatch(command('lyprop', {id: '1', layermode: 'MULTIPLY'}));
    layers.commit();
    assert.equal(layers.scene.entry('1').value.raster.layerMode, 'multiply');
    await layers.dispatch(command('lyprop', {id: '1', layermode: 'normal'}));
    layers.commit();
    assert.equal(graphics.drawCommitted(layers.scene).commands[0].fragment, undefined);
  } finally {
    layers.close();
  }
});

test('Artemis layer modes refuse custom raster fixtures without their required mode owner', async () => {
  const {layers} = await rasterFixture();
  try {
    await layers.dispatch(command('lyc', {id: '1', file: 'synthetic'}));
    layers.commit();
    await assert.rejects(
      layers.dispatch(command('lyprop', {id: '1', left: '10', layermode: 'add'})),
      /raster policy owner/,
    );
    assert.equal(layers.scene.entry('1').value.display.properties.left, 0);
    assert.equal(layers.scene.entry('1').value.raster.layerMode, 'normal');
  } finally {
    layers.close();
  }
});

test('Artemis color effects keep native flag spelling, hexadecimal prefixes and retained state', async () => {
  const {createArtemisOrdinaryGpuRaster} = await import('../dist/engines/artemis/gpu-raster.js');
  const {layers, graphics} = await rasterFixture(createArtemisOrdinaryGpuRaster(revision));
  try {
    await layers.dispatch(command('lyc', {id: '1', file: 'synthetic'}));
    layers.commit();
    const old = layers.scene.entry('1').value;
    await layers.dispatch(
      command('lyprop', {id: '1', negative: '00', grayscale: '', colormultiply: ' +0x4080c0tail'}),
    );
    assert.deepEqual(old.raster, {
      layerMode: 'normal',
      negative: false,
      grayscale: false,
      colorMultiply: 0xffffff,
    });
    assert.deepEqual(layers.scene.entry('1').value.raster, {
      layerMode: 'normal',
      negative: true,
      grayscale: true,
      colorMultiply: 0x4080c0,
    });
    assert.equal(graphics.drawCommitted(layers.scene).commands[0].fragment, undefined);
    layers.commit();
    const draw = graphics.drawCommitted(layers.scene).commands[0];
    assert.deepEqual(
      [...draw.vertices.slice(3, 6)],
      [Math.fround(64 / 255), Math.fround(128 / 255), Math.fround(192 / 255)],
    );
    assert.ok(draw.fragment.indexOf('vec3(1.0)-s.rgb') < draw.fragment.indexOf('float gray'));
    assert.ok(draw.fragment.indexOf('float gray') < draw.fragment.indexOf('s.rgb*=tint.rgb'));
    await layers.dispatch(
      command('lyprop', {id: '1', negative: '0', grayscale: '0', colormultiply: '100000000'}),
    );
    layers.commit();
    assert.equal(layers.scene.entry('1').value.raster.colorMultiply, 0xffffffff);
    await layers.dispatch(command('lyprop', {id: '1', colormultiply: '-1'}));
    layers.commit();
    assert.equal(layers.scene.entry('1').value.raster.colorMultiply, 0xffffffff);
    await layers.dispatch(command('lyprop', {id: '1', colormultiply: 'ffffff'}));
    layers.commit();
    assert.equal(graphics.drawCommitted(layers.scene).commands[0].fragment, undefined);
  } finally {
    layers.close();
  }
});

test('Artemis non-default image effects require an owner before changing geometry or wrapper state', async () => {
  const {layers} = await rasterFixture();
  try {
    await layers.dispatch(command('lyc', {id: '1', file: 'synthetic'}));
    layers.commit();
    for (const properties of [{negative: '1'}, {grayscale: '1'}, {colormultiply: 'ff0000'}]) {
      await assert.rejects(
        layers.dispatch(command('lyprop', {id: '1', left: '2', alpha: '128', ...properties})),
        /effects require/,
      );
      assert.equal(layers.scene.entry('1').value.display.properties.left, 0);
      assert.equal(layers.scene.entry('1').value.wrapper.alpha, 1);
    }
  } finally {
    layers.close();
  }
});

test('Artemis commit releases edited actors in ascending child order before removed children', () => {
  const released = [],
    scene = new ArtemisScene(revision, (value) => released.push(value));
  for (const id of ['10', '2', '0']) scene.set(id, `old-${id}`);
  scene.commit();
  scene.editValue('10', () => 'new-10');
  scene.editValue('2', () => 'new-2');
  scene.remove('0');
  assert.deepEqual(released, []);
  scene.commit();
  assert.deepEqual(released, ['old-2', 'old-10', 'old-0']);
  scene.clear();
  assert.deepEqual(released.slice(3), ['new-10', 'new-2']);
  assert.equal(scene.payloads().size, 0);
  scene.clear();
  assert.equal(released.length, 5);
});

test('Artemis removed groups destroy physical map slots before both actor slots', () => {
  for (const secondCycle of [false, true]) {
    const released = [],
      scene = new ArtemisScene(revision, (value) => released.push(value));
    scene.set('g', 'group-old', true);
    scene.set('g.a', 'a');
    scene.set('g.b', 'b');
    scene.commit();
    if (secondCycle) {
      scene.set('g.temporary', undefined, true);
      scene.remove('g.temporary');
      scene.commit(); // Flip the physical map slot while retaining the same children.
    }
    scene.remove('g.a');
    scene.set('g.c', 'c');
    scene.editValue('g', () => 'group-new');
    scene.remove('g');
    assert.deepEqual(released, []);
    scene.commit();
    assert.deepEqual(released, [
      ...(secondCycle ? ['c', 'b', 'a'] : ['a', 'c', 'b']),
      'group-new',
      'group-old',
    ]);
    assert.equal(scene.payloads().size, 0);
  }
});

test('Artemis shared payloads survive copied maps, actor slots and aliases until their last reference', () => {
  const released = [],
    scene = new ArtemisScene(revision, (value) => released.push(value));
  const shared = {};
  scene.set('1', shared);
  scene.set('2', shared);
  scene.commit();
  scene.editValue('1', (value) => value);
  scene.editValue('1', () => {
    throw Error('must not copy an already edited slot');
  });
  scene.commit();
  scene.remove('1');
  scene.commit();
  assert.deepEqual(released, []);
  assert.deepEqual([...scene.payloads()], [shared]);
  scene.remove('2');
  assert.deepEqual(released, []);
  scene.clear();
  assert.deepEqual(released, [shared]);
  scene.clear();
  assert.equal(released.length, 1);
});

test('Artemis layer release order determines the native over-budget victim and idle FIFO', async () => {
  const {cache, layers, disposed} = await cachedLayerFixture(16n);
  try {
    for (const id of ['0', '2', '10']) await layers.dispatch(command('lyc', {id, file: id}));
    layers.commit();
    for (const id of ['2', '0', '10']) await layers.dispatch(command('lydel', {id}));
    assert.equal(disposed.length, 0);
    layers.commit();
    assert.deepEqual(
      disposed.map((x) => x.path),
      ['10.png'],
    );
    const added = await cache.load('added'); // Current total fits; no reservation trim.
    await cache.load('missing'); // New total exceeds budget: oldest idle is 2, then 0.
    assert.deepEqual(
      disposed.map((x) => x.path),
      ['10.png', '2.png'],
    );
    added.lease.release();
  } finally {
    layers.close();
    cache.close();
  }
});

test('Artemis clip parsing accepts exactly four comma fields and rounds inclusive endpoints', async () => {
  const {artemisLayerProperties} = await import('../dist/engines/artemis/layer-properties.js');
  const parse = (clip) => artemisLayerProperties(new Map([['clip', clip]])).clip;
  assert.deepEqual(parse(' 1px,,1.5,1\0,extra'), {
    left: 1,
    top: 0,
    width: 1.5,
    height: 1,
    right: 1.5,
    bottom: 0,
  });
  for (const value of ['', '1,2,3', '1,2,3,4,5', 'nan,1']) assert.equal(parse(value), undefined);
  assert.throws(() => parse('nan,0,1,1'), /property number/);
  assert.throws(() => parse('3e38,0,3e38,1'), /clip rectangle/);
});

test('Artemis clip keeps retained source UVs and rebases cropped geometry without changing anchors', async () => {
  const {layers, graphics} = await rasterFixture();
  const positions = (draw) => [...draw.vertices].filter((_, i) => i % 9 < 2);
  const uv = (draw) => [...draw.vertices].filter((_, i) => i % 9 >= 7);
  try {
    await layers.dispatch(command('lyc', {id: '1', file: 'synthetic'}));
    layers.commit();
    const old = layers.scene.entry('1').value;
    await layers.dispatch(command('lyprop', {id: '1', clip: '0,0,1,1'}));
    assert.equal(layers.scene.entry('1').value.clip.width, 0); // Default endpoints match.
    layers.commit();
    const full = graphics.drawCommitted(layers.scene).commands[0];
    await layers.dispatch(command('lyprop', {id: '1', clip: '1,0,1,1'}));
    assert.deepEqual(graphics.drawCommitted(layers.scene).commands[0].vertices, full.vertices);
    assert.equal(old.clip.width, 0);
    layers.commit();
    const cropped = graphics.drawCommitted(layers.scene).commands[0];
    assert.deepEqual(positions(cropped), [-1, 1, -0.5, 1, -1, 0, -0.5, 0]);
    assert.deepEqual(uv(cropped), [0.5, 0, 1, 0, 0.5, 1, 1, 1]);
    assert.equal(layers.scene.entry('1').value.display.properties.anchorx, 1);
    await layers.dispatch(command('lyprop', {id: '1', clip: '-1,0,2,1'}));
    layers.commit();
    assert.deepEqual(
      uv(graphics.drawCommitted(layers.scene).commands[0]),
      [0, 0, 0.5, 0, 0, 1, 0.5, 1],
    );
    for (const clip of ['2,0,1,1', '0,1,1,1', '-2,0,1,1', '0,-2,1,1']) {
      await layers.dispatch(command('lyprop', {id: '1', clip}));
      layers.commit();
      assert.equal(graphics.drawCommitted(layers.scene).commands.length, 0);
    }
    await layers.dispatch(command('lyprop', {id: '1', clip: '2,0,0,1'}));
    layers.commit();
    assert.deepEqual(graphics.drawCommitted(layers.scene).commands[0].vertices, full.vertices);
  } finally {
    layers.close();
  }
});

test('Artemis clip setter preserves dimensions when float32 endpoint comparisons are unchanged', async () => {
  const {layers, graphics} = await rasterFixture();
  try {
    await layers.dispatch(command('lyc', {id: '1', file: 'synthetic'}));
    await layers.dispatch(command('lyprop', {id: '1', clip: '33554432,0,0,1'}));
    layers.commit();
    const old = layers.scene.entry('1').value.clip;
    assert.equal(old.width, 0);
    await layers.dispatch(command('lyprop', {id: '1', clip: '33554432,0,1,1'}));
    layers.commit();
    assert.deepEqual(layers.scene.entry('1').value.clip, old);
    assert.equal(graphics.drawCommitted(layers.scene).commands.length, 1);
  } finally {
    layers.close();
  }
});
