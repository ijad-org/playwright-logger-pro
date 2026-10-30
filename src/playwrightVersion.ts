import { createRequire } from 'node:module';
import path from 'node:path';

/**
 * How the running Playwright treats the headers of a request it redirects.
 * Measured on the fetch implementation of each release (playwright-core
 * `server/fetch.js`, or `coreBundle.js` from 1.60):
 *
 * - 1.30 - 1.31 lower-case every header name when the request is built, so the
 *   removals below always match.
 * - 1.32 - 1.59 keep the caller's header casing but remove headers by their
 *   exact lower-case name only: a `Cookie` or `Content-Type` set by the caller
 *   is forwarded, while one named `cookie` or the `content-type` Playwright
 *   adds itself is removed. `Authorization` is always forwarded, to other
 *   origins too.
 * - 1.60 and later remove headers case-insensitively and drop `Authorization`
 *   when the redirect leaves the origin.
 */
export interface RedirectRules {
  /** Headers are only removed on a redirect when their name is exactly lower-case. */
  exactCaseRemoval: boolean;
  /** `Authorization` is removed when the redirect target is another origin. */
  dropAuthorizationCrossOrigin: boolean;
}

/** The rules of the newest Playwright, also used when the version is unknown. */
const LATEST_RULES: RedirectRules = { exactCaseRemoval: false, dropAuthorizationCrossOrigin: true };

/**
 * The redirect rules of Playwright `version` ("1.45.0"). An unknown or
 * unparsable version gets the newest rules, which forward the least: the
 * printed curl never carries more than Playwright sent.
 */
export function redirectRulesFor(version: string | undefined): RedirectRules {
  const match = version === undefined ? null : /^(\d+)\.(\d+)/.exec(version);
  if (!match || Number(match[1]) !== 1) return LATEST_RULES;
  const minor = Number(match[2]);
  if (minor >= 60) return LATEST_RULES;
  return { exactCaseRemoval: minor >= 32, dropAuthorizationCrossOrigin: false };
}

const PACKAGES = ['@playwright/test', 'playwright-core', 'playwright'];

let detected: { version: string | undefined } | undefined;

/**
 * The version of the Playwright installed next to the test project, read
 * from its package.json (resolved from this library first, then from the
 * working directory). undefined when it cannot be found; this never throws.
 */
export function detectPlaywrightVersion(): string | undefined {
  if (detected) return detected.version;
  const bases = [
    ...(typeof __dirname === 'string' ? [path.join(__dirname, 'noop.js')] : []),
    path.join(process.cwd(), 'noop.js'),
  ];
  let version: string | undefined;
  search: for (const base of bases) {
    let req: NodeRequire;
    try {
      req = createRequire(base);
    } catch {
      continue;
    }
    for (const name of PACKAGES) {
      try {
        const found = (req(`${name}/package.json`) as { version?: unknown }).version;
        if (typeof found === 'string') {
          version = found;
          break search;
        }
      } catch {
        // not installed here, or package.json is not exported
      }
    }
  }
  detected = { version };
  return version;
}
