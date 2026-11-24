import {samplesInRange} from './analysis.mjs';

// Pair actual measurements, with X as the chronological anchor. Never cross a
// run boundary, interpolate, extrapolate, or reuse a Y sample.
export function pairSamples(xSamples, ySamples, {range, method = 'exact', tolerance = 0} = {}) {
  if (!['exact', 'nearest'].includes(method)) throw new Error('Choose exact or nearest timestamp matching.');
  if (method === 'nearest' && (!Number.isFinite(tolerance) || tolerance < 0)) throw new Error('Enter a finite, nonnegative time tolerance in seconds.');
  const limit = method === 'exact' ? 0 : tolerance;
  const byTime = (a, b) => a.run - b.run || a.t - b.t || (a.seq || 0) - (b.seq || 0);
  const xs = samplesInRange(xSamples, range).sort(byTime), ys = samplesInRange(ySamples, range).sort(byTime);
  const pairs = []; let j = 0;
  for (const x of xs) {
    while (j < ys.length && (ys[j].run < x.run || (ys[j].run === x.run && ys[j].t < x.t - limit))) j++;
    if (j === ys.length || ys[j].run !== x.run || ys[j].t > x.t + limit) continue;
    // Ties prefer the earlier Y timestamp. Skipped earlier Ys cannot help a later X.
    while (j + 1 < ys.length && ys[j + 1].run === x.run && ys[j + 1].t <= x.t + limit && Math.abs(ys[j + 1].t - x.t) < Math.abs(ys[j].t - x.t)) j++;
    const y = ys[j++];
    pairs.push({x: x.value, y: y.value, tx: x.t, ty: y.t, run: x.run, deltaT: y.t - x.t, xSeq: x.seq, ySeq: y.seq});
  }
  return {pairs, unmatchedX: xs.length - pairs.length, unmatchedY: ys.length - pairs.length,
    maxOffset: pairs.reduce((max, p) => Math.max(max, Math.abs(p.deltaT)), 0)};
}

export function pearson(pairs) {
  if (pairs.length < 2) return {r: null, reason: 'At least two matched pairs are needed.'};
  let scaleX = 0, scaleY = 0;
  for (const p of pairs) { scaleX = Math.max(scaleX, Math.abs(p.x)); scaleY = Math.max(scaleY, Math.abs(p.y)); }
  if (!scaleX || !scaleY) return {r: null, reason: 'Correlation is undefined when either quantity is constant.'};
  let mx = 0, my = 0;
  for (const [i, p] of pairs.entries()) { mx += (p.x / scaleX - mx) / (i + 1); my += (p.y / scaleY - my) / (i + 1); }
  let xx = 0, yy = 0, xy = 0;
  for (const p of pairs) {
    const x = p.x / scaleX - mx, y = p.y / scaleY - my;
    xx += x * x; yy += y * y; xy += x * y;
  }
  if (!(xx > 0 && yy > 0)) return {r: null, reason: 'Correlation is undefined when either quantity is constant.'};
  if (Math.sqrt(xx) < 1e-13 * Math.abs(mx) || Math.sqrt(yy) < 1e-13 * Math.abs(my)) return {r: null, reason: 'One quantity is nearly constant; correlation would be numerically unreliable.'};
  return {r: Math.max(-1, Math.min(1, xy / Math.sqrt(xx) / Math.sqrt(yy))), reason: ''};
}
