import * as path from 'node:path';
import { defineConfig } from '@playwright/test';

// Runs of the failed-test curl and colour checks (e2e/meta/failedcurl.test.ts): the list reporter
// followed by this package's reporter (PLP_REPORTER_OPTIONS, JSON) unless PLP_NO_PLP_REPORTER is set,
// and a JSON report in PLP_JSON_OUT for the attachments. The `apiLog` option is PLP_API_LOG (JSON).
const PORT = Number(process.env.PLP_E2E_PORT || 4181);
const options = process.env.PLP_REPORTER_OPTIONS ? JSON.parse(process.env.PLP_REPORTER_OPTIONS) : {};
const apiLog = process.env.PLP_API_LOG ? JSON.parse(process.env.PLP_API_LOG) : {};

export default defineConfig({
  testDir: './specs',
  workers: 1,
  retries: 0,
  outputDir: process.env.PLP_OUTPUT_DIR || path.join(__dirname, '..', '..', 'test-results', 'failed-curl'),
  reporter: [
    ['list'],
    ...(process.env.PLP_NO_PLP_REPORTER ? [] : [[path.join(__dirname, '..', '..', 'src', 'reporter.ts'), options] as [string, unknown]]),
    ['json', { outputFile: process.env.PLP_JSON_OUT }],
  ],
  use: { baseURL: `http://127.0.0.1:${PORT}`, ...({ apiLog } as Record<string, unknown>) },
  webServer: {
    command: 'node server.mjs',
    cwd: path.join(__dirname, '..', 'reporter'),
    url: `http://127.0.0.1:${PORT}/`,
    reuseExistingServer: false,
  },
  projects: [{ name: 'chromium' }],
});
