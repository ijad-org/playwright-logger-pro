// CommonJS consumers: the package resolves through its own `exports` map.
const assert = require('node:assert/strict');

const main = require('playwright-logger-pro');
for (const name of [
  'wrapRequestContext', 'buildCurl', 'resolveConfig', 'DEFAULT_CONFIG', 'redactUrl',
  'attachBrowserLogger', 'resolveBrowserConfig', 'DEFAULT_BROWSER_CONFIG', 'DEFAULT_SENSITIVE_SELECTORS',
  'DEFAULT_SENSITIVE_KEYS', 'renderBrowserEventText', 'renderBrowserEventJsonl',
]) {
  assert.notEqual(main[name], undefined, `playwright-logger-pro (require) is missing ${name}`);
}
const fixtures = require('playwright-logger-pro/fixtures');
assert.equal(typeof fixtures.test, 'function', 'fixtures: test');
assert.equal(typeof fixtures.test.step, 'function', 'fixtures: test.step');
assert.notEqual(fixtures.expect, undefined, 'fixtures: expect');
assert.equal(require('playwright-logger-pro/package.json').name, 'playwright-logger-pro');

// The same disabled config resolves identically in both formats.
assert.equal(main.resolveBrowserConfig({ enabled: false }).enabled, false);
console.log('smoke (cjs): ok');
