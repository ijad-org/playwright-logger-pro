import * as path from 'node:path';
import { defineConfig } from '@playwright/test';

// Runs of the reporter checks (e2e/meta/reporter.test.ts): PLP_WORKERS workers, the list reporter
// followed by this package's reporter (options in PLP_REPORTER_OPTIONS as JSON).
const PORT = Number(process.env.PLP_E2E_PORT || 4180);
const options = process.env.PLP_REPORTER_OPTIONS ? JSON.parse(process.env.PLP_REPORTER_OPTIONS) : {};

export default defineConfig({
  testDir: './specs',
  workers: Number(process.env.PLP_WORKERS || 1),
  fullyParallel: true,
  retries: 0,
  reporter: [['list'], [path.join(__dirname, '..', '..', 'src', 'reporter.ts'), options]],
  use: { baseURL: `http://127.0.0.1:${PORT}` },
  webServer: {
    command: 'node server.mjs',
    cwd: __dirname,
    url: `http://127.0.0.1:${PORT}/`,
    reuseExistingServer: false,
  },
  projects: [{ name: 'chromium' }],
});
