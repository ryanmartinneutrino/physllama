// All analysis consumes raw samples, never the display-reduced trace.
export function samplesInRange(samples, range) {
  const low = range ? Math.min(...range) : -Infinity;
  const high = range ? Math.max(...range) : Infinity;
  return samples.filter(p => Number.isFinite(p.t) && Number.isFinite(p.value) && p.t >= low && p.t <= high);
}
export function statistics(samples) {
  if (!samples.length) return {n: 0, min: NaN, max: NaN, mean: NaN, stddev: NaN};
  let min = Infinity, max = -Infinity, mean = 0, scale = 0;
  for (const [i, p] of samples.entries()) {
    min = Math.min(min, p.value); max = Math.max(max, p.value);
    mean = mean * (i / (i + 1)) + p.value / (i + 1);
    scale = Math.max(scale, Math.abs(p.value));
  }
  // Population spread (divide by N), centered before squaring. Scaling avoids
  // overflow; subtract first when possible to preserve small spreads at offsets.
  const variance = scale ? samples.reduce((sum, p) => {
    const delta = p.value - mean;
    const centered = Number.isFinite(delta) ? delta / scale : p.value / scale - mean / scale;
    return sum + centered ** 2 / samples.length;
  }, 0) : 0;
  return {n: samples.length, min, max, mean, stddev: scale * Math.sqrt(variance)};
}
export const MAX_HISTOGRAM_BINS = 1000;
export function histogram(samples, options = {}) {
  const {n, min: dataMin, max: dataMax} = statistics(samples);
  const padding = n && dataMin === dataMax ? Math.max(Math.abs(dataMin) * .02, 1) / 2 : 0;
  const min = options.min ?? (n ? dataMin - padding : 0);
  const max = options.max ?? (n ? dataMax + padding : 1);
  const bins = options.bins ?? (dataMin === dataMax || !n ? 1 : Math.min(50, Math.ceil(Math.sqrt(n))));
  if (!Number.isFinite(min) || !Number.isFinite(max) || !(min < max)) {
    throw new Error('Enter finite range limits with minimum less than maximum.');
  }
  if (!Number.isInteger(bins) || bins < 1 || bins > MAX_HISTOGRAM_BINS) {
    throw new Error(`Enter a whole number of bins from 1 to ${MAX_HISTOGRAM_BINS}.`);
  }
  const width = (max - min) / bins;
  if (!Number.isFinite(width) || width <= 0 || min + width === min || max - width === max) {
    throw new Error('This range cannot be divided into that many bins. Widen the range or use fewer bins.');
  }
  const counts = Array(bins).fill(0);
  for (const p of samples) {
    // Include both range endpoints; internal boundaries belong to the bin on the right.
    if (!Number.isFinite(p.value) || p.value < min || p.value > max) continue;
    counts[Math.min(bins - 1, Math.floor((p.value - min) / width))]++;
  }
  return {centers: counts.map((_, i) => min + (i + .5) * width), counts, width, min, max};
}

// A model owns its solver and parameter metadata. Future nonlinear models can
// consume initialGuesses; custom expressions must use a safe parser, never eval.
export const fitModels = {
  linear: {label: 'Linear: y = a + b t', parameters: ['a', 'b'], needsInitialGuesses: false,
    solve: (samples, options) => polynomialFit(samples, 1, options.sigma)},
  quadratic: {label: 'Quadratic: y = a + b t + c t²', parameters: ['a', 'b', 'c'], needsInitialGuesses: false,
    solve: (samples, options) => polynomialFit(samples, 2, options.sigma)},
};

