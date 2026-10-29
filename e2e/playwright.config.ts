import { defineConfig } from '@playwright/test';

const PORT = Number(process.env.PLP_E2E_PORT || 4173);

export default defineConfig({
  testDir: './specs',
  timeout: 20_000,
  retries: 0,
  workers: 2,
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
    ...(process.env.PLP_E2E_BROWSERS === 'all' ?
      [
        { name: 'firefox', use: { browserName: 'firefox' as const }, testIgnore: /noop\.spec/ },
        { name: 'webkit', use: { browserName: 'webkit' as const }, testIgnore: /noop\.spec/ },
      ] : []),
  ],
});
