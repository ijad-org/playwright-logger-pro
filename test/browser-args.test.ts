import { test } from 'node:test';
import assert from 'node:assert/strict';
import { isPrintableKey, renderArgs } from '../src/browser/args';
import type { ArgsContext } from '../src/browser/args';
import { METHOD_TABLES } from '../src/browser/methods';
import { describeLocator } from '../src/browser/describe';
import { BrowserLogSession } from '../src/browser/session';
import { resolveBrowserConfig } from '../src/browser/types';
import type { BrowserLoggerConfig } from '../src/browser/types';
import { getRegistry } from '../src/browser/registry';
import { FakePage } from './helpers/fakes';

const red = resolveBrowserConfig({ redact: { values: ['PLP-CANARY-7f3a'] } }).redact;
const ctx = (over: Partial<ArgsContext> = {}): ArgsContext => ({ redact: red, maxArgLength: 200, maskSecret: false, ...over });
const L = METHOD_TABLES.locator;
const P = METHOD_TABLES.page;

test('plain values render like code; trailing undefined is dropped', () => {
  assert.equal(renderArgs(L.click, [{ position: { x: 1, y: 2 }, timeout: 500 }], ctx()).text, '{ position: { x: 1, y: 2 }, timeout: 500 }');
  assert.equal(renderArgs(L.click, [undefined, undefined], ctx()).text, '');
  assert.equal(renderArgs(P.goto, ['/a b', { waitUntil: 'load' }], ctx()).text, "'/a b', { waitUntil: 'load' }");
  assert.equal(renderArgs(L.fill, ["it's\nmulti"], ctx()).text, "'it\\'s\\nmulti'");
});

test('cycles, BigInt, symbols, functions and RegExp never throw', () => {
  const cyc: Record<string, unknown> = { a: 1 };
  cyc.self = cyc;
  const out = renderArgs(L.click, [cyc, 10n, Symbol('s'), function named() {}, /x/g], ctx());
  assert.equal(out.text, "{ a: 1, self: '[Circular]' }, '10n', 'Symbol(s)', <function named>, '/x/g'");
});

test('every argument is truncated to maxArgLength', () => {
  const out = renderArgs(L.fill, ['x'.repeat(500)], ctx({ maxArgLength: 20 }));
  assert.ok(out.text.length < 40, out.text);
  assert.match(out.text, /…\(\+\d+\)$/);
});

test('secret-bearing arguments are masked when maskSecret is set, and reported for scrubbing', () => {
  const out = renderArgs(L.fill, ['hunter2hunter2'], ctx({ maskSecret: true }));
  assert.equal(out.text, '***');
  assert.equal(out.redacted, true);
  assert.deepEqual(out.secrets, ['hunter2hunter2']);
  const page = renderArgs(P.fill, ['#password', 'hunter2hunter2'], ctx({ maskSecret: true }));
  assert.equal(page.text, "'#password', ***");
  const notMasked = renderArgs(L.fill, ['visible'], ctx());
  assert.equal(notMasked.text, "'visible'");
  assert.equal(notMasked.redacted, false);
});

test('literal secret values are masked everywhere, even when not masked by policy', () => {
  assert.equal(renderArgs(L.fill, ['my PLP-CANARY-7f3a ok'], ctx()).text, "'my *** ok'");
  assert.equal(renderArgs(L.click, [{ note: 'PLP-CANARY-7f3a' }], ctx()).text, "{ note: '***' }");
});

test('keys: sensitive object keys are masked inside option bags', () => {
  const out = renderArgs(L.evaluate, [(x: unknown) => x, { password: 'zzzzzzzz', user: 'jo', nested: { apiKey: 'k1k1k1k1' } }], ctx());
  assert.equal(out.text, "x=>x, { password: '***', user: 'jo', nested: { apiKey: '***' } }");
});

