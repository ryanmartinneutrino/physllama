const { test, expect } = require('@playwright/test');

test('complete experiment with multiple devices, graphs, zoom, export and reset', async ({page}) => {
  const errors = [];
  page.on('pageerror', error => errors.push(error.message));
  await page.goto('/');
  await expect(page.locator('#status')).toHaveText('Ready to connect');
  await expect(page).toHaveTitle(/PhysLlama/);
  await expect(page.locator('#supported-devices')).toHaveText('Supported: Go Direct, PASCO wireless sensors');
  await expect(page.locator('#acquisition-llama')).not.toHaveClass(/running/);
  await expect(page.locator('.plot .main-svg').first()).toBeVisible();
  await expect(page.locator('#start')).toBeDisabled();
  await page.screenshot({path: 'test-results/workspace-empty.png', fullPage: true});
  await page.getByRole('button', {name: 'Add demo device'}).click();
  await expect(page.getByRole('heading', {name: 'Demo Motion & Force 1'})).toBeVisible();
  await expect(page.locator('#devices input[type="checkbox"]')).toHaveCount(0);
  await expect(page.locator('#start')).toBeEnabled();
  const first = page.locator('.graph').first();
  await first.locator('summary').click();
  await first.locator('[data-series="demo-1/1"]').check();
  await first.locator('[data-series="demo-1/2"]').check();
  await expect(page.locator('#channels')).toHaveText('4');
  await page.getByRole('button', {name: 'Add demo device'}).click();
  await expect(page.locator('#device-count')).toHaveText('2');
  await first.locator('summary').click();
  await first.locator('[data-series="demo-2/1"]').check();
  const period = page.locator('[data-period-device="demo-1"]');
  await expect(period).toHaveValue('50');
  await expect(page.locator('[data-device="demo-1"] .sampling-max')).toContainText('Max 100 Hz');
  await period.fill('20');
  await period.press('Enter');
  await expect(page.locator('[data-device="demo-1"] .period-rate')).toHaveText('= 50 Hz');
  await expect(page.locator('[data-period-device="demo-2"]')).toHaveValue('50');
  await expect(page.locator('#sampling-note')).toContainText('Each device samples at its own interval');
  await page.locator('[data-period-device="demo-2"]').fill('5');
  await page.locator('[data-period-device="demo-2"]').press('Enter');
  await expect(page.locator('#notice')).toContainText('choose an interval from 10 to 10000 ms');
  await expect(page.locator('[data-period-device="demo-2"]')).toHaveValue('50');
  await page.getByRole('button', {name: '+ Add graph'}).click();
  await expect(page.locator('.graph')).toHaveCount(2);
  const second = page.locator('.graph').nth(1);
  await expect(second.locator('.selection-count')).toHaveText('0 selected');
  await expect(second.locator('.sensor-dropdown')).not.toBeVisible();
  await second.locator('summary').click();
  await expect(second.getByRole('group', {name: 'Demo Motion & Force 1', exact: true})).toBeVisible();
  await expect(second.getByRole('group', {name: 'Demo Motion & Force 2', exact: true})).toBeVisible();
  await expect(second.locator('[data-series="demo-1/3"]')).toBeEnabled();
  await second.locator('[data-series="demo-1/2"]').check();
  await second.locator('[data-series="demo-2/1"]').check();
  await expect(second.locator('.selection-count')).toHaveText('2 selected');
  await expect(first.locator('.selection-count')).toHaveText('3 selected');
  await page.getByRole('button', {name: 'Start collection'}).click();
  await expect(page.locator('#status')).toHaveText('Recording');
  await expect(page.locator('#acquisition-llama')).toHaveClass(/running/);
  await expect(page.locator('.leg-front')).toHaveCSS('animation-name', 'llama-stride');
  const started = await (await page.request.get('/api/state')).json();
  expect(started.devices.find(d => d.id === 'demo-1').selected).toEqual([1, 2, 3, 4]);
  expect(started.devices.find(d => d.id === 'demo-2').selected).toEqual([1, 2, 3, 4]);
  await expect(page.locator('#scan')).toBeDisabled();
  await expect.poll(async () => Number((await page.locator('#samples').innerText()).replaceAll(',', ''))).toBeGreaterThan(30);
  await second.locator('summary').click();
  await expect(second.locator('[data-series="demo-1/3"]')).toBeEnabled();
  await second.locator('[data-series="demo-1/2"]').uncheck();
  await expect.poll(() => second.locator('.plot').evaluate(el => el.data?.length)).toBe(1);
  await expect(first.locator('[data-series="demo-1/2"]')).toBeChecked();
  await expect(page.locator('#channels')).toHaveText('8');
  await second.locator('[data-series="demo-1/2"]').check();
  await page.getByRole('button', {name: 'Stop collection', exact: true}).click();
  await expect(page.locator('#status')).toHaveText('Collection stopped');
  await expect(page.locator('#acquisition-llama')).not.toHaveClass(/running/);
  await expect(page.locator('.leg-front')).toHaveCSS('animation-name', 'none');
  await expect(second.locator('[data-series="demo-1/3"]')).toBeEnabled();
  await expect.poll(() => page.locator('.graph').first().locator('.plot').evaluate(el => el.data?.length)).toBe(3);
  await expect.poll(() => second.locator('.plot').evaluate(el => el.data?.map(s => s.name))).toEqual([
    'Demo Motion & Force 1 · Acceleration X', 'Demo Motion & Force 2 · Force',
  ]);
  const plot = page.locator('.plot').first();
  await expect.poll(() => plot.evaluate(el => !!el.layout.yaxis2)).toBe(true);
  await plot.evaluate(el => window.Plotly.relayout(el, {'xaxis.range': [0.1, 0.5]}));
  await expect(page.locator('.follow input').first()).not.toBeChecked();
  await page.locator('.fit').first().click();
  await expect.poll(() => plot.evaluate(el => el._fullLayout.xaxis.range[0])).toBeLessThan(.1);
  await plot.evaluate(el => window.Plotly.Fx.hover(el, [{curveNumber: 0, pointNumber: 2}]));
  await expect(page.locator('.hoverlayer').first()).toContainText('Force');
  // Each sample shown in the hover box is ringed at its plotted position.
  // (Programmatic Fx.hover doesn't emit plotly_hover, so use the mouse.)
  await plot.scrollIntoViewIfNeeded();
  const target = await plot.evaluate(el => {
    const xa = el._fullLayout.xaxis, ya = el._fullLayout.yaxis, rect = el.getBoundingClientRect();
    return [rect.left + xa._offset + xa.c2p(el.data[0].x[2]), rect.top + ya._offset + ya.c2p(el.data[0].y[2])];
  });
  await page.mouse.move(target[0], target[1]);
  const marks = page.locator('.graph').first().locator('.hover-mark');
  await expect.poll(() => marks.count()).toBeGreaterThan(0);
  const distances = await plot.evaluate(el => [...el.parentElement.querySelectorAll('.hover-mark')].map(mark => {
    const left = parseFloat(mark.style.left), top = parseFloat(mark.style.top);
    let best = Infinity;
    el.data.forEach(trace => {
      const xa = el._fullLayout.xaxis, ya = el._fullLayout[trace.yaxis === 'y' ? 'yaxis' : `yaxis${trace.yaxis.slice(1)}`];
      trace.x.forEach((x, i) => { best = Math.min(best, Math.hypot(left - xa._offset - xa.c2p(x), top - ya._offset - ya.c2p(trace.y[i]))); });
    });
    return best;
  }));
  expect(Math.max(...distances)).toBeLessThan(1);
  await page.mouse.move(5, 5);
  await expect(marks).toHaveCount(0);
  await page.setViewportSize({width: 1440, height: 1050});
  await page.screenshot({path: 'test-results/workspace-recorded.png', fullPage: true});
  const downloadPromise = page.waitForEvent('download');
  await page.getByRole('button', {name: 'Export CSV'}).click();
  const download = await downloadPromise;
  expect(download.suggestedFilename()).toContain('DEMO.csv');
  const stream = await download.createReadStream();
  let csv = ''; for await (const chunk of stream) csv += chunk;
  expect(csv).toContain('Acceleration X [m/s²]');
  expect(csv).toContain('Force [N]');
  // A graph export includes exactly its sensors and all samples outside zoom.
  await second.locator('.plot').evaluate(el => window.Plotly.relayout(el, {'xaxis.range': [.1, .2]}));
  const graphDownloadPromise = page.waitForEvent('download');
  await second.getByRole('button', {name: 'Download CSV'}).click();
  const graphDownload = await graphDownloadPromise;
  expect(graphDownload.suggestedFilename()).toBe('Graph 2-DEMO.csv');
  let graphCSV = '';
  for await (const chunk of await graphDownload.createReadStream()) graphCSV += chunk;
  const rows = graphCSV.trim().split(/\r?\n/).slice(1).map(row => row.split(','));
  const header = graphCSV.split(/\r?\n/)[0].split(',');
  expect(header).toHaveLength(5);
  expect(header.slice(0, 3)).toEqual(['run', 'time_s', 'run_time_s']);
  expect(header.some(column => column.includes('Acceleration X [m/s²] (demo-1/2'))).toBe(true);
  expect(header.some(column => column.includes('Force [N] (demo-2/1'))).toBe(true);
  expect(rows.length).toBeGreaterThan(1);
  expect(rows.every(row => row.length === 5)).toBe(true);
  expect(rows.map(row => row.slice(0, 3))).toEqual(csv.trim().split(/\r?\n/).slice(1).map(row => row.split(',').slice(0, 3)));
  expect(Math.max(...rows.map(row => Number(row[1])))).toBeGreaterThan(.2);
  const samples = await page.locator('#samples').innerText();
  await page.reload();
  await expect(page.locator('#samples')).toHaveText(samples);
  await expect(page.locator('.graph')).toHaveCount(2);
  await expect(second.locator('.selection-count')).toHaveText('2 selected');
  await expect(second.locator('[data-series="demo-1/1"]')).not.toBeChecked();
  await expect.poll(() => page.locator('.plot').first().evaluate(el => el.data?.[0]?.x?.length || 0)).toBeGreaterThan(1);
  await page.getByRole('button', {name: 'Reset collected data'}).click();
  await page.getByRole('button', {name: 'Clear data'}).click();
  await expect(page.locator('#samples')).toHaveText('0');
  await expect(page.locator('#device-count')).toHaveText('2');
  await page.locator('[data-device="demo-2"] [data-device-action="disconnect"]').click();
  await expect(page.locator('#device-count')).toHaveText('1');
  await expect(second.getByRole('button', {name: 'Download CSV'})).toBeDisabled();
  await page.setViewportSize({width: 390, height: 844});
  await expect.poll(() => page.locator('.plot').first().evaluate(el => el._fullLayout.width)).toBeLessThan(390);
  await page.screenshot({path: 'test-results/workspace-mobile.png', fullPage: true});
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
  expect(errors).toEqual([]);
});

