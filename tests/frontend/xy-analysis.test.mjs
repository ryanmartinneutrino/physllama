import {test} from 'node:test';
import assert from 'node:assert/strict';
import {pairSamples, pearson} from '../../physllama/static/xy-analysis.mjs';
const points = (times, run = 1) => times.map((t, i) => ({t, run, seq: i, value: i + 1}));

test('exact pairs preserve run identity and do not fill missing timestamps or values', () => {
  const x = [...points([0, 1, 2]), ...points([0], 2), {t: 3, run: 1, value: null}];
  const y = [...points([0, 2, 3]), ...points([1], 2)];
  const result = pairSamples(x, y);
  assert.deepEqual(result.pairs.map(p => [p.run, p.tx, p.ty]), [[1, 0, 0], [1, 2, 2]]);
  assert.equal(result.unmatchedX, 2); assert.equal(result.unmatchedY, 2);
  assert.equal(result.maxOffset, 0);
});

test('nearest pairs respect tolerance, earlier ties, no reuse and no crossing runs', () => {
  const result = pairSamples(points([1, 1.1, 2, 3]), [...points([.9, 1.5, 2.05]), ...points([3], 2)], {method: 'nearest', tolerance: .2});
  assert.deepEqual(result.pairs.map(p => [p.tx, p.ty]), [[1, .9], [2, 2.05]]);
  assert.equal(new Set(result.pairs.map(p => p.ySeq)).size, result.pairs.length);
  assert.deepEqual(pairSamples(points([1]), points([.5, 1.5]), {method: 'nearest', tolerance: .5}).pairs.map(p => p.ty), [.5]);
  assert.equal(pairSamples(points([1]), points([1], 2), {method: 'nearest', tolerance: 100}).pairs.length, 0);
});

test('time interval filters both sensors before matching, without extrapolating', () => {
  assert.equal(pairSamples(points([1]), points([.9]), {method: 'nearest', tolerance: .2, range: [1, 2]}).pairs.length, 0);
  assert.equal(pairSamples(points([0, 1, 2]), points([0, 1, 2]), {range: [1, 2]}).pairs.length, 2);
  assert.throws(() => pairSamples([], [], {method: 'nearest', tolerance: -1}), /tolerance/);
  assert.throws(() => pairSamples([], [], {method: 'nearest', tolerance: NaN}), /tolerance/);
});

test('Pearson handles positive, negative, zero and undefined correlations', () => {
  assert.ok(Math.abs(pearson([1, 2, 3, 4].map(x => ({x, y: 3 * x + 4}))).r - 1) < 1e-12);
  assert.ok(Math.abs(pearson([1, 2, 3, 4].map(x => ({x, y: -x}))).r + 1) < 1e-12);
  assert.ok(Math.abs(pearson([-1, 0, 1].map(x => ({x, y: x * x}))).r) < 1e-12);
  assert.equal(pearson([{x: 1, y: 2}, {x: 1, y: 3}]).r, null);
  assert.equal(pearson([{x: 1, y: 2}]).r, null);
  assert.ok(Math.abs(pearson([1, 2, 3].map(v => ({x: v * 1e200, y: v * 1e200}))).r - 1) < 1e-12);
});
