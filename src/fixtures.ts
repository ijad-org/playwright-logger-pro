import * as pw from '@playwright/test';
import type { ApiLoggerConfig } from './types';
import { resolveConfig } from './types';
import { writeCurlScript } from './curlFile';
import { wrapRequestContext } from './wrapRequestContext';
import { BrowserLogSession, NOOP_HANDLE } from './browser/session';
import type { BrowserLogHandle } from './browser/session';
import { getRegistry } from './browser/registry';
import { installBrowserHooks } from './browser/install';
import { ensureStackHygiene } from './browser/stackHygiene';
import { writeOutputs } from './browser/output';
import { wrapTestType } from './browser/steps';
import { resolveBrowserConfig } from './browser/types';
import type { BrowserLoggerConfig } from './browser/types';
import { markRunnerTty } from './env';

// Spec files are loaded in the runner process: if its stdout is a terminal, tell the workers
// (their own stdout is a pipe) so the printed curl is coloured by default. Does nothing in a worker.
markRunnerTty();

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
const base = pw.test;

export const test = wrapTestType(base.extend<LoggerOptions & BrowserLoggerFixtures & InternalFixtures>({
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
      await writeOutputs(session, testInfo);
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

  request: async ({ request, apiLog, baseURL, extraHTTPHeaders, _plpSession }, use, testInfo) => {
    // Resolved here, from the user's own sink, because teeApiLog() replaces the sink:
    // the wrapper must not mistake it for a custom one when it picks the colours.
    const resolved = resolveConfig({
      ...apiLog,
      baseURL: apiLog.baseURL ?? baseURL,
      extraHTTPHeaders: apiLog.extraHTTPHeaders ?? extraHTTPHeaders,
    });
    const config = _plpSession ? _plpSession.teeApiLog(resolved) : resolved;
    const curls: string[] = [];
    await use(wrapRequestContext(request, config, { onCurl: (plain) => curls.push(plain) }));
    await writeCurlScript(curls, testInfo, { log: config.sink });
  },

  browserLogger: async ({ _plpSession }, use) => {
    await use(_plpSession?.handle ?? NOOP_HANDLE);
  },
}));

/**
 * `mergeTests` (Playwright 1.39+) that keeps the browser log's `test.step`
 * integration on the merged test. Merging through Playwright's own
 * `mergeTests` still logs actions, just without step markers.
 */
// Playwright's own signature when it has one (1.39+); a loose one on older type packages.
type MergeTests = typeof pw extends { mergeTests: infer F } ? F : (...tests: pw.TestType<never, never>[]) => pw.TestType<never, never>;

export const mergeTests: MergeTests = ((...tests: unknown[]) => {
  const merge = (pw as { mergeTests?: (...t: unknown[]) => unknown }).mergeTests;
  if (typeof merge !== 'function') throw new Error('mergeTests needs @playwright/test 1.39 or newer');
  return wrapTestType(merge(...tests) as Parameters<typeof wrapTestType>[0]);
}) as unknown as MergeTests;

export const expect = pw.expect;
export type { BrowserLogHandle, BrowserLoggerConfig };