test('graph names stay consistent after delete, rename and reload', async ({page}) => {
  await page.goto('/');
  await page.evaluate(() => localStorage.setItem('physllama-layout', JSON.stringify({graphs: [{title: 'Graph 2', auto: false, selected: []}]})));
  await page.reload();
  await expect(page.getByRole('textbox', {name: 'Graph title'})).toHaveValue('Graph 1');
  await expect(page.locator('.graph-number')).toHaveCount(0);
  await page.getByRole('button', {name: '+ Add graph'}).click();
  await page.getByRole('button', {name: '+ Add graph'}).click();
  await page.getByRole('button', {name: 'Remove graph'}).first().click();
  await expect(page.getByRole('textbox', {name: 'Graph title'}).nth(0)).toHaveValue('Graph 1');
  await expect(page.getByRole('textbox', {name: 'Graph title'}).nth(1)).toHaveValue('Graph 2');
  await page.getByRole('textbox', {name: 'Graph title'}).first().fill('Motion comparison');
  await page.getByRole('textbox', {name: 'Graph title'}).first().press('Tab');
  await page.reload();
  await expect(page.getByRole('textbox', {name: 'Graph title'}).first()).toHaveValue('Motion comparison');
  await expect(page.getByRole('textbox', {name: 'Graph title'}).nth(1)).toHaveValue('Graph 2');
  await page.locator('.graph').first().locator('summary').click();
  await expect(page.locator('.sensor-dropdown').first()).toBeVisible();
  await page.keyboard.press('Escape');
  await expect(page.locator('.sensor-dropdown').first()).not.toBeVisible();
});

