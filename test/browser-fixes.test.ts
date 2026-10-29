/**
 * Regression tests for the LQA defects PCL-30 .. PCL-38 (browserLog, 0.2.0).
 */
import { afterEach, beforeEach, describe, mock, test } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { headerSecretValues, matchesAny, secretVariants } from '../src/redact';
import { resetWarnings } from '../src/warn';
import { DEFAULT_SENSITIVE_SELECTORS } from '../src/browser/sensitive';
import { BrowserLogSession } from '../src/browser/session';
import { callSite, isLibraryFile, parseStackFrame, pickCallSite } from '../src/browser/callSite';
import { OrderedPrinter } from '../src/browser/ordered';
import { writeOutputs } from '../src/browser/output';
import type { TestInfoLike } from '../src/browser/output';
import { LIB_DIRS } from '../src/libDir';
import { getRegistry } from '../src/browser/registry';
import { DEFAULT_BROWSER_CONFIG, resolveBrowserConfig } from '../src/browser/types';
import type { BrowserLoggerConfig, BrowserLogEvent } from '../src/browser';
import { FakeContext, FakeDialog, FakeLocator, FakePage } from './helpers/fakes';

type Action = Extract<BrowserLogEvent, { kind: 'action' }>;

function sessionFor(config: BrowserLoggerConfig = {}, sink?: string[]): { s: BrowserLogSession; page: FakePage; ctx: FakeContext } {
  getRegistry().activeSession = null;
  const cfg = resolveBrowserConfig({
    colors: false, print: false, browserConsole: 'all', network: 'all',
    ...(sink ? { sink: (l: string) => { sink.push(l); } } : {}),
    ...config,
  });
  const s = new BrowserLogSession(cfg, { title: 'fixes.test.ts › case', project: 'unit' }, cfg.print === true);
  const ctx = new FakeContext();
  const page = new FakePage();
  s.attachContext(ctx);
  s.attachPage(page);
  return { s, page, ctx };
}

const consoleMsg = (text: string, type = 'log') => ({ type: () => type, text: () => text, location: () => ({ url: 'http://x.test/app.js', lineNumber: 3 }) });
const response = (url: string) => ({
  status: () => 200,
  request: () => ({ url: () => url, method: () => 'GET', resourceType: () => 'fetch' }),
});
const texts = (s: BrowserLogSession, kind: 'console'): string[] =>
  s.events().flatMap((e) => (e.kind === kind ? [e.text] : []));
const actions = (s: BrowserLogSession): Action[] => s.events().filter((e): e is Action => e.kind === 'action');
const calls = (s: BrowserLogSession): string[] => actions(s).map((a) => `${a.subject}.${a.method}(${a.args})`);
const everything = (s: BrowserLogSession): string => JSON.stringify(s.events()) + s.handle.render('text');

async function withWarnings<T>(fn: () => T | Promise<T>): Promise<{ result: T; warnings: string[] }> {
  resetWarnings();
  const warn = mock.method(console, 'warn', () => undefined);
  try {
    const result = await fn();
    return { result, warnings: warn.mock.calls.map((c) => String(c.arguments[0])) };
  } finally {
    warn.mock.restore();
  }
}

beforeEach(() => {
  getRegistry().activeSession = null;
  FakeLocator.probeResult = ['text', ''];
});

