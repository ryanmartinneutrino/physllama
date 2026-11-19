const { mkdtempSync } = require('node:fs');
const { tmpdir } = require('node:os');
const { join } = require('node:path');
const { defineConfig } = require('@playwright/test');
const python = process.platform === 'win32' ? '.venv\\Scripts\\python.exe' : '.venv/bin/python';
module.exports = defineConfig({
  testDir: './tests/browser',
  workers: 1,
  use: {headless: true,
    launchOptions: process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE ? {executablePath: process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE} : {}},
  projects: [
    {name: 'individual', testIgnore: '**/classroom.spec.js', use: {baseURL: 'http://127.0.0.1:8766'}},
    {name: 'classroom', testMatch: '**/classroom.spec.js', use: {baseURL: 'http://127.0.0.1:8767'}},
  ],
  webServer: [
    {command: `${python} run.py --no-browser --port 8766`, url: 'http://127.0.0.1:8766', reuseExistingServer: false,
      env: {PHYSLLAMA_DATA_DIR: mkdtempSync(join(tmpdir(), 'physllama-ui-'))}},
    {command: `${python} run.py --multi --port 8767`, url: 'http://127.0.0.1:8767', reuseExistingServer: false,
      env: {PHYSLLAMA_DATA_DIR: mkdtempSync(join(tmpdir(), 'physllama-classroom-'))}},
  ],
});
