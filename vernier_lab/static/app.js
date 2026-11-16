const $ = (selector, root = document) => root.querySelector(selector);
const esc = value => String(value).replace(/[&<>"']/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
const colors = ['#168878', '#db9260', '#7290bd', '#aa7cb1', '#a9a34c', '#6bb2b9', '#c76e76'];
const points = new Map();
let state = {devices: [], series: [], recording: false, total_points: 0, period_ms: 50};
let generation = '', cursor = 0, busy = false, offline = false, deviceSignature = '', channelSignature = '', revision = 0;
let lastError = '', graphCounter = 0;
let graphs = [];

function saveLayout() {
  try { localStorage.setItem('vernier-layout', JSON.stringify({title: $('#experiment-title').value,
    graphs: graphs.map(({title, selected, auto, follow}) => ({title, selected, auto, follow}))})); } catch { /* Storage can be disabled. */ }
}
function showNotice(message = '') { $('#notice').textContent = message; $('#notice').hidden = !message; }
async function request(path, body) {
  const response = await fetch(`/api/${path}`, body === undefined ? {} : {
    method: 'POST', headers: {'Content-Type': 'application/json'}, body: JSON.stringify(body),
  });
  if (!response.ok) {
    const data = await response.json().catch(() => ({}));
    throw new Error(typeof data.detail === 'string' ? data.detail : `Request failed (${response.status}). Check the selected settings.`);
  }
  return response.json();
}
async function action(path, body = {}) {
  if (busy) return false;
  busy = true; showNotice(); renderControls();
  try {
    const result = await request(path, body);
    applyState(result, false);
    return true;
  } catch (error) {
    showNotice(error.message);
    deviceSignature = '';
    renderDevices();
    $('#period').value = state.period_ms;
    return false;
  } finally {
    busy = false; renderControls(); renderDevices();
  }
}
function availableChannels() {
  const result = new Map(state.series.map(s => [s.id, s]));
  for (const device of state.devices) {
    if (!device.connected) continue;
    for (const sensor of device.sensors) {
      if (!device.selected.includes(sensor.number)) continue;
      const id = `${device.id}/${sensor.number}`;
      result.set(id, {id, device_id: device.id, device: device.name, name: sensor.name, unit: sensor.unit, demo: device.demo});
    }
  }
  return [...result.values()];
}
function graphChannelOptions() {
  const channels = new Map(availableChannels().map(s => [s.id, {...s, canPlot: true}]));
  for (const device of state.devices.filter(d => d.connected)) {
    for (const sensor of device.sensors) {
      const id = `${device.id}/${sensor.number}`;
      if (!channels.has(id)) channels.set(id, {id, device_id: device.id, device: device.name,
        name: sensor.name, unit: sensor.unit, canPlot: false, supported: sensor.supported});
    }
  }
  return [...channels.values()];
}
function colorFor(id) { return colors[Math.max(0, availableChannels().findIndex(s => s.id === id)) % colors.length]; }
function selectedConfiguration() {
  return Object.fromEntries(state.devices.filter(d => d.connected).map(d => [d.id, [...d.selected]]));
}
function applyState(next, withPoints) {
  state = next;
  if (next.generation !== generation) {
    generation = next.generation; cursor = 0; points.clear(); revision++;
    for (const graph of graphs) graph.fit++;
  }
  if (withPoints) {
    for (const point of next.points) {
      if (!points.has(point.series)) points.set(point.series, []);
      points.get(point.series).push(point);
    }
    cursor = next.cursor;
    if (next.points.length) revision++;
  }
  if (next.error && next.error !== lastError) showNotice(next.error);
  lastError = next.error;
  renderControls(); renderDevices();
  const channels = availableChannels();
  const signature = JSON.stringify(graphChannelOptions());
  if (signature !== channelSignature) {
    channelSignature = signature;
    for (const graph of graphs) {
      if (graph.auto) graph.selected = channels.map(s => s.id);
      renderSeriesPicker(graph);
      graph.dirty = true;
    }
  }
  for (const graph of graphs) drawGraph(graph);
  const latest = new Map([...points].map(([id, data]) => [id, data.at(-1)?.value]));
  document.querySelectorAll('[data-reading]').forEach(el => {
    const value = latest.get(el.dataset.reading);
    el.textContent = value == null ? '—' : value.toFixed(2);
  });
}
function renderControls() {
  const connected = state.devices.filter(d => d.connected);
  const channels = connected.reduce((sum, d) => sum + d.selected.length, 0);
  $('#device-count').textContent = connected.length;
  $('#start').disabled = busy || offline || state.recording || !channels;
  $('#stop').disabled = busy || offline || !state.recording;
  $('#reset').disabled = busy || offline || state.recording || !state.total_points;
  for (const id of ['scan', 'demo', 'period']) $(`#${id}`).disabled = busy || offline || state.recording;
  $('#export').disabled = busy || offline || !state.series.some(s => graphs.some(g => g.selected.includes(s.id)));
  $('#elapsed').innerHTML = `${(state.elapsed || 0).toFixed(2)} <small>s</small>`;
  $('#samples').textContent = (state.total_points || 0).toLocaleString();
  $('#channels').textContent = channels;
  $('#sample-rate').textContent = `${(1000 / state.period_ms).toLocaleString(undefined, {maximumFractionDigits: 2})} Hz`;
  if (document.activeElement !== $('#period')) $('#period').value = state.period_ms;
  $('#status').textContent = offline ? 'Server unavailable' : busy ? 'Working…' : state.recording ? 'Recording' : state.total_points ? 'Collection stopped' : channels ? 'Ready to collect' : 'Ready to connect';
  $('#status-dot').classList.toggle('recording', state.recording && !offline);
  $('#demo-banner').hidden = !state.devices.some(d => d.demo && d.connected) && !state.series.some(s => s.demo);
}
function renderDevices() {
  const signature = JSON.stringify([state.devices, state.recording, busy, offline]);
  if (signature === deviceSignature) return;
  deviceSignature = signature;
  $('#device-empty').hidden = state.devices.length > 0;
  $('#devices').innerHTML = state.devices.map(d => {
    const disabled = busy || offline || state.recording ? 'disabled' : '';
    return `<article class="device-card" data-device="${esc(d.id)}">
      <div class="device-head"><span class="device-icon" aria-hidden="true">${d.demo ? '∿' : 'ᛒ'}</span><h3>${esc(d.name)}${d.demo ? '<br><span class="demo-label">SIMULATED DEVICE</span>' : ''}</h3></div>
      <div class="device-meta">${d.demo ? 'Explore with generated measurements' : `${esc(d.id)}${d.rssi != null ? ` · ${d.rssi} dBm` : ''}`}</div>
      <div class="device-actions">${d.connected ? '<span class="connection-label">Connected</span>' : '<span class="small disconnected">Not connected</span>'}<button class="text-button" data-device-action="${d.connected ? 'disconnect' : 'connect'}" ${disabled}>${d.connected ? 'Disconnect' : 'Connect'}</button></div>
      ${d.connected && !d.demo ? `<button class="battery-button" data-device-action="battery" ${disabled} title="Refresh battery while collection is stopped">▰ ${d.battery == null ? 'Battery unavailable' : `${d.battery}%${d.charging ? ' · charging' : ''}`} · refresh</button>` : ''}
      ${d.connected ? `<div class="sensor-list"><div class="sensor-label">CHANNELS TO RECORD</div>${d.sensors.map(s => `<label class="sensor-row" title="${s.supported ? `Sampling interval: ${s.minimum_ms}–${s.maximum_ms} ms` : 'Event-based channel: not supported yet'}"><input type="checkbox" data-sensor="${s.number}" ${d.selected.includes(s.number) ? 'checked' : ''} ${disabled || (!s.supported ? 'disabled' : '')}><span class="sensor-name">${esc(s.name)}</span><span class="sensor-value" data-reading="${esc(`${d.id}/${s.number}`)}">—</span><span class="sensor-unit">${esc(s.unit)}</span></label>`).join('')}</div>` : ''}
    </article>`;
  }).join('');
}
$('#devices').addEventListener('click', event => {
  const button = event.target.closest('[data-device-action]');
  if (button) action(button.dataset.deviceAction, {device_id: button.closest('[data-device]').dataset.device});
});
$('#devices').addEventListener('change', event => {
  const input = event.target.closest('[data-sensor]');
  if (!input) return;
  const selections = selectedConfiguration();
  const id = input.closest('[data-device]').dataset.device;
  const number = Number(input.dataset.sensor);
  selections[id] = input.checked ? [...selections[id], number] : selections[id].filter(n => n !== number);
  action('configure', {selections, period_ms: state.period_ms});
});

function addGraph(saved = {}) {
  const graph = {id: ++graphCounter, title: saved.title || `Graph ${graphCounter}`, selected: saved.selected || [],
    auto: saved.auto ?? true, follow: saved.follow ?? true, fit: 0, dirty: true, lastRevision: -1, drawing: false};
  if (graph.auto) graph.selected = availableChannels().map(s => s.id);
  const node = document.createElement('article'); node.className = 'graph';
  node.innerHTML = `<div class="graph-header"><div class="graph-title"><span class="graph-number">${String(graph.id).padStart(2, '0')}</span><input aria-label="Graph title" value="${esc(graph.title)}" maxlength="50"></div><div class="graph-tools"><label class="follow"><input type="checkbox" ${graph.follow ? 'checked' : ''}> Follow live</label><button class="fit" title="Fit all data">Fit view</button><button class="remove" title="Remove graph" aria-label="Remove graph">×</button></div></div><section class="graph-sensors" aria-label="Sensors to plot"><div class="graph-sensors-heading"><h3>Sensors to plot</h3><span class="selection-count"></span></div><p>Check sensors to overlay on this graph, including sensors from different devices.</p><div class="series-options"></div></section><div class="plot"></div><div class="graph-footer"><div class="legend"></div><span class="plot-note">Time in seconds</span></div>`;
  graph.node = node;
  $('#graphs').append(node); graphs.push(graph);
  graph.resizeObserver = new ResizeObserver(() => {
    const plot = $('.plot', node);
    if (plot._fullLayout) Plotly.Plots.resize(plot).catch(() => {});
  });
  graph.resizeObserver.observe(node);
  $('input[aria-label="Graph title"]', node).addEventListener('change', e => { graph.title = e.target.value; saveLayout(); });
  $('.follow input', node).addEventListener('change', e => { graph.follow = e.target.checked; graph.fit++; graph.dirty = true; drawGraph(graph); saveLayout(); });
  $('.fit', node).addEventListener('click', () => { graph.fit++; graph.dirty = true; drawGraph(graph); });
  $('.remove', node).addEventListener('click', () => {
    if (graphs.length === 1) return showNotice('Keep at least one graph in your workspace.');
    graph.resizeObserver.disconnect();
    Plotly.purge($('.plot', node)); node.remove(); graphs = graphs.filter(g => g !== graph);
    $('#graph-count').textContent = graphs.length; saveLayout(); renderControls();
  });
  $('.series-options', node).addEventListener('change', e => {
    const id = e.target.dataset.series;
    if (!id) return;
    graph.auto = false;
    graph.selected = e.target.checked ? [...graph.selected, id] : graph.selected.filter(s => s !== id);
    updateSelectionCount(graph);
    graph.dirty = true; graph.fit++; drawGraph(graph); renderControls(); saveLayout();
  });
  renderSeriesPicker(graph); drawGraph(graph);
  $('#graph-count').textContent = graphs.length;
  return graph;
}
function renderSeriesPicker(graph) {
  const groups = new Map();
  for (const channel of graphChannelOptions()) {
    if (!groups.has(channel.device_id)) groups.set(channel.device_id, []);
    groups.get(channel.device_id).push(channel);
  }
  $('.series-options', graph.node).innerHTML = groups.size ? [...groups.values()].map(channels =>
    `<fieldset><legend>${esc(channels[0].device)}</legend><div class="device-series">${channels.map(s =>
      `<label class="series-option${s.canPlot ? '' : ' unavailable'}"><input type="checkbox" data-series="${esc(s.id)}" ${graph.selected.includes(s.id) && s.canPlot ? 'checked' : ''} ${s.canPlot ? '' : 'disabled'}><span>${esc(s.name)} <span class="muted">(${esc(s.unit)})</span>${s.canPlot ? '' : `<small>${s.supported === false ? 'Unsupported event channel' : 'Enable recording in Devices'}</small>`}</span></label>`
    ).join('')}</div></fieldset>`).join('') : '<p class="small muted">Connect a device to see its sensors here. Choose channels to record in Devices.</p>';
  updateSelectionCount(graph);
}
function updateSelectionCount(graph) {
  const count = availableChannels().filter(s => graph.selected.includes(s.id)).length;
  $('.selection-count', graph.node).textContent = `${count} selected`;
}
// Min/max bucket reduction keeps extrema visible; CSV always contains every value.
function displayPoints(data) {
  if (data.length <= 4000) return data;
  const result = [data[0]], size = Math.ceil(data.length / 1800);
  for (let i = 1; i < data.length - 1; i += size) {
    const chunk = data.slice(i, i + size);
    let min = chunk[0], max = chunk[0];
    for (const point of chunk) {
      if (point.value < min.value) min = point;
      if (point.value > max.value) max = point;
    }
    result.push(...[min, max].sort((a, b) => a.seq - b.seq));
  }
  result.push(data.at(-1));
  return result;
}
async function drawGraph(graph) {
  if (graph.drawing || (!graph.dirty && graph.lastRevision === revision)) return;
  graph.drawing = true; graph.dirty = false; graph.lastRevision = revision;
  const channels = availableChannels().filter(s => graph.selected.includes(s.id));
  const units = [...new Set(channels.map(s => s.unit))];
  const plot = $('.plot', graph.node);
  const traces = channels.map(s => {
    const data = displayPoints(points.get(s.id) || []), x = [], y = [], runs = [];
    let run;
    for (const point of data) {
      if (run !== undefined && point.run !== run) { x.push(null); y.push(null); runs.push(null); }
      x.push(point.t); y.push(point.value); runs.push(point.run); run = point.run;
    }
    const unitIndex = units.indexOf(s.unit);
    return {x, y, customdata: runs, name: `${s.device} · ${s.name}`, type: 'scatter', mode: 'lines',
      line: {color: colorFor(s.id), width: 2}, yaxis: unitIndex ? `y${unitIndex + 1}` : 'y', connectgaps: false,
      hovertemplate: `${esc(s.name)}: <b>%{y:.4g} ${esc(s.unit)}</b><br>%{x:.4f} s · run %{customdata}<extra>${esc(s.device)}</extra>`};
  });
  const axis = {gridcolor: '#eef2ef', zerolinecolor: '#dce5de', tickfont: {size: 10, color: '#91a197'},
    title: {font: {size: 11, color: '#82988b'}, standoff: 10}, showline: false, automargin: true};
  const layout = {autosize: true, paper_bgcolor: 'white', plot_bgcolor: 'white', font: {family: 'Inter, Segoe UI, sans-serif', color: '#476356'},
    margin: {l: 60, r: Math.max(25, (units.length - 1) * 65), t: 28, b: 48},
    showlegend: false, hovermode: 'x unified', dragmode: 'zoom', uirevision: `${generation}-${graph.fit}`,
    datarevision: revision, hoverlabel: {bgcolor: '#fff', bordercolor: '#dbe8df', font: {size: 11}},
    xaxis: {...axis, title: {...axis.title, text: 'Time (s)'}, autorange: graph.follow ? true : undefined},
    yaxis: {...axis, title: {...axis.title, text: units[0] || 'Value'}},
  };
  units.slice(1).forEach((unit, i) => {
    layout[`yaxis${i + 2}`] = {...axis, title: {...axis.title, text: unit}, overlaying: 'y', side: 'right',
      anchor: 'free', position: 1, shift: i * 60, showgrid: false};
  });
  const hasData = traces.some(t => t.x.length);
  if (!hasData) {
    layout.xaxis.range = [0, 10]; layout.xaxis.autorange = false;
    layout.yaxis.range = [-5, 5];
    layout.annotations = [{xref: 'paper', yref: 'paper', x: .5, y: .56, showarrow: false,
      text: `<b>${channels.length ? 'Your experiment is ready' : 'Choose sensors for this graph'}</b><br><span style="font-size:11px;color:#95a69b">${channels.length ? 'Start collection to see your measurements here.' : 'Use the checklist above to start plotting.'}</span>`,
      font: {size: 15, color: '#728d7c'}, bgcolor: 'rgba(255,255,255,.94)', borderpad: 15}];
  }
  try {
    await Plotly.react(plot, traces, layout, {responsive: true, displaylogo: false, scrollZoom: true,
      modeBarButtonsToRemove: ['select2d', 'lasso2d'], toImageButtonOptions: {filename: graph.title || 'vernier-graph'}});
    if (!graph.listeners) {
      plot.on('plotly_relayout', event => {
        if ('xaxis.range[0]' in event || 'xaxis.range' in event) {
          graph.follow = false; $('.follow input', graph.node).checked = false; saveLayout();
        }
      });
      graph.listeners = true;
    }
    $('.legend', graph.node).innerHTML = channels.length ? channels.map(s => `<span class="legend-item"><i class="swatch" style="background:${colorFor(s.id)}"></i>${esc(s.name)}${channels.filter(c => c.name === s.name).length > 1 ? ` (${esc(s.device)})` : ''} <span class="muted">${esc(s.unit)}</span></span>`).join('') : '<span>No channels selected</span>';
    $('.plot-note', graph.node).textContent = channels.some(s => (points.get(s.id)?.length || 0) > 4000) ? 'Reduced display · export keeps all values' : 'Hover to inspect · time in seconds';
  } catch (error) { showNotice(`Graph could not be drawn: ${error.message}`); }
  finally { graph.drawing = false; }
}

$('#scan').addEventListener('click', async () => {
  $('#scan-note').textContent = 'Searching for nearby Go Direct devices…';
  const success = await action('scan');
  $('#scan-note').textContent = success ? (state.devices.some(d => !d.demo) ? 'Search complete. Choose a device below.' : 'No Go Direct devices found. Wake the sensor and try again.') : 'Search unavailable. Check Bluetooth on this computer.';
});
$('#demo').addEventListener('click', () => action('demo'));
$('#start').addEventListener('click', () => action('start'));
$('#stop').addEventListener('click', () => action('stop'));
$('#period').addEventListener('change', () => action('configure', {selections: selectedConfiguration(), period_ms: Number($('#period').value)}));
$('#reset').addEventListener('click', () => $('#reset-dialog').showModal());
$('#confirm-reset').addEventListener('click', async () => { $('#reset-dialog').close(); await action('reset'); });
$('#help-button').addEventListener('click', () => $('#help-dialog').showModal());
$('[data-close="help-dialog"]').addEventListener('click', () => $('#help-dialog').close());
$('[data-close="reset-dialog"]').addEventListener('click', () => $('#reset-dialog').close());
$('#add-graph').addEventListener('click', () => { addGraph({auto: false}); saveLayout(); renderControls(); });
$('#experiment-title').addEventListener('change', saveLayout);
$('#export').addEventListener('click', async () => {
  const ids = [...new Set(graphs.flatMap(g => g.selected))].filter(id => state.series.some(s => s.id === id));
  if (!ids.length) return showNotice('Choose a recorded series on a graph before exporting.');
  try {
    const query = new URLSearchParams(ids.map(id => ['series', id]));
    const response = await fetch(`/api/export?${query}`);
    if (!response.ok) throw new Error('Export failed. Check the local server and try again.');
    const url = URL.createObjectURL(await response.blob());
    const anchor = document.createElement('a'); anchor.href = url;
    anchor.download = `${$('#experiment-title').value.replace(/[^a-z0-9 _-]/gi, '').trim() || 'experiment'}${state.series.some(s => s.demo) ? '-DEMO' : ''}.csv`;
    anchor.click(); setTimeout(() => URL.revokeObjectURL(url), 1000);
  } catch (error) { showNotice(error.message); }
});
async function poll() {
  if (!busy) {
    try {
      const next = await request(`state?after=${cursor}&generation=${encodeURIComponent(generation)}`);
      if (offline) { offline = false; showNotice('Reconnected to the local server.'); }
      applyState(next, true);
    } catch {
      offline = true; renderControls(); renderDevices();
      showNotice('The local server is unavailable. Keep this page open and restart the app to reconnect.');
    }
  }
  setTimeout(poll, 250);
}
try {
  const saved = JSON.parse(localStorage.getItem('vernier-layout') || 'null');
  if (saved?.title) $('#experiment-title').value = saved.title;
  if (saved?.graphs?.length) saved.graphs.slice(0, 12).forEach(addGraph);
} catch { /* Start a clean layout if local preferences are unavailable. */ }
if (!graphs.length) addGraph();
poll();
