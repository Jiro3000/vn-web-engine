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
