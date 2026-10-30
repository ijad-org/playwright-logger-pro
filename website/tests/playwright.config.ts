import { defineConfig } from '@playwright/test';

const PORT = Number(process.env.DOCS_PORT || 3123);

// Run against a production build: `npm run build` first. Search only works in build/serve.
export default defineConfig({
  testDir: '.',
  timeout: 30_000,
  reporter: [['list']],
  use: { baseURL: `http://localhost:${PORT}/playwright-logger-pro/`, browserName: 'chromium' },
  webServer: {
    command: `npx docusaurus serve --no-open --port ${PORT}`,
    url: `http://localhost:${PORT}/playwright-logger-pro/`,
    cwd: '..',
    reuseExistingServer: true,
  },
});
