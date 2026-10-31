import * as path from 'node:path';
import { defineConfig } from '@playwright/test';

const PORT = Number(process.env.PLP_E2E_PORT || 4173);

export default defineConfig({
  testDir: './specs',
  timeout: Number(process.env.PLP_META_TIMEOUT || 8000),
  retries: 0,
  workers: 1,
  reporter: [[path.join(__dirname, 'reporter.cjs')]],
  outputDir: process.env.PLP_META_OUTPUT_DIR || path.join(__dirname, '..', '..', 'test-results', 'meta'),
  use: { baseURL: `http://127.0.0.1:${PORT}`, ...({ apiLog: { format: 'verbose' } } as Record<string, unknown>), trace: 'off', screenshot: 'off', video: 'off' },
  webServer: {
    command: 'node server.mjs',
    cwd: path.join(__dirname, '..'),
    url: `http://127.0.0.1:${PORT}/`,
    reuseExistingServer: true,
  },
  projects: [{ name: 'chromium', use: { browserName: 'chromium' } }],
});
