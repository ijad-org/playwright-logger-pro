/**
 * Regression tests for the LQA round-2 defects PCL-39 .. PCL-43 (browserLog, 0.2.0).
 */
import { describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { matchesAny, redactText, secretVariants } from '../src/redact';
import { DEFAULT_SENSITIVE_SELECTORS } from '../src/browser/sensitive';
import { BrowserLogSession } from '../src/browser/session';
import { getRegistry } from '../src/browser/registry';
import { resolveBrowserConfig } from '../src/browser/types';
import type { BrowserLoggerConfig } from '../src/browser';
import { FakeContext, FakePage } from './helpers/fakes';

function sessionFor(config: BrowserLoggerConfig = {}): { s: BrowserLogSession; page: FakePage } {
  getRegistry().activeSession = null;
  const cfg = resolveBrowserConfig({ colors: false, print: false, browserConsole: 'all', network: 'all', ...config });
  const s = new BrowserLogSession(cfg, { title: 'round3.test.ts › case', project: 'unit' }, false);
  s.attachContext(new FakeContext());
  const page = new FakePage();
  s.attachPage(page);
  return { s, page };
}

const consoleMsg = (text: string) => ({ type: () => 'log', text: () => text, location: () => ({ url: 'http://x.test/a.js', lineNumber: 1 }) });
const consoleTexts = (s: BrowserLogSession): string[] =>
  s.events().flatMap((e) => (e.kind === 'console' ? [e.text] : []));

// Independent reference encoders (not the code under test).
const hex4 = (c: number, upper: boolean): string => (upper ? c.toString(16).toUpperCase() : c.toString(16)).padStart(4, '0');
const units = (s: string): number[] => Array.from({ length: s.length }, (_, i) => s.charCodeAt(i));
const jsonStringify = (s: string): string => JSON.stringify(s).slice(1, -1);
/** PHP json_encode defaults: `\/` and every non-ASCII code unit as \uXXXX (lower case). */
const phpJson = (s: string, upper = false): string =>
  jsonStringify(s).replace(/\//g, '\\/').replace(/[^\x00-\x7f]/g, (c) => `\\u${hex4(c.charCodeAt(0), upper)}`);
/** Python json.dumps(ensure_ascii=True). */
const pyJson = (s: string, upper = false): string =>
  jsonStringify(s).replace(/[^\x00-\x7f]/g, (c) => `\\u${hex4(c.charCodeAt(0), upper)}`);
const allU = (s: string, upper: boolean): string => units(s).map((c) => `\\u${hex4(c, upper)}`).join('');
const legacyEscape = (s: string): string => (globalThis as unknown as { escape(s: string): string }).escape(s);
const lowerPercent = (s: string): string => s.replace(/%u?[0-9A-F]{2,4}/g, (m) => m.toLowerCase());

const SECRETS = [
  'p/ass/w0rd-ab12',
  'café/Pa$$w0rd',
  'smörgås/日本語-pw',
  'emoji-\u{1F600}-pw/x',
  'q"uote\\back/slash\tTab-1',
];

describe('PCL-39: more spellings of a learned secret are masked', () => {
  test('secretVariants covers every documented form, in lower and upper case hex', () => {
    for (const v of SECRETS) {
      const forms = new Set(secretVariants(v));
      const expected: Record<string, string> = {
        'JSON.stringify': jsonStringify(v),
        'JSON with \\/': jsonStringify(v).replace(/\//g, '\\/'),
        'PHP json_encode (lower)': phpJson(v),
        'PHP json_encode (upper)': phpJson(v, true),
        'Python ensure_ascii (lower)': pyJson(v),
        'Python ensure_ascii (upper)': pyJson(v, true),
        'all \\u (lower)': allU(v, false),
        'all \\u (upper)': allU(v, true),
        'escape()': legacyEscape(v),
        'escape() lower hex': lowerPercent(legacyEscape(v)),
        'encodeURIComponent': encodeURIComponent(v),
      };
      for (const [name, form] of Object.entries(expected)) assert.ok(forms.has(form), `${name} of ${v}: ${form}`);
    }
  });

  test('a surrogate pair is two \\u escapes, and escape() gives %uD83D%uDE00', () => {
    const forms = secretVariants('emoji-\u{1F600}-pw');
    assert.ok(forms.includes('emoji-\\ud83d\\ude00-pw'));
    assert.ok(forms.includes('emoji-\\uD83D\\uDE00-pw'));
    assert.ok(forms.includes('emoji-%uD83D%uDE00-pw'));
    assert.ok(forms.includes('emoji-%ud83d%ude00-pw'));
  });

  test('a typed secret is masked in all of those forms in console, URLs, pageerrors and dialogs', async () => {
    for (const secret of SECRETS) {
      const { s, page } = sessionFor();
      await page.locator('#password').fill(secret);
      const forms = [
        jsonStringify(secret), jsonStringify(secret).replace(/\//g, '\\/'), phpJson(secret), phpJson(secret, true),
        pyJson(secret), pyJson(secret, true), allU(secret, false), allU(secret, true),
        legacyEscape(secret), lowerPercent(legacyEscape(secret)),
        encodeURIComponent(secret), lowerPercent(encodeURIComponent(secret)),
      ];
      for (const f of forms) {
        page.emit('console', consoleMsg(`echo {"v":"${f}"} end`));
        page.emit('pageerror', new Error(`bad ${f}`));
        page.emit('request', { url: () => `http://x.test/api?d=${f}`, method: () => 'GET', resourceType: () => 'fetch' });
      }
      const out = JSON.stringify(s.events());
      for (const f of forms) assert.ok(!out.includes(JSON.stringify(f).slice(1, -1)) && !out.includes(f), `${secret} leaked as ${f}`);
      assert.deepEqual(consoleTexts(s), forms.map(() => 'echo {"v":"***"} end'));
    }
  });

  test('the same forms are masked for redact.values-style learning (addSecret)', () => {
    const { s } = sessionFor();
    const secret = 'café/Pa$$w0rd';
    s.addSecret(secret);
    for (const f of [phpJson(secret), pyJson(secret), legacyEscape(secret), allU(secret, true)]) {
      assert.equal(s.scrub(`x ${f} y`), 'x *** y', f);
    }
  });

  test('variants are deduplicated, never shorter than 4 characters, and ASCII-only values stay small', () => {
    const forms = secretVariants('abcd-1234');
    // plain ASCII: the value and its all-\\u spellings only (no percent, JSON or escape() changes)
    assert.deepEqual(forms, ['abcd-1234', allU('abcd-1234', false), allU('abcd-1234', true)]);
    for (const v of SECRETS) {
      const list = secretVariants(v);
      assert.equal(new Set(list).size, list.length);
      assert.ok(list.every((f) => f.length >= 4));
      assert.ok(list.length <= 48, String(list.length));
    }
  });

  test('variants are computed once per learned secret and dropped with it', async () => {
    const { s, page } = sessionFor();
    await page.locator('#password').fill('first-secret-1');
    const typedVariants = (s as unknown as { typedVariants: Map<string, string[]> }).typedVariants;
    const before = typedVariants.get('first-secret-1');
    assert.ok(before);
    await page.locator('#password').fill('second-secret-2');
    assert.equal(typedVariants.get('first-secret-1'), before);
    assert.equal(typedVariants.size, 2);
  });

  test('the longest value wins when a secret contains another', () => {
    assert.equal(redactText('a=ab/cd&b=ab', ['ab/cd', 'ab'].filter((v) => v.length >= 4), '***'), 'a=***&b=ab');
  });
});

describe('PCL-40: matching is literal-form based (documented limits)', () => {
  test('base64, double encoding, HTML entities, split values and fragments are not detected', async () => {
    const { s, page } = sessionFor();
    const secret = 'Tr0ub4dor&3/xyz';
    await page.locator('#password').fill(secret);
    const echoes = [
      Buffer.from(secret).toString('base64'),
      encodeURIComponent(encodeURIComponent(secret)),
      'Tr0ub4dor&amp;3/xyz',
      'Tr0ub4dor&#38;3/xyz',
      'ub4dor&3/x',
    ];
    for (const e of echoes) page.emit('console', consoleMsg(e));
    page.emit('console', { ...consoleMsg(''), text: () => 'Tr0ub4dor' });
    assert.deepEqual(consoleTexts(s), [...echoes, 'Tr0ub4dor']);
    page.emit('console', consoleMsg(secret));
    assert.equal(consoleTexts(s).at(-1), '***');
  });
});

describe('PCL-41: expiry and PAN fields are sensitive', () => {
  const hits = [
    '[autocomplete="cc-exp"]', '[autocomplete=cc-exp-month]', '[autocomplete="cc-exp-year"]', '[autocomplete=cc-csc]',
    'input[autocomplete=cc-expiry]', '#cc_exp', '#cc-exp-date', "getByLabel('Expiry date')", "getByLabel('Expiration')",
    "getByLabel('Expiration date')", "getByPlaceholder('MM/YY exp date')", "getByLabel('Exp. Date')", '#expiry', '#expiryDate',
    '[name=expiration]', '#exp_date', '#exp-month', '#cardExpiry', '#card_exp_year', "getByLabel('PAN')", '#pan',
    '[name=pan]', "getByPlaceholder('Enter PAN')", '#card-pan', "getByRole('textbox', { name: 'Card number' })", "getByLabel('Card number')",
  ];
  const misses = [
    '#company', "getByLabel('Company')", '.panel', '#panel-title', "getByLabel('Pane')", '#span', '#expand', '#express',
    "getByLabel('Expires in days')", '#expenses', '#export', '#experience', "getByLabel('Expense')", '#panorama', '#japan',
    '#pandora', "getByLabel('Company name')",
  ];

  test('hits', () => {
    for (const h of hits) assert.ok(matchesAny(h, DEFAULT_SENSITIVE_SELECTORS), h);
  });

  test('false positives are avoided (word boundaries)', () => {
    for (const m of misses) assert.ok(!matchesAny(m, DEFAULT_SENSITIVE_SELECTORS), m);
  });

  test('a value typed into an expiry field is masked in its action line and learned', async () => {
    const { s, page } = sessionFor();
    await page.fill('[autocomplete="cc-exp"]', '12/2031');
    await page.locator('#cc-csc').fill('9876');
    page.emit('console', consoleMsg('exp 12/2031 csc 9876'));
    const lines = s.events().flatMap((e) => (e.kind === 'action' ? [e.method + ' ' + JSON.stringify(e.args)] : []));
    assert.ok(lines.every((l) => !l.includes('12/2031') && !l.includes('9876')), lines.join('\n'));
    assert.deepEqual(consoleTexts(s), ['exp *** csc ***']);
  });
});

describe('PCL-43: httpCredentials arrays and old Playwright types', () => {
  test('every password of an array (Playwright 1.64+) and of a single object is a redaction value', () => {
    const many = resolveBrowserConfig({}, {
      httpCredentials: [{ username: 'a', password: 'first-pass-1' }, { username: 'b', password: 'second-pass-2' }],
    });
    assert.deepEqual([...many.redact.values].sort(), ['first-pass-1', 'second-pass-2']);
    const one = resolveBrowserConfig({}, { httpCredentials: { username: 'a', password: 'only-pass-1' } });
    assert.deepEqual(one.redact.values, ['only-pass-1']);
    assert.deepEqual(resolveBrowserConfig({}, { httpCredentials: [] }).redact.values, []);
    assert.deepEqual(resolveBrowserConfig({}, { httpCredentials: undefined }).redact.values, []);
  });

  test('fixtures still export mergeTests (typed without relying on Playwright 1.39+ types)', async () => {
    const fixtures = await import('../src/fixtures');
    assert.equal(typeof fixtures.mergeTests, 'function');
  });
});