test('scan failures are visible and do not invent devices', async ({page}) => {
  await page.route('**/api/scan', route => route.fulfill({status: 400, contentType: 'application/json', body: JSON.stringify({detail: 'Bluetooth scan failed: No Bluetooth adapters found. Enable Bluetooth on this computer.'})}));
  await page.goto('/');
  await page.locator('#scan').click();
  await expect(page.locator('#notice')).toContainText('No Bluetooth adapters found');
  await expect(page.locator('#scan')).toBeEnabled();
});

test('Bluetooth progress stays visible through retry and clears on success or failure', async ({page}) => {
  const snapshot = {devices: [{id: 'test-sensor', name: 'GDX Test', rssi: -42, demo: false,
    connected: false, sensors: [], selected: [], battery: null, charging: false}],
    series: [], recording: false, total_points: 0, period_ms: 50, generation: 'connection-test',
    points: [], cursor: 0, elapsed: 0, error: null};
  let progress = {status: 'idle'}, finish;
  await page.route('**/api/state?*', route => route.fulfill({json: snapshot}));
  await page.route('**/api/connection-status', route => route.fulfill({json: progress}));
  await page.route('**/api/connect', async route => {
    progress = {status: 'retrying', device_id: 'test-sensor', attempt: 1, max_attempts: 3,
      message: 'GDX Test: connection interrupted. Retrying (next attempt 2 of 3).'};
    const success = await new Promise(resolve => { finish = resolve; });
    progress = {status: success ? 'connected' : 'failed'};
    snapshot.devices[0].connected = success;
    await route.fulfill(success ? {json: snapshot} : {status: 503, json: {detail: 'Could not connect after 3 attempts. Check Bluetooth permissions.'}});
  });
  await page.goto('/');
  await page.getByRole('button', {name: 'Connect', exact: true}).click();
  await expect(page.locator('#connection-progress')).toContainText('attempt 2 of 3');
  await expect(page.getByRole('button', {name: 'Retrying…', exact: true})).toBeDisabled();
  await expect(page.locator('#scan')).toBeDisabled();
  finish(false);
  await expect(page.locator('#notice')).toContainText('Check Bluetooth permissions');
  await expect(page.locator('#connection-progress')).toBeHidden();
  await expect(page.getByRole('button', {name: 'Connect', exact: true})).toBeEnabled();
  await page.getByRole('button', {name: 'Connect', exact: true}).click();
  await expect(page.locator('#connection-progress')).toContainText('attempt 2 of 3');
  finish(true);
  await expect(page.getByRole('button', {name: 'Disconnect', exact: true})).toBeEnabled();
  await expect(page.locator('#connection-progress')).toBeHidden();
  await expect(page.locator('#notice')).toBeHidden();
  // A refreshed tab can see another tab's ongoing connection without waiting
  // for the serialized state endpoint to finish connecting.
  progress = {status: 'connecting', device_id: 'test-sensor', message: 'Connecting — attempt 3 of 3'};
  await page.reload();
  await expect(page.locator('#connection-progress')).toContainText('attempt 3 of 3');
  await expect(page.locator('#scan')).toBeDisabled();
  progress = {status: 'connected'};
  await expect(page.locator('#connection-progress')).toBeHidden();
  await expect(page.locator('#scan')).toBeEnabled();
});

