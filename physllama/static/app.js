const $ = (selector, root = document) => root.querySelector(selector);
const esc = value => String(value).replace(/[&<>"']/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
const colors = ['#1e5480', '#db9260', '#7290bd', '#aa7cb1', '#a9a34c', '#6596bf', '#c76e76'];
const points = new Map();
let state = {devices: [], series: [], recording: false, total_points: 0, period_ms: 50};
let generation = '', cursor = 0, busy = false, offline = false, deviceSignature = '', channelSignature = '', revision = 0;
let lastError = '', graphCounter = 0, quitting = false;
let graphs = [];
let multiMode = false, layoutKey = 'physllama-layout';
let connection = {status: 'idle'};
let lastConnectionError = '';
const connecting = () => ['connecting', 'retrying'].includes(connection.status);
function renderConnection() {
  $('#connection-progress').hidden = !connecting();
  $('#connection-progress').textContent = connection.message || '';
  renderControls(); renderDevices();
}

function saveLayout() {
  try { localStorage.setItem(layoutKey, JSON.stringify({title: $('#experiment-title').value,
    graphs: graphs.map(({title, customTitle, selected, follow}) => ({title, customTitle, selected, follow}))})); } catch { /* Storage can be disabled. */ }
}
function showNotice(message = '') { $('#notice').textContent = message; $('#notice').hidden = !message; }
async function request(path, body) {
  const response = await fetch(`/api/${path}`, body === undefined ? {} : {
    method: 'POST', headers: {'Content-Type': 'application/json'}, body: JSON.stringify(body),
  });
  if (!response.ok) {
    if (response.status === 401 && multiMode) {
      quitting = true;
      window.location.reload();
    }
    const data = await response.json().catch(() => ({}));
    throw new Error(typeof data.detail === 'string' ? data.detail : `Request failed (${response.status}). Check the selected settings.`);
  }
  return response.json();
}
async function action(path, body = {}) {
  if (busy || connecting()) return false;
  busy = true; showNotice();
  if (path === 'connect') {
    connection = {status: 'connecting', device_id: body.device_id, message: 'Starting Bluetooth connection…'};
    renderConnection();
  }
  renderControls();
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
    busy = false;
    if (path === 'connect') { connection = {status: 'idle'}; renderConnection(); }
    renderControls(); renderDevices();
  }
}
function availableChannels() {
  const result = new Map(state.series.map(s => [s.id, s]));
  for (const device of state.devices) {
    if (!device.connected) continue;
    for (const sensor of device.sensors) {
      const id = `${device.id}/${sensor.number}`;
      result.set(id, {id, device_id: device.id, device: device.name, name: sensor.name, unit: sensor.unit,
        demo: device.demo, supported: sensor.supported, active: state.recording && device.selected.includes(sensor.number)});
    }
  }
  return [...result.values()];
}
function graphChannelOptions() {
  return availableChannels().map(s => ({...s, canPlot: s.supported !== false &&
    (!state.recording || s.active || state.series.some(recorded => recorded.id === s.id))}));
}
function colorFor(id) { return colors[Math.max(0, availableChannels().findIndex(s => s.id === id)) % colors.length]; }
function selectedConfiguration() {
  const selected = new Set(graphs.flatMap(graph => graph.selected));
  return Object.fromEntries(state.devices.filter(d => d.connected).map(d => [d.id,
    d.sensors.filter(s => s.supported && selected.has(`${d.id}/${s.number}`)).map(s => s.number)]));
}
function applyState(next, withPoints) {
  state = next;
  if (next.experiment_name && document.activeElement !== $('#experiment-title')) {
    $('#experiment-title').value = next.experiment_name;
  }
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
  const signature = JSON.stringify(graphChannelOptions());
  if (signature !== channelSignature) {
    channelSignature = signature;
    for (const graph of graphs) {
      renderSeriesPicker(graph);
      graph.dirty = true;
    }
  }
  for (const graph of graphs) drawGraph(graph);
}
function renderControls() {
  const connected = state.devices.filter(d => d.connected);
  const channels = state.recording ? connected.reduce((sum, d) => sum + d.selected.length, 0)
    : Object.values(selectedConfiguration()).reduce((sum, numbers) => sum + numbers.length, 0);
  $('#device-count').textContent = connected.length;
  $('#start').disabled = busy || connecting() || offline || state.recording || !channels;
  $('#stop').disabled = busy || connecting() || offline || !state.recording;
  $('#reset').disabled = busy || connecting() || offline || state.recording || !state.total_points;
  for (const id of ['scan', 'demo', 'period']) $(`#${id}`).disabled = busy || connecting() || offline || state.recording;
  $('#save-device-name').disabled = busy || connecting() || offline || state.recording;
  $('#export').disabled = busy || connecting() || offline || !state.series.length;
  $('#end-group-button').disabled = busy || connecting() || offline;
  const options = new Map(graphChannelOptions().map(s => [s.id, s]));
  for (const graph of graphs) {
    $('.graph-export', graph.node).disabled = busy || connecting() || offline || !state.series.some(s => graph.selected.includes(s.id));
    for (const checkbox of graph.node.querySelectorAll('[data-series]')) {
      checkbox.disabled = busy || connecting() || offline || !options.get(checkbox.dataset.series)?.canPlot;
    }
  }
  $('#elapsed').innerHTML = `${(state.elapsed || 0).toFixed(2)} <small>s</small>`;
  $('#samples').textContent = (state.total_points || 0).toLocaleString();
  $('#channels').textContent = channels;
  $('#sample-rate').textContent = `${(1000 / state.period_ms).toLocaleString(undefined, {maximumFractionDigits: 2})} Hz`;
  if (document.activeElement !== $('#period')) $('#period').value = state.period_ms;
  $('#status').textContent = offline ? 'Server unavailable' : connecting() ? 'Connecting…' : busy ? 'Working…' : state.recording ? 'Recording' : state.total_points ? 'Collection stopped' : channels ? 'Ready to collect' : connected.length ? 'Choose sensors in a graph' : 'Ready to connect';
  $('#status-dot').classList.toggle('recording', state.recording && !offline);
  $('#acquisition-llama').classList.toggle('running', state.recording && !offline);
  $('#supported-devices').textContent = `Supported: ${(state.supported_devices || []).map(d => d.label).join(', ') || 'checking…'}`;
  $('#demo-banner').hidden = !state.devices.some(d => d.demo && d.connected) && !state.series.some(s => s.demo);
}
function renderDevices() {
  const signature = JSON.stringify([state.devices, state.recording, busy, offline, connection]);
  if (signature === deviceSignature) return;
  deviceSignature = signature;
  $('#device-empty').hidden = state.devices.length > 0;
  $('#devices').innerHTML = state.devices.map(d => {
    const inProgress = connecting() && connection.device_id === d.id;
    const disabled = busy || connecting() || offline || state.recording ? 'disabled' : '';
    const reservedElsewhere = d.owned === false && Boolean(d.reserved_by);
    return `<article class="device-card" data-device="${esc(d.id)}">
      <div class="device-head"><span class="device-icon" aria-hidden="true">${d.demo ? '∿' : 'ᛒ'}</span><h3>${esc(d.name)}${d.demo ? '<br><span class="demo-label">SIMULATED DEVICE</span>' : ''}</h3></div>
      <div class="device-meta">${esc(d.family || 'Bluetooth')}
        <div class="hardware-name">Advertised name: ${esc(d.hardware_name || d.name)}</div>
        ${d.serial ? `<div class="device-serial">Device ID: <strong>${esc(d.serial)}</strong></div>` : ''}
        <div class="device-address">${d.demo ? 'Demo ID' : 'Bluetooth ID'}: <span>${esc(d.id)}</span></div>
        ${d.rssi != null ? `<div>Signal: ${d.rssi} dBm</div>` : ''}
      </div>
      ${d.reserved_by ? `<p class="reservation-label">${reservedElsewhere ? `In use by ${esc(d.reserved_by)}` : 'Reserved for your group'}</p>` : ''}
      <div class="device-actions">${d.connected ? '<span class="connection-label">Connected</span>' : '<span class="small disconnected">Not connected</span>'}<button class="text-button" data-device-action="${d.connected ? 'disconnect' : 'connect'}" ${disabled || (reservedElsewhere ? 'disabled' : '')}>${inProgress ? (connection.status === 'retrying' ? 'Retrying…' : 'Connecting…') : d.connected ? 'Disconnect' : reservedElsewhere ? 'In use' : 'Connect'}</button></div>
      ${d.owned && !d.connected ? `<button class="text-button" data-device-action="disconnect" ${disabled}>Release device</button>` : ''}
      <button class="text-button rename-device" data-device-action="rename" ${disabled || (d.owned === false ? 'disabled' : '')}>Rename device</button>
      ${d.connected && !d.demo ? `<button class="battery-button" data-device-action="battery" ${disabled} title="Refresh battery while collection is stopped">▰ ${d.battery == null ? 'Battery unavailable' : `${d.battery}%${d.charging ? ' · charging' : ''}`} · refresh</button>` : ''}
      ${d.connected ? `<p class="small muted">${d.sensors.filter(s => s.supported).length} sensor channels · choose what to record in a graph’s Sensors dropdown.</p>` : ''}
      ${d.connected && d.acquisition_note ? `<p class="device-warning">${esc(d.acquisition_note)}</p>` : ''}
    </article>`;
  }).join('');
}
$('#devices').addEventListener('click', event => {
  const button = event.target.closest('[data-device-action]');
  if (!button) return;
  const id = button.closest('[data-device]').dataset.device;
  if (button.dataset.deviceAction === 'rename') {
    const device = state.devices.find(d => d.id === id);
    $('#rename-dialog').dataset.deviceId = id;
    $('#device-name').value = device.nickname || '';
    $('#rename-identity').textContent = `${device.hardware_name || device.name}${device.serial ? ` · Device ID: ${device.serial}` : ''} · Bluetooth ID: ${id}`;
    $('#rename-error').textContent = '';
    $('#rename-dialog').showModal();
    $('#device-name').focus();
  } else action(button.dataset.deviceAction, {device_id: id});
});
$('#rename-form').addEventListener('submit', async event => {
  event.preventDefault();
  const success = await action('rename', {device_id: $('#rename-dialog').dataset.deviceId, name: $('#device-name').value.trim()});
  if (success) $('#rename-dialog').close();
  else $('#rename-error').textContent = $('#notice').textContent || 'Stop collection before renaming a device.';
});
$('[data-close="rename-dialog"]').addEventListener('click', () => $('#rename-dialog').close());

function addGraph(saved = {}) {
  const customTitle = saved.customTitle ?? Boolean(saved.title && !/^Graph \d+$/.test(saved.title));
  const graph = {id: ++graphCounter, title: customTitle ? saved.title : `Graph ${graphs.length + 1}`, customTitle, selected: saved.selected || [],
    follow: saved.follow ?? true, fit: 0, dirty: true, lastRevision: -1, drawing: false};
  const node = document.createElement('article'); node.className = 'graph';
  node.innerHTML = `<div class="graph-header"><div class="graph-title"><input aria-label="Graph title" value="${esc(graph.title)}" maxlength="50"></div><div class="graph-tools"><label class="follow"><input type="checkbox" ${graph.follow ? 'checked' : ''}> Follow live</label><details class="graph-sensors"><summary>Sensors <span class="selection-count"></span><span aria-hidden="true">⌄</span></summary><div class="sensor-dropdown"><h3>Sensors to plot</h3><p>Check sensors from one or more devices to overlay on this graph.</p><div class="series-options"></div></div></details><button class="graph-export" title="Download all data for this graph, regardless of zoom" disabled>Download CSV</button><button class="fit" title="Fit all data">Fit view</button><button class="remove" title="Remove graph" aria-label="Remove graph">×</button></div></div><div class="plot"></div><div class="graph-footer"><div class="legend"></div><span class="plot-note">Time in seconds</span></div>`;
  graph.node = node;
  $('#graphs').append(node); graphs.push(graph);
  graph.resizeObserver = new ResizeObserver(() => {
    const plot = $('.plot', node);
    if (plot._fullLayout) Plotly.Plots.resize(plot).catch(() => {});
  });
  graph.resizeObserver.observe(node);
  $('input[aria-label="Graph title"]', node).addEventListener('change', e => {
    graph.customTitle = Boolean(e.target.value.trim());
    graph.title = e.target.value.trim();
    renumberGraphs(); saveLayout();
  });
  $('.graph-export', node).addEventListener('click', () => downloadCSV(graph.selected, graph.title));
  $('.graph-sensors', node).addEventListener('toggle', event => {
    if (event.target.open) for (const other of graphs) {
      if (other !== graph) $('.graph-sensors', other.node).open = false;
    }
  });
  $('.follow input', node).addEventListener('change', e => { graph.follow = e.target.checked; graph.fit++; graph.dirty = true; drawGraph(graph); saveLayout(); });
  $('.fit', node).addEventListener('click', () => { graph.fit++; graph.dirty = true; drawGraph(graph); });
  $('.remove', node).addEventListener('click', () => {
    if (graphs.length === 1) return showNotice('Keep at least one graph in your workspace.');
    graph.resizeObserver.disconnect();
    Plotly.purge($('.plot', node)); node.remove(); graphs = graphs.filter(g => g !== graph);
    renumberGraphs(); saveLayout(); renderControls();
  });
  $('.series-options', node).addEventListener('change', e => {
    const id = e.target.dataset.series;
    if (!id) return;
    graph.selected = e.target.checked ? [...graph.selected, id] : graph.selected.filter(s => s !== id);
    updateSelectionCount(graph);
    graph.dirty = true; graph.fit++; drawGraph(graph); renderControls(); saveLayout();
  });
  renderSeriesPicker(graph); drawGraph(graph);
  $('#graph-count').textContent = graphs.length;
  return graph;
}
function renumberGraphs() {
  graphs.forEach((graph, index) => {
    if (!graph.customTitle) graph.title = `Graph ${index + 1}`;
    $('input[aria-label="Graph title"]', graph.node).value = graph.title;
  });
  $('#graph-count').textContent = graphs.length;
}
document.addEventListener('click', event => {
  for (const graph of graphs) {
    const picker = $('.graph-sensors', graph.node);
    if (!picker.contains(event.target)) picker.open = false;
  }
});
document.addEventListener('keydown', event => {
  if (event.key !== 'Escape') return;
  for (const graph of graphs) {
    const picker = $('.graph-sensors', graph.node);
    if (picker.open) { picker.open = false; $('summary', picker).focus(); }
  }
});
function renderSeriesPicker(graph) {
  const groups = new Map();
  for (const channel of graphChannelOptions()) {
    if (!groups.has(channel.device_id)) groups.set(channel.device_id, []);
    groups.get(channel.device_id).push(channel);
  }
  $('.series-options', graph.node).innerHTML = groups.size ? [...groups.values()].map(channels =>
    `<fieldset><legend>${esc(channels[0].device)}</legend><p class="picker-device-id">Device: ${esc(state.devices.find(d => d.id === channels[0].device_id)?.serial || channels[0].device_id)}</p><div class="device-series">${channels.map(s =>
      `<label class="series-option${s.canPlot ? '' : ' unavailable'}"><input type="checkbox" data-series="${esc(s.id)}" ${graph.selected.includes(s.id) ? 'checked' : ''} ${s.canPlot && !busy && !offline ? '' : 'disabled'}><span>${esc(s.name)} <span class="muted">(${esc(s.unit)})</span>${s.canPlot ? '' : `<small>${s.supported === false ? 'Unsupported event channel' : 'Stop collection to add this sensor'}</small>`}</span></label>`
    ).join('')}</div></fieldset>`).join('') : '<p class="small muted">Connect a device to choose sensors for this graph.</p>';
  $('.sensor-dropdown > p', graph.node).textContent = state.recording
    ? 'Show or hide recorded data here. Stop collection before adding new sensors to record.'
    : 'Checked sensors across all graphs will be recorded when you start. Each sensor is recorded once.';
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
  const axis = {gridcolor: '#eef0f2', zerolinecolor: '#dbe1e6', tickfont: {size: 10, color: '#909aa2'},
    title: {font: {size: 11, color: '#808e9a'}, standoff: 10}, showline: false, automargin: true};
  const layout = {autosize: true, paper_bgcolor: 'white', plot_bgcolor: 'white', font: {family: 'Inter, Segoe UI, sans-serif', color: '#455765'},
    margin: {l: 60, r: Math.max(25, (units.length - 1) * 65), t: 28, b: 48},
    showlegend: false, hovermode: 'x unified', dragmode: 'zoom', uirevision: `${generation}-${graph.fit}`,
    datarevision: revision, hoverlabel: {bgcolor: '#fff', bordercolor: '#dae2e9', font: {size: 11}},
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
      text: `<b>${channels.length ? 'Your experiment is ready' : 'Choose sensors for this graph'}</b><br><span style="font-size:11px;color:#949ea7">${channels.length ? 'Start collection to see your measurements here.' : 'Open the Sensors dropdown to start plotting.'}</span>`,
      font: {size: 15, color: '#70818f'}, bgcolor: 'rgba(255,255,255,.94)', borderpad: 15}];
  }
  try {
    await Plotly.react(plot, traces, layout, {responsive: true, displaylogo: false, scrollZoom: true,
      modeBarButtonsToRemove: ['select2d', 'lasso2d'], toImageButtonOptions: {filename: graph.title || 'physllama-graph'}});
    if (!graph.listeners) {
      plot.on('plotly_relayout', event => {
        if ('xaxis.range[0]' in event || 'xaxis.range' in event) {
          graph.follow = false; $('.follow input', graph.node).checked = false; saveLayout();
        }
      });
      graph.listeners = true;
    }
    $('.legend', graph.node).innerHTML = channels.length ? channels.map(s => `<span class="legend-item"><i class="swatch" style="background:${colorFor(s.id)}"></i>${esc(s.name)}${channels.filter(c => c.name === s.name).length > 1 ? ` (${esc(s.device)})` : ''} <span class="muted">${esc(s.unit)}</span></span>`).join('') : '<span>No channels selected</span>';
    $('.plot-note', graph.node).textContent = channels.some(s => (points.get(s.id)?.length || 0) > 4000) ? 'Reduced display · CSV uses full-resolution data' : 'Hover to inspect · time in seconds';
  } catch (error) { showNotice(`Graph could not be drawn: ${error.message}`); }
  finally { graph.drawing = false; }
}

