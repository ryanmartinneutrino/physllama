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
    <div class="analysis-tabs">${[['table', 'Data table'], ['stats', 'Statistics'], ['fit', 'Fit']].map(([id, name]) => `<button type="button" class="analysis-toggle" data-panel="${id}" aria-expanded="false" aria-controls="analysis-${graph.id}-${id}">${name} <span aria-hidden="true">⌄</span></button>`).join('')}</div>
    <div class="analysis-panel" id="analysis-${graph.id}-table" data-content="table" hidden><div class="table-controls"><label><input type="checkbox" class="table-visible"> Visible time range only</label><span class="table-count small muted"></span></div><p class="small muted">Full-resolution samples for the selected runs. Times are seconds since the first Start; blanks mean no measurement at that timestamp.</p><div class="data-table"></div><div class="table-pagination"><button class="table-prev button">Previous</button><span class="table-page small"></span><button class="table-next button">Next</button></div></div>
    <div class="analysis-panel" id="analysis-${graph.id}-stats" data-content="stats" hidden><h3>Statistics</h3><p class="small muted">Each sensor uses all finite samples in the visible time interval, including points outside the vertical axis limits. RMS = √mean(y²).</p><div class="stats-table"></div></div>
    <div class="analysis-panel" id="analysis-${graph.id}-fit" data-content="fit" hidden><h3>Fit visible data</h3><form class="fit-form"><div class="fit-controls"><label>Sensor<select class="fit-sensor" aria-label="Fit sensor"></select></label><label>Function<select class="fit-model" aria-label="Fit function">${Object.entries(fitModels).map(([id, m]) => `<option value="${id}">${esc(m.label)}</option>`).join('')}</select></label><label>Y uncertainty (1σ)<input class="fit-sigma" aria-label="Y uncertainty" type="text" inputmode="decimal" placeholder="e.g. 0.1" required autocomplete="off"></label><button class="button primary fit-submit" type="submit">Fit visible data</button></div><p class="fit-unit small muted"></p><p class="small muted">One positive standard deviation for every point. Assumes independent y errors and exact times. Linear and quadratic fits need no initial guesses.</p></form><p class="fit-message small" role="status">Choose a sensor and enter its measurement uncertainty.</p><div class="fit-results" hidden></div><div class="fit-preview" hidden></div></div>`;
  graph.node.append(root);
  const scope = $('.data-scope', root); scope.value = graph.scope;
  let context, signature = '', sensorSignature = '', page = 0, rows = [], fitShown = false;
  let histogramDialog = null, histogramSensor = null, histogramOptions = null, fitInput = null;
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
    $('.stats-table', root).innerHTML = context.channels.length ? table(['Sensor', 'N', 'Min', 'Max', 'Mean', 'RMS', 'Distribution'], context.channels.map(s => {
      const stats = statistics(visible(s));
      return `<tr>${[label(s), stats.n, ...['min', 'max', 'mean', 'rms'].map(k => number(stats[k]))].map(v => `<td>${esc(v)}</td>`).join('')}<td><button class="button histogram-button" data-sensor="${esc(s.id)}" aria-label="Histogram for ${esc(label(s))}" ${stats.n ? '' : 'disabled'}>Histogram</button></td></tr>`;
    })) : '<p class="muted">Select sensors on the graph to see statistics.</p>';
  }
  async function renderHistogram(options = histogramOptions) {
    if (!histogramDialog?.open) return;
    const sensor = context.channels.find(s => s.id === histogramSensor);
    if (!sensor || context.recording) { histogramDialog.close(); return; }
    const errorMessage = $('.histogram-error', histogramDialog);
    try {
      const samples = visible(sensor), bins = histogram(samples, options || {});
      histogramOptions = {min: bins.min, max: bins.max, bins: bins.counts.length};
      if (!options) {
        for (const [key, value] of Object.entries(histogramOptions)) $(`[name="${key}"]`, histogramDialog).value = String(value);
      }
      const included = bins.counts.reduce((sum, count) => sum + count, 0);
      errorMessage.textContent = '';
      $('h2', histogramDialog).textContent = `${sensor.name} histogram`;
      $('.histogram-note', histogramDialog).textContent = `${label(sensor)} · ${samples.length} samples · ${included} in histogram · ${samples.length - included} outside value range · ${bins.counts.length} equal-width bins · ${rangeText()}`;
      await Plotly.react($('.histogram-plot', histogramDialog), [{type: 'bar', x: bins.centers, y: bins.counts, width: bins.width,
        marker: {color: sensor.color}, customdata: bins.centers.map(x => [x - bins.width / 2, x + bins.width / 2]),
        hovertemplate: 'Range: %{customdata[0]:.5g}–%{customdata[1]:.5g}<br>Count: %{y}<extra></extra>'}], {
        margin: {t: 20, b: 60, l: 60, r: 20}, xaxis: {title: {text: sensor.unit || 'Value'}, range: [bins.min, bins.max]}, yaxis: {title: {text: 'Count'}, rangemode: 'tozero', dtick: included < 10 ? 1 : undefined},
        annotations: included ? [] : [{text: samples.length ? 'No samples in this value range' : 'No samples in the visible interval', showarrow: false, xref: 'paper', yref: 'paper', x: .5, y: .5}],
      }, {responsive: true, displaylogo: false});
    } catch (error) { errorMessage.textContent = error.message; }
  }
  function rangeText() {
    return context.range ? `${number(Math.min(...context.range))}–${number(Math.max(...context.range))} s` : 'Full time range';
  }
  function update() {
    context = getContext();
    scope.disabled = context.recording;
    const key = JSON.stringify([context.revision, context.generation, context.recording, context.run, graph.scope, context.range, context.channels.map(s => [s.id, s.name, s.device, s.unit])]);
    if (signature === key) return;
    signature = key;
    if (fitInput) {
      const sensor = context.channels.find(s => s.id === fitInput.sensorId);
      const samples = sensor ? visible(sensor) : [];
      // Autorange padding can change on resize without changing the fitted data.
      if (fitInput.key !== dataKey() || samples.length !== fitInput.samples.length || samples.some((p, i) => p !== fitInput.samples[i])) invalidateFit();
    }
    $('.analysis-status', root).textContent = context.recording ? 'Stop collection to analyze data.' : `${graph.scope === 'current' ? `Run ${context.run || '—'}` : 'All runs'} · Analysis interval: ${rangeText()}`;
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
    if (open && button.dataset.panel === 'fit' && fitShown) Plotly.Plots.resize($('.fit-preview', root)).catch(() => {});
  });
  $('.table-visible', root).addEventListener('change', () => { page = 0; renderTable(); });
  $('.table-prev', root).addEventListener('click', () => { page--; renderPage(); });
  $('.table-next', root).addEventListener('click', () => { page++; renderPage(); });
  $('.stats-table', root).addEventListener('click', event => {
    const button = event.target.closest('[data-sensor]');
    if (!button) return;
    histogramSensor = button.dataset.sensor;
    histogramOptions = null;
    if (!histogramDialog) {
      histogramDialog = document.createElement('dialog'); histogramDialog.className = 'histogram-dialog';
      histogramDialog.setAttribute('aria-labelledby', `histogram-title-${graph.id}`);
      histogramDialog.innerHTML = `<h2 id="histogram-title-${graph.id}"></h2><p class="histogram-note small muted"></p><form class="histogram-controls" novalidate><label>Minimum value<input name="min" type="text" inputmode="decimal" required></label><label>Maximum value<input name="max" type="text" inputmode="decimal" required></label><label>Number of bins<input name="bins" type="text" inputmode="numeric" required></label><button class="button primary" type="submit">Redraw</button></form><p class="small muted">Range limits use the sensor’s units and include both endpoints. Values outside the range are excluded. Choose 1–${MAX_HISTOGRAM_BINS} bins.</p><p class="histogram-error small" role="alert"></p><div class="histogram-plot"></div><div class="dialog-actions"><button class="button histogram-close">Close histogram</button></div>`;
      document.body.append(histogramDialog);
      $('.histogram-close', histogramDialog).addEventListener('click', () => histogramDialog.close());
      $('.histogram-controls', histogramDialog).addEventListener('submit', event => {
        event.preventDefault();
        const options = Object.fromEntries(['min', 'max', 'bins'].map(key => {
          const value = $(`[name="${key}"]`, histogramDialog).value.trim();
          return [key, value ? Number(value) : NaN];
        }));
        renderHistogram(options);
      });
      histogramDialog.addEventListener('close', () => Plotly.purge($('.histogram-plot', histogramDialog)));
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
    Plotly.purge($('.fit-preview', root));
    if (histogramDialog) { Plotly.purge($('.histogram-plot', histogramDialog)); histogramDialog.remove(); }
  }};
}