test('llama recovers recording state after reload, respects reduced motion and stops on errors', async ({page}) => {
  const snapshot = {devices: [], series: [], recording: true, total_points: 2, period_ms: 50,
    generation: 'llama-test', points: [], cursor: 0, elapsed: .05, error: null,
    supported_devices: [{id: 'example', label: 'Example family'}]};
  await page.route('**/api/state?*', route => route.fulfill({json: snapshot}));
  await page.route('**/api/connection-status', route => route.fulfill({json: {status: 'idle'}}));
  await page.goto('/');
  await expect(page.locator('#acquisition-llama')).toHaveClass(/running/);
  await expect(page.locator('#supported-devices')).toHaveText('Supported: Example family');
  await page.reload();
  await expect(page.locator('#acquisition-llama')).toHaveClass(/running/);
  await page.emulateMedia({reducedMotion: 'reduce'});
  await expect(page.locator('.leg-front')).toHaveCSS('animation-name', 'none');
  await expect(page.locator('#status')).toHaveText('Recording');
  await page.emulateMedia({reducedMotion: 'no-preference'});
  snapshot.recording = false;
  snapshot.error = 'Device disconnected. Collected data is preserved.';
  await expect(page.locator('#notice')).toContainText('Device disconnected');
  await expect(page.locator('#acquisition-llama')).not.toHaveClass(/running/);
  snapshot.recording = true;
  snapshot.error = null;
  await expect(page.locator('#acquisition-llama')).toHaveClass(/running/);
  await page.route('**/api/connection-status', route => route.abort());
  await expect(page.locator('#status')).toHaveText('Server unavailable');
  await expect(page.locator('#acquisition-llama')).not.toHaveClass(/running/);
});

test('PhysLlama restores graph preferences saved under the old name', async ({page}) => {
  await page.goto('/');
  await page.evaluate(() => {
    localStorage.removeItem('physllama-layout');
    localStorage.setItem('vernier-layout', JSON.stringify({title: 'Pendulum lab',
      graphs: [{title: 'Pendulum motion', customTitle: true, selected: [], follow: false}]}));
  });
  await page.reload();
  await expect(page.locator('#experiment-title')).toHaveValue('Pendulum lab');
  await expect(page.getByRole('textbox', {name: 'Graph title'})).toHaveValue('Pendulum motion');
  await page.locator('#experiment-title').fill('Renamed experiment');
  await page.locator('#experiment-title').press('Tab');
  await expect.poll(() => page.evaluate(() => JSON.parse(localStorage.getItem('physllama-layout'))?.title)).toBe('Renamed experiment');
});

test('rename keeps hardware identity visible and updates graphs without changing selections', async ({page}) => {
  await page.goto('/');
  const card = page.locator('[data-device="demo-1"]');
  await expect(card).toBeVisible();
  await card.getByRole('button', {name: 'Rename device', exact: true}).click();
  await expect(page.locator('#rename-identity')).toContainText('Demo Motion & Force 1');
  await expect(page.locator('#rename-identity')).toContainText('demo-1');
  await page.getByLabel('Display name').fill('Red cart <science>');
  await page.getByRole('button', {name: 'Save name', exact: true}).click();
  await expect(page.locator('#rename-dialog')).toBeHidden();
  await expect(card.getByRole('heading')).toContainText('Red cart <science>');
  await expect(card.locator('.hardware-name')).toHaveText('Advertised name: Demo Motion & Force 1');
  await expect(card.locator('.device-address')).toContainText('demo-1');
  await page.locator('.graph').first().locator('summary').click();
  await expect(page.getByRole('group', {name: 'Red cart <science>', exact: true})).toBeVisible();
  await page.reload();
  await expect(card.getByRole('heading')).toContainText('Red cart <science>');
  await card.getByRole('button', {name: 'Rename device', exact: true}).click();
  await page.getByLabel('Display name').fill('');
  await page.getByRole('button', {name: 'Save name', exact: true}).click();
  await expect(card.getByRole('heading')).toContainText('Demo Motion & Force 1');
});

