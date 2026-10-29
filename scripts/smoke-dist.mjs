// ESM consumers: the package resolves through its own `exports` map.
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import * as main from 'playwright-logger-pro';
import * as fixtures from 'playwright-logger-pro/fixtures';

for (const name of [
  'wrapRequestContext', 'buildCurl', 'resolveConfig', 'DEFAULT_CONFIG', 'redactUrl',
  'attachBrowserLogger', 'resolveBrowserConfig', 'DEFAULT_BROWSER_CONFIG', 'DEFAULT_SENSITIVE_SELECTORS',
  'DEFAULT_SENSITIVE_KEYS', 'renderBrowserEventText', 'renderBrowserEventJsonl',
]) {
  assert.notEqual(main[name], undefined, `playwright-logger-pro (import) is missing ${name}`);
}
assert.equal(typeof fixtures.test, 'function', 'fixtures: test');
assert.equal(typeof fixtures.test.step, 'function', 'fixtures: test.step');
assert.notEqual(fixtures.expect, undefined, 'fixtures: expect');

// A CJS copy and this ESM copy share one registry: loading both must not double patch.
const cjs = createRequire(import.meta.url)('playwright-logger-pro');
assert.equal(typeof cjs.attachBrowserLogger, 'function');
console.log('smoke (esm): ok');
