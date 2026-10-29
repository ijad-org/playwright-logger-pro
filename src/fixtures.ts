import { test as base } from '@playwright/test';
import type { ApiLoggerConfig } from './types';
import { wrapRequestContext } from './wrapRequestContext';
import { BrowserLogSession, NOOP_HANDLE } from './browser/session';
import type { BrowserLogHandle } from './browser/session';
import { getRegistry } from './browser/registry';
import { installBrowserHooks } from './browser/install';
import { ensureStackHygiene } from './browser/stackHygiene';
import { resolveBrowserConfig } from './browser/types';
import type { BrowserLoggerConfig } from './browser/types';

export interface ApiLoggerOptions {
  /**
   * Logger configuration. Settable project-wide in playwright.config.ts
   * (use: { apiLog: { curl: true } }) or per-suite via test.use().
   */
  apiLog: ApiLoggerConfig;
}

export interface BrowserLoggerOptions {
  /**
   * Browser-action logging. On by default but quiet: the timeline is printed
   * and attached to the report only when a test fails. Set
   * `browserLog: { enabled: false }` to turn it off.
   */
  browserLog: BrowserLoggerConfig;
}

/** For `defineConfig<LoggerOptions>()`. */
export type LoggerOptions = ApiLoggerOptions & BrowserLoggerOptions;

export interface BrowserLoggerFixtures {
  /** Add notes to this test's browser timeline and read its events. */
  browserLogger: BrowserLogHandle;
}

interface InternalFixtures {
  _plpSession: BrowserLogSession | null;
}

/**
 * Drop-in replacement for @playwright/test's `test`: the built-in `request`
 * fixture is transparently wrapped with the API logger, and the actions a
 * test performs in the browser are recorded (see `browserLog`).
 */
export const test = base.extend<LoggerOptions & BrowserLoggerFixtures & InternalFixtures>({
  apiLog: [{}, { option: true }],
  browserLog: [{}, { option: true }],

  _plpSession: [async ({ browserLog, apiLog, httpCredentials, extraHTTPHeaders }, use, testInfo) => {
    const cfg = resolveBrowserConfig(browserLog, { apiLog, httpCredentials, extraHTTPHeaders });
    if (!cfg.enabled) {
      await use(null);
      return;
    }
    ensureStackHygiene();
    const titlePath = Array.isArray(testInfo.titlePath) ? testInfo.titlePath : [testInfo.title];
    const session = new BrowserLogSession(cfg, {
      title: titlePath.filter(Boolean).join(' › '),
      project: testInfo.project?.name,
    });
    getRegistry().activeSession = session;
    try {
      await use(session);
    } finally {
      session.endCapture();
      session.detach();
      const reg = getRegistry();
      if (reg.activeSession === session) reg.activeSession = null;
    }
  }, { auto: true }],

  // Overriding `context` covers the default page, popups and context.newPage().
  context: async ({ context, _plpSession }, use) => {
    _plpSession?.attachContext(context);
    await use(context);
    // Playwright's own teardown (tracing, closing the context) follows: not part of the test.
    _plpSession?.endCapture();
  },

  // Worker scope; only runs for tests that use a browser.
  browser: [async ({ browser }, use) => {
    installBrowserHooks(browser);
    await use(browser);
  }, { scope: 'worker' }],

  request: async ({ request, apiLog, baseURL, extraHTTPHeaders, _plpSession }, use) => {
    const config = {
      ...apiLog,
      baseURL: apiLog.baseURL ?? baseURL,
      extraHTTPHeaders: apiLog.extraHTTPHeaders ?? extraHTTPHeaders,
    };
    await use(wrapRequestContext(request, _plpSession ? _plpSession.teeApiLog(config) : config));
  },

  browserLogger: async ({ _plpSession }, use) => {
    await use(_plpSession?.handle ?? NOOP_HANDLE);
  },
});

export { expect } from '@playwright/test';
export type { BrowserLogHandle, BrowserLoggerConfig };
