import assert from 'node:assert/strict';
import {test} from 'node:test';
import {timetable} from '../dist/engines/siglus/timing.js';

test('Siglus timetable applies each segment and holds its endpoint in the gaps', () => {
  const notice = [
    [0, 500, 1628, 2],
    [2000, 2500, 1678, 2],
  ];
  assert.deepEqual(
    [-1, 0, 250, 500, 1000, 2000, 2250, 2500, 3000].map((elapsed) =>
      timetable(elapsed, 1678, notice),
    ),
    [1678, 1678, 1641, 1628, 1628, 1628, 1666, 1678, 1678],
  );
});

test('Siglus timetable supports linear and quadratic interpolation with signed rounding', () => {
  assert.equal(timetable(50, -15, [[0, 100, -8]]), -12);
  assert.equal(timetable(75, -1, [[0, 100, 0]]), 0);
  assert.equal(timetable(50, 10, [[0, 100, 30, 1]]), 15);
  assert.equal(timetable(50, 10, [[0, 100, 30, 2]]), 25);
  assert.equal(timetable(100, 10, [[100, 100, 30]]), 30);
});
