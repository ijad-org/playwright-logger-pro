/**
 * Regression tests for PCL-46 (browserLog selectors/keys add to the defaults)
 * and PCL-47 (browserLog masks sensitive query parameters in every printed URL).
 */
import { describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { renderArgs } from '../src/browser/args';
import { METHOD_TABLES } from '../src/browser/methods';
import { BrowserLogSession } from '../src/browser/session';
import { resolveBrowserConfig } from '../src/browser/types';
import type { BrowserLoggerConfig, ResolveContext } from '../src/browser/types';
import { getRegistry } from '../src/browser/registry';
import { maskUrl, redactUrl, redactUrlsInText } from '../src/redact';
import { DEFAULT_REDACT_QUERY_PARAMS } from '../src/types';
import { FakeContext, FakePage } from './helpers/fakes';

const SECRET = 'SECRET_LOC_KEY';

function sessionFor(config: BrowserLoggerConfig = {}, context: ResolveContext = {}) {
  getRegistry().activeSession = null;
  const cfg = resolveBrowserConfig({ colors: false, print: false, browserConsole: 'all', network: 'all', ...config }, context);
  const s = new BrowserLogSession(cfg, {}, false);
  const ctx = new FakeContext();
  const page = new FakePage();
  s.attachContext(ctx);
  s.attachPage(page);
  return { s, page, ctx, cfg };
}

const response = (url: string) => ({
  status: () => 200,
  request: () => ({ url: () => url, method: () => 'GET', resourceType: () => 'document' }),
});
const everything = (s: BrowserLogSession): string => JSON.stringify(s.events()) + s.handle.render('text');
const argsOf = (s: BrowserLogSession): string[] =>
  s.events().flatMap((e) => (e.kind === 'action' ? [e.args] : []));

describe('PCL-47: query parameters are masked in browserLog URLs', () => {
  test('a redirect to ?api_key=SECRET is masked in the navigation and network lines', async () => {
    const { s, page, ctx } = sessionFor();
    await page.goto('http://app.test/r/302');
    ctx.emit('response', response(`http://app.test/echo?from=302&api_key=${SECRET}`));
    page.emit('framenavigated', { url: () => `http://app.test/echo?from=302&api_key=${SECRET}`, parentFrame: () => null });
    const out = everything(s);
    assert.ok(!out.includes(SECRET), out);
    assert.ok(s.events().some((e) => e.kind === 'navigation' && e.url === 'http://app.test/echo?from=302&api_key=***'));
    assert.ok(s.events().some((e) => e.kind === 'network' && e.url === 'http://app.test/echo?from=302&api_key=***'));
    assert.match(s.handle.render('text'), /↪ http:\/\/app\.test\/echo\?from=302&api_key=\*\*\*/);
  });

  test('goto with ?token= is masked in the action line and the navigation line', async () => {
    const { s, page } = sessionFor();
    const url = 'http://app.test/echo?token=QS_TOKEN_123&api_key=QS_KEY_456&n=1';
    await page.goto(url);
    page.emit('framenavigated', { url: () => url, parentFrame: () => null });
    const out = everything(s);
    assert.ok(!out.includes('QS_TOKEN_123') && !out.includes('QS_KEY_456'), out);
    assert.deepEqual(argsOf(s), ["'http://app.test/echo?token=***&api_key=***&n=1'"]);
    assert.ok(s.events().some((e) => e.kind === 'navigation' && e.url === 'http://app.test/echo?token=***&api_key=***&n=1'));
  });

  test('page open, download, frame description and free text are masked too', () => {
    const { s, page } = sessionFor();
    page.emit('download', { url: () => 'http://app.test/f?access_token=DL_TOKEN_1', suggestedFilename: () => 'a.txt' });
    page.emit('console', { type: () => 'error', text: () => 'GET http://app.test/x?secret=CON_SECRET_1&a=b failed (http://app.test/y?password=CON_PW_2).', location: () => ({ url: 'http://app.test/app.js', lineNumber: 1 }) });
    const out = everything(s);
    for (const v of ['DL_TOKEN_1', 'CON_SECRET_1', 'CON_PW_2']) assert.ok(!out.includes(v), out);
    assert.match(out, /x\?secret=\*\*\*&a=b failed \(http:\/\/app\.test\/y\?password=\*\*\*\)\./);
  });

  test('request/waitFor patterns and relative URLs in arguments are masked', () => {
    const red = resolveBrowserConfig().redact;
    const ctx = { redact: red, maxArgLength: 200, maskSecret: false };
    assert.equal(renderArgs(METHOD_TABLES.page.goto, ['/echo?apikey=abc123'], ctx).text, "'/echo?apikey=***'");
    assert.equal(renderArgs(METHOD_TABLES.page.waitForResponse, ['**/api?access_token=abc123'], ctx).text, "'**/api?access_token=***'");
  });

  test('runtime redact.values still apply on top of the query-parameter masking', async () => {
    const { s, ctx } = sessionFor({ redact: { values: ['custom-session-id'] } });
    ctx.emit('response', response('http://app.test/p?token=abc&sid=custom-session-id'));
    assert.ok(s.events().some((e) => e.kind === 'network' && e.url === 'http://app.test/p?token=***&sid=***'));
  });

  test('the key list is apiLog\'s: defaults, custom names add, replaceDefaultRedaction replaces', () => {
    assert.deepEqual(resolveBrowserConfig().redact.queryParams, [...DEFAULT_REDACT_QUERY_PARAMS]);
    const added = resolveBrowserConfig({ redact: { queryParams: ['sig'] } }, { apiLog: { redactQueryParams: ['code'] } });
    assert.deepEqual(added.redact.queryParams, [...DEFAULT_REDACT_QUERY_PARAMS, 'code', 'sig']);
    const replaced = resolveBrowserConfig({}, { apiLog: { redactQueryParams: ['only'], replaceDefaultRedaction: true } });
    assert.deepEqual(replaced.redact.queryParams, ['only']);

    const { ctx, s } = sessionFor({ redact: { queryParams: ['sig'] } });
    ctx.emit('response', response('http://app.test/p?sig=S1G&token=T0K&n=1'));
    assert.ok(s.events().some((e) => e.kind === 'network' && e.url === 'http://app.test/p?sig=***&token=***&n=1'));
  });

  test('uses the same helper as apiLog and honours a custom mask', () => {
    assert.equal(maskUrl('http://a/p?token=x#f', undefined, '***', DEFAULT_REDACT_QUERY_PARAMS), redactUrl('http://a/p?token=x#f', DEFAULT_REDACT_QUERY_PARAMS));
    assert.equal(redactUrl('http://a/p?token=x', ['token'], '[x]'), 'http://a/p?token=[x]');
    assert.equal(redactUrlsInText('see http://a/p?token=x, ok', ['token']), 'see http://a/p?token=***, ok');
  });
});

describe('PCL-46: redact.selectors and redact.keys add to the defaults', () => {
  test("selectors: ['#nick'] still masks #password and #pin fills, and masks #nick", async () => {
    const { s, page } = sessionFor({ redact: { selectors: ['#nick'] } });
    await page.locator('#password').fill('hunter2hunter2');
    await page.locator('#pin').fill('48151623');
    await page.locator('#nick').fill('joejoe');
    await page.locator('#city').fill('Paris');
    assert.deepEqual(argsOf(s), ['***', '***', '***', "'Paris'"]);
    assert.ok(!everything(s).includes('hunter2hunter2'));
  });

  test("camelCase/_/- splitting still applies with custom selectors", async () => {
    const { s, page } = sessionFor({ redact: { selectors: ['#nick'] } });
    await page.locator('#cardExpDate').fill('12/30');
    await page.locator('#pan_number').fill('4111111111111111');
    assert.deepEqual(argsOf(s), ['***', '***']);
  });

  test("keys: ['nickname'] still masks a password key, and masks nickname", () => {
    const red = resolveBrowserConfig({ redact: { keys: ['nickname'] } }).redact;
    const out = renderArgs(METHOD_TABLES.locator.evaluate, [(x: unknown) => x, { password: 'zzzzzzzz', nickname: 'joe', user: 'jo' }], {
      redact: red, maxArgLength: 200, maskSecret: false,
    });
    assert.equal(out.text, "x=>x, { password: '***', nickname: '***', user: 'jo' }");
  });

  test('apiLog replaceDefaultRedaction opts out of the defaults, as for apiLog', async () => {
    const c = resolveBrowserConfig(
        { redact: { selectors: ['#nick'], keys: ['nickname'] } },
        { apiLog: { replaceDefaultRedaction: true } },
    );
    assert.deepEqual(c.redact.selectors, ['#nick']);
    assert.deepEqual(c.redact.keys, ['nickname']);
    const { s, page } = sessionFor({ redact: { selectors: ['#nick'] } }, { apiLog: { replaceDefaultRedaction: true } });
    await page.locator('#password').fill('hunter2hunter2');
    await page.locator('#nick').fill('joejoe');
    assert.deepEqual(argsOf(s), ["'hunter2hunter2'", '***']);
  });

  test('no duplicates when a default is passed again', () => {
    const defaults = resolveBrowserConfig().redact;
    const c = resolveBrowserConfig({ redact: { selectors: [...defaults.selectors], keys: [...defaults.keys] } });
    assert.equal(c.redact.selectors.length, defaults.selectors.length);
    assert.equal(c.redact.keys.length, defaults.keys.length);
  });
});
