import { ensureStackHygiene } from './stackHygiene';
import { getRegistry } from './registry';
import { BrowserLogSession, NOOP_HANDLE } from './session';
import type { BrowserLogHandle } from './session';
import { resolveBrowserConfig } from './types';
import type { BrowserLoggerConfig } from './types';

/** The fixture session of the running test, if there is one. */
export function getActiveSession(): BrowserLogSession | null {
  const active = getRegistry().activeSession;
  return active instanceof BrowserLogSession ? active : null;
}

type Target = { pages?: unknown } & object;

/**
 * Log the browser activity of a Page or BrowserContext you manage yourself
 * (scripts, global setup, a page shared from `beforeAll`).
 *
 * - Inside a test that uses the `test` fixtures, the objects join that test's
 *   timeline and follow its print/attach/file rules.
 * - Elsewhere the returned handle prints live to `sink`, and objects that
 *   outlive a single test route their events to whichever test is running.
 */
export function attachBrowserLogger(target: object, config: BrowserLoggerConfig = {}): BrowserLogHandle {
  const cfg = resolveBrowserConfig(config);
  if (!cfg.enabled) return NOOP_HANDLE;
  ensureStackHygiene();
  const isContext = typeof (target as Target).pages === 'function';

  const active = getActiveSession();
  if (active) {
    if (isContext) active.attachContext(target);
    else active.attachPage(target);
    return active.handle;
  }

  const session = new BrowserLogSession(cfg, {}, cfg.print !== false);
  session.floating = true;
  if (isContext) session.attachContext(target);
  else session.attachPage(target);
  return session.handle;
}
