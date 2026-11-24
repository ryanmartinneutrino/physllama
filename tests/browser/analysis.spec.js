const {test, expect} = require('@playwright/test');

async function fixture(page, count = 5) {
  const sensors = [{number: 1, name: 'Position', unit: 'm'}, {number: 2, name: 'Force', unit: 'N'}]
    .map(s => ({...s, supported: true, minimum_ms: 10, maximum_ms: 10000, step_ms: 10, excluded_channels: []}));
  const points = [];
  for (let run = 1; run <= 2; run++) for (let i = 0; i < count; i++) {
    const t = (run - 1) * 10 + i * (count === 5 ? 1 : 5 / count);
    for (const sensor of sensors) points.push({seq: points.length + 1, series: `demo-1/${sensor.number}`, run, t,
      value: sensor.number === 1 ? 1 + 2 * t : 3 - t + .5 * t * t});
  }
  const snapshot = {devices: [{id: 'demo-1', name: 'Demo test', connected: true, demo: true, sensors,
    selected: [1, 2], period_ms: 50}], series: sensors.map(s => ({...s, id: `demo-1/${s.number}`, device: 'Demo test', device_id: 'demo-1', demo: true})),
    recording: false, run: 2, generation: 'analysis-test', elapsed: 14, total_points: points.length, cursor: points.length, error: null};
  await page.route('**/api/state?*', route => {
    const after = Number(new URL(route.request().url()).searchParams.get('after'));
    return route.fulfill({json: {...snapshot, points: snapshot.total_points ? points.filter(p => p.seq > after) : []}});
  });
  await page.goto('/');
  await expect(page.locator('#samples')).toHaveText(points.length.toLocaleString());
  await page.locator('.graph-sensors summary').click();
  await page.locator('[data-series="demo-1/1"]').check();
  await page.locator('[data-series="demo-1/2"]').check();
  await page.locator('.graph-sensors summary').click();
  await expect.poll(() => page.locator('.plot').evaluate(el => el.data?.length)).toBe(2);
  return {snapshot, points};
}