// ---------------------------------------------------------------------------
describe('PCL-30: typed secrets are learned for the rest of the test', () => {
  const PW = 'hunter2-Zq9!';

  test('console, page errors, network URLs, navigation and dialogs show the masked value', async () => {
    const { s, page, ctx } = sessionFor();
    await page.locator('#password').fill(PW);
    page.emit('console', consoleMsg(`debug password=${PW}`));
    page.emit('console', consoleMsg(`warn ${PW}`, 'warning'));
    page.emit('console', consoleMsg(`error ${PW}`, 'error'));
    page.emit('pageerror', new Error(`boom ${PW}`));
    ctx.emit('response', response(`http://x.test/api/login?token=${encodeURIComponent(PW)}&pw=${PW}`));
    page.emit('framenavigated', { url: () => `http://x.test/login?session=${encodeURIComponent(PW)}`, parentFrame: () => null });
    page.emit('dialog', new FakeDialog('alert', `you typed ${PW}`));
    const out = everything(s);
    assert.ok(!out.includes(PW), out);
    assert.ok(!out.includes(encodeURIComponent(PW)), out);
    assert.deepEqual(texts(s, 'console'), ['debug password=***', 'warn ***', 'error ***']);
    assert.ok(s.events().some((e) => e.kind === 'pageerror' && e.message === 'boom ***'));
    assert.ok(s.events().some((e) => e.kind === 'network' && e.url === 'http://x.test/api/login?token=***&pw=***'));
    assert.ok(s.events().some((e) => e.kind === 'navigation' && e.url === 'http://x.test/login?session=***'));
    assert.ok(s.events().some((e) => e.kind === 'dialog' && e.message === 'you typed ***'));
  });

  test('fill, type, pressSequentially-style text, keyboard.type and insertText-style calls all teach the logger', async () => {
    const { s, page } = sessionFor();
    await page.locator('#password').click();
    await page.keyboard.type('keyboard-typed-1');
    await page.fill('input[type=password]', 'page-filled-22');
    await page.locator('#password').fill('locator-filled-3');
    page.emit('console', consoleMsg('a keyboard-typed-1 b page-filled-22 c locator-filled-3'));
    assert.deepEqual(texts(s, 'console'), ['a *** b *** c ***']);
  });

  test('URL-encoded spellings are masked too: %XX, +, lower-case hex, RFC 3986 and JSON escapes', async () => {
    const { s, page } = sessionFor();
    const value = `p@ss w0rd&x=1'(!)"q`;
    await page.locator('#password').fill(value);
    const spellings = [
      encodeURIComponent(value),
      encodeURIComponent(value).replace(/%20/g, '+'),
      encodeURIComponent(value).replace(/[!'()*]/g, (c) => `%${c.charCodeAt(0).toString(16).toUpperCase()}`),
      encodeURIComponent(value).replace(/%[0-9A-F]{2}/g, (m) => m.toLowerCase()),
      JSON.stringify(value).slice(1, -1),
    ];
    for (const sp of spellings) assert.equal(s.scrub(`x=${sp}&y=1`), 'x=***&y=1', sp);
    assert.ok(secretVariants(value).length >= 5);
  });

  test('values shorter than 4 characters, and values typed into ordinary fields, are not learned', async () => {
    const { s, page } = sessionFor();
    await page.locator('#password').fill('abc');
    await page.locator('#password').fill('    ');
    await page.locator('#nick').fill('plain-nick-1');
    page.emit('console', consoleMsg('abc plain-nick-1'));
    assert.deepEqual(texts(s, 'console'), ['abc plain-nick-1']);
  });

  test('fillValues: never does not learn; always learns every typed value', async () => {
    const never = sessionFor({ redact: { fillValues: 'never' } });
    await never.page.locator('#password').fill('typed-never-1');
    never.page.emit('console', consoleMsg('typed-never-1'));
    assert.deepEqual(texts(never.s, 'console'), ['typed-never-1']);
    const always = sessionFor({ redact: { fillValues: 'always' } });
    await always.page.locator('#nick').fill('typed-always-1');
    always.page.emit('console', consoleMsg('typed-always-1'));
    assert.deepEqual(texts(always.s, 'console'), ['***']);
  });

  test('the value is learned even when the action itself is not logged (actions: false)', async () => {
    const { s, page } = sessionFor({ actions: false });
    await page.locator('#password').fill(PW);
    assert.deepEqual(actions(s), []);
    page.emit('console', consoleMsg(`echo ${PW}`));
    assert.deepEqual(texts(s, 'console'), ['echo ***']);
  });

  test('query-string redaction by key is still not a feature: only learned values are masked', async () => {
    const { s, ctx } = sessionFor();
    ctx.emit('response', response('http://x.test/api?token=ordinary-token-value&n=1'));
    assert.ok(s.events().some((e) => e.kind === 'network' && e.url === 'http://x.test/api?token=ordinary-token-value&n=1'));
  });

  test('inspectInputType: a provisionally learned value is taken back when the probe finds an ordinary field', async () => {
    const plain = sessionFor({ redact: { inspectInputType: true } });
    FakeLocator.probeResult = ['text', ''];
    await plain.page.locator('#nick').fill('probe-plain-1');
    plain.page.emit('console', consoleMsg('during probe-plain-1')); // probe not answered yet: safe side
    await new Promise((r) => setTimeout(r, 10));
    plain.page.emit('console', consoleMsg('after probe-plain-1'));
    assert.deepEqual(texts(plain.s, 'console'), ['during ***', 'after probe-plain-1']);

    const secret = sessionFor({ redact: { inspectInputType: true } });
    FakeLocator.probeResult = ['password', ''];
    await secret.page.locator('#f1').fill('probe-secret-1');
    await new Promise((r) => setTimeout(r, 10));
    secret.page.emit('console', consoleMsg('after probe-secret-1'));
    assert.deepEqual(texts(secret.s, 'console'), ['after ***']);
  });

  test('only the newest 256 typed values are remembered (bounded work per event)', async () => {
    const { s, page } = sessionFor();
    for (let i = 0; i < 300; i++) await page.locator('#password').fill(`secret-value-${String(i).padStart(4, '0')}`);
    assert.equal(s.scrub('secret-value-0299'), '***');
    assert.equal(s.scrub('secret-value-0000'), 'secret-value-0000');
  });

  test('stdout block, attachment, text and JSONL files and sink events carry no raw value', async () => {
    const sink: string[] = [];
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'plp-fix-'));
    const attached: Array<{ name: string; body?: string | Buffer }> = [];
    const { s, page, ctx } = sessionFor({ print: 'on-failure', attach: true, file: true, fileFormat: 'jsonl', fileDir: dir }, sink);
    await page.locator('#password').fill(PW);
    page.emit('console', consoleMsg(`echo ${PW}`));
    ctx.emit('response', response(`http://x.test/a?q=${encodeURIComponent(PW)}`));
    s.note(`note ${PW}`);
    s.endCapture();
    const info: TestInfoLike = {
      title: 't', status: 'failed', expectedStatus: 'passed', outputPath: (...p) => path.join(dir, ...p),
      async attach(name, o) { attached.push({ name, body: o.body }); },
    };
    await writeOutputs(s, info);
    const files = fs.readdirSync(dir).map((f) => fs.readFileSync(path.join(dir, f), 'utf8'));
    const all = [...sink, ...attached.map((a) => String(a.body)), ...files].join('\n');
    assert.ok(all.includes('echo ***'));
    assert.ok(!all.includes(PW), all);
    assert.ok(!all.includes(encodeURIComponent(PW)), all);
  });
});

