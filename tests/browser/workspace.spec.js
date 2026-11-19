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
  await expect(page.locator('#start')).toBeDisabled();
  const first = page.locator('.graph').first();
  await first.locator('summary').click();
  await first.locator('[data-series="demo-1/1"]').check();
  await first.locator('[data-series="demo-1/2"]').check();
  await expect(page.locator('#channels')).toHaveText('2');
  await page.getByRole('button', {name: 'Add demo device'}).click();
  await expect(page.locator('#device-count')).toHaveText('2');
  await first.locator('summary').click();
  await first.locator('[data-series="demo-2/1"]').check();
  await page.locator('#period').fill('20');
  await page.locator('#period').press('Tab');
  await expect(page.locator('#sample-rate')).toHaveText('50 Hz');
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
  expect(started.devices.find(d => d.id === 'demo-1').selected).toEqual([1, 2]);
  expect(started.devices.find(d => d.id === 'demo-2').selected).toEqual([1]);
  await expect(page.locator('#scan')).toBeDisabled();
  await expect.poll(async () => Number((await page.locator('#samples').innerText()).replaceAll(',', ''))).toBeGreaterThan(30);
  await second.locator('summary').click();
  await expect(second.locator('[data-series="demo-1/3"]')).toBeDisabled();
  await second.locator('[data-series="demo-1/2"]').uncheck();
  await expect.poll(() => second.locator('.plot').evaluate(el => el.data?.length)).toBe(1);
  await expect(first.locator('[data-series="demo-1/2"]')).toBeChecked();
  await expect(page.locator('#channels')).toHaveText('3');
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
  await page.setViewportSize({width: 1440, height: 1050});
  await page.screenshot({path: 'test-results/workspace-recorded.png', fullPage: true});
  const downloadPromise = page.waitForEvent('download');
  await page.getByRole('button', {name: 'Export CSV'}).click();
  const download = await downloadPromise;
  expect(download.suggestedFilename()).toContain('DEMO.csv');
  const stream = await download.createReadStream();
  let csv = ''; for await (const chunk of stream) csv += chunk;
  expect(csv).toContain('Acceleration X,m/s²');
  expect(csv).toContain('Force,N');
  // A graph export includes exactly its sensors and all samples outside zoom.
  await second.locator('.plot').evaluate(el => window.Plotly.relayout(el, {'xaxis.range': [.1, .2]}));
  const graphDownloadPromise = page.waitForEvent('download');
  await second.getByRole('button', {name: 'Download CSV'}).click();
  const graphDownload = await graphDownloadPromise;
  expect(graphDownload.suggestedFilename()).toBe('Graph 2-DEMO.csv');
  let graphCSV = '';
  for await (const chunk of await graphDownload.createReadStream()) graphCSV += chunk;
  const rows = graphCSV.trim().split(/\r?\n/).slice(1).map(row => row.split(','));
  expect([...new Set(rows.map(row => `${row[3]}/${row[4]}`))].sort()).toEqual([
    'demo-1/Acceleration X', 'demo-2/Force',
  ]);
  const recorded = await (await page.request.get('/api/state')).json();
  expect(rows).toHaveLength(recorded.points.filter(p => ['demo-1/2', 'demo-2/1'].includes(p.series)).length);
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
