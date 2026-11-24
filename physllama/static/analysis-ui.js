import {fitGaussian} from './gaussian.mjs';
import {attachXY} from './xy-ui.js';
import {samplesInRange, statistics, histogram, MAX_HISTOGRAM_BINS, fitModels} from './analysis.mjs';
const $ = (selector, root) => root.querySelector(selector);
const esc = value => String(value).replace(/[&<>"']/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
const number = value => Number.isFinite(value) ? Number(value.toPrecision(7)).toString() : '—';
const table = (headers, rows) => `<div class="analysis-scroll"><table><thead><tr>${headers.map(h => `<th scope="col">${esc(h)}</th>`).join('')}</tr></thead><tbody>${rows.join('')}</tbody></table></div>`;
const cells = values => `<tr>${values.map(v => `<td>${esc(v)}</td>`).join('')}</tr>`;
const label = s => `${s.device} · ${s.name} (${s.unit || 'unitless'})`;

export function attachAnalysis(graph, getContext, changeScope) {
  const root = document.createElement('section'); root.className = 'graph-analysis';
  root.setAttribute('aria-label', 'Graph data analysis');
  root.innerHTML = `<div class="analysis-toolbar"><label>Show <select class="data-scope" aria-label="Graph data scope"><option value="all">All runs</option><option value="current">Current run</option></select></label><span class="analysis-status small muted"></span></div>
    <div class="analysis-tabs">${[['table', 'Data table'], ['stats', 'Statistics'], ['fit', 'Fit'], ['xy', 'X–Y analysis']].map(([id, name]) => `<button type="button" class="analysis-toggle" data-panel="${id}" aria-expanded="false" aria-controls="analysis-${graph.id}-${id}">${name} <span aria-hidden="true">⌄</span></button>`).join('')}</div>
    <div class="analysis-panel" id="analysis-${graph.id}-table" data-content="table" hidden><div class="table-controls"><label><input type="checkbox" class="table-visible"> Visible time range only</label><span class="table-count small muted"></span><button type="button" class="button compare-columns">Compare columns</button></div><p class="small muted">Full-resolution samples for the selected runs. Times are seconds since the first Start; blanks mean no measurement at that timestamp.</p><div class="data-table"></div><div class="table-pagination"><button class="table-prev button">Previous</button><span class="table-page small"></span><button class="table-next button">Next</button></div></div>
    <div class="analysis-panel" id="analysis-${graph.id}-stats" data-content="stats" hidden><h3>Statistics</h3><p class="small muted">Each sensor uses all finite samples in the visible time interval, including points outside the vertical axis limits. Standard deviation = √mean((y − mean)²), using N samples.</p><div class="stats-table"></div></div>
    <div class="analysis-panel" id="analysis-${graph.id}-fit" data-content="fit" hidden><h3>Fit visible data</h3><form class="fit-form"><div class="fit-controls"><label>Sensor<select class="fit-sensor" aria-label="Fit sensor"></select></label><label>Function<select class="fit-model" aria-label="Fit function">${Object.entries(fitModels).map(([id, m]) => `<option value="${id}">${esc(m.label)}</option>`).join('')}</select></label><label>Y uncertainty (1σ)<input class="fit-sigma" aria-label="Y uncertainty" type="text" inputmode="decimal" placeholder="e.g. 0.1" required autocomplete="off"></label><button class="button primary fit-submit" type="submit">Fit visible data</button></div><p class="fit-unit small muted"></p><p class="small muted">One positive standard deviation for every point. Assumes independent y errors and exact times. Linear and quadratic fits need no initial guesses.</p></form><p class="fit-message small" role="status">Choose a sensor and enter its measurement uncertainty.</p><div class="fit-results" hidden></div><div class="fit-preview" hidden></div></div><div class="analysis-panel" id="analysis-${graph.id}-xy" data-content="xy" hidden></div>`;
  graph.node.append(root);
  const xy = attachXY($('[data-content="xy"]', root), () => ({...context, scope: graph.scope}));
  const scope = $('.data-scope', root); scope.value = graph.scope;
  let context, signature = '', sensorSignature = '', runSignature = '', page = 0, rows = [], fitShown = false;
  let histogramDialog = null, histogramSensor = null, histogramOptions = null, fitInput = null;
  let histogramState = null, gaussian = null, histogramVersion = 0, histogramDirty = false;
  const dataKey = () => JSON.stringify([context.generation, context.recording, context.run, graph.scope, context.channels.map(s => [s.id, s.name, s.device, s.unit])]);
  const visible = s => samplesInRange(s.samples, context.range);
  const invalidateFit = () => {
    if (!fitShown) return;
    fitShown = false; fitInput = null;
    $('.fit-results', root).hidden = true;
    const preview = $('.fit-preview', root); Plotly.purge(preview); preview.hidden = true;
    $('.fit-message', root).textContent = 'Data, interval, or fit settings changed. Fit again to update the result.';
  };
  const updateUnit = () => {
    const sensor = context?.channels.find(s => s.id === $('.fit-sensor', root).value);
    $('.fit-unit', root).textContent = sensor ? `Uncertainty in ${sensor.unit || 'sensor units'}. Parameters use t in seconds since the first Start.` : 'Select a sensor on the graph to fit its data.';
  };
  function renderTable() {
    const channels = context.channels;
    const joined = new Map();
    const interval = $('.table-visible', root).checked && context.range;
    for (const [i, s] of channels.entries()) for (const p of s.samples) {
      if (interval && (p.t < Math.min(...interval) || p.t > Math.max(...interval))) continue;
      const key = `${p.run}/${p.t}`;
      if (!joined.has(key)) joined.set(key, {run: p.run, t: p.t, values: new Map()});
      joined.get(key).values.set(i, Number.isFinite(p.value) ? String(p.value) : '');
    }
    rows = [...joined.values()].sort((a, b) => a.run - b.run || a.t - b.t);
    page = Math.min(page, Math.max(0, Math.ceil(rows.length / 100) - 1));
    $('.table-count', root).textContent = `${rows.length.toLocaleString()} timestamps`;
    renderPage();
  }
  function renderPage() {
    $('.data-table', root).innerHTML = rows.length ? table(['Run', 'Time (s)', ...context.channels.map(label)], rows.slice(page * 100, (page + 1) * 100).map(r => cells([r.run, r.t, ...context.channels.map((_, i) => r.values.get(i) ?? '')]))) : '<p class="muted">No samples in this selection.</p>';
    $('.table-page', root).textContent = `Page ${page + 1} of ${Math.max(1, Math.ceil(rows.length / 100))}`;
    $('.table-prev', root).disabled = page === 0;
    $('.table-next', root).disabled = (page + 1) * 100 >= rows.length;
  }
  function renderStats() {
    $('.stats-table', root).innerHTML = context.channels.length ? table(['Sensor', 'N', 'Min', 'Max', 'Mean', 'Standard deviation', 'Distribution'], context.channels.map(s => {
      const stats = statistics(visible(s));
      return `<tr>${[label(s), stats.n, ...['min', 'max', 'mean', 'stddev'].map(k => number(stats[k]))].map(v => `<td>${esc(v)}</td>`).join('')}<td><button class="button histogram-button" data-sensor="${esc(s.id)}" aria-label="Histogram for ${esc(label(s))}" ${stats.n ? '' : 'disabled'}>Histogram</button></td></tr>`;
    })) : '<p class="muted">Select sensors on the graph to see statistics.</p>';
  }
  function clearGaussian(message = '') {
    gaussian = null;
    $('.gaussian-results', histogramDialog).hidden = true;
    $('.gaussian-message', histogramDialog).textContent = message;
    $('.gaussian-message', histogramDialog).classList.remove('analysis-warning');
  }
  async function drawHistogram() {
    if (!histogramDialog?.open || !histogramState) return;
    const {sensor, bins, included} = histogramState;
    const traces = [{type: 'bar', x: bins.centers, y: bins.counts, width: bins.width,
      error_y: {type: 'data', array: bins.counts.map(Math.sqrt), visible: true, color: '#314c61', thickness: 1, width: 3},
      marker: {color: sensor.color}, customdata: bins.centers.map(x => [x - bins.width / 2, x + bins.width / 2]),
      hovertemplate: 'Range: %{customdata[0]:.5g}–%{customdata[1]:.5g}<br>Count: %{y}<extra></extra>'}];
    if (gaussian) traces.push({type: 'scatter', mode: 'lines', name: 'Gaussian expected counts', x: bins.centers, y: gaussian.expected,
      line: {color: gaussian.status === 'poor' ? '#a45d2b' : '#314c61', width: 2, dash: gaussian.status === 'poor' ? 'dash' : 'solid'},
      hovertemplate: 'Gaussian expected count: %{y:.5g}<extra></extra>'});
    try {
      await Plotly.react($('.histogram-plot', histogramDialog), traces, {
        margin: {t: 20, b: 60, l: 60, r: 20}, showlegend: false,
        xaxis: {title: {text: sensor.unit || 'Value'}, range: [bins.min, bins.max]},
        yaxis: {title: {text: 'Count'}, rangemode: 'tozero', dtick: included.length < 10 ? 1 : undefined},
        annotations: included.length ? [] : [{text: histogramState.samples.length ? 'No samples in this value range' : 'No samples in the visible interval', showarrow: false, xref: 'paper', yref: 'paper', x: .5, y: .5}],
      }, {responsive: true, displaylogo: false});
    } catch (error) { $('.histogram-error', histogramDialog).textContent = error.message; }
  }
  async function renderHistogram(options = histogramOptions, commit = false) {
    if (!histogramDialog?.open) return;
    const sensor = context.channels.find(s => s.id === histogramSensor);
    if (!sensor || context.recording) { histogramDialog.close(); return; }
    const errorMessage = $('.histogram-error', histogramDialog);
    try {
      const samples = visible(sensor), bins = histogram(samples, options || {});
      const included = samples.filter(p => p.value >= bins.min && p.value <= bins.max), stats = statistics(included);
      if (!histogramState || histogramState.sensor.id !== sensor.id || histogramState.bins.min !== bins.min || histogramState.bins.max !== bins.max || histogramState.bins.counts.length !== bins.counts.length || included.length !== histogramState.included.length || included.some((p, i) => p !== histogramState.included[i])) {
        histogramVersion++; clearGaussian();
      }
      if (commit) histogramDirty = false;
      histogramState = {sensor, samples, bins, included};
      histogramOptions = {min: bins.min, max: bins.max, bins: bins.counts.length};
      if (!options) {
        for (const [key, value] of Object.entries(histogramOptions)) $(`[name="${key}"]`, histogramDialog).value = String(value);
      }
      errorMessage.textContent = '';
      $('.gaussian-fit', histogramDialog).disabled = histogramDirty || included.length === 0;
      $('h2', histogramDialog).textContent = `${sensor.name} histogram`;
      $('.histogram-note', histogramDialog).textContent = `${label(sensor)} · ${samples.length} samples · ${included.length} in histogram · ${samples.length - included.length} outside value range · ${bins.counts.length} equal-width bins · ${rangeText()}`;
      $('.histogram-summary', histogramDialog).textContent = `Mean = ${number(stats.mean)} ${sensor.unit} · Standard deviation = ${number(stats.stddev)} ${sensor.unit} · Based on the ${included.length} values inside this histogram’s range. Spread uses N samples; count error bars are ±√n (zero for empty bins).`;
      await drawHistogram();
    } catch (error) { errorMessage.textContent = error.message; }
  }
  function rangeText() {
    return context.range ? `${number(Math.min(...context.range))}–${number(Math.max(...context.range))} s` : 'Full time range';
  }
  function update() {
    context = getContext();
    scope.disabled = context.recording;
    const runs = [...context.runs];
    // A saved selection may precede its samples during reload/import. Keep it visible.
    if (graph.scope.startsWith('run:') && !runs.includes(Number(graph.scope.slice(4)))) runs.push(Number(graph.scope.slice(4)));
    runs.sort((a, b) => a - b);
    const runKey = JSON.stringify(runs);
    if (runKey !== runSignature) {
      runSignature = runKey;
      scope.innerHTML = '<option value="all">All runs</option><option value="current">Current run</option>'
        + runs.map(run => `<option value="run:${run}">Run ${run}</option>`).join('');
    }
    scope.value = graph.scope;
    const key = JSON.stringify([context.revision, context.generation, context.recording, context.run, graph.scope, context.range, context.channels.map(s => [s.id, s.name, s.device, s.unit])]);
    if (signature === key) return;
    signature = key;
    xy.update();
    if (fitInput) {
      const sensor = context.channels.find(s => s.id === fitInput.sensorId);
      const samples = sensor ? visible(sensor) : [];
      // Autorange padding can change on resize without changing the fitted data.
      if (fitInput.key !== dataKey() || samples.length !== fitInput.samples.length || samples.some((p, i) => p !== fitInput.samples[i])) invalidateFit();
    }
    $('.analysis-status', root).textContent = context.recording ? 'Stop collection to analyze data.' : `${graph.scope === 'all' ? 'All runs' : `Run ${graph.scope === 'current' ? context.run || '—' : graph.scope.slice(4)}`} · Analysis interval: ${rangeText()}`;
    for (const button of root.querySelectorAll('.analysis-toggle')) {
      button.disabled = context.recording;
      if (context.recording) button.setAttribute('aria-expanded', 'false');
    }
    for (const panel of root.querySelectorAll('.analysis-panel')) panel.hidden = context.recording || $(`[data-panel="${panel.dataset.content}"]`, root).getAttribute('aria-expanded') !== 'true';
    const sensorKey = JSON.stringify(context.channels.map(s => [s.id, label(s)]));
    if (sensorKey !== sensorSignature) {
      sensorSignature = sensorKey;
      const select = $('.fit-sensor', root), old = select.value;
      select.innerHTML = context.channels.map(s => `<option value="${esc(s.id)}">${esc(label(s))}</option>`).join('');
      if (context.channels.some(s => s.id === old)) select.value = old;
      updateUnit();
    }
    $('.fit-submit', root).disabled = context.recording || !context.channels.length;
    if (!$('[data-content="table"]', root).hidden) renderTable();
    if (!$('[data-content="stats"]', root).hidden) renderStats();
    renderHistogram();
  }
  scope.addEventListener('change', () => { page = 0; changeScope(scope.value); });
  for (const button of root.querySelectorAll('.analysis-toggle')) button.addEventListener('click', () => {
    const open = button.getAttribute('aria-expanded') !== 'true';
    button.setAttribute('aria-expanded', String(open));
    $(`[data-content="${button.dataset.panel}"]`, root).hidden = !open;
    if (open && button.dataset.panel === 'table') renderTable();
    if (open && button.dataset.panel === 'stats') renderStats();
    if (open && button.dataset.panel === 'xy') { xy.update(); xy.resize(); }
    if (open && button.dataset.panel === 'fit' && fitShown) Plotly.Plots.resize($('.fit-preview', root)).catch(() => {});
  });
  $('.compare-columns', root).addEventListener('click', () => {
    const toggle = $('[data-panel="xy"]', root);
    if (toggle.getAttribute('aria-expanded') !== 'true') toggle.click();
    $('[data-content="xy"]', root).scrollIntoView({block: 'start'});
    $('.xy-x', root).focus({preventScroll: true});
  });
  $('.table-visible', root).addEventListener('change', () => { page = 0; renderTable(); });
  $('.table-prev', root).addEventListener('click', () => { page--; renderPage(); });
  $('.table-next', root).addEventListener('click', () => { page++; renderPage(); });
  $('.stats-table', root).addEventListener('click', event => {
    const button = event.target.closest('[data-sensor]');
    if (!button) return;
    histogramSensor = button.dataset.sensor;
    histogramOptions = null; histogramState = null; histogramDirty = false; histogramVersion++;
    if (!histogramDialog) {
      histogramDialog = document.createElement('dialog'); histogramDialog.className = 'histogram-dialog';
      histogramDialog.setAttribute('aria-labelledby', `histogram-title-${graph.id}`);
      histogramDialog.innerHTML = `<h2 id="histogram-title-${graph.id}"></h2><p class="histogram-note small muted"></p><p class="histogram-summary small"></p><form class="histogram-controls" novalidate><label>Minimum value<input name="min" type="text" inputmode="decimal" required></label><label>Maximum value<input name="max" type="text" inputmode="decimal" required></label><label>Number of bins<input name="bins" type="text" inputmode="numeric" required></label><button class="button primary" type="submit">Redraw</button></form><p class="small muted">Range limits use the sensor’s units and include both endpoints. Values outside the range are excluded. Choose 1–${MAX_HISTOGRAM_BINS} bins.</p><p class="histogram-error small" role="alert"></p><div class="histogram-plot"></div><button class="button gaussian-fit" type="button">Fit Gaussian</button><p class="gaussian-message small" role="status"></p><div class="gaussian-results" hidden></div><div class="dialog-actions"><button class="button histogram-close">Close histogram</button></div>`;
      document.body.append(histogramDialog);
      $('.histogram-close', histogramDialog).addEventListener('click', () => histogramDialog.close());
      $('.histogram-controls', histogramDialog).addEventListener('submit', event => {
        event.preventDefault();
        const options = Object.fromEntries(['min', 'max', 'bins'].map(key => {
          const value = $(`[name="${key}"]`, histogramDialog).value.trim();
          return [key, value ? Number(value) : NaN];
        }));
        renderHistogram(options, true);
      });
      $('.histogram-controls', histogramDialog).addEventListener('input', () => {
        histogramDirty = true; histogramVersion++;
        $('.gaussian-fit', histogramDialog).disabled = true;
        clearGaussian('Histogram settings changed. Redraw before fitting.');
        drawHistogram();
      });
      $('.gaussian-fit', histogramDialog).addEventListener('click', async () => {
        if (!histogramState || histogramDirty) return;
        const fitVersion = histogramVersion;
        const button = $('.gaussian-fit', histogramDialog), message = $('.gaussian-message', histogramDialog);
        button.disabled = true; clearGaussian('Fitting Gaussian…');
        await new Promise(resolve => requestAnimationFrame(resolve));
        if (fitVersion !== histogramVersion || !histogramDialog.open) return;
        try {
          gaussian = fitGaussian(histogramState.included, histogramState.bins);
          const result = $('.gaussian-results', histogramDialog); result.hidden = false;
          result.innerHTML = table(['Parameter', 'Value', 'Uncertainty (1σ)', 'Units'], [
            cells(['μ (mean)', number(gaussian.mu), number(gaussian.muError), histogramState.sensor.unit]),
            cells(['σ (width)', number(gaussian.sigma), number(gaussian.sigmaError), histogramState.sensor.unit]),
            cells(['N (in range)', number(gaussian.normalization), number(gaussian.normalizationError), 'counts']),
          ]) + '<h3>Parameter correlation matrix</h3>' + table(['Parameter', 'μ', 'σ', 'N'], gaussian.correlation.map((row, i) => cells([['μ', 'σ', 'N'][i], ...row.map(number)]))) + `<p class="small muted">Initial μ = ${number(gaussian.initial.mu)}, σ = ${number(gaussian.initial.sigma)} (standard deviation), N = ${gaussian.initial.normalization}.</p><p class="small muted">Fits integrated bin counts with a Poisson likelihood, normalized within this value range. Parameter errors are approximate. Count χ² = Σ(n − expected)²/n uses √n errors and excludes empty bins; it is evaluated at the likelihood fit. The separate pooled Pearson check uses expected-count Poisson variance, merging adjacent bins to at least 5 expected counts. The goodness-of-fit check assumes independent samples and assesses only this range; it does not prove normality.</p>`;
          message.classList.toggle('analysis-warning', gaussian.status !== 'compatible');
          message.textContent = (gaussian.status === 'poor' ? 'Poor Gaussian fit: these counts are inconsistent with this model (p < 0.01). Treat the parameters as unreliable.' : gaussian.status === 'insufficient' ? 'Gaussian fitted, but there are too few adequately populated bins to assess goodness of fit. Try more data or different binning.' : 'No significant lack of fit detected at the 1% level.')
            + ` Count χ² (√n errors) = ${number(gaussian.countChiSquared.value)}, degrees of freedom = ${gaussian.countChiSquared.dof}, empty bins excluded = ${gaussian.countChiSquared.excludedBins}. Poisson deviance = ${number(gaussian.deviance)}. Pooled Pearson χ² = ${number(gaussian.chiSquared)}, degrees of freedom = ${Math.max(0, gaussian.dof)}, p = ${gaussian.pValue === null ? 'unavailable' : number(gaussian.pValue)}.`;
        } catch (error) { clearGaussian(error.message); message.classList.add('analysis-warning'); }
        finally { if (fitVersion === histogramVersion) { button.disabled = false; await drawHistogram(); } }
      });
      histogramDialog.addEventListener('close', () => { histogramVersion++; Plotly.purge($('.histogram-plot', histogramDialog)); });
    }
    histogramDialog.showModal(); renderHistogram();
  });
  $('.fit-form', root).addEventListener('input', () => { invalidateFit(); updateUnit(); });
  $('.fit-form', root).addEventListener('submit', async event => {
    event.preventDefault();
    if (context.recording) return;
    const message = $('.fit-message', root);
    try {
      const sensor = context.channels.find(s => s.id === $('.fit-sensor', root).value);
      if (!sensor) throw new Error('Select a sensor to fit.');
      const samples = visible(sensor), model = fitModels[$('.fit-model', root).value];
      const sigma = Number($('.fit-sigma', root).value.trim());
      const result = model.solve(samples, {sigma, initialGuesses: {}});
      const output = $('.fit-results', root); output.hidden = false; fitShown = true;
      fitInput = {sensorId: sensor.id, samples, key: dataKey()};
      message.textContent = `${samples.length} samples · χ² = ${number(result.chiSquared)} · Degrees of freedom = ${result.dof} · Reduced χ² = ${result.reducedChiSquared === null ? 'undefined (zero degrees of freedom)' : number(result.reducedChiSquared)}`;
      output.innerHTML = table(['Parameter', 'Value', 'Uncertainty (1σ)', 'Units'], model.parameters.map((name, i) => cells([name, number(result.parameters[i]), number(result.errors[i]), `${sensor.unit || '1'}${i ? `/s${i === 2 ? '²' : ''}` : ''}`])))
        + '<h3>Parameter correlation matrix</h3>' + table(['Parameter', ...model.parameters], result.correlation.map((row, i) => cells([model.parameters[i], ...row.map(number)])))
        + '<p class="small muted">Parameter uncertainties use the supplied absolute y uncertainty; they are not rescaled by reduced χ².</p>';
      let low = Infinity, high = -Infinity;
      for (const sample of samples) { low = Math.min(low, sample.t); high = Math.max(high, sample.t); }
      const x = Array.from({length: 201}, (_, i) => low + (high - low) * i / 200);
      const preview = $('.fit-preview', root); preview.hidden = false;
      // Only the preview is reduced; the solver above always sees every sample.
      const stride = Math.max(1, Math.ceil(samples.length / 2000));
      const display = samples.filter((_, i) => i % stride === 0);
      await Plotly.react(preview, [{type: 'scatter', mode: 'markers', name: esc(sensor.name),
        x: display.map(p => p.t), y: display.map(p => p.value), marker: {color: sensor.color, size: 5},
        error_y: {type: 'constant', value: sigma, visible: true}},
      {type: 'scatter', mode: 'lines', name: 'Fit', x, y: x.map(result.predict), line: {color: '#314c61', width: 2}}], {
        margin: {t: 30, l: 65, r: 20, b: 55}, showlegend: true, legend: {orientation: 'h', y: 1.15},
        xaxis: {title: {text: 'Time since first Start (s)'}, range: [low, high]}, yaxis: {title: {text: sensor.unit || 'Value'}},
      }, {responsive: true, displaylogo: false});
      if (stride > 1) message.textContent += ' · Fit preview displays a subset; all samples were fitted.';
    } catch (error) { invalidateFit(); message.textContent = error.message; }
  });
  return {update, dispose() {
    xy.dispose(); histogramVersion++;
    Plotly.purge($('.fit-preview', root));
    if (histogramDialog) { Plotly.purge($('.histogram-plot', histogramDialog)); histogramDialog.remove(); }
  }};
}