// ---------------------------------------------------------------------------
describe('PCL-31: card and code fields are recognised from the selector', () => {
  test('hits and misses', () => {
    const hits = ['#card', "locator('#card')", "getByLabel('Card')", "getByPlaceholder('Card')", "getByLabel('Credit card')",
      'input[name="cardnumber"]', '[name=card]', '[autocomplete="cc-number"]', '[autocomplete=cc-csc]', '#cc_number', '#ccnum',
      '#card-no', "getByLabel('Card No.')", "getByRole('textbox', { name: 'Card' })", '#securityCode', '#totp', '#userCardNumber'];
    for (const h of hits) assert.ok(matchesAny(h, DEFAULT_SENSITIVE_SELECTORS), h);
    const misses = ['.card', "getByText('Card')", "getByRole('button', { name: 'Card' })", '#card-list', '#cardholder',
      "getByLabel('Card holder')", '#discard', '#discard-no', '#scorecard', '.card-body', '#cards', "getByLabel('Email')", '#passenger-name'];
    for (const m of misses) assert.ok(!matchesAny(m, DEFAULT_SENSITIVE_SELECTORS), m);
  });

  test('a card number filled into #card / getByLabel("Card") is masked in the default config, with inspectInputType off', async () => {
    const { s, page } = sessionFor();
    assert.equal(s.cfg.redact.inspectInputType, false);
    await page.locator('#card').fill('4111111111111111');
    await page.fill('[name=cardnumber]', '4111111111111112');
    await page.fill('[autocomplete="cc-number"]', '4111111111111113');
    assert.deepEqual(calls(s), [
      'locator(\'#card\').fill(***)', "page.fill('[name=cardnumber]', ***)", 'page.fill(\'[autocomplete="cc-number"]\', ***)']);
  });
});

// ---------------------------------------------------------------------------
describe('PCL-32: the bare token of an Authorization header is learned', () => {
  test('headerSecretValues: Bearer, Basic (decoded), other schemes and cookies', () => {
    assert.deepEqual(headerSecretValues('Authorization', 'Bearer tok-ABC-123'), ['Bearer tok-ABC-123', 'tok-ABC-123']);
    const basic = Buffer.from('jo:s3cret-pass').toString('base64');
    assert.deepEqual(headerSecretValues('authorization', `Basic ${basic}`), [`Basic ${basic}`, basic, 'jo:s3cret-pass', 's3cret-pass']);
    assert.deepEqual(headerSecretValues('Authorization', 'Token abcd1234'), ['Token abcd1234', 'abcd1234']);
    assert.deepEqual(headerSecretValues('X-Api-Key', 'plainkey-0001'), ['plainkey-0001']);
    assert.deepEqual(headerSecretValues('Cookie', 'sid=cookie-aaaa; theme=dark-bbbb'), ['sid=cookie-aaaa; theme=dark-bbbb', 'cookie-aaaa', 'dark-bbbb']);
    assert.deepEqual(headerSecretValues('Authorization', 12), []);
  });

  for (const target of ['page', 'context'] as const) {
    test(`${target}.setExtraHTTPHeaders({ Authorization: "Bearer X" }) also masks X`, async () => {
      const { s, page, ctx } = sessionFor();
      await (target === 'page' ? page : ctx).setExtraHTTPHeaders({ Authorization: 'Bearer tok-ABC-123', 'X-Trace': 'visible-trace' });
      page.emit('console', consoleMsg('echo tok-ABC-123 visible-trace'));
      assert.deepEqual(texts(s, 'console'), ['echo *** visible-trace']);
      assert.equal(calls(s)[0].includes('tok-ABC-123'), false);
    });
  }

  test('Basic credentials: the password is masked when the page echoes it', async () => {
    const { s, page } = sessionFor();
    await page.setExtraHTTPHeaders({ Authorization: `Basic ${Buffer.from('jo:s3cret-pass').toString('base64')}` });
    page.emit('console', consoleMsg('pw=s3cret-pass'));
    assert.deepEqual(texts(s, 'console'), ['pw=***']);
  });

  test('the extraHTTPHeaders option is learned the same way', () => {
    const c = resolveBrowserConfig({}, { extraHTTPHeaders: { Authorization: 'Bearer cfg-token-77' } });
    assert.ok(c.redact.values.includes('cfg-token-77'));
    assert.ok(c.redact.values.includes('Bearer cfg-token-77'));
  });
});