test('scan results distinguish Pasco carts by printed serial and Bluetooth ID even with identical nicknames', async ({page}) => {
  const snapshot = {devices: ['123-456', '987-654'].map((serial, i) => ({
    id: `bluetooth-id-${i}`, serial, name: 'Red cart', nickname: 'Red cart',
    hardware_name: `Smart Cart ${serial}>5`, family: 'PASCO Smart Cart',
    rssi: -40, demo: false, connected: false, sensors: [], selected: [], battery: null, charging: false,
  })), series: [], recording: false, total_points: 0, period_ms: 50, generation: 'pasco-scan',
    points: [], cursor: 0, elapsed: 0, error: null, supported_devices: [{id: 'pasco', label: 'PASCO wireless sensors'}]};
  await page.route('**/api/state?*', route => route.fulfill({json: snapshot}));
  await page.route('**/api/connection-status', route => route.fulfill({json: {status: 'idle'}}));
  await page.route('**/api/scan', route => route.fulfill({json: snapshot}));
  let chosen;
  await page.route('**/api/connect', route => {
    chosen = route.request().postDataJSON().device_id;
    return route.fulfill({json: snapshot});
  });
  await page.goto('/');
  await page.locator('#scan').click();
  for (let i = 0; i < 2; i++) {
    const card = page.locator('.device-card').nth(i);
    await expect(card.getByRole('heading')).toHaveText('Red cart');
    await expect(card.locator('.device-serial')).toContainText(snapshot.devices[i].serial);
    await expect(card.locator('.hardware-name')).toContainText(snapshot.devices[i].hardware_name);
    await expect(card.locator('.device-address')).toContainText(`bluetooth-id-${i}`);
  }
  await page.locator('.device-card').nth(1).getByRole('button', {name: 'Connect', exact: true}).click();
  await expect.poll(() => chosen).toBe('bluetooth-id-1');
  await page.setViewportSize({width: 390, height: 844});
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
  await page.screenshot({path: 'test-results/pasco-device-identities.png', fullPage: true});
});

test('experiment names persist and top export includes every recorded channel while graph exports stay filtered', async ({page}) => {
  await page.request.post('/api/stop', {data: {}});
  await page.request.post('/api/reset', {data: {}});
  await page.request.post('/api/connect', {data: {device_id: 'demo-1'}});
  await page.goto('/');
  await page.getByRole('textbox', {name: 'Experiment name', exact: true}).fill('Collision experiment');
  await page.getByRole('textbox', {name: 'Experiment name', exact: true}).press('Tab');
  await page.request.post('/api/start', {data: {selections: {'demo-1': [1, 2]}, period_ms: 10}});
  await expect.poll(async () => (await (await page.request.get('/api/state')).json()).total_points).toBeGreaterThan(4);
  await page.request.post('/api/stop', {data: {}});
  const graph = page.locator('.graph').first();
  await graph.locator('summary').click();
  await graph.locator('[data-series="demo-1/1"]').check();
  await expect(graph.locator('[data-series="demo-1/2"]')).not.toBeChecked();
  const graphExport = page.waitForEvent('download');
  await graph.getByRole('button', {name: 'Download CSV'}).click();
  let graphCSV = '';
  for await (const part of await (await graphExport).createReadStream()) graphCSV += part;
  expect(graphCSV).toContain('Force [N]');
  expect(graphCSV).not.toContain('Acceleration X [m/s²]');
  await graph.locator('summary').click();
  await graph.locator('[data-series="demo-1/1"]').uncheck();
  await expect(graph.getByRole('button', {name: 'Download CSV'})).toBeDisabled();
  await expect(page.locator('#export')).toBeEnabled();
  const allExport = page.waitForEvent('download');
  await page.locator('#export').click();
  const downloaded = await allExport;
  expect(downloaded.suggestedFilename()).toBe('Collision experiment-DEMO.csv');
  let allCSV = '';
  for await (const part of await downloaded.createReadStream()) allCSV += part;
  expect(allCSV).toContain('Force [N]');
  expect(allCSV).toContain('Acceleration X [m/s²]');
  await page.reload();
  await expect(page.getByRole('textbox', {name: 'Experiment name', exact: true})).toHaveValue('Collision experiment');
});

