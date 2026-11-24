const { test, expect } = require('@playwright/test');

async function createGroup(page, name) {
  await page.goto('/');
  await expect(page.locator('#classroom-lobby')).toBeVisible();
  await page.getByLabel('Group name', {exact: true}).fill(name);
  await page.getByRole('button', {name: 'Create group', exact: true}).click();
  await expect(page.locator('#current-group-name')).toHaveText(name);
  await expect(page.locator('#workspace')).toBeVisible();
}
async function demoChannel(page, number) {
  await page.getByRole('button', {name: 'Add demo device'}).click();
  const graph = page.locator('.graph').first();
  await graph.locator('summary').click();
  await graph.locator(`[data-series="demo-1/${number}"]`).check();
  await graph.locator('summary').click();
}

test('two groups record independently and a teammate rejoins the same experiment', async ({browser, baseURL}) => {
  const contexts = await Promise.all([1, 2, 3].map(() => browser.newContext({baseURL})));
  const [a, b, teammate] = await Promise.all(contexts.map(c => c.newPage()));
  try {
    await createGroup(a, 'Bench A');
    await createGroup(b, 'Bench B');
    const code = await a.locator('#current-group-code').innerText();
    await demoChannel(a, 1);
    await demoChannel(b, 2);
    await a.getByRole('textbox', {name: 'Experiment name', exact: true}).fill('Force experiment');
    await a.getByRole('textbox', {name: 'Experiment name', exact: true}).press('Tab');
    await b.getByRole('textbox', {name: 'Experiment name', exact: true}).fill('Acceleration experiment');
    await b.getByRole('textbox', {name: 'Experiment name', exact: true}).press('Tab');
    await a.locator('[data-period-device="demo-1"]').fill('20');
    await a.locator('[data-period-device="demo-1"]').press('Tab');
    await expect(a.locator('[data-device="demo-1"] .period-rate')).toHaveText('= 50 Hz');
    await a.getByRole('button', {name: 'Start collection', exact: true}).click();
    await b.getByRole('button', {name: 'Start collection', exact: true}).click();
    await expect(a.locator('#status')).toHaveText('Recording');
    await expect(b.locator('#status')).toHaveText('Recording');
    await expect(b.locator('[data-period-device="demo-1"]')).toHaveValue('50');
    await teammate.goto('/');
    await teammate.getByLabel('Group code', {exact: true}).fill(code);
    await teammate.getByRole('button', {name: 'Join group', exact: true}).click();
    await expect(teammate.locator('#current-group-name')).toHaveText('Bench A');
    await expect(teammate.locator('#status')).toHaveText('Recording');
    await expect(teammate.getByRole('textbox', {name: 'Experiment name', exact: true})).toHaveValue('Force experiment');
    await teammate.getByRole('button', {name: 'Stop collection', exact: true}).click();
    await expect(a.locator('#status')).toHaveText('Collection stopped');
    await expect(b.locator('#status')).toHaveText('Recording');
    await a.getByRole('button', {name: 'Reset collected data', exact: true}).click();
    await a.getByRole('button', {name: 'Clear data', exact: true}).click();
    await expect(a.locator('#samples')).toHaveText('0');
    await expect(b.locator('#status')).toHaveText('Recording');
    await a.reload();
    await expect(a.getByRole('textbox', {name: 'Experiment name', exact: true})).toHaveValue('Force experiment');
    await expect(b.getByRole('textbox', {name: 'Experiment name', exact: true})).toHaveValue('Acceleration experiment');
    await a.getByRole('button', {name: 'End group session', exact: true}).click();
    await a.getByRole('button', {name: 'End and release devices', exact: true}).click();
    await expect(a.locator('#classroom-lobby')).toBeVisible();
    await expect(teammate.locator('#classroom-lobby')).toBeVisible();
    await expect(b.locator('#status')).toHaveText('Recording');
    await b.getByRole('button', {name: 'Stop collection', exact: true}).click();
    const exportPromise = b.waitForEvent('download');
    await b.locator('#export').click();
    let csv = '';
    for await (const part of await (await exportPromise).createReadStream()) csv += part;
    expect(csv).toContain('Acceleration X [m/s²]');
    expect(csv).toContain('Force [N]');
    const graphExport = b.waitForEvent('download');
    await b.locator('.graph-export').first().click();
    let graphCSV = '';
    for await (const part of await (await graphExport).createReadStream()) graphCSV += part;
    expect(graphCSV).toContain('Acceleration X [m/s²]');
    expect(graphCSV).not.toContain('Force [N]');
    await b.screenshot({path: 'test-results/classroom-workspace.png', fullPage: true});
  } finally {
    for (const context of contexts) await context.close();
  }
});

test('group entry handles bad codes, reserves controls and fits a mobile viewport', async ({page}) => {
  await page.goto('/');
  await page.getByLabel('Group code', {exact: true}).fill('wrong-code');
  await page.getByRole('button', {name: 'Join group', exact: true}).click();
  await expect(page.locator('#lobby-error')).toContainText('Group code not found');
  await page.setViewportSize({width: 390, height: 844});
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
  await page.screenshot({path: 'test-results/classroom-lobby.png', fullPage: true});
  await createGroup(page, 'Mobile bench');
  const snapshot = {workspace: {}, supported_devices: [], devices: [{id: 'exact-hardware-id',
    name: 'Smart Cart 123-456>5', hardware_name: 'Smart Cart 123-456>5', serial: '123-456',
    family: 'PASCO Smart Cart', demo: false, connected: false, owned: false, reserved_by: 'Another bench',
    sensors: [], selected: [], battery: null, charging: false}],
    series: [], recording: false, total_points: 0, period_ms: 50, generation: 'reserved',
    points: [], cursor: 0, elapsed: 0, error: null};
  await page.route('**/api/state?*', route => route.fulfill({json: snapshot}));
  await expect(page.locator('.reservation-label')).toHaveText('In use by Another bench');
  await expect(page.getByRole('button', {name: 'In use', exact: true})).toBeDisabled();
  await expect(page.getByRole('button', {name: 'Rename device', exact: true})).toBeDisabled();
  await expect(page.locator('.device-serial')).toContainText('123-456');
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
});
