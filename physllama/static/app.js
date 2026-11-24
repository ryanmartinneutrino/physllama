import {attachAnalysis} from './analysis-ui.js';

const $ = (selector, root = document) => root.querySelector(selector);
const esc = value => String(value).replace(/[&<>"']/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
const colors = ['#1e5480', '#db9260', '#7290bd', '#aa7cb1', '#a9a34c', '#6596bf', '#c76e76'];
const points = new Map();
// Latest-run timing per series: {run, first, last, n}. Used to report achieved rates.
const runStats = new Map();
// First sample time of each run, for marking run starts on graphs.
const runStarts = new Map();
let state = {devices: [], series: [], recording: false, total_points: 0};
let generation = '', cursor = 0, busy = false, offline = false, deviceSignature = '', channelSignature = '', revision = 0;
let lastError = '', graphCounter = 0, quitting = false;
let graphs = [];
let multiMode = false, layoutKey = 'physllama-layout', sidebarCollapsed = false;
let connection = {status: 'idle'};
let lastConnectionError = '';
const connecting = () => ['connecting', 'retrying'].includes(connection.status);
function renderConnection() {
  $('#connection-progress').hidden = !connecting();
  $('#connection-progress').textContent = connection.message || '';
  renderControls(); renderDevices();
}

function saveLayout() {
  try { localStorage.setItem(layoutKey, JSON.stringify({title: $('#experiment-title').value, sidebarCollapsed,
    graphs: graphs.map(({title, customTitle, selected, follow, scope}) => ({title, customTitle, selected, follow, scope}))})); } catch { /* Storage can be disabled. */ }
}
function setSidebarCollapsed(collapsed) {
  sidebarCollapsed = collapsed;
  $('#workspace').classList.toggle('sidebar-collapsed', collapsed);
  $('#device-sidebar').hidden = collapsed;
  $('#show-devices').hidden = !collapsed;
  for (const id of ['hide-devices', 'show-devices']) $(`#${id}`).setAttribute('aria-expanded', String(!collapsed));
}
$('#hide-devices').addEventListener('click', () => {
  setSidebarCollapsed(true); $('#show-devices').focus(); saveLayout();
});
$('#show-devices').addEventListener('click', () => {
  setSidebarCollapsed(false); $('#hide-devices').focus(); saveLayout();
});
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
    return false;
  } finally {
    busy = false;
    if (path === 'connect') { connection = {status: 'idle'}; renderConnection(); }
    renderControls(); renderDevices();
  }
}
function availableChannels() {
  const result = new Map();
  for (const device of state.devices) {
    if (!device.connected) continue;
    for (const sensor of device.sensors) {
      const id = `${device.id}/${sensor.number}`;
      result.set(id, {id, device_id: device.id, device: device.name, name: sensor.name, unit: sensor.unit,
        demo: device.demo, supported: sensor.supported, active: state.recording && device.selected.includes(sensor.number)});
    }
  }
  // Devices from an opened experiment file keep their channels (and recorded
  // data) on graphs until they reconnect with the same IDs.
  for (const saved of state.saved_devices || []) {
    for (const sensor of saved.sensors) {
      const id = `${saved.id}/${sensor.number}`;
      if (!result.has(id)) result.set(id, {id, device_id: saved.id, device: saved.name, name: sensor.name, unit: sensor.unit,
        demo: saved.demo, supported: sensor.supported, active: false, saved: true});
    }
  }
  return [...result.values()];
}
function graphChannelOptions() {
  return availableChannels().map(s => ({...s, canPlot: s.supported !== false &&
    (!state.recording || s.active || state.series.some(recorded => recorded.id === s.id))}));
}
function colorFor(id) { return colors[Math.max(0, availableChannels().findIndex(s => s.id === id)) % colors.length]; }
// Whether a channel can be sampled at this interval (range and granularity).
function acceptsInterval(sensor, period) {
  if (!(period >= sensor.minimum_ms && period <= sensor.maximum_ms)) return false;
  const step = sensor.step_ms;
  return !(step > 0) || Math.abs(period / step - Math.round(period / step)) < 1e-5;
}
const plottedIds = () => new Set(graphs.flatMap(graph => graph.selected));
function recordingConfiguration(periods = {}) {
  const plotted = plottedIds();
  return Object.fromEntries(state.devices.filter(d => d.connected).map(device => {
    const sensors = device.sensors.filter(s => s.supported);
    const period = periods[device.id] ?? device.period_ms;
    // All channels on a device share its interval. Plotted channels are always
    // requested (the backend explains any that cannot keep up). Unplotted
    // channels are added only if they accept the interval and don't conflict,
    // so a slow unplotted channel never limits the device's rate.
    const chosen = sensors.filter(s => plotted.has(`${device.id}/${s.number}`));
    for (const sensor of sensors) {
      if (!chosen.includes(sensor) && acceptsInterval(sensor, period) && chosen.every(other =>
        !sensor.excluded_channels.includes(other.number) && !other.excluded_channels.includes(sensor.number))) {
        chosen.push(sensor);
      }
    }
    return [device.id, sensors.filter(s => chosen.includes(s)).map(s => s.number)];
  }));
}
function applyState(next, withPoints) {
  if (state.run !== next.run || state.recording !== next.recording) {
    revision++;
    for (const graph of graphs) if (graph.scope === 'current' && state.run !== next.run) graph.fit++;
  }
  state = next;
  // Recorded history remains exportable, but only connected devices are graph inputs.
  const available = new Set(availableChannels().map(s => s.id));
  let selectionChanged = false;
  for (const graph of graphs) {
    const selected = graph.selected.filter(id => available.has(id));
    if (selected.length !== graph.selected.length) {
      graph.selected = selected;
      graph.dirty = true;
      selectionChanged = true;
    }
  }
  if (selectionChanged) saveLayout();
  if (next.experiment_name && document.activeElement !== $('#experiment-title')) {
    $('#experiment-title').value = next.experiment_name;
  }
  if (next.generation !== generation) {
    generation = next.generation; cursor = 0; points.clear(); runStats.clear(); runStarts.clear(); revision++;
    for (const graph of graphs) graph.fit++;
  }
  if (withPoints) {
    for (const point of next.points) {
      if (!points.has(point.series)) points.set(point.series, []);
      points.get(point.series).push(point);
      if (!(runStarts.get(point.run) <= point.t)) runStarts.set(point.run, point.t);
      const stats = runStats.get(point.series);
      if (!stats || stats.run !== point.run) runStats.set(point.series, {run: point.run, first: point.t, last: point.t, n: 1});
      else { stats.last = point.t; stats.n++; }
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
  const configuration = state.recording ? Object.fromEntries(connected.map(d => [d.id, d.selected])) : recordingConfiguration();
  const channels = state.recording ? connected.reduce((sum, d) => sum + d.selected.length, 0)
    : Object.values(configuration).reduce((sum, numbers) => sum + numbers.length, 0);
  const plotted = plottedIds();
  const tooSlow = [], alternatives = [], blocked = [];
  for (const d of connected) {
    for (const s of d.sensors.filter(s => s.supported)) {
      const fits = acceptsInterval(s, d.period_ms);
      if (!configuration[d.id].includes(s.number)) (fits ? alternatives : tooSlow).push(`${d.name}: ${s.name} (max ${formatHz(1000 / s.minimum_ms)})`);
      else if (!state.recording && !fits && plotted.has(`${d.id}/${s.number}`)) blocked.push(`${d.name}: ${s.name} (max ${formatHz(1000 / s.minimum_ms)})`);
    }
  }
  const notes = [];
  if (blocked.length) notes.push(`Can’t start: ${blocked.join(', ')} ${blocked.length > 1 ? 'are' : 'is'} plotted but can’t be sampled at ${blocked.length > 1 ? 'their device’s' : 'its device’s'} interval. All channels on one device share its interval, so choose a longer interval or uncheck the channel.`);
  if (tooSlow.length) notes.push(`⚠ ${state.recording ? 'Not being recorded in this run' : 'Will not be recorded'}: ${tooSlow.join(', ')}. ${tooSlow.length > 1 ? 'These channels are' : 'This channel is'} too slow for ${tooSlow.length > 1 ? 'their device’s' : 'its device’s'} interval, so ${state.recording ? 'this run has' : 'the next run will have'} no data for ${tooSlow.length > 1 ? 'them' : 'it'}, in the graphs or in either CSV. ${state.recording ? 'Stop and choose' : 'Choose'} a longer interval on the device card to record ${tooSlow.length > 1 ? 'them' : 'it'}.`);
  if (alternatives.length) notes.push(`Alternative channels not recorded: ${alternatives.join(', ')}. To use an alternative, select it on a graph while stopped and uncheck its conflicting range.`);
  $('#recording-note').textContent = notes.length ? notes.join(' ')
    : 'All supported channels on connected devices are recorded. Graph selections only control what you plot and export from that graph.';
  $('#recording-note').classList.toggle('warning', blocked.length > 0 || tooSlow.length > 0);
  $('#device-count').textContent = connected.length;
  $('#sampling-note').textContent = connected.length > 1
    ? 'Each device samples at its own interval, set on its card. Devices are not synchronized, so their sample times differ.'
    : connected.length ? 'Set the sampling interval on the device card.' : '';
  $('#sampling-note').hidden = !connected.length;
  $('#start').disabled = busy || connecting() || offline || state.recording || !channels || blocked.length > 0;
  $('#stop').disabled = busy || connecting() || offline || !state.recording;
  $('#reset').disabled = busy || connecting() || offline || state.recording || !state.total_points;
  for (const id of ['scan', 'demo']) $(`#${id}`).disabled = busy || connecting() || offline || state.recording;
  $('#save-device-name').disabled = busy || connecting() || offline || state.recording;
  $('#export').disabled = busy || connecting() || offline || !state.series.length;
  for (const id of ['open-experiment', 'save-experiment']) $(`#${id}`).disabled = busy || connecting() || offline || state.recording;
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
  const run = state.run || 0;
  $('#run-number').innerHTML = run ? `${run} <small>${state.recording ? 'recording' : 'stopped'}</small>` : '–';
  $('#start').title = `Start run ${run + 1}`;
  const started = runStarts.get(run);
  $('#run-note').textContent = state.recording
    ? `Recording run ${run}${started != null ? `, which began at ${started.toFixed(2)} s` : ''}. Stop ends the run.`
    : run ? `${run} run${run > 1 ? 's' : ''} recorded. Start begins run ${run + 1}. Time keeps counting from the first Start while stopped, so run ${run + 1} appears after a gap.`
    : 'Each Start begins a new run. Time is measured from the first Start and keeps counting while stopped.';
  $('#status').textContent = offline ? 'Server unavailable' : connecting() ? 'Connecting…' : busy ? 'Working…' : state.recording ? 'Recording' : state.total_points ? 'Collection stopped' : channels ? 'Ready to collect' : connected.length ? 'Choose sensors in a graph' : 'Ready to connect';
  $('#status-dot').classList.toggle('recording', state.recording && !offline);
  $('#acquisition-llama').classList.toggle('running', state.recording && !offline);
  $('#supported-devices').textContent = `Supported: ${(state.supported_devices || []).map(d => d.label).join(', ') || 'checking…'}`;
  $('#demo-banner').hidden = !state.devices.some(d => d.demo && d.connected) && !state.series.some(s => s.demo);
}
// Interval limits for a device: the fastest any channel allows, the range the
// plotted channels allow (they must all be recorded), and per-channel maxima.
function intervalLimits(device) {
  const sensors = device.sensors.filter(s => s.supported);
  if (!sensors.length) return null;
  const plotted = plottedIds();
  const required = sensors.filter(s => plotted.has(`${device.id}/${s.number}`));
  const bounds = list => ({min: Math.max(...list.map(s => s.minimum_ms)), max: Math.min(...list.map(s => s.maximum_ms))});
  const groups = new Map();
  for (const s of sensors) groups.set(s.minimum_ms, [...(groups.get(s.minimum_ms) || []), s.name]);
  return {
    min: Math.min(...sensors.map(s => s.minimum_ms)), max: Math.max(...sensors.map(s => s.maximum_ms)),
    required: required.length ? {...bounds(required), names: required.map(s => s.name)} : null,
    groups: [...groups].sort((a, b) => a[0] - b[0]),
    steps: [...new Set(sensors.map(s => s.step_ms).filter(step => step > 0 && step !== 1))],
  };
}
const formatMs = ms => `${ms.toLocaleString(undefined, {maximumFractionDigits: 2})} ms`;
const formatHz = hz => `${hz.toLocaleString(undefined, {maximumFractionDigits: hz < 10 ? 2 : 1})} Hz`;
function achievedRate(deviceId) {
  // Average rate over the latest run: (samples − 1) ÷ (last time − first time).
  let best = null;
  for (const [id, stats] of runStats) {
    if (!id.startsWith(`${deviceId}/`) || stats.n < 2 || stats.last <= stats.first) continue;
    if (!best || stats.run > best.run || (stats.run === best.run && stats.n > best.n)) best = stats;
  }
  return best && {run: best.run, hz: (best.n - 1) / (best.last - best.first), n: best.n};
}
function samplingDetails(device, disabled) {
  const limits = intervalLimits(device);
  const period = device.period_ms;
  // The input allows what the plotted channels allow, or else any channel's range.
  const allowed = limits?.required || limits;
  const control = `<div class="device-sampling-control">
      <label for="period-${esc(device.id)}">Interval</label>
      <div class="input-unit"><input id="period-${esc(device.id)}" class="period-input" type="number" data-period-device="${esc(device.id)}"
        value="${period ?? ''}" min="${allowed ? allowed.min : 10}" max="${allowed ? allowed.max : 10000}" step="any" ${disabled}><span>ms</span></div>
      <span class="period-rate">${period ? `= ${formatHz(1000 / period)}` : ''}</span></div>`;
  let maximum = '';
  if (limits) {
    maximum = `<p class="sampling-max"><strong>Max ${formatHz(1000 / limits.min)}</strong> (${formatMs(limits.min)})`
      + ` · min ${formatHz(1000 / limits.max)} (${formatMs(limits.max)})${limits.steps.length ? ` · multiples of ${limits.steps.map(formatMs).join(' or ')}` : ''}</p>`;
    if (limits.groups.length > 1) {
      maximum += `<p class="sampling-channels">Per channel: ${limits.groups.map(([ms, names]) => `${esc(names.join(', '))} up to ${formatHz(1000 / ms)}`).join('; ')}.`
        + ' Channels slower than the interval are not recorded unless plotted.</p>';
    }
    if (limits.required && limits.required.min > limits.min) {
      maximum += `<p class="sampling-channels">Plotted channels limit this device to <strong>${formatHz(1000 / limits.required.min)}</strong>. Uncheck the slower ones to sample faster.</p>`;
    }
  }
  let how = '';
  if (device.timing === 'polled') {
    const rate = achievedRate(device.id);
    how = 'Polled: this computer requests each reading, so the achieved rate is often below the maximum and slightly irregular.'
      + (rate ? ` <strong>Run ${rate.run}: ${formatHz(rate.hz)} achieved.</strong>` : '');
  } else if (device.timing === 'device') {
    how = 'Device-clocked: the sensor samples at exactly this interval on its own clock and streams the data.';
  } else if (device.timing === 'simulated') {
    how = 'Simulated at exactly this interval.';
  }
  return `<div class="sampling-detail"><span class="sampling-heading">Sampling</span>${control}${maximum}${how ? `<p>${how}</p>` : ''}</div>`;
}
function renderDevices() {
  // Don't replace a period input while someone is typing in it.
  if (document.activeElement?.matches?.('#devices .period-input')) return;
  const rates = state.devices.filter(d => d.timing === 'polled').map(d => achievedRate(d.id)?.hz.toFixed(1));
  const signature = JSON.stringify([state.devices, state.saved_devices, state.recording, busy, offline, connection, rates, [...plottedIds()]]);
  if (signature === deviceSignature) return;
  deviceSignature = signature;
  const saved = new Map((state.saved_devices || []).map(d => [d.id, d]));
  $('#device-empty').hidden = state.devices.length > 0 || saved.size > 0;
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
      ${saved.has(d.id) && !d.connected ? `<p class="saved-label">From the opened experiment. Connect to restore its channels${saved.get(d.id).period_ms ? ` and ${formatMs(saved.get(d.id).period_ms)} interval` : ''}.</p>` : ''}
      ${d.reserved_by ? `<p class="reservation-label">${reservedElsewhere ? `In use by ${esc(d.reserved_by)}` : 'Reserved for your group'}</p>` : ''}
      <div class="device-actions">${d.connected ? '<span class="connection-label">Connected</span>' : '<span class="small disconnected">Not connected</span>'}<button class="text-button" data-device-action="${d.connected ? 'disconnect' : 'connect'}" ${disabled || (reservedElsewhere ? 'disabled' : '')}>${inProgress ? (connection.status === 'retrying' ? 'Retrying…' : 'Connecting…') : d.connected ? 'Disconnect' : reservedElsewhere ? 'In use' : 'Connect'}</button></div>
      ${d.owned && !d.connected ? `<button class="text-button" data-device-action="disconnect" ${disabled}>Release device</button>` : ''}
      <button class="text-button rename-device" data-device-action="rename" ${disabled || (d.owned === false ? 'disabled' : '')}>Rename device</button>
      ${d.connected && !d.demo ? `<button class="battery-button" data-device-action="battery" ${disabled} title="Refresh battery while collection is stopped">▰ ${d.battery == null ? 'Battery unavailable' : `${d.battery}%${d.charging ? ' · charging' : ''}`} · refresh</button>` : ''}
      ${d.connected ? `<p class="small muted">${d.sensors.filter(s => s.supported).length} sensor channels · recorded even when not plotted.</p>` : ''}
      ${d.connected ? samplingDetails(d, disabled) : ''}
      ${d.connected && d.acquisition_note ? `<p class="device-warning">${esc(d.acquisition_note)}</p>` : ''}
    </article>`;
  }).join('') + [...saved.values()].filter(d => !state.devices.some(device => device.id === d.id)).map(d => `<article class="device-card saved-device" data-saved-device="${esc(d.id)}">
      <div class="device-head"><span class="device-icon" aria-hidden="true">ᛒ</span><h3>${esc(d.name)}</h3></div>
      <div class="device-meta">${esc(d.family)}
        <div class="hardware-name">Advertised name: ${esc(d.hardware_name)}</div>
        ${d.serial ? `<div class="device-serial">Device ID: <strong>${esc(d.serial)}</strong></div>` : ''}
        <div class="device-address">Bluetooth ID: <span>${esc(d.id)}</span></div>
      </div>
      <p class="saved-label">From the opened experiment · not connected</p>
      <p class="small muted">Search for devices and connect this one to continue recording. Its channels${d.period_ms ? ` and ${formatMs(d.period_ms)} interval` : ''} are restored when it connects. Its recorded data is already on your graphs.</p>
    </article>`).join('');
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
    follow: saved.follow ?? true, scope: saved.scope === 'current' ? 'current' : 'all', fit: 0, dirty: true, lastRevision: -1, drawing: false};
  const node = document.createElement('article'); node.className = 'graph';
  node.innerHTML = `<div class="graph-header"><div class="graph-title"><input aria-label="Graph title" value="${esc(graph.title)}" maxlength="50"></div><div class="graph-tools"><label class="follow"><input type="checkbox" ${graph.follow ? 'checked' : ''}> Follow live</label><details class="graph-sensors"><summary>Sensors <span class="selection-count"></span><span aria-hidden="true">⌄</span></summary><div class="sensor-dropdown"><h3>Sensors to plot</h3><p>Check sensors from one or more devices to overlay on this graph.</p><div class="series-options"></div></div></details><button class="graph-export" title="Download all data for this graph, regardless of zoom" disabled>Download CSV</button><button class="fit" title="Fit the selected runs in view">Fit view</button><button class="remove" title="Remove graph" aria-label="Remove graph">×</button></div></div><div class="plot-area"><div class="plot"></div><div class="hover-marks" aria-hidden="true"></div></div><div class="graph-footer"><div class="legend"></div><span class="plot-note">Time in seconds</span></div>`;
  graph.node = node;
  graph.analysis = attachAnalysis(graph, () => ({
    revision, generation, recording: state.recording, run: state.run,
    range: $('.plot', node)._fullLayout?.xaxis.range?.slice(),
    channels: availableChannels().filter(s => graph.selected.includes(s.id)).map(s => ({
      ...s, color: colorFor(s.id), samples: graphSamples(graph, s.id),
    })),
  }), scope => {
    graph.scope = scope; graph.fit++; graph.dirty = true; drawGraph(graph); saveLayout();
  });
  $('#graphs').append(node); graphs.push(graph);
  graph.resizeObserver = new ResizeObserver(() => {
    for (const plot of node.querySelectorAll('.plot, .fit-preview')) {
      if (plot._fullLayout && plot.getClientRects().length) Plotly.Plots.resize(plot).catch(() => {});
    }
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
    graph.analysis.dispose();
    Plotly.purge($('.plot', node)); node.remove(); graphs = graphs.filter(g => g !== graph);
    renumberGraphs(); saveLayout(); renderControls();
  });
  $('.series-options', node).addEventListener('change', e => {
    const id = e.target.dataset.series;
    if (!id) return;
    graph.selected = e.target.checked ? [...graph.selected, id] : graph.selected.filter(s => s !== id);
    updateSelectionCount(graph);
    graph.dirty = true; graph.fit++; drawGraph(graph); renderControls(); renderDevices(); saveLayout();
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
    `<fieldset><legend>${esc(channels[0].device)}${channels[0].saved ? ' <small class="saved-tag">saved · not connected</small>' : ''}</legend><p class="picker-device-id">Device: ${esc([...state.devices, ...(state.saved_devices || [])].find(d => d.id === channels[0].device_id)?.serial || channels[0].device_id)}</p><div class="device-series">${channels.map(s =>
      `<label class="series-option${s.canPlot ? '' : ' unavailable'}"><input type="checkbox" data-series="${esc(s.id)}" ${graph.selected.includes(s.id) ? 'checked' : ''} ${s.canPlot && !busy && !offline ? '' : 'disabled'}><span>${esc(s.name)} <span class="muted">(${esc(s.unit)})</span>${s.canPlot ? '' : `<small>${s.supported === false ? 'Unsupported event channel' : 'Stop collection to add this sensor'}</small>`}</span></label>`
    ).join('')}</div></fieldset>`).join('') : '<p class="small muted">Connect a device to choose sensors for this graph.</p>';
  $('.sensor-dropdown > p', graph.node).textContent = state.recording
    ? 'Show or hide recorded data here. Stop collection before adding new sensors to record.'
    : 'Choose what this graph displays. All supported compatible channels are recorded, including unchecked sensors.';
  updateSelectionCount(graph);
}
function updateSelectionCount(graph) {
  const count = availableChannels().filter(s => graph.selected.includes(s.id)).length;
  $('.selection-count', graph.node).textContent = `${count} selected`;
}
function graphSamples(graph, id) {
  const data = points.get(id) || [];
  return graph.scope === 'current' ? data.filter(p => p.run === state.run) : data;
}
// Min/max bucket reduction keeps extrema visible; CSV uses full-resolution data.
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
// Ring each sample shown in the hover box, positioned with Plotly's axis mapping.
function placeHoverMarks(graph) {
  const plot = $('.plot', graph.node), layer = $('.hover-marks', graph.node), layout = plot._fullLayout;
  if (!layout || !graph.hovered?.length) { layer.replaceChildren(); return; }
  const marks = [];
  for (const point of graph.hovered) {
    const xa = layout[point.xaxis], ya = layout[point.yaxis];
    if (!xa || !ya || point.y == null) continue;
    const x = xa.c2p(point.x), y = ya.c2p(point.y);
    if (!(x >= 0 && x <= xa._length && y >= 0 && y <= ya._length)) continue;
    const mark = document.createElement('i');
    mark.className = 'hover-mark';
    mark.style.left = `${xa._offset + x}px`; mark.style.top = `${ya._offset + y}px`;
    mark.style.setProperty('--mark-color', point.color || '#1e5480');
    marks.push(mark);
  }
  layer.replaceChildren(...marks);
}
async function drawGraph(graph) {
  if (graph.drawing || (!graph.dirty && graph.lastRevision === revision)) return;
  graph.drawing = true; graph.dirty = false; graph.lastRevision = revision;
  const channels = availableChannels().filter(s => graph.selected.includes(s.id));
  const units = [...new Set(channels.map(s => s.unit))];
  const plot = $('.plot', graph.node);
  const traces = channels.map(s => {
    const data = displayPoints(graphSamples(graph, s.id)), x = [], y = [], runs = [];
    for (const point of data) { x.push(point.t); y.push(point.value); runs.push(point.run); }
    const unitIndex = units.indexOf(s.unit);
    return {x, y, customdata: runs, name: `${s.device} · ${s.name}`, type: 'scatter', mode: 'markers',
      // Plot each recorded sample as its own point; no line implies values between samples.
      marker: {color: colorFor(s.id), size: 5}, yaxis: unitIndex ? `y${unitIndex + 1}` : 'y',
      hovertemplate: `${esc(s.name)}: <b>%{y:.4g} ${esc(s.unit)}</b><br>%{x:.4f} s · run %{customdata}<extra>${esc(s.device)}</extra>`};
  });
  const hasData = traces.some(t => t.x.length);
  if (hasData && graph.hadData === false) graph.fit++;
  graph.hadData = hasData;
  const axis = {gridcolor: '#eef0f2', zerolinecolor: '#dbe1e6', tickfont: {size: 10, color: '#909aa2'},
    title: {font: {size: 11, color: '#808e9a'}, standoff: 10}, showline: false, automargin: true};
  const layout = {autosize: true, paper_bgcolor: 'white', plot_bgcolor: 'white', font: {family: 'Inter, Segoe UI, sans-serif', color: '#455765'},
    margin: {l: 60, r: Math.max(25, (units.length - 1) * 65), t: 28, b: 48},
    showlegend: false, hovermode: 'x unified', dragmode: 'zoom', uirevision: `${generation}-${graph.fit}`,
    datarevision: revision, hoverlabel: {bgcolor: '#fff', bordercolor: '#dae2e9', font: {size: 11}},
    xaxis: {...axis, title: {...axis.title, text: 'Time since first Start (s)'}, autorange: graph.follow ? true : undefined},
    yaxis: {...axis, title: {...axis.title, text: units[0] || 'Value'}},
  };
  units.slice(1).forEach((unit, i) => {
    layout[`yaxis${i + 2}`] = {...axis, title: {...axis.title, text: unit}, overlaying: 'y', side: 'right',
      anchor: 'free', position: 1, shift: i * 60, showgrid: false};
  });
  // Mark where each run begins once there is more than one.
  if (hasData && runStarts.size > 1) {
    const starts = [...runStarts].filter(([run]) => graph.scope !== 'current' || run === state.run).sort((a, b) => a[0] - b[0]);
    layout.shapes = starts.map(([, t]) => ({type: 'line', xref: 'x', yref: 'paper', x0: t, x1: t, y0: 0, y1: 1,
      line: {color: '#b9c4cd', width: 1, dash: 'dot'}, layer: 'below'}));
    layout.annotations = starts.map(([run, t]) => ({x: t, xref: 'x', y: 1, yref: 'paper', yanchor: 'bottom', xanchor: 'left',
      text: `Run ${run}`, showarrow: false, font: {size: 10, color: '#7d8a95'}}));
  }
  if (!hasData) {
    layout.xaxis.range = [0, 10]; layout.xaxis.autorange = false;
    layout.yaxis.range = [-5, 5];
    layout.annotations = [{xref: 'paper', yref: 'paper', x: .5, y: .56, showarrow: false,
      text: `<b>${channels.length ? 'No data yet' : 'Choose sensors for this graph'}</b><br><span style="font-size:11px;color:#949ea7">${channels.length ? 'Start collection to see your measurements here.' : 'Open the Sensors dropdown to start plotting.'}</span>`,
      font: {size: 15, color: '#70818f'}, bgcolor: 'rgba(255,255,255,.94)', borderpad: 15}];
  }
  try {
    await Plotly.react(plot, traces, layout, {responsive: true, displaylogo: false, scrollZoom: true,
      modeBarButtonsToRemove: ['select2d', 'lasso2d'], toImageButtonOptions: {filename: graph.title || 'physllama-graph'}});
    if (!graphs.includes(graph)) return;
    if (!graph.listeners) {
      plot.on('plotly_relayout', event => {
        if ('xaxis.range[0]' in event || 'xaxis.range' in event) {
          graph.follow = false; $('.follow input', graph.node).checked = false; saveLayout();
        }
        placeHoverMarks(graph);
        if (!graph.drawing) graph.analysis.update();
      });
      plot.on('plotly_hover', event => {
        graph.hovered = event.points.map(point => ({x: point.x, y: point.y, xaxis: point.xaxis._name,
          yaxis: point.yaxis._name, color: point.data.marker?.color}));
        placeHoverMarks(graph);
      });
      plot.on('plotly_unhover', () => { graph.hovered = []; placeHoverMarks(graph); });
      graph.listeners = true;
    }
    // Live redraws can move the axes or remove Plotly's hover label.
    if (!plot.querySelector('.hoverlayer')?.childElementCount) graph.hovered = [];
    placeHoverMarks(graph);
    $('.legend', graph.node).innerHTML = channels.length ? channels.map(s => `<span class="legend-item"><i class="swatch" style="background:${colorFor(s.id)}"></i>${esc(s.name)}${channels.filter(c => c.name === s.name).length > 1 ? ` (${esc(s.device)})` : ''} <span class="muted">${esc(s.unit)}</span></span>`).join('') : '<span>No channels selected</span>';
    $('.plot-note', graph.node).textContent = channels.some(s => graphSamples(graph, s.id).length > 4000) ? 'Showing the minimum and maximum sample in each time bucket · CSV contains every sample' : 'Each point is one recorded sample · hover to inspect';
  } catch (error) {
    // A graph removed mid-draw (closed, or replaced by an opened experiment) is not an error.
    if (graphs.includes(graph)) showNotice(`Graph could not be drawn: ${error.message}`);
  }
  finally {
    graph.drawing = false;
    if (graphs.includes(graph)) {
      graph.analysis.update();
      if (graph.dirty || graph.lastRevision !== revision) drawGraph(graph);
    }
  }
}

$('#scan').addEventListener('click', async () => {
  $('#scan-note').textContent = 'Searching for supported Bluetooth devices…';
  const success = await action('scan');
  $('#scan-note').textContent = success ? (state.devices.some(d => !d.demo) ? 'Search complete. Choose a device below.' : 'No supported devices found. Wake your device and try again.') : `Search unavailable. Check Bluetooth on ${multiMode ? 'the instructor’s' : 'this'} computer.`;
});
$('#demo').addEventListener('click', () => action('demo'));
$('#start').addEventListener('click', () => action('start', {selections: recordingConfiguration()}));
$('#stop').addEventListener('click', () => action('stop'));
$('#devices').addEventListener('change', async event => {
  const input = event.target.closest('[data-period-device]');
  if (!input) return;
  const value = Number(input.value);
  input.blur();
  const id = input.dataset.periodDevice;
  if (!input.value || !(value >= Number(input.min) && value <= Number(input.max))) {
    const device = state.devices.find(d => d.id === id);
    const required = device && intervalLimits(device)?.required;
    showNotice(`${device?.name || 'This device'}: choose an interval from ${input.min} to ${input.max} ms (${formatHz(1000 / Number(input.min))} down to ${formatHz(1000 / Number(input.max))}).`
      + (required ? ` The plotted channels (${required.names.join(', ')}) set this range; uncheck slower channels to sample faster.` : ''));
    deviceSignature = ''; renderDevices();
    return;
  }
  // Warn when the new interval drops channels that were going to be recorded.
  const device = state.devices.find(d => d.id === id);
  const before = new Set(recordingConfiguration()[id] || []);
  const after = new Set(recordingConfiguration({[id]: value})[id] || []);
  const dropped = (device?.sensors || []).filter(s => before.has(s.number) && !after.has(s.number) && !acceptsInterval(s, value));
  if (await action('configure', {selections: recordingConfiguration({[id]: value}), periods: {[id]: value}}) && dropped.length) {
    const slowest = Math.max(...dropped.map(s => s.minimum_ms));
    showNotice(`${device.name}: at ${formatMs(value)} (${formatHz(1000 / value)}), ${dropped.map(s => `${s.name} (max ${formatHz(1000 / s.minimum_ms)})`).join(', ')} `
      + `will not be recorded and won’t appear in either CSV. All channels on a device share one interval. `
      + `Choose ${formatMs(slowest)} or longer to record ${dropped.length > 1 ? 'them' : 'it'}.`);
  }
  deviceSignature = ''; renderDevices();
});
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
const graphLayout = () => graphs.map(({title, customTitle, selected, follow, scope}) => ({title, customTitle, selected, follow, scope}));
function replaceGraphs(saved) {
  for (const graph of graphs) {
    graph.resizeObserver.disconnect();
    graph.analysis.dispose();
    Plotly.purge($('.plot', graph.node)); graph.node.remove();
  }
  graphs = []; graphCounter = 0;
  // The layout comes from a file: keep only well-formed fields.
  const valid = (Array.isArray(saved) ? saved : []).filter(g => g && typeof g === 'object').slice(0, 12).map(g => ({
    title: typeof g.title === 'string' ? g.title.slice(0, 50) : '', customTitle: g.customTitle === true,
    selected: Array.isArray(g.selected) ? [...new Set(g.selected.filter(id => typeof id === 'string'))] : [],
    follow: g.follow !== false, scope: g.scope === 'current' ? 'current' : 'all'}));
  (valid.length ? valid : [{}]).forEach(addGraph);
  renumberGraphs(); saveLayout(); renderControls(); renderDevices();
}
function fileName(title, extension) {
  return `${title.replace(/[^a-z0-9 _-]/gi, '').trim() || 'experiment'}${extension}`;
}
$('#save-experiment').addEventListener('click', async () => {
  showNotice();
  try {
    const data = await request('experiment/file');
    data.layout = {graphs: graphLayout()};
    const url = URL.createObjectURL(new Blob([JSON.stringify(data)], {type: 'application/json'}));
    const anchor = document.createElement('a'); anchor.href = url;
    anchor.download = fileName($('#experiment-title').value, '.physllama');
    anchor.click(); setTimeout(() => URL.revokeObjectURL(url), 1000);
  } catch (error) { showNotice(error.message); }
});
$('#open-experiment').addEventListener('click', () => {
  if (state.total_points || graphs.some(g => g.selected.length)) $('#open-dialog').showModal();
  else $('#experiment-file').click();
});
$('[data-close="open-dialog"]').addEventListener('click', () => $('#open-dialog').close());
$('#confirm-open').addEventListener('click', () => { $('#open-dialog').close(); $('#experiment-file').click(); });
$('#experiment-file').addEventListener('change', async event => {
  const file = event.target.files[0];
  event.target.value = '';
  if (!file) return;
  let data;
  try { data = JSON.parse(await file.text()); } catch {
    return showNotice(`${file.name} is not a PhysLlama experiment file.`);
  }
  if (await action('experiment/file', data)) replaceGraphs(data?.layout?.graphs);
});
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
      setSidebarCollapsed(saved?.sidebarCollapsed === true);
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