test('key presses: only typed characters are secret', () => {
  assert.ok(isPrintableKey('a'));
  assert.ok(isPrintableKey('Shift+A'));
  assert.ok(isPrintableKey('+'));
  assert.ok(isPrintableKey('€'));
  assert.ok(!isPrintableKey('Enter'));
  assert.ok(!isPrintableKey('Control+a'));
  assert.ok(!isPrintableKey('ArrowLeft'));
  assert.ok(!isPrintableKey(''));
  const K = METHOD_TABLES.keyboard;
  assert.equal(renderArgs(K.press, ['x'], ctx({ maskSecret: true })).text, '***');
  assert.equal(renderArgs(K.press, ['Enter'], ctx({ maskSecret: true })).text, "'Enter'");
  assert.equal(renderArgs(K.type, ['secret text'], ctx({ maskSecret: true })).text, '***');
});

test('URLs: userinfo passwords are masked, query strings are left alone (no query redaction yet)', () => {
  const out = renderArgs(P.goto, ['https://jo:hunter2@host.test/p?token=abc'], ctx());
  assert.equal(out.text, "'https://jo:***@host.test/p?token=abc'");
  assert.equal(renderArgs(P.goto, ['/x', { referer: 'https://u:pw123456@h/' }], ctx()).text, "'/x', { referer: 'https://u:***@h/' }");
});

test('headers, cookies and credentials never show their secrets', () => {
  const headers = renderArgs(P.setExtraHTTPHeaders, [{ Authorization: 'Bearer abcdef', 'X-Trace': 'visible' }], ctx());
  assert.equal(headers.text, "{ Authorization: '***', 'X-Trace': 'visible' }");
  const cookies = renderArgs(METHOD_TABLES.context.addCookies, [[{ name: 'sid', value: 'abc123xyz', domain: 'x.test', path: '/' }]], ctx());
  assert.equal(cookies.text, "[{ name: 'sid', domain: 'x.test', path: '/', value: *** }]");
  assert.ok(!cookies.text.includes('abc123xyz'));
  const creds = renderArgs(METHOD_TABLES.context.setHTTPCredentials, [{ username: 'jo', password: 'pw-pw-pw-pw' }], ctx());
  assert.equal(creds.text, "{ username: 'jo', password: *** }");
});

test('files, html, scripts and evaluate sources are summarised', () => {
  assert.equal(renderArgs(L.setInputFiles, ['/home/jo/x.pdf'], ctx()).text, "'x.pdf'");
  assert.equal(
      renderArgs(L.setInputFiles, [{ name: 'a.txt', mimeType: 'text/plain', buffer: Buffer.alloc(1234) }], ctx()).text,
      'a.txt (text/plain, 1.2 KB)',
  );
  assert.equal(renderArgs(P.setInputFiles, ['#up', ['/a/b.png', '/a/c.png']], ctx()).text, "'#up', ['b.png', 'c.png']");
  assert.equal(renderArgs(P.setContent, ['<html>' + 'x'.repeat(2000) + '</html>'], ctx()).text, '<html 2.0 KB>');
  assert.equal(renderArgs(P.addInitScript, ['window.x = 1'], ctx()).text, '<script 12 B>');
  assert.equal(renderArgs(P.addScriptTag, [{ path: '/a/b/s.js' }], ctx()).text, "{ path: 's.js' }");
  assert.equal(renderArgs(L.evaluate, [() => document.title], ctx()).text.length > 0, true);
  const src = renderArgs(P.evaluate, ['document.querySelector("#a").textContent + "' + 'y'.repeat(200) + '"'], ctx()).text;
  assert.ok(src.length <= 82, src);
});

test('predicates and route handlers are not dumped', () => {
  assert.equal(renderArgs(P.waitForEvent, ['close', () => true], ctx()).text, "'close', <predicate>");
  assert.equal(renderArgs(P.route, ['**/api/*', () => {}], ctx()).text, "'**/api/*', <handler>");
  assert.equal(renderArgs(P.waitForURL, [/done/], ctx()).text, '/done/');
});

