import { defineConfig } from '@playwright/test';

const PORT = Number(process.env.PLP_E2E_PORT || 4173);

export default defineConfig({
  testDir: './specs',
  timeout: 20_000,
  retries: 0,
  workers: 2,
  // Benchmarks only run through scripts/perf.mjs.
  ...(process.env.PLP_E2E_PERF ? { grep: /@perf/ } : { grepInvert: /@perf/ }),
  reporter: [['list']],
  use: {
    baseURL: `http://127.0.0.1:${PORT}`,
    trace: 'off',
    screenshot: 'off',
    video: 'off',
  },
  webServer: {
    command: 'node server.mjs',
    url: `http://127.0.0.1:${PORT}/`,
    reuseExistingServer: true,
  },
  projects: [
    { name: 'chromium', use: { browserName: 'chromium' }, testIgnore: /noop\.spec/ },
    // Dedicated project: browserLog switched off.
    {
      name: 'noop',
      testMatch: /noop\.spec/,
      use: { browserName: 'chromium', browserLog: { enabled: false } } as never,
    },
    ...(['firefox', 'webkit'] as const)
        .filter((name) => (process.env.PLP_E2E_BROWSERS ?? '').split(',').includes(name) || process.env.PLP_E2E_BROWSERS === 'all')
        .map((name) => ({ name, use: { browserName: name }, testIgnore: /noop\.spec/ })),
  ],
});
