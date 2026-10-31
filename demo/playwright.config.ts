import { defineConfig } from '@playwright/test';

// `npm run demo`: three tests against the mock shop API (server.mjs), printed by the list reporter
// followed by this package's reporter. For the documentation (scripts/demo-output.mjs):
// PLP_DEMO_COLORS=1 forces colours although the output is piped, PLP_DEMO_THEME=dark|light switches
// to the true-colour palette of the screenshots.
const theme = process.env.PLP_DEMO_THEME;
const options = {
  ...(theme ? { theme } : {}),
  ...(theme || process.env.PLP_DEMO_COLORS ? { colors: true } : {}),
};

export default defineConfig({
  testDir: './specs',
  workers: 1,
  retries: 0,
  reporter: [
    ['list'],
    ['../src/reporter.ts', options],
  ],
  webServer: {
    command: 'node server.mjs',
    url: `http://127.0.0.1:${process.env.PLP_DEMO_API_PORT || 4310}/v1/products`,
    reuseExistingServer: true,
  },
  projects: [{ name: 'chromium' }],
});