test('locator descriptions: current format kept, old Playwright (1.30) internal: engines rewritten', () => {
  const d = (s: string): string => describeLocator({ toString: () => s });
  assert.equal(d("getByLabel('Password')"), "getByLabel('Password')");
  assert.equal(d('Locator@internal:label="Password"i'), "getByLabel('Password')");
  assert.equal(d('Locator@internal:role=button[name="Sign in"i]'), "getByRole('button', { name: 'Sign in' })");
  assert.equal(d('Locator@internal:attr=[placeholder="Enter PIN"i]'), "getByPlaceholder('Enter PIN')");
  assert.equal(d('Locator@ul >> li >> nth=2'), "locator('ul').locator('li').nth(2)");
  assert.equal(d('[object Object]'), 'locator(<?>)');
});

// -- sensitivity state machine (needs a session with a fake page) -------------

function sessionFor(config: BrowserLoggerConfig = {}): { s: BrowserLogSession; page: FakePage } {
  getRegistry().activeSession = null;
  const s = new BrowserLogSession(resolveBrowserConfig({ colors: false, print: false, ...config }), {}, false);
  const page = new FakePage();
  s.attachPage(page);
  return { s, page };
}
const lastArgs = (s: BrowserLogSession): string[] =>
  s.events().filter((e) => e.kind === 'action').map((e) => (e.kind === 'action' ? e.args : ''));

test('auto: fill on a password-like target is masked, an ordinary one is not', async () => {
  const { s, page } = sessionFor();
  await page.locator('#password').fill('hunter2hunter2');
  await page.locator('#email').fill('jo@example.com');
  await page.fill('input[type=password]', 'hunter2hunter2');
  await page.fill('#nick', 'joe');
  assert.deepEqual(lastArgs(s), ['***', "'jo@example.com'", "'input[type=password]', ***", "'#nick', 'joe'"]);
});

test('auto: keyboard input is masked while the last targeted field was sensitive', async () => {
  const { s, page } = sessionFor();
  await page.locator('#email').fill('jo@example.com');
  await page.keyboard.type('visible-text');
  await page.locator('#password').click();
  await page.keyboard.type('hunter2hunter2');
  await page.keyboard.press('Enter');
  await page.locator('#email').click();
  await page.keyboard.type('visible-again');
  assert.deepEqual(lastArgs(s), [
    "'jo@example.com'", "'visible-text'", '', '***', "'Enter'", '', "'visible-again'",
  ]);
});

test('fillValues: always masks everything, never masks nothing (literal values still apply)', async () => {
  const always = sessionFor({ redact: { fillValues: 'always' } });
  await always.page.locator('#email').fill('jo@example.com');
  assert.deepEqual(lastArgs(always.s), ['***']);
  const never = sessionFor({ redact: { fillValues: 'never', values: ['hunter2hunter2'] } });
  await never.page.locator('#password').fill('hunter2hunter2');
  await never.page.locator('#password').fill('other-value');
  assert.deepEqual(lastArgs(never.s), ["'***'", "'other-value'"]);
});

test('custom selectors extend the defaults when spread', async () => {
  const { s, page } = sessionFor({ redact: { selectors: ['#vault'] } });
  await page.locator('#vault').fill('abcdefgh');
  await page.locator('#password').fill('abcdefgh');
  assert.deepEqual(lastArgs(s), ['***', "'abcdefgh'"]); // replaced, not merged: documented
});

test('errors never echo a masked secret', async () => {
  const { s, page } = sessionFor();
  const proto = Object.getPrototypeOf(page.mainFrame());
  const sym = Object.getOwnPropertySymbols(proto).find((x) => (x.description ?? '').endsWith('.fill'))!;
  const saved = proto[sym];
  proto[sym] = () => Promise.reject(new Error('frame.fill: Timeout\nCall log:\n  - fill("hunter2hunter2")'));
  try {
    await assert.rejects(page.locator('#password').fill('hunter2hunter2'));
  } finally {
    proto[sym] = saved;
  }
  const ev = s.events().at(-1);
  assert.ok(ev?.kind === 'action' && ev.error);
  assert.ok(!JSON.stringify(ev).includes('hunter2hunter2'));
  assert.match(JSON.stringify(ev), /fill\(\\"\*\*\*\\"\)/);
});
