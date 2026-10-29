// Plain object on purpose: this file must not import its own copy of @playwright/test.
// Run through ../gen-doc-samples.mjs, which uses the repository's Playwright.
export default {
  testDir: '.',
  testMatch: 'samples.spec.ts',
  timeout: 30_000,
  workers: 1,
  reporter: 'null',
  use: { browserName: 'chromium', baseURL: 'http://127.0.0.1:4399' },
};