test('disconnecting or removing a device clears graph inputs but preserves experiment export', async ({page}) => {
  await page.request.post('/api/stop', {data: {}});
  await page.request.post('/api/reset', {data: {}});
  const added = await (await page.request.post('/api/demo', {data: {}})).json();
  const device = added.devices.at(-1);
  const channel = `${device.id}/1`;
  await page.request.post('/api/start', {data: {selections: {[device.id]: [1]}, period_ms: 10}});
  await expect.poll(async () => (await (await page.request.get('/api/state')).json()).total_points).toBeGreaterThan(2);
  await page.request.post('/api/stop', {data: {}});
  await page.goto('/');
  const graph = page.locator('.graph').first();
  await graph.locator('summary').click();
  await graph.locator(`[data-series="${channel}"]`).check();
  await expect(graph.locator('.selection-count')).toHaveText('1 selected');
  await page.locator(`.device-card[data-device="${device.id}"]`).getByRole('button', {name: 'Disconnect', exact: true}).click();
  await expect(page.locator(`[data-series="${channel}"]`)).toHaveCount(0);
  await expect(graph.locator('.selection-count')).toHaveText('0 selected');
  await expect(graph.locator('.graph-export')).toBeDisabled();
  await expect.poll(() => graph.locator('.plot').evaluate(el => el.data?.length)).toBe(0);
  await expect(page.locator('#export')).toBeEnabled();
  const downloadPromise = page.waitForEvent('download');
  await page.locator('#export').click();
  let csv = '';
  for await (const part of await (await downloadPromise).createReadStream()) csv += part;
  expect(csv).toContain(channel);
  expect(csv.trim().split(/\r?\n/).length).toBeGreaterThan(2);
  await page.reload();
  await expect(page.locator(`[data-series="${channel}"]`)).toHaveCount(0);
  await page.locator(`.device-card[data-device="${device.id}"]`).getByRole('button', {name: 'Connect', exact: true}).click();
  await expect(graph.locator(`[data-series="${channel}"]`)).not.toBeChecked();
  await graph.locator('summary').click();
  await graph.locator(`[data-series="${channel}"]`).check();
  // A rescan or classroom release can remove the entire device from the state.
  await page.route('**/api/state?*', async route => {
    const response = await route.fetch();
    const state = await response.json();
    state.devices = state.devices.filter(d => d.id !== device.id);
    await route.fulfill({response, json: state});
  });
  await expect(page.locator(`[data-series="${channel}"]`)).toHaveCount(0);
  await expect(graph.locator('.selection-count')).toHaveText('0 selected');
  await page.locator('#add-graph').click();
  await expect(page.locator(`[data-series="${channel}"]`)).toHaveCount(0);
  await expect(page.locator('#export')).toBeEnabled();
});

test('collection records unplotted channels and unplotted devices; exports share all run timestamps', async ({page}) => {
  await page.request.post('/api/stop', {data: {}});
  await page.request.post('/api/reset', {data: {}});
  const initial = await (await page.request.get('/api/state')).json();
  for (const device of initial.devices.filter(d => d.connected)) {
    await page.request.post('/api/disconnect', {data: {device_id: device.id}});
  }
  const devices = [];
  for (let i = 0; i < 2; i++) {
    const state = await (await page.request.post('/api/demo', {data: {}})).json();
    devices.push(state.devices.at(-1));
  }
  await page.goto('/');
  await expect(page.locator('#channels')).toHaveText('8');
  await expect(page.locator('#start')).toBeEnabled();
  const graph = page.locator('.graph').first();
  await expect(graph.locator('.selection-count')).toHaveText('0 selected');
  await page.locator('#start').click();
  await expect.poll(async () => (await (await page.request.get('/api/state')).json()).total_points).toBeGreaterThan(16);
  await page.locator('#stop').click();
  const firstRun = await (await page.request.get('/api/state')).json();
  await graph.locator('summary').click();
  await graph.locator(`[data-series="${devices[0].id}/1"]`).check();
  await page.locator('#start').click();
  await expect.poll(async () => (await (await page.request.get('/api/state')).json()).total_points).toBeGreaterThan(firstRun.total_points + 16);
  await page.locator('#stop').click();
  const state = await (await page.request.get('/api/state')).json();
  expect(state.series).toHaveLength(8);
  for (const device of devices) {
    expect(state.devices.find(d => d.id === device.id).selected).toEqual([1, 2, 3, 4]);
    for (const sensor of device.sensors) {
      expect([...new Set(state.points.filter(p => p.series === `${device.id}/${sensor.number}`).map(p => p.run))]).toEqual([1, 2]);
    }
  }
  async function download(button) {
    const promise = page.waitForEvent('download');
    await button.click();
    let text = '';
    for await (const part of await (await promise).createReadStream()) text += part;
    return text.trim().split(/\r?\n/).map(row => row.split(','));
  }
  const all = await download(page.locator('#export'));
  const plotted = await download(graph.locator('.graph-export'));
  expect(all[0]).toHaveLength(11);
  for (const device of devices) for (const sensor of device.sensors) {
    expect(all[0].some(column => column.includes(`${device.id}/${sensor.number};`))).toBe(true);
  }
  expect(plotted[0]).toHaveLength(4);
  expect(plotted[0][3]).toContain(`${devices[0].id}/1;`);
  const expectedTimes = [...new Set(state.points.map(p => JSON.stringify([p.run, p.t])))].map(s => JSON.parse(s))
    .sort((a, b) => a[0] - b[0] || a[1] - b[1]);
  expect(all.slice(1).map(row => row.slice(0, 2).map(Number))).toEqual(expectedTimes);
  expect(plotted.slice(1).map(row => row.slice(0, 3))).toEqual(all.slice(1).map(row => row.slice(0, 3)));
  // run_time_s restarts at 0 for each run.
  const firsts = {};
  for (const [run, t, runTime] of all.slice(1).map(row => row.slice(0, 3).map(Number))) {
    firsts[run] ??= t;
    expect(runTime).toBeCloseTo(t - firsts[run], 6);
  }
});