$('#scan').addEventListener('click', async () => {
  $('#scan-note').textContent = 'Searching for supported Bluetooth devices…';
  const success = await action('scan');
  $('#scan-note').textContent = success ? (state.devices.some(d => !d.demo) ? 'Search complete. Choose a device below.' : 'No supported devices found. Wake your device and try again.') : `Search unavailable. Check Bluetooth on ${multiMode ? 'the instructor’s' : 'this'} computer.`;
});
$('#demo').addEventListener('click', () => action('demo'));
$('#start').addEventListener('click', () => action('start', {selections: selectedConfiguration(), period_ms: state.period_ms}));
$('#stop').addEventListener('click', () => action('stop'));
$('#period').addEventListener('change', () => action('configure', {selections: selectedConfiguration(), period_ms: Number($('#period').value)}));
$('#reset').addEventListener('click', () => $('#reset-dialog').showModal());
$('#confirm-reset').addEventListener('click', async () => { $('#reset-dialog').close(); await action('reset'); });
$('#help-button').addEventListener('click', () => $('#help-dialog').showModal());
$('[data-close="help-dialog"]').addEventListener('click', () => $('#help-dialog').close());
$('[data-close="reset-dialog"]').addEventListener('click', () => $('#reset-dialog').close());
$('#add-graph').addEventListener('click', () => { addGraph(); saveLayout(); renderControls(); });
$('#experiment-title').addEventListener('change', async event => {
  event.target.value = event.target.value.trim() || 'Untitled experiment';
  if (await action('experiment', {name: event.target.value})) saveLayout();
});
async function downloadCSV(selected, title) {
  const ids = selected === null ? state.series.map(s => s.id)
    : [...new Set(selected)].filter(id => state.series.some(s => s.id === id));
  if (!ids.length) return showNotice('Choose a recorded series on a graph before exporting.');
  try {
    const query = new URLSearchParams(ids.map(id => ['series', id]));
    const response = await fetch(selected === null ? '/api/export' : `/api/export?${query}`);
    if (!response.ok) throw new Error('Export failed. Check the local server and try again.');
    const url = URL.createObjectURL(await response.blob());
    const anchor = document.createElement('a'); anchor.href = url;
    anchor.download = `${title.replace(/[^a-z0-9 _-]/gi, '').trim() || 'experiment'}${state.series.some(s => ids.includes(s.id) && s.demo) ? '-DEMO' : ''}.csv`;
    anchor.click(); setTimeout(() => URL.revokeObjectURL(url), 1000);
  } catch (error) { showNotice(error.message); }
}
$('#export').addEventListener('click', () => downloadCSV(null, $('#experiment-title').value));
async function poll() {
  if (quitting) return;
  try {
    // This endpoint stays responsive while Bluetooth owns the worker thread.
    const progress = await request('connection-status');
    if (quitting) return;
    connection = progress;
    if (connecting()) lastConnectionError = '';
    if (progress.status === 'failed' && progress.message && progress.message !== lastConnectionError) {
      showNotice(progress.message);
      lastConnectionError = progress.message;
    }
    renderConnection();
    if (!busy && !connecting()) {
      const next = await request(`state?after=${cursor}&generation=${encodeURIComponent(generation)}`);
      if (quitting) return;
      if (offline) { offline = false; showNotice('Reconnected to the local server.'); }
      applyState(next, true);
    }
  } catch {
    if (quitting) return;
    offline = true; renderControls(); renderDevices();
    showNotice('The local server is unavailable. Keep this page open and restart the app to reconnect.');
  }
  setTimeout(poll, connecting() ? 500 : 250);
}
async function openWorkspace() {
  try {
    const session = await request('session');
    multiMode = session.multi;
    $('#session-loading').hidden = true;
    if (multiMode) {
      $('.local-indicator').textContent = 'Instructor Bluetooth';
      if (!session.group) {
        $('#classroom-lobby').hidden = false;
        return;
      }
      layoutKey = `physllama-layout:${session.group.id}`;
      $('#group-banner').hidden = false;
      $('#current-group-name').textContent = session.group.name;
      $('#current-group-code').textContent = session.group.join_code;
      $('#rename-scope').textContent = 'Leave blank to restore the advertised name. Nicknames belong to your group for this session; hardware IDs stay visible to everyone.';
      $('.privacy-note').textContent = 'Your group’s measurements stay on the instructor’s computer. Export before ending your session.';
      $('#sharing-note').textContent = 'Only teammates with your group code share your controls and measurements. Other groups work independently.';
    }
    $('#workspace').hidden = false;
    try {
      const saved = JSON.parse(localStorage.getItem(layoutKey) || (!multiMode && localStorage.getItem('vernier-layout')) || 'null');
      if (saved?.title) $('#experiment-title').value = saved.title;
      if (saved?.graphs?.length) saved.graphs.slice(0, 12).forEach(addGraph);
    } catch { /* Start a clean layout if local preferences are unavailable. */ }
    if (!graphs.length) addGraph();
    request('app').then(info => { $('#quit-button').hidden = !info.desktop; }).catch(() => {});
    poll();
  } catch {
    $('#session-loading').textContent = 'The server is unavailable. Retrying…';
    setTimeout(openWorkspace, 2000);
  }
}

