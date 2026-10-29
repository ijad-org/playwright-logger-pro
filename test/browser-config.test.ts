import { test } from 'node:test';
import assert from 'node:assert/strict';
import { DEFAULT_BROWSER_CONFIG, resolveBrowserConfig } from '../src/browser/types';
import {
  DEFAULT_SENSITIVE_KEY_PATTERNS,
  DEFAULT_SENSITIVE_SELECTORS,
} from '../src/browser/sensitive';
import { DEFAULT_CONFIG, DEFAULT_REDACT_HEADERS, detectColorSupport } from '../src/types';
import { matchesAny } from '../src/redact';

test('approved defaults: on, quiet on success, nothing risky enabled', () => {
  const c = resolveBrowserConfig();
  assert.equal(c.enabled, true);
  assert.equal(c.print, 'on-failure');
  assert.equal(c.attach, 'on-failure');
  assert.equal(c.file, false);
  assert.equal(c.redact.inspectInputType, false);
  assert.equal(c.steps, 'auto');
  assert.equal(c.network, false);
  assert.equal(c.browserConsole, 'warning');
  assert.equal(c.queries, false);
  assert.equal(c.mouseMoves, false);
  assert.equal(c.logStart, false);
  assert.equal(c.location, false);
  assert.equal(c.slowActionMs, 1000);
  assert.equal(c.maxArgLength, 200);
  assert.equal(c.maxEvents, 5000);
  assert.equal(c.redact.fillValues, 'auto');
  assert.equal(c.redact.mask, '***');
  assert.equal(typeof c.colors, 'boolean');
  assert.equal(typeof c.sink, 'function');
});

test('user options replace defaults; undefined never overrides', () => {
  const c = resolveBrowserConfig({ print: true, network: 'failed', maxEvents: undefined, colors: false });
  assert.equal(c.print, true);
  assert.equal(c.network, 'failed');
  assert.equal(c.maxEvents, DEFAULT_BROWSER_CONFIG.maxEvents);
  assert.equal(c.colors, false);
});

test('redact is merged one level deep with the defaults', () => {
  const c = resolveBrowserConfig({ redact: { mask: '[x]', selectors: ['#pin-pad'] } });
  assert.equal(c.redact.mask, '[x]');
  assert.deepEqual(c.redact.selectors, ['#pin-pad']);
  assert.deepEqual(c.redact.keys, [...DEFAULT_SENSITIVE_KEY_PATTERNS]);
  assert.equal(c.redact.fillValues, 'auto');
});

test('default arrays are copies so users cannot corrupt the defaults', () => {
  const c = resolveBrowserConfig();
  c.redact.selectors.push('mutated');
  c.redact.headers.push('mutated');
  assert.ok(!DEFAULT_BROWSER_CONFIG.redact.selectors.includes('mutated'));
  assert.ok(!DEFAULT_CONFIG.redactHeaders.includes('mutated'));
});

test('headers: apiLog resolved list (defaults + extras) plus browserLog extras; one list for both loggers', () => {
  const none = resolveBrowserConfig({}, { apiLog: {} });
  assert.deepEqual(none.redact.headers, [...DEFAULT_REDACT_HEADERS]);

  const inherited = resolveBrowserConfig({}, { apiLog: { redactHeaders: ['x-custom'] } });
  assert.deepEqual(inherited.redact.headers, [...DEFAULT_REDACT_HEADERS, 'x-custom']);

  const own = resolveBrowserConfig({ redact: { headers: ['X-Own'] } }, { apiLog: { redactHeaders: ['x-custom'] } });
  assert.deepEqual(own.redact.headers, [...DEFAULT_REDACT_HEADERS, 'x-custom', 'X-Own']);

  const replaced = resolveBrowserConfig({}, { apiLog: { redactHeaders: ['x-only'], replaceDefaultRedaction: true } });
  assert.deepEqual(replaced.redact.headers, ['x-only']);
});

test('browserLog has no query-string redaction yet; colors use the shared detector', () => {
  const c = resolveBrowserConfig();
  assert.ok(!('query' in c.redact));
  assert.equal(c.colors, detectColorSupport());
  assert.equal(resolveBrowserConfig({ colors: true }).colors, true);
});

test('secrets are auto-collected from httpCredentials and sensitive extraHTTPHeaders', () => {
  const c = resolveBrowserConfig({ redact: { values: ['user-secret-1'] } }, {
    httpCredentials: { username: 'jo', password: 'basic-pass-9' },
    extraHTTPHeaders: { Authorization: 'Bearer abcdef', 'X-Trace': 'visible-value' },
  });
  assert.deepEqual(c.redact.values, ['user-secret-1', 'basic-pass-9', 'Bearer abcdef'].sort((a, b) => b.length - a.length));
  assert.ok(!c.redact.values.includes('visible-value'));
  assert.ok(!c.redact.values.includes('jo'));
});

test('empty, non-string and short redact values are filtered out', () => {
  const warn = console.warn;
  console.warn = () => {};
  try {
    const c = resolveBrowserConfig({ redact: { values: ['', 'ab', undefined as unknown as string, 'good-secret'] } });
    assert.deepEqual(c.redact.values, ['good-secret']);
  } finally {
    console.warn = warn;
  }
});

test('default sensitive selectors match the documented examples and not ordinary ones', () => {
  const hits = ['#password', "getByLabel('Password')", 'input[type=password]', "getByPlaceholder('Enter PIN')",
    '#pin-pad', '[name=otp]', "getByLabel('API key')", '#cvv', '[autocomplete="current-password"]', '#user_token'];
  for (const h of hits) assert.ok(matchesAny(h, DEFAULT_SENSITIVE_SELECTORS), h);
  const misses = ["getByLabel('Email')", "getByRole('button', { name: 'Shipping' })", '#passenger-name', '#spinner', 'text=Pinterest'];
  for (const m of misses) assert.ok(!matchesAny(m, DEFAULT_SENSITIVE_SELECTORS), m);
});