test('recording includes compatible unplotted channels and explains exclusive alternatives', async ({page}) => {
  const state = await (await page.request.get('/api/state')).json();
  state.recording = false;
  state.series = []; state.points = []; state.total_points = 0;
  state.devices = [state.devices.find(d => d.connected)];
  const device = state.devices[0];
  device.sensors[0].excluded_channels = [2];
  device.sensors[1].excluded_channels = [1];
  device.sensors[2].supported = false;
  await page.route('**/api/state?*', route => route.fulfill({json: state}));
  let selections;
  await page.route('**/api/start', route => {
    selections = route.request().postDataJSON().selections;
    return route.fulfill({json: state});
  });
  await page.goto('/');
  await expect(page.locator('#channels')).toHaveText('2');
  await expect(page.locator('#recording-note')).toContainText('Alternative channels not recorded');
  await expect(page.locator('#recording-note')).toContainText('Acceleration X');
  const graph = page.locator('.graph').first();
  await graph.locator('summary').click();
  await graph.locator(`[data-series="${device.id}/2"]`).check();
  await expect(graph.locator(`[data-series="${device.id}/3"]`)).toBeDisabled();
  await page.locator('#start').click();
  await expect.poll(() => selections).toEqual({[device.id]: [2, 4]});
});


test('a slow unplotted channel does not limit a fast device; plotted channels do', async ({page}) => {
  await page.request.post('/api/demo');
  const state = await (await page.request.get('/api/state')).json();
  state.recording = false; state.series = []; state.points = []; state.total_points = 0;
  state.devices = [state.devices.find(d => d.connected)];
  const device = state.devices[0];
  device.sensors[0].minimum_ms = 50;  // Force: max 20 Hz; accelerations: max 100 Hz
  device.period_ms = 50;
  await page.route('**/api/state?*', route => route.fulfill({json: state}));
  await page.route('**/api/configure', route => {
    Object.assign(device, {period_ms: route.request().postDataJSON().periods[device.id]});
    return route.fulfill({json: state});
  });
  let selections;
  await page.route('**/api/start', route => { selections = route.request().postDataJSON().selections; return route.fulfill({json: state}); });
  await page.goto('/');
  const card = page.locator(`[data-device="${device.id}"]`);
  // At 50 ms every channel is recorded; going faster warns that Force is lost.
  await expect(page.locator('#channels')).toHaveText('4');
  await expect(page.locator('#recording-note')).not.toHaveClass(/warning/);
  await card.locator('.period-input').fill('10');
  await card.locator('.period-input').press('Enter');
  await expect(page.locator('#notice')).toContainText('Force (max 20 Hz) will not be recorded and won’t appear in either CSV');
  await expect(page.locator('#notice')).toContainText('Choose 50 ms or longer');
  await expect(page.locator('#recording-note')).toContainText('no data for it, in the graphs or in either CSV');
  await expect(page.locator('#recording-note')).toHaveClass(/warning/);
  await expect(card.locator('.sampling-max')).toContainText('Max 100 Hz');
  await expect(card.locator('.sampling-channels').first()).toContainText('Force up to 20 Hz');
  await expect(page.locator('#recording-note')).toContainText('Will not be recorded: ');
  await expect(page.locator('#channels')).toHaveText('3');
  const graph = page.locator('.graph').first();
  await graph.locator('summary').click();
  await graph.locator(`[data-series="${device.id}/2"]`).check();
  await page.locator('#start').click();
  await expect.poll(() => selections).toEqual({[device.id]: [2, 3, 4]});
  // Plotting Force at 10 ms is impossible: the device shares one interval.
  await graph.locator('summary').click();
  await graph.locator(`[data-series="${device.id}/1"]`).check();
  await page.keyboard.press('Escape');
  await expect(page.locator('#recording-note')).toContainText('Can’t start');
  await expect(page.locator('#start')).toBeDisabled();
  await expect(card.locator('.sampling-channels').last()).toContainText('Plotted channels limit this device to 20 Hz');
  await expect(card.locator('.period-input')).toHaveAttribute('min', '50');
  await page.request.post('/api/disconnect', {data: {device_id: device.id}});
});