// ---------------------------------------------------------------------------
describe('PCL-33: the README says what Playwright-owned artifacts contain', () => {
  const readme = fs.readFileSync(path.join(__dirname, '..', 'README.md'), 'utf8');
  const changelog = fs.readFileSync(path.join(__dirname, '..', 'CHANGELOG.md'), 'utf8');

  test('limitations name HTML step titles, error-context.md and traces, and do not claim traces off is enough', () => {
    assert.match(readme, /Playwright-owned/i);
    assert.match(readme, /step titles?/i);
    assert.match(readme, /error-context\.md/);
    assert.match(readme, /even with traces? (off|disabled)/i);
    assert.match(readme, /redact\.values.{0,200}(does not|doesn't|do not).{0,80}(Playwright|report|trace)/is);
    assert.doesNotMatch(readme, /keep traces off to keep secrets/i);
  });

  test('the changelog lists the fixes', () => {
    for (const id of ['PCL-30', 'PCL-31', 'PCL-32', 'PCL-33', 'PCL-34', 'PCL-35', 'PCL-36', 'PCL-37', 'PCL-38']) {
      assert.ok(changelog.includes(id), id);
    }
  });
});

// ---------------------------------------------------------------------------
describe('PCL-34: stack frames with and without parentheses', () => {
  test('both frame forms give a clean { file, line, column }', () => {
    assert.deepEqual(parseStackFrame('    at /abs/path/leak.spec.ts:11:5'), { file: '/abs/path/leak.spec.ts', line: 11, column: 5 });
    assert.deepEqual(parseStackFrame('    at fn (/abs/path/leak.spec.ts:11:5)'), { file: '/abs/path/leak.spec.ts', line: 11, column: 5 });
    assert.deepEqual(parseStackFrame('    at async /abs/path/leak.spec.ts:12:7'), { file: '/abs/path/leak.spec.ts', line: 12, column: 7 });
    assert.deepEqual(parseStackFrame('    at async Context.<anonymous> (/abs/path/leak.spec.ts:12:7)'), { file: '/abs/path/leak.spec.ts', line: 12, column: 7 });
    assert.deepEqual(parseStackFrame('    at new Foo (/abs/a.ts:1:2)'), { file: '/abs/a.ts', line: 1, column: 2 });
    assert.deepEqual(parseStackFrame('    at /abs/Program Files (x86)/a.ts:1:2'), { file: '/abs/Program Files (x86)/a.ts', line: 1, column: 2 });
    assert.deepEqual(parseStackFrame('    at fn (/abs/Program Files (x86)/a.ts:3:4)'), { file: '/abs/Program Files (x86)/a.ts', line: 3, column: 4 });
  });

  test('Windows paths', () => {
    assert.deepEqual(parseStackFrame('    at C:\\proj\\tests\\a.spec.ts:11:5'), { file: 'C:\\proj\\tests\\a.spec.ts', line: 11, column: 5 });
    assert.deepEqual(parseStackFrame('    at fn (C:\\proj\\tests\\a.spec.ts:11:5)'), { file: 'C:\\proj\\tests\\a.spec.ts', line: 11, column: 5 });
    assert.deepEqual(parseStackFrame('    at fn (c:/proj/tests/a.spec.ts:11:5)'), { file: 'c:/proj/tests/a.spec.ts', line: 11, column: 5 });
  });

  test('file:// URLs become paths (percent-decoded; Windows drive letters kept)', () => {
    assert.deepEqual(parseStackFrame('    at file:///abs/my%20dir/a.spec.ts:11:5'), { file: '/abs/my dir/a.spec.ts', line: 11, column: 5 });
    assert.deepEqual(parseStackFrame('    at fn (file:///abs/a.spec.mjs:2:3)'), { file: '/abs/a.spec.mjs', line: 2, column: 3 });
    assert.deepEqual(parseStackFrame('    at file:///C:/proj/a.spec.ts:11:5'), { file: 'C:/proj/a.spec.ts', line: 11, column: 5 });
  });

  test('node internals, native, eval, <anonymous> and non-frames are not locations', () => {
    for (const raw of ['    at node:internal/process/task_queues:95:5', '    at fn (node:internal/modules/cjs/loader:1:1)',
      '    at new Promise (<anonymous>)', '    at Array.map (<anonymous>)', '    at eval at f (/abs/a.js:1:1), <anonymous>:1:1',
      'Error', 'Error: at /abs/a.ts:1:1', '']) {
      assert.equal(parseStackFrame(raw), undefined, raw);
    }
  });

  test('the step location Playwright receives is a plain absolute path', () => {
    const site = callSite(LIB_DIRS);
    assert.ok(site, 'a call site');
    assert.ok(path.isAbsolute(site.file), site.file);
    assert.ok(!site.file.includes('at '), site.file);
    assert.equal(site.file, __filename);
  });
});

// ---------------------------------------------------------------------------
describe('PCL-35: the call site skips library, Playwright and node frames', () => {
  const LIB = '/proj/node_modules/playwright-logger-pro/dist/';
  const stack = [
    'Error',
    `    at callSite (${LIB}fixtures.js:100:20)`,
    `    at /proj/node_modules/playwright-logger-pro/dist/fixtures.js:1675:12`,
    `    at Page.fill (${LIB}fixtures.js:1700:3)`,
    '    at node:internal/process/task_queues:95:5',
    '    at /proj/node_modules/playwright/lib/common/testType.js:200:30',
    '    at fn (/proj/node_modules/playwright-core/lib/client/frame.js:3:4)',
    '    at /proj/tests/login.spec.ts:14:9',
    '    at /proj/node_modules/playwright/lib/worker/workerMain.js:1:1',
  ].join('\n');

  test('dist frames without parentheses are skipped (they used to be returned as "at /…/fixtures.js")', () => {
    assert.deepEqual(pickCallSite(stack, [LIB]), { file: '/proj/tests/login.spec.ts', line: 14, column: 9 });
  });

  test('a stack captured from an installed package (anonymous wrapper frames have no parentheses)', () => {
    const real = [
      'Error: ',
      '    at callSite (/tmp/qa-proj/node_modules/playwright-logger-pro/dist/fixtures.js:2138:17)',
      '    at BrowserLogSession.beginAction (/tmp/qa-proj/node_modules/playwright-logger-pro/dist/fixtures.js:2498:37)',
      '    at /tmp/qa-proj/node_modules/playwright-logger-pro/dist/fixtures.js:1675:18',
      '    at safe (/tmp/qa-proj/node_modules/playwright-logger-pro/dist/fixtures.js:1615:5)',
      '    at _Page.goto (/tmp/qa-proj/node_modules/playwright-logger-pro/dist/fixtures.js:1674:5)',
      '    at /tmp/qa-proj/tests/loc.spec.ts:4:14',
      '    at /tmp/qa-proj/node_modules/playwright/lib/worker/workerProcessEntry.js:1662:15',
    ].join('\n');
    assert.deepEqual(pickCallSite(real, ['/tmp/qa-proj/node_modules/playwright-logger-pro/dist/']),
        { file: '/tmp/qa-proj/tests/loc.spec.ts', line: 4, column: 14 });
  });

  test('frames of this package under src/, file:// frames and Windows spellings are skipped as well', () => {
    const dirs = ['/proj/node_modules/playwright-logger-pro/dist/', '/proj/node_modules/playwright-logger-pro/src/'];
    const s = [
      'Error',
      '    at x (file:///proj/node_modules/playwright-logger-pro/dist/fixtures.mjs:5:1)',
      '    at y (/proj/node_modules/playwright-logger-pro/src/browser/session.ts:5:1)',
      '    at /proj/tests/a.spec.ts:1:2',
    ].join('\n');
    assert.equal(pickCallSite(s, dirs)?.file, '/proj/tests/a.spec.ts');
    const win = ['Error', '    at x (C:\\P\\node_modules\\plp\\dist\\fixtures.js:5:1)', '    at C:\\P\\tests\\a.spec.ts:1:2'].join('\n');
    assert.equal(pickCallSite(win, ['c:\\P\\node_modules\\plp\\dist\\'])?.file, 'C:\\P\\tests\\a.spec.ts');
  });

  test('Playwright packages are skipped even before their directories are known', () => {
    assert.ok(isLibraryFile('/p/node_modules/playwright/lib/x.js', []));
    assert.ok(isLibraryFile('/p/node_modules/playwright-core/lib/x.js', []));
    assert.ok(isLibraryFile('/p/node_modules/@playwright/test/lib/x.js', []));
    assert.ok(!isLibraryFile('/p/tests/playwright-notes.spec.ts', []));
    assert.ok(!isLibraryFile('/p/node_modules/other/x.js', []));
    assert.equal(pickCallSite('Error\n    at /p/node_modules/playwright/lib/x.js:1:1', []), undefined);
  });

  test('a real call: location: true on an action reports this file, not the library', async () => {
    for (const dir of LIB_DIRS) getRegistry().libDirs.add(dir); // what ensureStackHygiene() does
    const { s, page } = sessionFor({ location: true });
    await page.locator('#x').click();
    const a = actions(s)[0];
    assert.equal(a.location?.file, __filename);
    assert.ok((a.location?.line ?? 0) > 0);
  });
});

// ---------------------------------------------------------------------------
describe('PCL-36: browserLog options are validated', () => {
  afterEach(() => resetWarnings());

  test('bad types and values warn once and fall back to the defaults', async () => {
    const { result, warnings } = await withWarnings(() => resolveBrowserConfig({
      print: 'yes', browserConsole: 'verbose', network: 'some', slowActionMs: 'x', bogus: 1, maxEvents: 0,
      attach: 'sometimes', file: 1, steps: 'maybe', colors: 'no', location: 'yes', attachFormat: 'xml', sink: 'nope',
      redact: { fillValues: 'sometimes', mask: 5, inspectInputType: 'yes', extra: true },
    } as unknown as BrowserLoggerConfig));
    for (const key of ['print', 'browserConsole', 'network', 'slowActionMs', 'bogus', 'maxEvents', 'attach', 'file', 'steps',
      'colors', 'location', 'attachFormat', 'sink', 'redact.fillValues', 'redact.mask', 'redact.inspectInputType', 'redact.extra']) {
      assert.ok(warnings.some((w) => w.includes(`"${key}"`)), `${key}\n${warnings.join('\n')}`);
    }
    assert.ok(warnings.every((w) => w.startsWith('[playwright-logger-pro] ')));
    assert.ok(warnings.some((w) => /"print" must be true, false or 'on-failure' \(got the string "yes"\); using 'on-failure'/.test(w)));
    for (const key of ['print', 'browserConsole', 'network', 'slowActionMs', 'maxEvents', 'attach', 'file', 'steps', 'location',
      'attachFormat', 'maxArgLength', 'includeApiLog']) {
      assert.deepEqual(result[key as keyof typeof result], DEFAULT_BROWSER_CONFIG[key as keyof typeof DEFAULT_BROWSER_CONFIG], key);
    }
    assert.equal(result.sink, DEFAULT_BROWSER_CONFIG.sink);
    assert.equal(result.redact.fillValues, 'auto');
    assert.equal(result.redact.mask, '***');
    assert.equal(result.redact.inspectInputType, false);
  });

  test('maxEvents 0, negative, fractional, NaN, Infinity and strings use the default and warn', async () => {
    for (const bad of [0, -1, 1.5, Number.NaN, Infinity, '10', null]) {
      const { result, warnings } = await withWarnings(() => resolveBrowserConfig({ maxEvents: bad } as unknown as BrowserLoggerConfig));
      assert.equal(result.maxEvents, DEFAULT_BROWSER_CONFIG.maxEvents, String(bad));
      assert.ok(warnings.some((w) => /"maxEvents" must be a positive integer/.test(w)), String(bad));
    }
    assert.equal(resolveBrowserConfig({ maxEvents: 3 }).maxEvents, 3);
  });

  test('maxEvents: 0 no longer suppresses the failure block', async () => {
    const sink: string[] = [];
    const { s, page } = sessionFor({ maxEvents: 0, print: 'on-failure' }, sink);
    const warn = mock.method(console, 'warn', () => undefined);
    try {
      await page.locator('#x').click();
    } finally {
      warn.mock.restore();
    }
    const info: TestInfoLike = {
      title: 't', status: 'failed', expectedStatus: 'passed', outputPath: (...p) => p.join('/'),
      async attach() {},
    };
    s.endCapture();
    await writeOutputs(s, info);
    assert.equal(sink.length, 1);
    assert.match(sink[0], /locator\('#x'\)\.click\(\)/);
  });

  test('list options: wrong container or entries warn; valid values pass through', async () => {
    const { result, warnings } = await withWarnings(() => resolveBrowserConfig({
      redact: { selectors: 'password', values: ['good-secret-1', 7, null], keys: [/x/, 3], headers: 'x-h' },
    } as unknown as BrowserLoggerConfig));
    assert.ok(warnings.some((w) => /"redact\.selectors" must be an array of strings or regular expressions/.test(w)), warnings.join('\n'));
    assert.ok(warnings.some((w) => /"redact\.values" contains entries that are not strings/.test(w)));
    assert.ok(warnings.some((w) => /"redact\.keys" contains entries/.test(w)));
    assert.ok(warnings.some((w) => /"redact\.headers" must be an array of strings/.test(w)));
    assert.deepEqual(result.redact.values, ['good-secret-1']);
    assert.deepEqual(result.redact.selectors, [...DEFAULT_SENSITIVE_SELECTORS]);
    assert.equal(result.redact.keys.length, 1);
  });

  test('the whole option must be an object', async () => {
    const { result, warnings } = await withWarnings(() => resolveBrowserConfig(false as unknown as BrowserLoggerConfig));
    assert.ok(warnings.some((w) => /browserLog option must be an object/.test(w)));
    assert.equal(result.enabled, true);
  });

  test('valid configurations and undefined values are silent', async () => {
    const { result, warnings } = await withWarnings(() => resolveBrowserConfig({
      enabled: true, colors: false, actions: true, waits: false, queries: true, mouseMoves: true, navigation: true,
      browserConsole: false, pageErrors: false, network: 'documents', networkFilter: () => true, steps: 'auto', includeApiLog: false,
      logStart: true, slowActionMs: Infinity, location: true, maxArgLength: 80, maxEvents: 10, print: true, attach: 'on-failure',
      attachFormat: 'jsonl', file: true, fileFormat: 'jsonl', fileDir: '/tmp/x', sink: () => undefined,
      redact: { mask: '[x]', fillValues: 'always', selectors: ['a', /b/], values: ['value-1234'], keys: ['k'], headers: ['h'], inspectInputType: true },
    }));
    assert.deepEqual(warnings, []);
    assert.equal(result.maxEvents, 10);
    assert.equal(result.slowActionMs, Infinity);
    const undef = await withWarnings(() => resolveBrowserConfig({ print: undefined, maxEvents: undefined, redact: { mask: undefined } }));
    assert.deepEqual(undef.warnings, []);
    assert.equal(undef.result.print, 'on-failure');
  });

  test('each warning is printed once per process', async () => {
    const { warnings } = await withWarnings(() => {
      resolveBrowserConfig({ print: 'yes' } as unknown as BrowserLoggerConfig);
      resolveBrowserConfig({ print: 'yes' } as unknown as BrowserLoggerConfig);
    });
    assert.equal(warnings.length, 1);
  });
});

// ---------------------------------------------------------------------------
describe('PCL-37: a fill that completed is not "still pending" when the probe has not answered', () => {
  test('flushed at test end: status ok, duration of the call, value masked', async () => {
    const { s, page } = sessionFor({ redact: { inspectInputType: true } });
    FakeLocator.probeResult = new Promise(() => undefined); // never answers
    await page.locator('#nick').fill('plain-value-1');
    s.endCapture();
    const [fill] = actions(s);
    assert.equal(fill.method, 'fill');
    assert.equal(fill.status, 'ok');
    assert.equal(fill.args, '***');
    assert.equal(fill.redacted, true);
    assert.ok(!JSON.stringify(s.events()).includes('plain-value-1'));
    assert.ok(!s.handle.render('text').includes('still pending'));
  });

  test('a call that is really unfinished at test end is still reported as pending', async () => {
    const { s, page } = sessionFor();
    const proto = Object.getPrototypeOf(page.mainFrame());
    const sym = Object.getOwnPropertySymbols(proto).find((x) => (x.description ?? '').endsWith('.click'))!;
    const saved = proto[sym];
    proto[sym] = () => new Promise(() => undefined);
    try {
      void page.click('#never');
      s.endCapture();
    } finally {
      proto[sym] = saved;
    }
    assert.equal(actions(s)[0].status, 'pending');
  });

  test('an answer arriving after the flush changes nothing and does not duplicate the event', async () => {
    const { s, page } = sessionFor({ redact: { inspectInputType: true } });
    let answer!: (v: string[]) => void;
    FakeLocator.probeResult = new Promise((r) => { answer = r as (v: string[]) => void; });
    await page.locator('#nick').fill('plain-value-2');
    s.endCapture();
    answer(['text', '']);
    await new Promise((r) => setTimeout(r, 5));
    assert.equal(actions(s).length, 1);
    assert.equal(actions(s)[0].status, 'ok');
    assert.equal(actions(s)[0].args, '***');
  });
});

// ---------------------------------------------------------------------------
describe('PCL-38: the timeline is in chronological order', () => {
  test('events that happen while an action runs follow its line', async () => {
    const { s, page } = sessionFor();
    const proto = Object.getPrototypeOf(page.mainFrame());
    const sym = Object.getOwnPropertySymbols(proto).find((x) => (x.description ?? '').endsWith('.click'))!;
    const saved = proto[sym];
    proto[sym] = async () => {
      page.emit('dialog', new FakeDialog('alert', 'hello'));
      page.emit('console', consoleMsg('during click'));
    };
    try {
      await page.click('#open');
    } finally {
      proto[sym] = saved;
    }
    page.emit('console', consoleMsg('after click'));
    const kinds = s.events().map((e) => (e.kind === 'action' ? `action:${e.method}` : e.kind === 'console' ? `console:${e.text}` : e.kind));
    assert.deepEqual(kinds.filter((k) => k !== 'page'), ['action:click', 'dialog', 'console:during click', 'console:after click']);
    const events = s.events();
    assert.deepEqual(events.map((e) => e.seq), [...events.map((e) => e.seq)].sort((a, b) => a - b));
    assert.deepEqual(events.map((e) => e.t), [...events.map((e) => e.t)].sort((a, b) => a - b));
    const text = s.handle.render('text');
    assert.ok(text.indexOf('page.click') < text.indexOf('dialog alert'), text);
  });

  test('the page-opened line comes before the first action on it', async () => {
    const { s, page } = sessionFor();
    page.emit('framenavigated', { url: () => 'http://x.test/', parentFrame: () => null });
    await page.goto('/x');
    await new Promise((r) => setImmediate(r));
    const kinds = s.events().map((e) => (e.kind === 'page' ? `page:${e.event}` : e.kind === 'action' ? `action:${e.method}` : e.kind));
    assert.ok(kinds.indexOf('page:opened') < kinds.indexOf('action:goto'), kinds.join(','));
  });

  test('concurrent actions are ordered by start, with their events after each', async () => {
    const { s, page } = sessionFor();
    const proto = Object.getPrototypeOf(page.mainFrame());
    const sym = Object.getOwnPropertySymbols(proto).find((x) => (x.description ?? '').endsWith('.click'))!;
    const saved = proto[sym];
    proto[sym] = (selector: string) => new Promise<void>((r) => setTimeout(() => {
      page.emit('console', consoleMsg(`done ${selector}`));
      r();
    }, selector === '#slow' ? 20 : 1));
    try {
      await Promise.all([page.click('#slow'), page.click('#fast')]);
    } finally {
      proto[sym] = saved;
    }
    const order = s.events().flatMap((e) => (e.kind === 'action' ? [`click ${e.args}`] : e.kind === 'console' ? [e.text] : []));
    assert.deepEqual(order.filter((x) => !x.startsWith('page')), ["click '#slow'", "click '#fast'", 'done #fast', 'done #slow']);
  });

  test('live printing is in the same order as the stored timeline', async () => {
    const sink: string[] = [];
    const { s, page } = sessionFor({ print: true }, sink);
    const proto = Object.getPrototypeOf(page.mainFrame());
    const sym = Object.getOwnPropertySymbols(proto).find((x) => (x.description ?? '').endsWith('.click'))!;
    const saved = proto[sym];
    proto[sym] = async () => {
      await new Promise((r) => setTimeout(r, 5));
      page.emit('dialog', new FakeDialog('alert', 'hello'));
    };
    try {
      await page.click('#open');
    } finally {
      proto[sym] = saved;
    }
    await new Promise((r) => setImmediate(r));
    const printed = sink.join('\n');
    assert.ok(printed.indexOf('page.click') < printed.indexOf('dialog alert'), printed);
    assert.ok(printed.indexOf('page#1 opened') < printed.indexOf('page.click'), printed);
    assert.equal(sink.length, s.events().filter((e) => e.kind !== 'api').length);
    s.detach();
  });

  test('OrderedPrinter: holds lines behind an unfinished action, releases in seq order, flush and overflow never lose lines', () => {
    const out: string[] = [];
    const p = new OrderedPrinter((t) => out.push(t), 4);
    p.put(0, 'a');
    p.hold(1);
    p.put(2, 'c');
    p.put(3, 'd');
    assert.deepEqual(out, ['a']);
    p.put(1, 'b');
    assert.deepEqual(out, ['a', 'b', 'c', 'd']);
    p.hold(4);
    p.put(5, 'f');
    p.flush();
    assert.deepEqual(out, ['a', 'b', 'c', 'd', 'f']);
    p.put(4, 'e'); // late: printed right away
    assert.equal(out.at(-1), 'e');
    p.hold(10);
    for (let i = 11; i < 20; i++) p.put(i, `l${i}`);
    assert.equal(out.filter((l) => l.startsWith('l')).length, 9, 'a backlog is released, not dropped');
    p.hold(30);
    p.release(30);
    p.put(31, 'z');
    assert.equal(out.at(-1), 'z');
  });

  test('ring buffer trimming drops the oldest events by timeline order', async () => {
    const { s, page } = sessionFor({ maxEvents: 20 });
    for (let i = 0; i < 100; i++) await page.locator(`#x${i}`).click();
    const events = s.events();
    assert.equal(events[0].kind, 'dropped');
    const last = events.at(-1) as Action;
    assert.equal(last.subject, "locator('#x99')");
    const seqs = events.slice(1).map((e) => e.seq);
    assert.deepEqual(seqs, [...seqs].sort((a, b) => a - b));
  });
});
