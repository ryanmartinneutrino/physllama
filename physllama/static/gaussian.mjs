import {statistics} from './analysis.mjs';

// Stable normal interval probabilities, including intervals in either tail.
// Abramowitz & Stegun 7.1.26; absolute erf error < 1.5e-7.
function erfcPositive(x) {
  const t = 1 / (1 + .3275911 * x);
  return (((((1.061405429 * t - 1.453152027) * t) + 1.421413741) * t - .284496736) * t + .254829592) * t * Math.exp(-x * x);
}
function normalMass(low, high) {
  if (low >= 0) return Math.max(0, .5 * (erfcPositive(low / Math.SQRT2) - erfcPositive(high / Math.SQRT2)));
  if (high <= 0) return normalMass(-high, -low);
  return Math.max(0, 1 - .5 * (erfcPositive(-low / Math.SQRT2) + erfcPositive(high / Math.SQRT2)));
}
function logGamma(z) {
  const coefficients = [676.5203681218851, -1259.1392167224028, 771.3234287776531, -176.6150291621406,
    12.507343278686905, -.13857109526572012, 9.984369578019572e-6, 1.5056327351493116e-7];
  z -= 1;
  let x = .9999999999998099;
  coefficients.forEach((c, i) => { x += c / (z + i + 1); });
  const t = z + 7.5;
  return .5 * Math.log(2 * Math.PI) + (z + .5) * Math.log(t) - t + Math.log(x);
}
export function chiSquareSurvival(value, dof) {
  if (!(dof > 0) || !(value >= 0)) return NaN;
  if (value === Infinity) return 0;
  if (value === 0) return 1;
  const a = dof / 2, x = value / 2, factor = Math.exp(a * Math.log(x) - x - logGamma(a));
  if (x < a + 1) {
    let term = 1 / a, sum = term;
    for (let i = 1; i < 2000; i++) { term *= x / (a + i); sum += term; if (Math.abs(term) < Math.abs(sum) * 1e-14) break; }
    return Math.max(0, Math.min(1, 1 - sum * factor));
  }
  const tiny = 1e-300;
  let b = x + 1 - a, c = 1 / tiny, d = 1 / b, h = d;
  for (let i = 1; i < 2000; i++) {
    const an = -i * (i - a); b += 2;
    d = an * d + b; if (Math.abs(d) < tiny) d = tiny;
    c = b + an / c; if (Math.abs(c) < tiny) c = tiny;
    d = 1 / d; const delta = d * c; h *= delta;
    if (Math.abs(delta - 1) < 1e-14) break;
  }
  return Math.max(0, Math.min(1, factor * h));
}

function minimize(objective, initial) {
  let simplex = [initial, [initial[0] + .05, initial[1]], [initial[0], initial[1] + .15]]
    .map(p => ({p, f: objective(p)}));
  const evaluate = p => ({p, f: objective(p)});
  for (let iteration = 0; iteration < 600; iteration++) {
    simplex.sort((a, b) => a.f - b.f);
    const [best, middle, worst] = simplex;
    if (Number.isFinite(best.f) && Math.max(...worst.p.map((v, i) => Math.abs(v - best.p[i])), ...middle.p.map((v, i) => Math.abs(v - best.p[i]))) < 1e-7) return {...best, converged: true};
    const center = best.p.map((v, i) => (v + middle.p[i]) / 2);
    const reflected = evaluate(center.map((v, i) => 2 * v - worst.p[i]));
    if (reflected.f < best.f) {
      const expanded = evaluate(center.map((v, i) => v + 2 * (reflected.p[i] - v)));
      simplex[2] = expanded.f < reflected.f ? expanded : reflected;
    } else if (reflected.f < middle.f) simplex[2] = reflected;
    else {
      const outside = reflected.f < worst.f;
      const contracted = evaluate(center.map((v, i) => v + .5 * ((outside ? reflected : worst).p[i] - v)));
      if (contracted.f < (outside ? reflected.f : worst.f)) simplex[2] = contracted;
      else simplex = [best, ...simplex.slice(1).map(point => evaluate(point.p.map((v, i) => (v + best.p[i]) / 2)))];
    }
  }
  simplex.sort((a, b) => a.f - b.f);
  return {...simplex[0], converged: false};
}

