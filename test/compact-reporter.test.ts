import { afterEach, beforeEach, describe, mock, test } from 'node:test';
import assert from 'node:assert/strict';
import type { FullConfig, TestCase, TestResult } from '@playwright/test/reporter';
import { REPORTER_VAR } from '../src/compact/finish';
import { ATTACHMENT_NAME } from '../src/compact/types';
import type { CallRecord, CallsAttachment } from '../src/compact/types';
import Reporter from '../src/reporter';
import type { ReporterOptions } from '../src/reporter';

const tick = () => new Promise<void>((resolve) => setImmediate(resolve));

let written: string[];
let savedTty: string | undefined;
let savedVar: string | undefined;

beforeEach(() => {
  written = [];
  savedTty = process.env.PLAYWRIGHT_FORCE_TTY;
  savedVar = process.env[REPORTER_VAR];
});
afterEach(() => {
  mock.restoreAll();
  if (savedTty === undefined) delete process.env.PLAYWRIGHT_FORCE_TTY;
  else process.env.PLAYWRIGHT_FORCE_TTY = savedTty;
  if (savedVar === undefined) delete process.env[REPORTER_VAR];
  else process.env[REPORTER_VAR] = savedVar;
});

const call = (path: string, status: number, durationMs = 30, extra: Partial<CallRecord> = {}): CallRecord => ({
  method: 'GET', url: `https://api.test${path}`, status, statusText: status >= 500 ? 'Server Error' : status >= 400 ? 'Not Found' : 'OK',
  durationMs, responseBody: { kind: 'text', text: '{"e":1}' }, ...extra,
});

const testCase = (title: string, expectedStatus = 'passed'): TestCase => ({
  title,
  titlePath: () => ['', 'chromium', 'a.spec.ts', title],
  location: { file: '/repo/a.spec.ts', line: 3, column: 5 },
  expectedStatus,
}) as unknown as TestCase;

const result = (calls: CallRecord[] | undefined, status = 'passed', options?: Record<string, unknown>): TestResult => ({
  status,
  attachments: calls ? [{
    name: ATTACHMENT_NAME, contentType: 'application/json',
    body: Buffer.from(JSON.stringify({ version: 1, options, calls } satisfies CallsAttachment)),
  }] : [],
}) as unknown as TestResult;

function spy(r: Reporter): Reporter {
  // Not process.stdout: the test runner talks to its parent through it.
  mock.method(r as unknown as { write: (lines: string[]) => void }, 'write', (lines: string[]) => {
    if (lines.length > 0) written.push(`${lines.join('\n')}\n`);
  });
  return r;
}

function reporter(options: ReporterOptions = {}, listed = true) {
  const r = spy(new Reporter({ colors: false, ...options }));
  r.onBegin({ reporter: listed ? [['list'], ['x']] : [['dot']] } as unknown as FullConfig);
  return r;
}

const out = () => written.join('');