test('analysis follows run scope and zoom, with raw table, histogram and weighted fits', async ({page}) => {
  const errors = []; page.on('pageerror', error => errors.push(error.message));
  const {snapshot} = await fixture(page);
  await page.getByRole('button', {name: 'Statistics', exact: true}).click();
  const stats = page.locator('.stats-table tbody tr').first();
  await expect(stats.locator('td').nth(1)).toHaveText('10');
  await expect(stats.locator('td').nth(4)).toHaveText('15');
  await page.getByRole('button', {name: 'Data table', exact: true}).click();
  await expect(page.locator('.data-table tbody tr')).toHaveCount(10);
  await page.getByLabel('Graph data scope').selectOption('current');
  await expect(stats.locator('td').nth(1)).toHaveText('5');
  await expect(page.locator('.data-table tbody tr')).toHaveCount(5);
  expect(await page.locator('.plot').evaluate(el => el.data.every(trace => trace.customdata.every(run => run === 2)))).toBe(true);
  await page.locator('.plot').evaluate(el => Plotly.relayout(el, {'xaxis.range': [11, 13], 'yaxis.range': [23, 24]}));
  await expect(stats.locator('td').nth(1)).toHaveText('3');
  await expect(stats.locator('td').nth(2)).toHaveText('23');
  await expect(stats.locator('td').nth(3)).toHaveText('27');
  await expect(stats.locator('td').nth(4)).toHaveText('25');
  await expect(page.locator('.data-table tbody tr')).toHaveCount(5);
  await page.getByLabel('Visible time range only').check();
  await expect(page.locator('.data-table tbody tr')).toHaveCount(3);
  await stats.getByRole('button', {name: /Histogram/}).click();
  await expect(page.getByRole('dialog')).toContainText('3 samples');
  expect(await page.locator('.histogram-plot').evaluate(el => el.data[0].y.reduce((a, b) => a + b, 0))).toBe(3);
  await page.getByRole('button', {name: 'Close histogram'}).click();
  await page.getByRole('button', {name: 'Fit', exact: true}).click();
  await page.getByLabel('Y uncertainty', {exact: true}).fill('0.5');
  await page.getByRole('button', {name: 'Fit visible data'}).click();
  await expect(page.locator('.fit-results')).toBeVisible();
  const parameters = page.locator('.fit-results table').first().locator('tbody tr');
  await expect(parameters.nth(0).locator('td').nth(1)).toHaveText('1');
  await expect(parameters.nth(1).locator('td').nth(1)).toHaveText('2');
  await expect(page.locator('.fit-message')).toContainText('Degrees of freedom = 1');
  await expect(page.locator('.fit-preview .main-svg').first()).toBeVisible();
  await page.getByLabel('Fit sensor', {exact: true}).selectOption('demo-1/2');
  await expect(page.locator('.fit-results')).toBeHidden();
  await page.getByLabel('Fit function').selectOption('quadratic');
  await page.getByRole('button', {name: 'Fit visible data'}).click();
  await expect(parameters.nth(0).locator('td').nth(1)).toHaveText('3');
  await expect(parameters.nth(1).locator('td').nth(1)).toHaveText('-1');
  await expect(parameters.nth(2).locator('td').nth(1)).toHaveText('0.5');
  await expect(page.locator('.fit-message')).toContainText('undefined (zero degrees of freedom)');
  await page.locator('.plot').evaluate(el => Plotly.relayout(el, {'xaxis.range': [11.1, 11.9]}));
  await expect(page.locator('.fit-results')).toBeHidden();
  await expect(stats.locator('td').nth(1)).toHaveText('0');
  await expect(stats.getByRole('button')).toBeDisabled();
  await page.getByRole('button', {name: 'Fit visible data'}).click();
  await expect(page.locator('.fit-message')).toContainText('at least 3');
  await page.getByRole('button', {name: 'Fit view', exact: true}).click();
  await expect(stats.locator('td').nth(1)).toHaveText('5');
  await page.getByLabel('Y uncertainty', {exact: true}).fill('0');
  await page.getByRole('button', {name: 'Fit visible data'}).click();
  await expect(page.locator('.fit-message')).toContainText('greater than zero');
  await page.getByLabel('Y uncertainty', {exact: true}).fill('0.5');
  await page.getByRole('button', {name: 'Fit visible data'}).click();
  await expect(page.locator('.fit-results')).toBeVisible();
  await page.setViewportSize({width: 1440, height: 1100});
  await page.screenshot({path: 'test-results/analysis-desktop.png', fullPage: true});
  await page.setViewportSize({width: 390, height: 844});
  await expect.poll(() => page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  await expect.poll(() => page.locator('.plot').evaluate(el => el._fullLayout.width)).toBeLessThan(390);
  await expect.poll(() => page.locator('.fit-preview').evaluate(el => el._fullLayout.width)).toBeLessThan(390);
  await page.screenshot({path: 'test-results/analysis-mobile.png', fullPage: true});
  // Scope persists independently of the analysis panels and is saved in experiment files.
  const downloadPromise = page.waitForEvent('download');
  await page.getByRole('button', {name: 'Save experiment', exact: true}).click();
  let saved = ''; for await (const chunk of await (await downloadPromise).createReadStream()) saved += chunk;
  expect(JSON.parse(saved).layout.graphs[0].scope).toBe('current');
  snapshot.recording = true;
  await expect(page.getByLabel('Graph data scope')).toBeDisabled();
  await expect(page.getByRole('button', {name: 'Statistics', exact: true})).toBeDisabled();
  await expect(page.locator('.fit-results')).toBeHidden();
  snapshot.recording = false;
  await expect(page.getByLabel('Graph data scope')).toBeEnabled();
  await page.reload();
  await expect(page.getByLabel('Graph data scope')).toHaveValue('current');
  expect(errors).toEqual([]);
});

test('analysis uses every raw sample despite graph reduction and paginates the table', async ({page}) => {
  await fixture(page, 5001);
  await page.getByLabel('Graph data scope').selectOption('current');
  await page.getByRole('button', {name: 'Statistics', exact: true}).click();
  await expect(page.locator('.stats-table tbody tr').first().locator('td').nth(1)).toHaveText('5001');
  expect(await page.locator('.plot').evaluate(el => el.data[0].x.length)).toBeLessThan(4000);
  await page.getByRole('button', {name: 'Data table', exact: true}).click();
  await expect(page.locator('.table-count')).toHaveText('5,001 timestamps');
  await expect(page.locator('.data-table tbody tr')).toHaveCount(100);
  await page.getByRole('button', {name: 'Next', exact: true}).click();
  await expect(page.locator('.table-page')).toHaveText('Page 2 of 51');
  await page.getByRole('button', {name: 'Fit', exact: true}).click();
  await page.getByLabel('Y uncertainty', {exact: true}).fill('1');
  await page.getByRole('button', {name: 'Fit visible data'}).click();
  await expect(page.locator('.fit-message')).toContainText('5001 samples');
});

test('missing samples, independent graph scopes, new runs and reset stay consistent', async ({page}) => {
  const {snapshot, points} = await fixture(page);
  await page.getByLabel('Graph data scope').selectOption('current');
  await page.getByRole('button', {name: 'Statistics', exact: true}).click();
  await page.getByRole('button', {name: '+ Add graph'}).click();
  const first = page.locator('.graph').first(), second = page.locator('.graph').nth(1);
  await second.locator('.graph-sensors summary').click();
  await second.locator('[data-series="demo-1/1"]').check();
  await second.getByRole('button', {name: 'Statistics', exact: true}).click();
  await expect(second.locator('.stats-table tbody tr td').nth(1)).toHaveText('10');
  await expect(first.locator('.stats-table tbody tr').first().locator('td').nth(1)).toHaveText('5');
  // A new current run must not fall back to older data, even before its first sample.
  await first.locator('.plot').evaluate(el => Plotly.relayout(el, {'xaxis.range': [11, 13]}));
  snapshot.run = 3;
  await expect(first.locator('.stats-table tbody tr').first().locator('td').nth(1)).toHaveText('0');
  await expect(second.locator('.stats-table tbody tr td').nth(1)).toHaveText('10');
  // Include mismatched sensor timestamps and a missing value, as real devices can produce.
  for (const p of [{series: 'demo-1/1', t: 25, value: 51}, {series: 'demo-1/2', t: 25.1, value: 2}, {series: 'demo-1/1', t: 26, value: null}]) {
    points.push({...p, run: 3, seq: points.length + 1});
  }
  snapshot.cursor = points.length; snapshot.total_points = points.length;
  await expect(first.locator('.stats-table tbody tr').first().locator('td').nth(1)).toHaveText('1');
  await expect.poll(() => first.locator('.plot').evaluate(el => el._fullLayout.xaxis.range[1])).toBeGreaterThan(25);
  await first.getByRole('button', {name: 'Data table', exact: true}).click();
  await expect(first.locator('.data-table tbody tr')).toHaveCount(3);
  await first.getByLabel('Visible time range only').check();
  await expect(first.locator('.data-table tbody tr')).toHaveCount(3);
  await expect(first.locator('.data-table tbody tr').nth(0).locator('td').nth(3)).toHaveText('');
  await expect(first.locator('.data-table tbody tr').nth(1).locator('td').nth(2)).toHaveText('');
  snapshot.generation = 'reset-analysis'; snapshot.total_points = 0; snapshot.cursor = 0; snapshot.run = 0;
  await expect(first.locator('.stats-table tbody tr').first().locator('td').nth(1)).toHaveText('0');
  await expect(first.locator('.data-table')).toContainText('No samples');
  await expect(second.locator('.stats-table tbody tr td').nth(1)).toHaveText('0');
});

test('histogram range and bin controls redraw, validate, and preserve graph statistics', async ({page}) => {
  const errors = []; page.on('pageerror', error => errors.push(error.message));
  await fixture(page);
  await page.getByLabel('Graph data scope').selectOption('current');
  await page.getByRole('button', {name: 'Statistics', exact: true}).click();
  const stats = page.locator('.stats-table tbody tr');
  await stats.first().getByRole('button', {name: /Histogram/}).click();
  const modal = page.getByRole('dialog');
  const plot = modal.locator('.histogram-plot');
  await expect(modal.getByLabel('Minimum value')).toHaveValue('21');
  await expect(modal.getByLabel('Maximum value')).toHaveValue('29');
  await expect(modal.getByLabel('Number of bins')).toHaveValue('3');
  await modal.getByLabel('Minimum value').fill('23');
  await modal.getByLabel('Maximum value').fill('27');
  await modal.getByLabel('Number of bins').fill('2');
  expect(await plot.evaluate(el => el.data[0].y.length)).toBe(3);
  await modal.getByRole('button', {name: 'Redraw', exact: true}).click();
  await expect.poll(() => plot.evaluate(el => el.data[0].y)).toEqual([1, 2]);
  expect(await plot.evaluate(el => el.layout.xaxis.range)).toEqual([23, 27]);
  await expect(modal.locator('.histogram-note')).toContainText('3 in histogram · 2 outside value range');
  await modal.getByLabel('Minimum value').fill('30');
  await modal.getByRole('button', {name: 'Redraw', exact: true}).click();
  await expect(modal.getByRole('alert')).toContainText('minimum less than maximum');
  expect(await plot.evaluate(el => el.data[0].y)).toEqual([1, 2]);
  await modal.getByLabel('Minimum value').fill('');
  await modal.getByRole('button', {name: 'Redraw', exact: true}).click();
  await expect(modal.getByRole('alert')).toContainText('finite range limits');
  await modal.getByLabel('Minimum value').fill('23');
  for (const count of ['1.5', '1001']) {
    await modal.getByLabel('Number of bins').fill(count);
    await modal.getByRole('button', {name: 'Redraw', exact: true}).click();
    await expect(modal.getByRole('alert')).toContainText('whole number of bins');
  }
  await modal.getByLabel('Minimum value').fill('100');
  await modal.getByLabel('Maximum value').fill('110');
  await modal.getByLabel('Number of bins').fill('4');
  await modal.getByLabel('Number of bins').press('Enter');
  await expect.poll(() => plot.evaluate(el => el.data[0].y)).toEqual([0, 0, 0, 0]);
  await expect(modal.locator('.histogram-note')).toContainText('0 in histogram · 5 outside value range');
  await expect(modal.locator('.histogram-error')).toBeEmpty();
  await page.setViewportSize({width: 390, height: 844});
  await expect.poll(() => plot.evaluate(el => el._fullLayout.width)).toBeLessThan(390);
  expect(await modal.evaluate(el => el.scrollWidth <= el.clientWidth)).toBe(true);
  await page.screenshot({path: 'test-results/histogram-controls-mobile.png'});
  await modal.getByRole('button', {name: 'Close histogram'}).click();
  await expect(stats.first().locator('td').nth(1)).toHaveText('5');
  await stats.nth(1).getByRole('button', {name: /Histogram/}).click();
  await expect(modal.getByLabel('Minimum value')).toHaveValue('43');
  await expect(modal.getByLabel('Maximum value')).toHaveValue('87');
  await expect(modal.getByLabel('Number of bins')).toHaveValue('3');
  await expect.poll(() => plot.evaluate(el => el.data[0].y.reduce((a, b) => a + b, 0))).toBe(5);
  expect(errors).toEqual([]);
});