// Fit the *binned* likelihood, including zero-count bins. Bin probabilities are
// conditional on the displayed value range; N denotes counts inside that range.
// N's Poisson MLE is exactly the observed total, so profile it out analytically.
export function fitGaussian(samples, bins) {
  const included = samples.filter(p => Number.isFinite(p.value) && p.value >= bins.min && p.value <= bins.max);
  const stats = statistics(included), n = stats.n, k = bins.counts.length;
  if (n < 20) throw new Error('A Gaussian fit needs at least 20 values in the histogram. Collect more data or widen the range.');
  if (k < 4) throw new Error('Use at least 4 bins to fit a Gaussian.');
  if (!(stats.max > stats.min) || bins.counts.filter(count => count > 0).length < 3) throw new Error('The values have too little spread across bins to determine a Gaussian width.');
  if (bins.counts.reduce((sum, v) => sum + v, 0) !== n) throw new Error('The histogram changed. Redraw it before fitting.');
  const span = bins.max - bins.min, origin = bins.min + span / 2;
  const initial = {mu: stats.mean, sigma: stats.stddev, normalization: n};
  const mu0 = (stats.mean - origin) / span;
  const minSigma = 1 / (20 * k), maxSigma = 20;
  function probabilities([mu, logSigma]) {
    const sigma = Math.exp(logSigma);
    if (Math.abs(mu) > 5 || sigma < minSigma || sigma > maxSigma) return null;
    const mass = Array.from({length: k}, (_, i) => normalMass((i / k - .5 - mu) / sigma, ((i + 1) / k - .5 - mu) / sigma));
    const total = mass.reduce((sum, v) => sum + v, 0);
    return total > 1e-14 ? mass.map(v => Math.max(1e-300, v / total)) : null;
  }
  const objective = p => {
    const probability = probabilities(p);
    // The constant-free Poisson deviance has its minimum at the binned MLE.
    return probability ? bins.counts.reduce((sum, count, i) => sum + (count ? 2 * count * Math.log(count / n / probability[i]) : 0), 0) : Infinity;
  };
  const start = sigma => [mu0, Math.log(Math.min(maxSigma / 2, Math.max(minSigma * 2, sigma)))];
  // Seed with the measured standard deviation; also try a wider starting width
  // for cropped histograms, whose observed spread underestimates the full width.
  const attempts = [1, 2].map(factor => minimize(objective, start(factor * stats.stddev / span)));
  const optimum = attempts.filter(a => a.converged && Number.isFinite(a.f)).sort((a, b) => a.f - b.f)[0];
  if (!optimum) throw new Error('The Gaussian fit did not converge. Try a different range or bin count; the data may not follow a Gaussian.');
  const [muScaled, logSigma] = optimum.p, sigmaScaled = Math.exp(logSigma);
  if (Math.abs(muScaled) > 4.9 || sigmaScaled > maxSigma * .95 || sigmaScaled < minSigma * 1.05) throw new Error('No reliable Gaussian width could be determined. The data may not be Gaussian, or the value range may be too narrow.');
  const probability = probabilities(optimum.p), expected = probability.map(v => n * v);
  // Expected Fisher information for (scaled mu, log sigma).
  const derivatives = [0, 1].map(axis => {
    const step = axis === 0 ? Math.max(1e-7, sigmaScaled * 1e-4) : 1e-4;
    const plus = [...optimum.p], minus = [...optimum.p]; plus[axis] += step; minus[axis] -= step;
    const a = probabilities(plus), b = probabilities(minus);
    if (!a || !b) throw new Error('The Gaussian fit is too close to numerical limits to estimate uncertainties.');
    return a.map((v, i) => (v - b[i]) / (2 * step));
  });
  const information = (a, b) => probability.reduce((sum, p, i) => sum + n * derivatives[a][i] * derivatives[b][i] / p, 0);
  const aa = information(0, 0), ab = information(0, 1), bb = information(1, 1), det = aa * bb - ab * ab;
  if (!(det > aa * bb * 1e-10)) throw new Error('The Gaussian parameters are not independently constrained. Widen the range or collect more data.');
  const muError = span * Math.sqrt(bb / det), sigmaError = span * sigmaScaled * Math.sqrt(aa / det);
  const mu = origin + span * muScaled, sigma = span * sigmaScaled;
  if (![mu, sigma, muError, sigmaError].every(Number.isFinite) || sigmaError > sigma || muError > span) throw new Error('The Gaussian fit is poorly constrained. The data may not be Gaussian; try a wider range or more samples.');
  // Merge adjacent bins to achieve expected counts >= 5 for an approximate
  // Pearson goodness-of-fit test. Two shape parameters and one total are estimated.
  const groups = []; let observed = 0, predicted = 0;
  for (let i = 0; i < k; i++) {
    observed += bins.counts[i]; predicted += expected[i];
    if (predicted >= 5) { groups.push({observed, predicted}); observed = predicted = 0; }
  }
  if (predicted > 0 && groups.length) { groups.at(-1).observed += observed; groups.at(-1).predicted += predicted; }
  const dof = groups.length - 3;
  const chiSquared = groups.reduce((sum, g) => sum + (g.observed - g.predicted) ** 2 / g.predicted, 0);
  const pValue = dof > 0 ? chiSquareSurvival(chiSquared, dof) : null;
  const rho = Math.max(-1, Math.min(1, -ab / Math.sqrt(aa) / Math.sqrt(bb)));
  const correlation = [[1, rho, 0], [rho, 1, 0], [0, 0, 1]];
  return {mu, sigma, normalization: n, muError, sigmaError, normalizationError: Math.sqrt(n), correlation, initial,
    expected, countChiSquared: poissonCountChiSquared(bins.counts, expected),
    deviance: Math.max(0, optimum.f), chiSquared, dof, pValue,
    status: pValue === null ? 'insufficient' : pValue < .01 ? 'poor' : 'compatible'};
}

// ROOT TH1's default observed-error chi-square: error = sqrt(count).
// Zero-error bins are excluded here, but remain included in the likelihood fit.
// https://root.cern.ch/doc/v636/classTH1.html (Chi-square Fits)
export function poissonCountChiSquared(counts, expected, parameters = 3) {
  let value = 0, usedBins = 0;
  counts.forEach((count, i) => {
    if (count > 0) { value += (count - expected[i]) ** 2 / count; usedBins++; }
  });
  return {value, dof: usedBins - parameters, usedBins, excludedBins: counts.length - usedBins};
}
