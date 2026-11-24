import {test} from 'node:test';
import assert from 'node:assert/strict';
import {samplesInRange, statistics, histogram, polynomialFit} from '../../physllama/static/analysis.mjs';
const near = (actual, expected, tolerance = 1e-10) => assert.ok(Math.abs(actual - expected) <= tolerance, `${actual} ≠ ${expected}`);
const samples = values => values.map((value, t) => ({t, value}));

test('range selection includes endpoints, excludes nulls, and handles reversed axes', () => {
  const data = samples([2, null, 4, Infinity, -2]);
  assert.deepEqual(samplesInRange(data, [4, 1]), [data[2], data[4]]);
  const stats = statistics(samplesInRange(data));
  assert.equal(stats.n, 3); assert.equal(stats.min, -2); assert.equal(stats.max, 4);
  near(stats.mean, 4 / 3); near(stats.stddev, Math.sqrt(56) / 3);
  assert.equal(statistics([]).n, 0);
  near(statistics(samples([1e200, -1e200])).stddev, 1e200, 1e185);
});

test('standard deviation measures centered population spread, not raw magnitude', () => {
  near(statistics(samples([99, 101])).stddev, 1);
  near(statistics(samples([1e12 - 1, 1e12 + 1])).stddev, 1);
  near(statistics(samples([5, 5, 5])).stddev, 0);
  near(statistics(samples([5])).stddev, 0);
  assert.ok(Number.isNaN(statistics([]).stddev));
});

test('histograms count every sample, including the upper boundary and constant values', () => {
  for (const values of [[1, 1, 1], [-10, -5, 0, 5, 10], [0], []]) {
    const result = histogram(samples(values));
    assert.equal(result.counts.reduce((a, b) => a + b, 0), values.length);
    assert.ok(result.width > 0);
  }
});

test('linear fit returns analytic absolute covariance, chi squared and correlations', () => {
  const residual = [1, -2, 2, -2, 1];
  const data = samples(residual.map((r, t) => 2 + 3 * t + r));
  const fit = polynomialFit(data, 1, 2);
  near(fit.parameters[0], 2); near(fit.parameters[1], 3);
  near(fit.covariance[0][0], 2.4); near(fit.covariance[0][1], -.8); near(fit.covariance[1][1], .4);
  near(fit.errors[0], Math.sqrt(2.4)); near(fit.correlation[0][1], -.8 / Math.sqrt(.96));
  near(fit.chiSquared, 3.5); assert.equal(fit.dof, 3); near(fit.reducedChiSquared, 3.5 / 3);
  const doubled = polynomialFit(data, 1, 4);
  near(doubled.parameters[0], fit.parameters[0]); near(doubled.errors[0], fit.errors[0] * 2);
  near(doubled.chiSquared, fit.chiSquared / 4);
});

test('quadratic fit returns known inverse design covariance', () => {
  const data = [-2, -1, 0, 1, 2].map(t => ({t, value: 3 - 2 * t + .5 * t * t}));
  const fit = polynomialFit(data, 2, 1);
  [3, -2, .5].forEach((v, i) => near(fit.parameters[i], v));
  near(fit.covariance[0][0], 17 / 35); near(fit.covariance[0][2], -1 / 7);
  near(fit.covariance[1][1], 1 / 10); near(fit.covariance[2][2], 1 / 14);
  near(fit.predict(.25), 3 - .5 + .5 * .25 ** 2); near(fit.chiSquared, 0);
});

test('fit remains stable over narrow intervals far from time zero', () => {
  const data = Array.from({length: 30}, (_, i) => ({t: 1e6 + i * .001, value: 4 + 2 * i * .001 + 3 * (i * .001) ** 2}));
  const fit = polynomialFit(data, 2, .1);
  for (const point of data) near(fit.predict(point.t), point.value, 1e-8);
  assert.ok(fit.errors.every(Number.isFinite));
});

test('per-sample uncertainty callback supports heteroscedastic weights', () => {
  const data = samples([0, 1, 10]);
  const fit = polynomialFit(data, 1, p => p.t === 2 ? 10 : 1);
  near(fit.parameters[0], -8 / 105); near(fit.parameters[1], 129 / 105);
});

test('invalid uncertainties and underdetermined fits fail clearly', () => {
  for (const sigma of [0, -1, NaN, Infinity]) assert.throws(() => polynomialFit(samples([1, 2, 3]), 1, sigma), /uncertainty/);
  assert.throws(() => polynomialFit(samples([1, 2]), 2, 1), /at least 3/);
  assert.throws(() => polynomialFit([{t: 1, value: 2}, {t: 1, value: 3}], 1, 1), /distinct/);
  assert.throws(() => polynomialFit([{t: 0, value: 1}, {t: 1, value: 2}, {t: 1, value: 3}], 2, 1), /reliably/);
  assert.equal(polynomialFit(samples([1, 2]), 1, 1).reducedChiSquared, null);
});

test('custom histograms exclude out-of-range values and include both endpoints', () => {
  const result = histogram(samples([-1, 0, .5, 1, 1.5, 2, 3]), {min: 0, max: 2, bins: 2});
  assert.deepEqual(result.counts, [2, 3]);
  assert.deepEqual(result.centers, [.5, 1.5]);
  assert.equal(result.width, 1);
  assert.deepEqual(histogram(samples([1, 2]), {min: 10, max: 20, bins: 4}).counts, [0, 0, 0, 0]);
  assert.deepEqual(histogram(samples([1, 1, 1]), {min: 0, max: 2, bins: 2}).counts, [0, 3]);
});

test('custom histograms reject invalid ranges and bin counts', () => {
  for (const [min, max] of [[1, 1], [2, 1], [NaN, 1], [0, Infinity]]) {
    assert.throws(() => histogram(samples([1]), {min, max, bins: 2}), /range limits/);
  }
  for (const bins of [0, -1, 1.5, NaN, Infinity, 1001]) {
    assert.throws(() => histogram(samples([1]), {min: 0, max: 2, bins}), /whole number/);
  }
  assert.throws(() => histogram(samples([1]), {min: -1e308, max: 1e308, bins: 1}), /Widen the range/);
});
