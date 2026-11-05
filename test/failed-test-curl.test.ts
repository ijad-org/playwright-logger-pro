import { after, before, beforeEach, describe, mock, test } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import * as os from 'node:os';
import * as path from 'node:path';
import { request } from '@playwright/test';
import type { APIRequestContext } from '@playwright/test';
import { CallCollector, finishCompact } from '../src/compact/finish';
import { DEFAULT_DISPLAY, failedTestCurlOf } from '../src/compact/options';
import { renderCalls, renderDetail, showsDetail } from '../src/compact/render';
import type { RenderOptions } from '../src/compact/render';
import { ATTACHMENT_NAME } from '../src/compact/types';
import type { CallRecord, CallsAttachment } from '../src/compact/types';
import { DEFAULT_CONFIG, resolveConfig } from '../src/types';
import type { ApiLoggerConfig } from '../src/types';
import { resetWarnings } from '../src/warn';
import { wrapRequestContext } from '../src/wrapRequestContext';

const SECRET = 'SECRET-123';
const strip = (text: string): string => text.replace(/\u001b\[[0-9;]*m/g, '');

const server = http.createServer((req, res) => {
  req.resume();
  req.on('end', () => {
    const { pathname } = new URL(req.url ?? '/', 'http://x');
    const send = (status: number, body: string) => {
      res.writeHead(status, { 'content-type': 'application/json' });
      res.end(body);
    };
    if (pathname === '/created') return send(201, JSON.stringify({ id: 7, accessToken: SECRET }));
    if (pathname === '/missing') return send(404, '{"error":"missing"}');
    if (pathname === '/boom') return send(500, '{"error":"boom"}');
    return send(200, '{"ok":true}');
  });
});

let baseURL = '';
let ctx: APIRequestContext;
before(async () => {
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  baseURL = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  ctx = await request.newContext({ baseURL });
});
after(async () => {
  await ctx.dispose();
  server.closeAllConnections();
  await new Promise<void>((resolve) => server.close(() => resolve()));
});
beforeEach(() => resetWarnings());

interface Attached { name: string; body: string }

/** A fake TestInfo whose `errors` the test can grow, like Playwright does when an assertion fails. */
function fakeTestInfo(status: 'passed' | 'failed', expectedStatus = 'passed') {
  const attached: Attached[] = [];
  const errors: unknown[] = [];
  return {
    attached,
    errors,
    info: {
      title: 'a test', status, expectedStatus, errors, file: '/repo/tests/a.spec.ts', line: 7,
      config: { rootDir: '/repo' }, project: { testDir: '/repo/tests' },
      outputPath: (...parts: string[]) => path.join(os.tmpdir(), ...parts),
      attach: async (name: string, o: { body?: string | Buffer }) => {
        attached.push({ name, body: String(o.body ?? '') });
      },
    },
  };
}

/** What the fixture does: wrap, collect, call, finish. `act` gets the context and the test's `errors`. */
async function run(
    config: ApiLoggerConfig,
    act: (api: APIRequestContext, errors: unknown[]) => Promise<unknown>,
    { status = 'failed', expectedStatus = 'passed', colors }: { status?: 'passed' | 'failed'; expectedStatus?: string; colors?: boolean } = {},
) {
  const printed: string[] = [];
  const cfg = resolveConfig({ baseURL, colors: false, ...config, sink: (l) => printed.push(l) });
  const { attached, errors, info } = fakeTestInfo(status, expectedStatus);
  const collector = new CallCollector(cfg.curlOnFailedTest, info);
  const api = wrapRequestContext(ctx, cfg, { onCall: (c) => collector.add(c) });
  await act(api, errors);
  await finishCompact(collector.calls, info, { cfg, customSink: false, reporter: false, colors });
  const json = attached.find((a) => a.name === ATTACHMENT_NAME);
  return {
    collector,
    printed: printed.join('\n'),
    lines: strip(printed.join('\n')).split('\n'),
    scripts: attached.filter((a) => /^curl.*\.sh$/.test(a.name)),
    attachment: json ? JSON.parse(json.body) as CallsAttachment : undefined,
    everything: [printed.join('\n'), ...attached.map((a) => a.body)].join('\n'),
  };
}

/** The repro: a 200, then a POST that answers 201 where the test expected 200. */
const repro = async (api: APIRequestContext) => {
  await api.get('/ok?token=abc');
  await api.post('/created?token=abc', { data: { name: 'x', password: SECRET }, headers: { Authorization: `Bearer ${SECRET}` } });
};

describe('the option', () => {
  test('is off by default and parses false, true, last and all', () => {
    assert.equal(DEFAULT_CONFIG.curlOnFailedTest, false);
    assert.equal(resolveConfig({}).curlOnFailedTest, false);
    assert.equal(resolveConfig({ curlOnFailedTest: false }).curlOnFailedTest, false);
    assert.equal(resolveConfig({ curlOnFailedTest: true }).curlOnFailedTest, 'last');
    assert.equal(resolveConfig({ curlOnFailedTest: 'last' }).curlOnFailedTest, 'last');
    assert.equal(resolveConfig({ curlOnFailedTest: 'all' }).curlOnFailedTest, 'all');
    // a resolved config can be resolved again (the fixture does)
    assert.equal(resolveConfig(resolveConfig({ curlOnFailedTest: 'all' })).curlOnFailedTest, 'all');
    assert.equal(failedTestCurlOf('first'), undefined);
  });

  test('another value warns and falls back to off; the option is not "unknown"', () => {
    const warn = mock.method(console, 'warn', () => undefined);
    try {
      assert.equal(resolveConfig({ curlOnFailedTest: 'first' as 'last' }).curlOnFailedTest, false);
      const messages = warn.mock.calls.map((c) => String(c.arguments[0]));
      assert.equal(messages.length, 1, messages.join('\n'));
      assert.match(messages[0] as string, /option "curlOnFailedTest" must be false, true, 'last' or 'all' \(got the string "first"\); using false/);
    } finally {
      warn.mock.restore();
    }
  });
});

describe('a failed test whose last call succeeded', () => {
  test('without the option nothing changes: no block, no curl, no script', async () => {
    const out = await run({}, repro);
    assert.equal(out.lines.length, 2, out.printed);
    assert.deepEqual(out.scripts, []);
    assert.ok(out.attachment?.calls.every((c) => c.curl === undefined && c.curlOnFailedTest === undefined));
    assert.ok(out.collector.calls.every((c) => c.curlParts === undefined), 'no curl is even built');
  });

  test("'last': the 2xx call gets its response, its curl and a curl.sh, the call before it does not", async () => {
    const out = await run({ curlOnFailedTest: 'last' }, repro);
    assert.match(out.lines[0] ?? '', /^ {4}GET {4} 200 {3}http:\/\/127\.0\.0\.1:\d+\/ok\?token=\*\*\* /);
    assert.match(out.lines[1] ?? '', /^ {4}POST {3} 201 {3}http:\/\/127\.0\.0\.1:\d+\/created\?token=\*\*\* /, 'the chip is not an error chip');
    assert.equal(out.lines[2], '    │ ← 201 Created  {"id":7,"accessToken":"***"}');
    assert.equal(out.lines[3], '    │');
    assert.equal(out.lines[4], `    │ curl -X POST '${baseURL}/created?token=***' \\`);
    assert.ok(out.lines.includes('    │ ↳ replay: curl.sh attached to the HTML report'), out.printed);
    assert.equal(out.lines.filter((l) => l.startsWith('    │ ←')).length, 1, 'one block, for the last call only');
    assert.deepEqual(out.scripts.map((s) => s.name), ['curl.sh']);
    const [first, second] = out.attachment?.calls ?? [];
    assert.equal(first?.curl, undefined);
    assert.equal(second?.curlOnFailedTest, true);
    assert.equal(second?.curlFile, 'curl.sh');
  });

  test('the curl is masked everywhere: ***  in the console and the attachment, ${VAR} placeholders in curl.sh', async () => {
    const out = await run({ curlOnFailedTest: 'last' }, repro);
    assert.ok(!out.everything.includes(SECRET), 'the secret is nowhere');
    const script = out.scripts[0]?.body ?? '';
    assert.match(script, /^#!\/usr\/bin\/env bash\nset -euo pipefail\n/);
    for (const name of ['AUTHORIZATION', 'TOKEN', 'PASSWORD']) {
      assert.ok(script.includes(`: "\${${name}:?export ${name} first}"`), `guard for ${name}\n${script}`);
    }
    assert.ok(script.includes(`Authorization: '"\${AUTHORIZATION}"'`) || script.includes('"${AUTHORIZATION}"'), script);
    assert.ok(script.includes('token=\'"${TOKEN}"'), script);
    assert.ok(out.printed.includes('Authorization: ***') && out.printed.includes('token=***') && out.printed.includes('"password":"***"'), out.printed);
  });

  test('the same curl as the status modes build: a 5xx call under the default mode is not duplicated or changed', async () => {
    const plain = await run({}, (api) => api.get('/boom'));
    const flagged = await run({ curlOnFailedTest: 'last' }, (api) => api.get('/boom'));
    assert.equal(flagged.attachment?.calls[0]?.curl, plain.attachment?.calls[0]?.curl);
    assert.deepEqual(flagged.scripts.map((s) => [s.name, s.body]), plain.scripts.map((s) => [s.name, s.body]));
    assert.equal(flagged.lines.filter((l) => l.includes('← 500')).length, 1);
    assert.equal(flagged.lines.filter((l) => l.includes('replay:')).length, 1);
  });

  test("a 4xx last call gets the curl the default '5xx' mode withholds", async () => {
    const plain = await run({}, (api) => api.get('/missing'));
    assert.ok(!plain.printed.includes('curl '), plain.printed);
    assert.deepEqual(plain.scripts, []);
    const out = await run({ curlOnFailedTest: 'last' }, (api) => api.get('/missing'));
    assert.ok(out.printed.includes("│ curl '"), out.printed);
    assert.deepEqual(out.scripts.map((s) => s.name), ['curl.sh']);
  });

  test("'all': every call made before the failure; several scripts are numbered", async () => {
    const out = await run({ curlOnFailedTest: 'all' }, repro);
    assert.equal(out.lines.filter((l) => l.startsWith('    │ ←')).length, 2);
    assert.deepEqual(out.scripts.map((s) => s.name), ['curl-1-GET-ok.sh', 'curl-2-POST-created.sh']);
  });

  test('it works with curl: never, and together with curl: always', async () => {
    const never = await run({ curl: 'never', curlOnFailedTest: 'last' }, repro);
    assert.deepEqual(never.scripts.map((s) => s.name), ['curl.sh']);
    assert.equal(never.attachment?.calls[0]?.curl, undefined, 'the other call has none');
    const always = await run({ curl: 'always', curlOnFailedTest: 'last' }, repro);
    assert.equal(always.lines.filter((l) => l.startsWith('    │ ←')).length, 1, 'only the selected call is printed');
    assert.equal(always.scripts.length, 2, 'curl: always scripts every call of a failed test, as before');
  });

  test('details: never keeps the block out but not the script; curlFormat.file: false keeps the file out but not the block', async () => {
    const never = await run({ curlOnFailedTest: 'last', details: 'never' }, repro);
    assert.equal(never.lines.length, 2);
    assert.deepEqual(never.scripts.map((s) => s.name), ['curl.sh']);
    const noFile = await run({ curlOnFailedTest: 'last', curlFormat: { file: false } }, repro);
    assert.ok(noFile.printed.includes("│ curl -X POST '"), noFile.printed);
    assert.ok(!noFile.printed.includes('replay:'));
    assert.deepEqual(noFile.scripts, []);
  });

  test('the first failure ends the search: calls made after it (afterEach cleanups, steps after expect.soft) are not the last call', async () => {
    const out = await run({ curlOnFailedTest: 'last' }, async (api, errors) => {
      await api.get('/ok');
      await api.post('/created', { data: {} });
      errors.push(new Error('expect(received).toBe(expected)'));
      await api.get('/ok?cleanup=1');
    });
    assert.deepEqual(out.scripts.map((s) => s.name), ['curl.sh']);
    assert.ok(out.printed.includes("curl -X POST '"), out.printed);
    const calls = out.attachment?.calls ?? [];
    assert.deepEqual(calls.map((c) => c.curlOnFailedTest), [undefined, true, undefined]);
  });

  test("'last' keeps one curl, however many calls the test made", async () => {
    const out = await run({ curlOnFailedTest: 'last' }, async (api) => {
      for (let i = 0; i < 25; i++) await api.get(`/ok?n=${i}`);
    });
    assert.equal(out.collector.calls.filter((c) => c.curlParts !== undefined).length, 1);
    assert.equal(out.collector.calls.at(-1)?.curlParts !== undefined, true);
  });

  test('a call that threw (network error) is the last call and already has its curl: shown once', async () => {
    const out = await run({ curlOnFailedTest: 'last' }, async (api) => {
      await api.get('/ok');
      await api.get('http://127.0.0.1:9/health', { timeout: 2000 }).catch(() => undefined);
    });
    assert.equal(out.lines.filter((l) => l.includes('← ECONNREFUSED')).length, 1);
    assert.equal(out.lines.filter((l) => l.includes("│ curl '")).length, 1);
    assert.deepEqual(out.scripts.map((s) => s.name), ['curl.sh']);
  });
});

describe('where it does not apply', () => {
  test('a passing test: no curl, no script, no block, nothing in the attachment', async () => {
    const out = await run({ curlOnFailedTest: 'all' }, repro, { status: 'passed' });
    assert.equal(out.lines.length, 2);
    assert.deepEqual(out.scripts, []);
    assert.ok(out.attachment?.calls.every((c) => c.curl === undefined && c.curlOnFailedTest === undefined));
  });

  test('a test that fails as test.fail() expects is not a failed test', async () => {
    const out = await run({ curlOnFailedTest: 'all' }, repro, { status: 'failed', expectedStatus: 'failed' });
    assert.equal(out.lines.length, 2);
    assert.deepEqual(out.scripts, []);
  });

  test("format: 'verbose' is unchanged: no curl is built for the option", async () => {
    const lines: string[] = [];
    const curls: string[] = [];
    const api = wrapRequestContext(ctx, {
      baseURL, colors: false, format: 'verbose', curlOnFailedTest: 'all', sink: (l) => lines.push(l),
    }, { onCurl: (c) => curls.push(c), onCall: () => assert.fail('verbose does not record compact calls') });
    await api.get('/ok');
    assert.deepEqual(curls, []);
    assert.ok(!lines.join('\n').includes('curl '), lines.join('\n'));
  });
});

describe('colours', () => {
  const ESC = '\u001b[';

  test('the 2xx keeps its status colour (not the error chip) and the block is neutral', async () => {
    const out = await run({ colors: true, curlOnFailedTest: 'last' }, (api) => api.post('/created', { data: {} }), { colors: true });
    const [line, ...block] = out.printed.split('\n');
    assert.ok((line ?? '').includes(`${ESC}32m201${ESC}39m`), line);
    assert.ok(!(line ?? '').includes(`${ESC}41m`) && !(line ?? '').includes(`${ESC}43m`), 'no error chip');
    assert.ok(block.length > 3);
    assert.ok(block.every((l) => !l.includes(`${ESC}31m`) && !l.includes(`${ESC}33m`)), 'no red or yellow gutter');
  });

  test('a record without the flag renders exactly as before (a 2xx has no block)', () => {
    const record: CallRecord = { method: 'GET', url: 'https://x.test/a', status: 200, statusText: 'OK', durationMs: 5, curl: "curl 'https://x.test/a'" };
    const opts: RenderOptions = { ...DEFAULT_DISPLAY, ascii: false, curl: 'always', colors: false, width: 120 };
    assert.deepEqual(renderDetail(record, opts), []);
    assert.equal(showsDetail(record, { details: 'always' }, true), false);
    assert.equal(renderCalls([record], opts, true).length, 1);
  });

  test('the flag shows a block only for a failed test, never with details: never, and uses | in ASCII mode', () => {
    const record: CallRecord = {
      method: 'POST', url: 'https://x.test/a', status: 201, statusText: 'Created', durationMs: 5,
      curl: "curl -X POST 'https://x.test/a'", curlFile: 'curl.sh', curlOnFailedTest: true,
    };
    const opts: RenderOptions = { ...DEFAULT_DISPLAY, ascii: true, curl: 'never', colors: false, width: 120 };
    assert.equal(showsDetail(record, { details: 'failed-tests' }, false), false);
    assert.equal(showsDetail(record, { details: 'never' }, true), false);
    assert.deepEqual(renderCalls([record], opts, true).slice(1), [
      '    | <- 201 Created',
      '    |',
      "    | curl -X POST 'https://x.test/a'",
      '    |',
      '    | -> replay: curl.sh attached to the HTML report',
    ]);
  });
});

describe('colors: true reaches the output that the fixture prints', () => {
  const ANSI = /\u001b\[/;

  test('an explicit colors: true colours it although nothing says there is a terminal; it is recorded for the reporter', async () => {
    const on = await run({ colors: true }, (api) => api.get('/missing'), { colors: true });
    assert.match(on.printed, ANSI);
    assert.equal(on.attachment?.options?.colors, true);
  });

  test('colors: false stays plain and is recorded; an unset colors is not recorded', async () => {
    const off = await run({ colors: false }, (api) => api.get('/missing'), { colors: false });
    assert.doesNotMatch(off.printed, ANSI);
    assert.equal(off.attachment?.options?.colors, false);
    const unset = await run({}, (api) => api.get('/missing'));
    assert.doesNotMatch(unset.printed, ANSI);
    assert.equal('colors' in (unset.attachment?.options ?? {}), false);
  });
});
