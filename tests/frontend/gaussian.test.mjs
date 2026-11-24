import {test} from 'node:test';
import assert from 'node:assert/strict';
import {histogram, statistics} from '../../physllama/static/analysis.mjs';
import {fitGaussian, chiSquareSurvival, poissonCountChiSquared} from '../../physllama/static/gaussian.mjs';
function generator(seed = 1234) {
  const uniform = () => { seed = (1664525 * seed + 1013904223) >>> 0; return (seed + .5) / 4294967296; };
  return {uniform, normal: () => Math.sqrt(-2 * Math.log(uniform())) * Math.cos(2 * Math.PI * uniform())};
}
const sample = (n, fn) => Array.from({length: n}, (_, t) => ({t, value: fn()}));

test('Gaussian histogram fit recovers parameters and exposes requested initial guesses', () => {
  const random = generator(), samples = sample(2000, () => 5 + 2 * random.normal());
  const result = fitGaussian(samples, histogram(samples, {bins: 30}));
  assert.ok(Math.abs(result.mu - 5) < .15);
  assert.ok(Math.abs(result.sigma - 2) < .15);
  assert.equal(result.normalization, 2000);
  assert.equal(result.initial.mu, statistics(samples).mean);
  assert.equal(result.initial.sigma, statistics(samples).stddev);
  assert.equal(result.initial.normalization, 2000);
  assert.ok(result.muError > 0 && result.sigmaError > 0);
  assert.ok(Math.abs(result.sigmaError - 2 / Math.sqrt(4000)) < .01);
  assert.ok(Math.abs(result.correlation[0][1]) < .1);
  assert.deepEqual(result.correlation[2], [0, 0, 1]);
  assert.ok(Math.abs(result.muError - 2 / Math.sqrt(2000)) < .01);
  assert.ok(Math.abs(result.expected.reduce((a, b) => a + b, 0) - 2000) < 1e-8);
  assert.equal(result.status, 'compatible');
  const counts = histogram(samples, {bins: 30}).counts;
  const expectedChiSquared = counts.reduce((sum, count, i) => count ? sum + (count - result.expected[i]) ** 2 / count : sum, 0);
  assert.ok(Math.abs(result.countChiSquared.value - expectedChiSquared) < 1e-10);
  assert.equal(result.countChiSquared.dof, counts.filter(n => n > 0).length - 3);
  const expectedDeviance = counts.reduce((sum, count, i) => sum + 2 * (result.expected[i] - count + (count ? count * Math.log(count / result.expected[i]) : 0)), 0);
  assert.ok(Math.abs(result.deviance - expectedDeviance) < 1e-8);
});

test('count chi-square uses sqrt(count) errors and excludes zero-error bins like ROOT', () => {
  // Contributions: (4−2)²/4 = 1, (9−12)²/9 = 1, (16−8)²/16 = 4.
  assert.deepEqual(poissonCountChiSquared([4, 0, 9, 16], [2, 7, 12, 8]),
    {value: 6, dof: 0, usedBins: 3, excludedBins: 1});
  assert.equal(poissonCountChiSquared([4, 0, 9, 16], [2, 700, 12, 8]).value, 6);
});

test('Gaussian fit handles a large mean offset and a truncated value interval', () => {
  const random = generator(99), samples = sample(5000, () => 1000 + .2 * random.normal());
  const result = fitGaussian(samples, histogram(samples, {min: 999.8, max: 1000.4, bins: 20}));
  assert.ok(Math.abs(result.mu - 1000) < .03);
  assert.ok(Math.abs(result.sigma - .2) < .03);
  assert.ok(result.normalization < samples.length);
});

test('non-Gaussian histograms are rejected or flagged, never reported as compatible', () => {
  for (const shape of ['uniform', 'bimodal', 'skewed']) {
    const random = generator(23);
    const samples = sample(3000, () => shape === 'uniform' ? random.uniform() : shape === 'bimodal' ? (random.uniform() < .5 ? -3 : 3) + .3 * random.normal() : -Math.log(random.uniform()));
    try { assert.notEqual(fitGaussian(samples, histogram(samples, {bins: 30})).status, 'compatible', shape); }
    catch (error) { if (error instanceof assert.AssertionError) throw error; assert.match(error.message, /Gaussian|constrained/); }
  }
});

test('Gaussian fitting fails clearly for sparse, constant and under-binned data', () => {
  assert.throws(() => fitGaussian(sample(5, () => 1), histogram(sample(5, () => 1))), /at least 20/);
  const data = sample(100, () => 2);
  assert.throws(() => fitGaussian(data, histogram(data, {bins: 10})), /spread/);
  const random = generator(), normal = sample(50, random.normal);
  assert.throws(() => fitGaussian(normal, histogram(normal, {bins: 3})), /at least 4 bins/);
});

test('chi-square probabilities agree with analytic and reference critical values', () => {
  for (const x of [.1, 1, 10, 100]) assert.ok(Math.abs(chiSquareSurvival(x, 2) - Math.exp(-x / 2)) < 1e-12);
  assert.ok(Math.abs(chiSquareSurvival(3.841458820694124, 1) - .05) < 1e-12);
  assert.ok(Math.abs(chiSquareSurvival(18.307038053275146, 10) - .05) < 1e-12);
});
