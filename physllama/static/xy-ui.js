import {fitModels, samplesInRange} from './analysis.mjs';
import {pairSamples, pearson} from './xy-analysis.mjs';
const $ = (selector, root) => root.querySelector(selector);
const esc = value => String(value).replace(/[&<>"']/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
const number = value => Number.isFinite(value) ? Number(value.toPrecision(7)).toString() : '—';
const label = s => `${s.device} · ${s.name} (${s.unit || 'unitless'})`;
const table = (headers, rows) => `<div class="analysis-scroll"><table><thead><tr>${headers.map(h => `<th scope="col">${esc(h)}</th>`).join('')}</tr></thead><tbody>${rows.map(row => `<tr>${row.map(v => `<td>${esc(v)}</td>`).join('')}</tr>`).join('')}</tbody></table></div>`;
const numericInput = input => input.value.trim() ? Number(input.value.trim()) : NaN;

export function attachXY(panel, getContext) {
  panel.innerHTML = `<h3>Compare two quantities</h3><p class="small muted">Uses the runs chosen above. Choose two sensors from this graph and how to pair their measurements.</p>
    <form class="xy-form" novalidate><div class="fit-controls"><label>X quantity<select class="xy-x" aria-label="X quantity"></select></label><label>Y quantity<select class="xy-y" aria-label="Y quantity"></select></label>
    <label>Time interval<select class="xy-interval" aria-label="X–Y time interval"><option value="visible">Visible time range</option><option value="runs">Entire selected runs</option><option value="custom">Custom time range</option></select></label></div>
    <div class="xy-custom fit-controls" hidden><label>Start time (s)<input class="xy-start" type="text" inputmode="decimal" aria-label="X–Y start time"></label><label>End time (s)<input class="xy-end" type="text" inputmode="decimal" aria-label="X–Y end time"></label></div>
    <div class="fit-controls xy-matching"><label>Match samples<select class="xy-method" aria-label="Match samples"><option value="exact">Exact timestamps</option><option value="nearest">Nearest unused sample</option></select></label><label class="xy-tolerance-label" hidden>Time tolerance (s)<input class="xy-tolerance" type="text" inputmode="decimal" placeholder="e.g. 0.01" aria-label="Time tolerance"></label><button type="submit" class="button primary xy-build">Plot X–Y</button></div>
    <p class="xy-match-help small muted">Only equal timestamps in the same run are paired. Missing values are skipped; nothing is interpolated.</p></form>
    <p class="xy-message small" role="status">Select two sensors to compare their values.</p>
    <div class="xy-output" hidden><p class="xy-pair-summary small muted"></p><p class="xy-correlation"></p><div class="xy-plot"></div><p class="small muted">Zoom this X–Y plot to select points for correlation and fitting. The time interval above filters both sensors before matching.</p>
    <button class="button xy-pairs-toggle" type="button" aria-expanded="false">Show matched pairs</button><div class="xy-pairs" hidden><div class="xy-pair-table"></div><div class="table-pagination"><button class="button xy-prev" type="button">Previous pairs</button><span class="xy-page small"></span><button class="button xy-next" type="button">Next pairs</button></div></div>
    <form class="xy-fit-form" novalidate><h3>Fit Y versus X</h3><div class="fit-controls"><label>Function<select class="xy-model" aria-label="X–Y fit function">${Object.entries(fitModels).map(([id, model]) => `<option value="${id}">${esc(model.label.replace(/\bt\b/g, 'x'))}</option>`).join('')}</select></label><label>Y uncertainty (1σ)<input class="xy-sigma" type="text" inputmode="decimal" placeholder="e.g. 0.1" aria-label="X–Y y uncertainty"></label><button type="submit" class="button primary xy-fit">Fit X–Y data</button></div><p class="xy-fit-unit small muted"></p></form><p class="xy-fit-message small" role="status"></p><div class="xy-fit-results" hidden></div></div>`;
  const plot = $('.xy-plot', panel);
  let context, signature = '', sensorKey = '', result = null, xSensor, ySensor, bounds = null, fit = null, page = 0, drawing = false, version = 0, drawToken = 0, active = [], source = null;
  const selectedPairs = () => result ? result.pairs.filter(p => !bounds || (p.x >= Math.min(...bounds.x) && p.x <= Math.max(...bounds.x) && p.y >= Math.min(...bounds.y) && p.y <= Math.max(...bounds.y))) : [];
  function clearFit() {
    const hadFit = Boolean(fit); fit = null;
    $('.xy-fit-results', panel).hidden = true;
    $('.xy-fit-message', panel).textContent = hadFit ? 'Selection or fit settings changed. Fit again to update the result.' : '';
    return hadFit;
  }
  function invalidate(message) {
    version++; result = null; source = null; active = []; bounds = null; drawing = false; clearFit();
    Plotly.purge(plot); delete plot.xyListeners; $('.xy-output', panel).hidden = true;
    $('.xy-message', panel).textContent = message;
  }
  function controls() {
    $('.xy-custom', panel).hidden = $('.xy-interval', panel).value !== 'custom';
    const nearest = $('.xy-method', panel).value === 'nearest';
    $('.xy-tolerance-label', panel).hidden = !nearest;
    $('.xy-match-help', panel).textContent = nearest
      ? 'For each X sample in time order, choose the nearest unused Y sample within the tolerance, in the same run. Ties prefer the earlier Y sample. Each sample is used at most once; no interpolation. Swapping X and Y can change the pairs.'
      : 'Only equal timestamps in the same run are paired. Missing values are skipped; nothing is interpolated.';
  }
  function renderPairs() {
    if (!result || $('.xy-pairs', panel).hidden) return;
    page = Math.min(page, Math.max(0, Math.ceil(active.length / 100) - 1));
    $('.xy-pair-table', panel).innerHTML = table(['Run', 'X time (s)', 'Y time (s)', 'Δt = Y − X (s)', label(xSensor), label(ySensor)], active.slice(page * 100, (page + 1) * 100).map(p => [p.run, p.tx, p.ty, number(p.deltaT), p.x, p.y]));
    $('.xy-page', panel).textContent = `Page ${page + 1} of ${Math.max(1, Math.ceil(active.length / 100))}`;
    $('.xy-prev', panel).disabled = page === 0;
    $('.xy-next', panel).disabled = (page + 1) * 100 >= active.length;
  }
  function selectionChanged() {
    const previous = active; active = selectedPairs();
    const changed = active.length !== previous.length || active.some((p, i) => p !== previous[i]);
    if (changed && clearFit()) draw();
    const correlation = pearson(active);
    $('.xy-correlation', panel).textContent = `${active.length} of ${result.pairs.length} pairs in view · Pearson r = ${correlation.r === null ? 'undefined' : number(correlation.r)}${correlation.reason ? ` · ${correlation.reason}` : ''}`;
    $('.xy-fit', panel).disabled = active.length < 2;
    renderPairs();
  }
  function axisRange(values) {
    let low = Infinity, high = -Infinity;
    for (const value of values) { low = Math.min(low, value); high = Math.max(high, value); }
    const pad = high > low ? (high - low) * .06 : Math.max(Math.abs(low) * .06, 1);
    return [low - pad, high + pad];
  }
  async function draw() {
    if (!result) return;
    const drawVersion = version, token = ++drawToken;
    drawing = true;
    const stride = Math.max(1, Math.ceil(result.pairs.length / 4000));
    const display = result.pairs.filter((_, i) => i % stride === 0);
    const traces = [{type: 'scatter', mode: 'markers', name: `${esc(ySensor.name)} vs ${esc(xSensor.name)}`,
      x: display.map(p => p.x), y: display.map(p => p.y), marker: {size: 6, color: ySensor.color},
      error_y: fit ? {type: 'constant', value: fit.sigma, visible: true} : {visible: false},
      customdata: display.map(p => [p.run, p.tx, p.ty, p.deltaT]),
      hovertemplate: 'X: %{x:.6g}<br>Y: %{y:.6g}<br>Run %{customdata[0]}<br>X time: %{customdata[1]:.6g} s<br>Y time: %{customdata[2]:.6g} s<br>Δt: %{customdata[3]:.6g} s<extra></extra>'}];
    if (fit) traces.push(fit.trace);
    try {
      await Plotly.react(plot, traces, {margin: {l: 75, r: 25, t: 30, b: 65}, showlegend: false, dragmode: 'zoom',
        xaxis: {title: {text: esc(`${xSensor.name} (${xSensor.unit || 'unitless'})`)}, range: bounds.x},
        yaxis: {title: {text: esc(`${ySensor.name} (${ySensor.unit || 'unitless'})`)}, range: bounds.y},
      }, {responsive: true, displaylogo: false, scrollZoom: true, modeBarButtonsToRemove: ['select2d', 'lasso2d']});
      if (drawVersion !== version || token !== drawToken || !result) return;
      if (!plot.xyListeners) {
        plot.on('plotly_relayout', () => {
          if (drawing || !result || !plot._fullLayout) return;
          bounds = {x: [...plot._fullLayout.xaxis.range], y: [...plot._fullLayout.yaxis.range]};
          selectionChanged();
        });
        plot.xyListeners = true;
      }
      $('.xy-pair-summary', panel).textContent = `${result.pairs.length} matched pairs · ${result.unmatchedX} unmatched X samples · ${result.unmatchedY} unmatched Y samples · Largest |Δt|: ${number(result.maxOffset)} s${stride > 1 ? ` · Displaying ${display.length} pairs; analysis uses all pairs in view.` : ''}`;
    } catch (error) { if (drawVersion === version && token === drawToken) $('.xy-message', panel).textContent = `Could not draw X–Y plot: ${error.message}`; }
    finally { if (drawVersion === version && token === drawToken) drawing = false; }
  }
  $('.xy-form', panel).addEventListener('input', () => { controls(); invalidate('Settings changed. Select Plot X–Y to update the comparison.'); });
  $('.xy-form', panel).addEventListener('submit', async event => {
    event.preventDefault();
    if (context.recording) return;
    invalidate('');
    try {
      xSensor = context.channels.find(s => s.id === $('.xy-x', panel).value);
      ySensor = context.channels.find(s => s.id === $('.xy-y', panel).value);
      if (!xSensor || !ySensor || xSensor.id === ySensor.id) throw new Error('Choose two different sensors. Add them using the graph’s Sensors menu.');
      const interval = $('.xy-interval', panel).value;
      let range = interval === 'visible' ? context.range : null;
      if (interval === 'custom') {
        range = [numericInput($('.xy-start', panel)), numericInput($('.xy-end', panel))];
        if (!range.every(Number.isFinite) || range[0] > range[1]) throw new Error('Enter finite start and end times, with start no later than end.');
      }
      result = pairSamples(xSensor.samples, ySensor.samples, {range, method: $('.xy-method', panel).value, tolerance: numericInput($('.xy-tolerance', panel))});
      if (!result.pairs.length) throw new Error(`No matching samples (${result.unmatchedX} unmatched X, ${result.unmatchedY} unmatched Y). Choose another interval or use nearest matching with a time tolerance.`);
      source = {x: samplesInRange(xSensor.samples, range), y: samplesInRange(ySensor.samples, range), range, sensorKey, scope: context.scope, generation: context.generation};
      bounds = {x: axisRange(result.pairs.map(p => p.x)), y: axisRange(result.pairs.map(p => p.y))};
      if (![...bounds.x, ...bounds.y].every(Number.isFinite)) throw new Error('The selected values exceed the plot’s numerical range.');
      $('.xy-output', panel).hidden = false;
      $('.xy-message', panel).textContent = range ? `Time interval: ${number(Math.min(...range))}–${number(Math.max(...range))} s (since first Start).` : 'Using the entire selected runs.';
      $('.xy-fit-unit', panel).textContent = `Enter an absolute uncertainty in ${ySensor.unit || 'Y units'}. Fits treat X as exact and do not model timing offsets or X uncertainty.`;
      page = 0; selectionChanged(); await draw();
    } catch (error) { invalidate(error.message); }
  });
  $('.xy-pairs-toggle', panel).addEventListener('click', () => {
    const open = $('.xy-pairs', panel).hidden;
    $('.xy-pairs', panel).hidden = !open;
    $('.xy-pairs-toggle', panel).setAttribute('aria-expanded', String(open));
    $('.xy-pairs-toggle', panel).textContent = open ? 'Hide matched pairs' : 'Show matched pairs';
    renderPairs();
  });
  $('.xy-prev', panel).addEventListener('click', () => { page--; renderPairs(); });
  $('.xy-next', panel).addEventListener('click', () => { page++; renderPairs(); });
  $('.xy-fit-form', panel).addEventListener('input', () => { if (clearFit()) draw(); });
  $('.xy-fit-form', panel).addEventListener('submit', async event => {
    event.preventDefault();
    if (!result || context.recording) return;
    clearFit();
    try {
      const model = fitModels[$('.xy-model', panel).value];
      const sigma = numericInput($('.xy-sigma', panel));
      const fitted = model.solve(active.map(p => ({t: p.x, value: p.y})), {sigma});
      let low = Infinity, high = -Infinity;
      for (const p of active) { low = Math.min(low, p.x); high = Math.max(high, p.x); }
      const x = Array.from({length: 201}, (_, i) => low + (high - low) * i / 200);
      fit = {sigma, trace: {type: 'scatter', mode: 'lines', name: 'Fit', x, y: x.map(fitted.predict), line: {color: '#314c61', width: 2}, hovertemplate: 'Fit: %{y:.6g}<extra></extra>'}};
      $('.xy-fit-message', panel).textContent = `${active.length} pairs fitted · χ² = ${number(fitted.chiSquared)} · Degrees of freedom = ${fitted.dof} · Reduced χ² = ${fitted.reducedChiSquared === null ? 'undefined (zero degrees of freedom)' : number(fitted.reducedChiSquared)}`;
      const output = $('.xy-fit-results', panel); output.hidden = false;
      output.innerHTML = table(['Parameter', 'Value', 'Uncertainty (1σ)', 'Units'], model.parameters.map((name, i) => [name, number(fitted.parameters[i]), number(fitted.errors[i]), `${ySensor.unit || '1'}${i ? `/(${xSensor.unit || '1'})${i === 2 ? '²' : ''}` : ''}`]))
        + '<h3>Parameter correlation matrix</h3>' + table(['Parameter', ...model.parameters], fitted.correlation.map((row, i) => [model.parameters[i], ...row.map(number)]))
        + '<p class="small muted">Parameter uncertainties use your absolute Y uncertainty and are not rescaled by reduced χ².</p>';
      await draw();
    } catch (error) { $('.xy-fit-message', panel).textContent = error.message.replaceAll('time values', 'X values').replaceAll('Time values', 'X values'); await draw(); }
  });
  return {
    update() {
      context = getContext();
      const nextSensorKey = JSON.stringify(context.channels.map(s => [s.id, label(s)]));
      if (sensorKey !== nextSensorKey) {
        sensorKey = nextSensorKey;
        for (const [index, selector] of ['.xy-x', '.xy-y'].entries()) {
          const select = $(selector, panel), previous = select.value;
          select.innerHTML = context.channels.map(s => `<option value="${esc(s.id)}">${esc(label(s))}</option>`).join('');
          select.value = context.channels.some(s => s.id === previous) ? previous : context.channels[Math.min(index, context.channels.length - 1)]?.id || '';
        }
      }
      $('.xy-build', panel).disabled = context.recording || context.channels.length < 2;
      const key = JSON.stringify([context.generation, context.revision, context.recording, context.scope, sensorKey, $('.xy-interval', panel).value === 'visible' ? context.range : null]);
      if (signature !== key) {
        signature = key;
        if (result && source) {
          const range = $('.xy-interval', panel).value === 'visible' ? context.range : source.range;
          const xs = samplesInRange(context.channels.find(s => s.id === xSensor.id)?.samples || [], range);
          const ys = samplesInRange(context.channels.find(s => s.id === ySensor.id)?.samples || [], range);
          const same = (a, b) => a.length === b.length && a.every((p, i) => p === b[i]);
          if (context.recording || source.generation !== context.generation || source.scope !== context.scope || source.sensorKey !== sensorKey || !same(xs, source.x) || !same(ys, source.y)) invalidate('Data or time selection changed. Select Plot X–Y to update the comparison.');
        }
      }
      if (!$('.xy-start', panel).value && context.range) {
        $('.xy-start', panel).value = number(Math.min(...context.range)); $('.xy-end', panel).value = number(Math.max(...context.range));
      }
    },
    resize() { if (result && plot._fullLayout && plot.getClientRects().length) Plotly.Plots.resize(plot).catch(() => {}); },
    dispose() { version++; Plotly.purge(plot); },
  };
}
