import { test as base } from '@playwright/test';
import type { ApiLoggerConfig } from './types';
import { wrapRequestContext } from './wrapRequestContext';

export interface ApiLoggerOptions {
  /**
   * Logger configuration. Settable project-wide in playwright.config.ts
   * (use: { apiLog: { curl: true } }) or per-suite via test.use().
   */
  apiLog: ApiLoggerConfig;
}

/**
 * Drop-in replacement for @playwright/test's `test`: the built-in `request`
 * fixture is transparently wrapped with the API logger.
 */
export const test = base.extend<ApiLoggerOptions>({
  apiLog: [{}, { option: true }],
  request: async ({ request, apiLog, baseURL, extraHTTPHeaders }, use) => {
    await use(wrapRequestContext(request, {
      ...apiLog,
      baseURL: apiLog.baseURL ?? baseURL,
      extraHTTPHeaders: apiLog.extraHTTPHeaders ?? extraHTTPHeaders,
    }));
  },
});

export { expect } from '@playwright/test';