describe('the reporter outside a terminal', () => {
  beforeEach(() => { process.env.PLAYWRIGHT_FORCE_TTY = '0'; });

  test('prints the lines of a test when it ends (one tick later), a total at the end', async () => {
    const r = reporter();
    const t = testCase('buys');
    r.onTestBegin();
    r.onTestEnd(t, result([call('/a', 200, 142), call('/b', 404)]));
    assert.equal(out(), '', 'not before the list reporter has finished its line');
    await tick();
    const first = out().split('\n')[0] ?? '';
    assert.ok(first.startsWith('    GET     200   https://api.test/a  ') && first.endsWith('  142ms'), first);
    assert.equal(first.length, 82, 'plain mode keeps the timing at column 82');
    assert.equal(out().split('\n')[1]?.slice(0, 16), '    GET    [404]');
    await r.onEnd();
    assert.ok(out().endsWith('  2 requests · 1 error\n'), out());
  });

  test('details follow the result of the test, not the call', async () => {
    const r = reporter();
    r.onTestBegin();
    r.onTestEnd(testCase('passes'), result([call('/x', 404)], 'passed'));
    r.onTestBegin();
    await tick();
    assert.ok(!out().includes('←'), 'a 404 in a passing test has no block');
    r.onTestEnd(testCase('fails'), result([call('/y', 404)], 'failed'));
    await tick();
    assert.ok(out().includes('│ ← 404 Not Found  {"e":1}'), out());
    // an expected failure (test.fail()) counts as passed
    written.length = 0;
    r.onTestBegin();
    r.onTestEnd(testCase('expected', 'failed'), result([call('/z', 500)], 'failed'));
    await tick();
    assert.ok(!out().includes('←'));
  });

  test('without the list reporter the block carries a title line; with it, it does not', async () => {
    const withList = reporter();
    withList.onTestBegin();
    withList.onTestEnd(testCase('t1'), result([call('/a', 200)]));
    await tick();
    assert.ok(!out().includes('t1'));
    written.length = 0;
    const alone = reporter({}, false);
    alone.onTestBegin();
    alone.onTestEnd(testCase('t1'), result([call('/a', 200)]));
    await tick();
    assert.equal(out().split('\n')[0], '  ✓  [chromium] › a.spec.ts:3:5 › t1');
  });

  test('tests that end in the same tick get title lines: their result lines may be anywhere', async () => {
    const r = reporter();
    r.onTestBegin();
    r.onTestBegin();
    r.onTestEnd(testCase('one'), result([call('/a', 200)]));
    r.onTestEnd(testCase('two'), result([call('/b', 200)]));
    await tick();
    assert.match(out(), /one\n.*\/a.*\n.*two\n.*\/b/);
  });

  test('a test without calls, or with an unreadable attachment, prints nothing', async () => {
    const r = reporter();
    r.onTestBegin();
    r.onTestEnd(testCase('none'), result(undefined));
    r.onTestBegin();
    r.onTestEnd(testCase('bad'), { status: 'passed', attachments: [{ name: ATTACHMENT_NAME, body: Buffer.from('{nope') }] } as never);
    await tick();
    await r.onEnd();
    assert.equal(out(), '');
  });

  test('its own options win over the ones the fixture recorded', async () => {
    const r = reporter({ details: 'never', slowThresholdMs: 10, ascii: true });
    r.onTestBegin();
    r.onTestEnd(testCase('t'), result([call('/a', 500, 20)], 'failed', { details: 'always', slowThresholdMs: 5000, ascii: false }));
    await tick();
    assert.equal(out().split('\n').length, 2, 'details never: the line only');
    assert.ok(out().includes('^ 20ms'), out());
  });

  test('registers itself for the workers of this runner', () => {
    delete process.env[REPORTER_VAR];
    reporter();
    assert.equal(process.env[REPORTER_VAR], String(process.pid));
  });

  test('colours: off by default outside a terminal, on with colors: true', async () => {
    const r = spy(new Reporter({}));
    r.onBegin({ reporter: [['list']] } as unknown as FullConfig);
    r.onTestBegin();
    r.onTestEnd(testCase('t'), result([call('/a', 200)]));
    await tick();
    assert.ok(!out().includes('\u001b['));
    written.length = 0;
    const forced = reporter({ colors: true });
    forced.onTestBegin();
    forced.onTestEnd(testCase('t'), result([call('/a', 200)]));
    await tick();
    assert.ok(out().includes('\u001b['));
  });
});

describe('the reporter in a terminal', () => {
  beforeEach(() => { process.env.PLAYWRIGHT_FORCE_TTY = '1'; });

  test('the only running test: the lines go out at once, under its result line', async () => {
    const r = reporter();
    r.onTestBegin();
    r.onTestEnd(testCase('solo'), result([call('/a', 200)]));
    await tick();
    assert.ok(out().startsWith('    GET'), out());
  });

  test('while another test runs nothing is printed: the list reporter would rewrite the wrong row', async () => {
    const r = reporter();
    r.onTestBegin(); // A
    r.onTestBegin(); // B
    r.onTestEnd(testCase('A'), result([call('/a', 200)]));
    await tick();
    assert.equal(out(), '', 'held');
    r.onTestEnd(testCase('B'), result([call('/b', 200)]));
    await tick();
    // both come out once the terminal is idle, each under a title line
    assert.match(out(), /✓ {2}\[chromium\] › a\.spec\.ts:3:5 › A\n.*\/a.*\n {2}✓ {2}\[chromium\] › a\.spec\.ts:3:5 › B\n.*\/b/);
  });

  test('a test that starts meanwhile keeps holding it back; the end of the run prints what is left', async () => {
    const r = reporter();
    r.onTestBegin();
    r.onTestEnd(testCase('A'), result([call('/a', 200)]));
    r.onTestBegin(); // C starts before A's lines were printed
    await tick();
    assert.equal(out(), '');
    await r.onEnd();
    assert.ok(out().includes('› A\n'), out());
    assert.ok(out().endsWith('  1 request\n'));
  });

  test('the total comes last, after everything', async () => {
    const r = reporter();
    r.onTestBegin();
    r.onTestEnd(testCase('A'), result([call('/a', 500, 2000)], 'failed'));
    await tick();
    await r.onEnd();
    const lines = out().trimEnd().split('\n');
    assert.equal(lines.at(-1), '  1 request · 1 error · 1 slow ≥1s');
  });
});