async function enterGroup(path, body) {
  const buttons = document.querySelectorAll('.group-form button');
  for (const button of buttons) button.disabled = true;
  $('#lobby-error').hidden = true;
  try {
    await request(path, body);
    window.location.reload();
  } catch (error) {
    $('#lobby-error').textContent = error.message;
    $('#lobby-error').hidden = false;
    for (const button of buttons) button.disabled = false;
  }
}
$('#create-group-form').addEventListener('submit', event => {
  event.preventDefault();
  enterGroup('groups', {name: $('#group-name').value.trim()});
});
$('#join-group-form').addEventListener('submit', event => {
  event.preventDefault();
  enterGroup('groups/join', {code: $('#group-code').value.trim()});
});
$('#end-group-button').addEventListener('click', () => {
  $('#end-group-error').textContent = '';
  $('#end-group-dialog').showModal();
});
$('[data-close="end-group-dialog"]').addEventListener('click', () => $('#end-group-dialog').close());
$('#confirm-end-group').addEventListener('click', async () => {
  $('#confirm-end-group').disabled = true;
  quitting = true;
  try {
    await request('groups/end', {});
    window.location.reload();
  } catch (error) {
    quitting = false;
    $('#confirm-end-group').disabled = false;
    $('#end-group-error').textContent = error.message;
    poll();
  }
});
$('#quit-button').addEventListener('click', () => $('#quit-dialog').showModal());
$('[data-close="quit-dialog"]').addEventListener('click', () => $('#quit-dialog').close());
$('#confirm-quit').addEventListener('click', async () => {
  $('#quit-dialog').close();
  quitting = true;
  try {
    await request('quit', {});
    offline = true; renderControls(); renderDevices();
    $('#status').textContent = 'App closed';
    $('#quit-button').disabled = true;
    showNotice('PhysLlama has closed. You can close this tab.');
  } catch (error) { quitting = false; showNotice(error.message); poll(); }
});
openWorkspace();