// Weighted QR on centered/scaled time avoids squaring the condition number.
// sigma may also be a function of a sample (e.g. a future override keyed by seq).
// Absolute uncertainties: covariance is NOT scaled by reduced chi-squared.
export function polynomialFit(samples, degree, sigma) {
  if (![1, 2].includes(degree)) throw new Error('Unsupported polynomial degree.');
  const n = samples.length, m = degree + 1;
  if (n < m) throw new Error(`Select at least ${m} valid samples for this fit.`);
  if (!samples.every(p => Number.isFinite(p.t) && Number.isFinite(p.value))) throw new Error('Fit samples must be finite.');
  const uncertainties = samples.map(p => typeof sigma === 'function' ? sigma(p) : sigma);
  if (!uncertainties.every(s => Number.isFinite(s) && s > 0)) throw new Error('Enter a finite y uncertainty greater than zero.');
  let low = Infinity, high = -Infinity;
  for (const p of samples) { low = Math.min(low, p.t); high = Math.max(high, p.t); }
  const center = low / 2 + high / 2, scale = Math.max(Math.abs(high - center), Math.abs(low - center));
  if (!(scale > 0)) throw new Error('The fit needs distinct time values.');
  const z = samples.map(p => (p.t - center) / scale);
  const q = Array.from({length: m}, (_, j) => z.map((v, i) => v ** j / uncertainties[i]));
  const r = Array.from({length: m}, () => Array(m).fill(0));
  const dot = (a, b) => a.reduce((sum, v, i) => sum + v * b[i], 0);
  for (let j = 0; j < m; j++) {
    const originalNorm = Math.sqrt(dot(q[j], q[j]));
    // Reorthogonalize to keep covariance accurate for nearly dependent columns.
    for (let pass = 0; pass < 2; pass++) for (let k = 0; k < j; k++) {
      const projection = dot(q[k], q[j]); r[k][j] += projection;
      for (let i = 0; i < n; i++) q[j][i] -= projection * q[k][i];
    }
    r[j][j] = Math.sqrt(dot(q[j], q[j]));
    if (!Number.isFinite(r[j][j]) || r[j][j] <= originalNorm * 1e-12) throw new Error('Time values cannot determine this fit reliably. Choose a wider interval with distinct times.');
    for (let i = 0; i < n; i++) q[j][i] /= r[j][j];
  }
  const solve = rhs => {
    const out = Array(m).fill(0);
    for (let j = m - 1; j >= 0; j--) {
      out[j] = (rhs[j] - r[j].reduce((s, v, k) => s + (k > j ? v * out[k] : 0), 0)) / r[j][j];
    }
    return out;
  };
  const weightedY = samples.map((p, i) => p.value / uncertainties[i]);
  const coefficients = solve(q.map(col => dot(col, weightedY)));
  const inverseColumns = Array.from({length: m}, (_, j) => solve(Array.from({length: m}, (_, k) => +(j === k))));
  const transform = degree === 1 ? [[1, -center / scale], [0, 1 / scale]]
    : [[1, -center / scale, (center / scale) ** 2], [0, 1 / scale, -2 * center / scale ** 2], [0, 0, 1 / scale ** 2]];
  const parameters = transform.map(row => dot(row, coefficients));
  const transformedInverse = transform.map(row => inverseColumns.map(col => dot(row, col)));
  const covariance = transformedInverse.map(row => transformedInverse.map(other => dot(row, other)));
  const errors = covariance.map((row, i) => Math.sqrt(row[i]));
  const correlation = covariance.map((row, i) => row.map((v, j) => Math.max(-1, Math.min(1, v / errors[i] / errors[j]))));
  const predict = t => {
    const x = (t - center) / scale;
    return coefficients.reduceRight((sum, v) => sum * x + v, 0);
  };
  const chiSquared = samples.reduce((sum, p, i) => sum + ((p.value - predict(p.t)) / uncertainties[i]) ** 2, 0);
  if (![...parameters, ...errors, ...correlation.flat(), chiSquared].every(Number.isFinite)) throw new Error('The fit exceeds numerical limits. Check values and uncertainties.');
  return {parameters, errors, covariance, correlation, chiSquared, dof: n - m,
    reducedChiSquared: n > m ? chiSquared / (n - m) : null, predict};
}