test('an experiment saves to a file and reopens with its graphs, settings and data', async ({page}) => {
  // Start from a clean session: earlier tests share this server.
  for (const device of (await (await page.request.get('/api/state')).json()).devices.filter(d => d.connected)) {
    await page.request.post('/api/disconnect', {data: {device_id: device.id}});
  }
  await page.request.post('/api/reset');
  await page.goto('/');
  await page.getByRole('button', {name: 'Add demo device'}).click();
  await expect(page.locator('#device-count')).not.toHaveText('0');
  const id = (await (await page.request.get('/api/state')).json()).devices.find(d => d.connected).id;
  await page.getByRole('textbox', {name: 'Experiment name', exact: true}).fill('Pendulum');
  await page.getByRole('textbox', {name: 'Experiment name', exact: true}).press('Tab');
  const graph = page.locator('.graph').first();
  await graph.locator('summary').click();
  await graph.locator(`[data-series="${id}/2"]`).check();
  await page.keyboard.press('Escape');
  await page.locator(`[data-period-device="${id}"]`).fill('25');
  await page.locator(`[data-period-device="${id}"]`).press('Enter');
  await expect(page.locator(`[data-device="${id}"] .period-rate`)).toHaveText('= 40 Hz');
  await page.getByRole('button', {name: 'Start collection', exact: true}).click();
  await expect.poll(async () => Number((await page.locator('#samples').innerText()).replaceAll(',', ''))).toBeGreaterThan(20);
  await page.getByRole('button', {name: 'Stop collection', exact: true}).click();
  await expect(page.locator('#status')).toHaveText('Collection stopped');
  const samples = await page.locator('#samples').innerText();
  const downloadPromise = page.waitForEvent('download');
  await page.getByRole('button', {name: 'Save experiment'}).click();
  const download = await downloadPromise;
  expect(download.suggestedFilename()).toBe('Pendulum.physllama');
  const file = test.info().outputPath('Pendulum.physllama');
  await download.saveAs(file);

  // Clear everything, then reopen the file.
  await page.request.post('/api/disconnect', {data: {device_id: id}});
  await page.request.post('/api/reset');
  await page.request.post('/api/experiment', {data: {name: 'Something else'}});
  await page.reload();
  await expect(page.locator('#samples')).toHaveText('0');
  await page.getByRole('button', {name: 'Open experiment'}).click();
  await page.locator('#experiment-file').setInputFiles(file);
  await expect(page.locator('#samples')).toHaveText(samples);
  await expect(page.getByRole('textbox', {name: 'Experiment name', exact: true})).toHaveValue('Pendulum');
  await expect(page.locator('#notice')).toBeHidden();
  await expect(page.locator(`[data-period-device="${id}"]`)).toHaveValue('25');
  await expect(page.locator('.graph').first().locator('.selection-count')).toHaveText('1 selected');
  await expect.poll(() => page.locator('.plot').first().evaluate(el => el.data?.[0]?.x.length)).toBeGreaterThan(0);
  await expect(page.locator('#run-number')).toContainText('1');
  await expect(page.locator('#run-note')).toContainText('Start begins run 2');
  await expect(page.locator('#start')).toHaveAttribute('title', 'Start run 2');
  // Continuing adds a second run after the saved one, marked on the graph.
  await page.getByRole('button', {name: 'Start collection', exact: true}).click();
  await expect.poll(async () => (await (await page.request.get('/api/state')).json()).run).toBe(2);
  await expect(page.locator('#run-number')).toContainText('2 recording');
  await expect(page.locator('#run-note')).toContainText('Recording run 2');
  await page.getByRole('button', {name: 'Stop collection', exact: true}).click();
  await expect.poll(() => page.locator('.plot').first().evaluate(el => (el.layout.annotations || []).map(a => a.text))).toEqual(['Run 1', 'Run 2']);
  await expect.poll(() => page.locator('.plot').first().evaluate(el => el.layout.xaxis.title.text)).toBe('Time since first Start (s)');
  // Opening over existing data asks first; invalid files are explained.
  await page.getByRole('button', {name: 'Open experiment'}).click();
  await expect(page.locator('#open-dialog')).toBeVisible();
  await page.getByRole('button', {name: 'Cancel'}).click();
  await page.locator('#experiment-file').setInputFiles({name: 'notes.json', mimeType: 'application/json', buffer: Buffer.from('{"hello": 1}')});
  await expect(page.locator('#notice')).toContainText('not a PhysLlama experiment file');
  await page.request.post('/api/disconnect', {data: {device_id: id}});
  await page.request.post('/api/reset');
});
