import { after, before, beforeEach, describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { execFile, execFileSync } from 'node:child_process';
import { promisify } from 'node:util';
import * as fs from 'node:fs';
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import * as os from 'node:os';
import * as path from 'node:path';
import { request } from '@playwright/test';
import type { APIRequestContext } from '@playwright/test';
import { buildCurlParts, curlFileName, envName } from '../src/compact/curlScript';
import { finishCompact, reporterActive } from '../src/compact/finish';
import { ATTACHMENT_NAME } from '../src/compact/types';
import type { CallsAttachment } from '../src/compact/types';
import { DEFAULT_REDACT_BODY_KEYS, DEFAULT_REDACT_HEADERS, DEFAULT_REDACT_QUERY_PARAMS, resolveConfig } from '../src/types';
import type { ApiLoggerConfig } from '../src/types';
import { resetWarnings } from '../src/warn';
import { wrapRequestContext } from '../src/wrapRequestContext';
import type { CompactCall } from '../src/wrapRequestContext';

const SECRET = 'SECRET-123';
const strip = (text: string): string => text.replace(/\u001b\[[0-9;]*m/g, '');

interface Received { method: string; url: string; headers: http.IncomingHttpHeaders; body: string }
const received: Received[] = [];

const server = http.createServer((req, res) => {
  const chunks: Buffer[] = [];
  req.on('data', (c: Buffer) => chunks.push(c));
  req.on('end', () => {
    received.push({ method: req.method ?? '', url: req.url ?? '', headers: req.headers, body: Buffer.concat(chunks).toString('utf8') });
    const { pathname } = new URL(req.url ?? '/', 'http://x');
    const send = (status: number, type: string, body: string | Buffer, extra: Record<string, string> = {}) => {
      res.writeHead(status, { 'content-type': type, ...extra });
      res.end(body);
    };
    if (pathname === '/boom') return send(500, 'application/json', JSON.stringify({ error: 'boom', accessToken: SECRET }), { 'set-cookie': `sid=${SECRET}` });
    if (pathname === '/missing') return send(404, 'application/json', '{"error":"missing"}');
    if (pathname === '/pdf') return send(500, 'application/pdf', Buffer.alloc(12_698, 1));
    if (pathname === '/empty') return send(503, 'text/plain', '');
    if (pathname === '/text') return send(502, 'text/plain', 'Bad gateway\nsecond line');
    return send(200, 'application/json', '{"ok":true}');
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
beforeEach(() => {
  resetWarnings();
  received.length = 0;
});

interface Attached { name: string; body: string; contentType?: string }

function fakeTestInfo(status: 'passed' | 'failed' = 'failed') {
  const attached: Attached[] = [];
  return {
    attached,
    info: {
      title: 'a test', status, expectedStatus: 'passed', file: '/repo/tests/a.spec.ts', line: 7,
      config: { rootDir: '/repo' }, project: { testDir: '/repo/tests' },
      outputPath: (...parts: string[]) => path.join(os.tmpdir(), ...parts),
      attach: async (name: string, o: { body?: string | Buffer; contentType?: string }) => {
        attached.push({ name, body: String(o.body ?? ''), contentType: o.contentType });
      },
    },
  };
}

/** What a test run with the fixture does: wrap, call, finish. Returns everything it produced. */
async function run(
    config: ApiLoggerConfig,
    act: (api: APIRequestContext) => Promise<unknown>,
    status: 'passed' | 'failed' = 'failed',
) {
  const printed: string[] = [];
  const cfg = resolveConfig({ baseURL, colors: false, ...config, sink: (l) => printed.push(l) });
  const calls: CompactCall[] = [];
  const api = wrapRequestContext(ctx, cfg, { onCall: (c) => calls.push(c) });
  await act(api);
  const { attached, info } = fakeTestInfo(status);
  await finishCompact(calls, info, { cfg, customSink: false, reporter: false });
  const json = attached.find((a) => a.name === ATTACHMENT_NAME);
  return {
    calls,
    printed: printed.join('\n'),
    attached,
    scripts: attached.filter((a) => /^curl.*\.sh$/.test(a.name)),
    attachment: json ? JSON.parse(json.body) as CallsAttachment : undefined,
    everything: [printed.join('\n'), ...attached.map((a) => a.body)].join('\n'),
  };
}

describe('recording', () => {
  test('a call becomes a record: masked URL, status, timing, bodies; the line is printed with the details of a failed test', async () => {
    const out = await run({}, (api) => api.post('/boom?token=abc&x=1', { data: { a: 1 } }));
    const [record] = out.attachment?.calls ?? [];
    assert.equal(record?.method, 'POST');
    assert.equal(record?.url, `${baseURL}/boom?token=***&x=1`);
    assert.equal(record?.status, 500);
    assert.equal(record?.statusText, 'Internal Server Error');
    assert.ok((record?.durationMs ?? -1) >= 0);
    assert.equal(record?.requestBody, '{\n  "a": 1\n}');
    assert.deepEqual(record?.responseBody, { kind: 'text', text: '{"error":"boom","accessToken":"***"}' });
    assert.equal(record?.responseHeaders?.['set-cookie'], '***');
    const lines = strip(out.printed).split('\n');
    assert.match(lines[0] ?? '', /^ {4}POST {3}\[500\] {2}http:\/\/127\.0\.0\.1:\d+\/boom\?token=\*\*\*&x=1 +\d+ms$/);
    assert.equal(lines[1], '    │ ← 500 Internal Server Error  {"error":"boom","accessToken":"***"}');
  });

  test('a passing test prints the line of a 404 without a block', async () => {
    const out = await run({}, (api) => api.get('/missing'), 'passed');
    assert.equal(out.printed.split('\n').length, 1);
    assert.ok(out.printed.includes('[404]'));
    assert.equal(out.scripts.length, 0, 'no curl.sh for a passing test');
  });

  test('empty, text and binary bodies', async () => {
    const out = await run({ colors: false }, async (api) => {
      await api.get('/empty');
      await api.get('/text');
      await api.get('/pdf');
    });
    assert.deepEqual(out.attachment?.calls.map((c) => c.responseBody), [
      { kind: 'empty' }, { kind: 'text', text: 'Bad gateway\nsecond line' }, { kind: 'binary', bytes: 12_698, type: 'application/pdf' },
    ]);
    assert.ok(out.printed.includes('← 503 Service Unavailable  <empty body>'));
    assert.ok(out.printed.includes('← 502 Bad Gateway  Bad gateway\n') || out.printed.includes('← 502 Bad Gateway  Bad gateway'));
    assert.ok(out.printed.includes('<binary 12.4 KB application/pdf>'));
  });

  test('a network failure: ERR, the code, the curl', async () => {
    const out = await run({}, (api) => api.get('http://127.0.0.1:9/health?token=abc', { timeout: 2000 }).catch(() => undefined));
    const [record] = out.attachment?.calls ?? [];
    assert.equal(record?.status, undefined);
    assert.equal(record?.error?.code, 'ECONNREFUSED');
    assert.ok(record?.curl?.startsWith("curl 'http://127.0.0.1:9/health?token=***'"));
    const lines = strip(out.printed).split('\n');
    assert.ok(/^ {4}GET {4}\[ERR\] {2}http:\/\/127\.0\.0\.1:9\/health\?token=\*\*\*/.test(lines[0] ?? ''), lines[0]);
    assert.ok((lines[1] ?? '').startsWith('    │ ← ECONNREFUSED  '));
    assert.equal(out.scripts[0]?.name, 'curl.sh');
  });

  test('the rejection reaches the caller unchanged', async () => {
    const api = wrapRequestContext(ctx, { colors: false, sink: () => undefined }, { onCall: () => undefined });
    await assert.rejects(api.get('http://127.0.0.1:9/', { timeout: 2000 }), /ECONNREFUSED/);
  });

  test('details: never prints no block; the scripts follow the blocks', async () => {
    const out = await run({ details: 'never' }, (api) => api.get('/boom'));
    assert.equal(out.printed.split('\n').length, 1);
    assert.equal(out.scripts.length, 1, 'a failed test still gets the script of its 5xx');
  });

  test('curl modes decide which calls get a curl and a script', async () => {
    const calls = (api: APIRequestContext) => Promise.all([api.get('/missing'), api.get('/boom'), api.get('/ok')]).then(() => undefined);
    const names = async (curl: ApiLoggerConfig['curl']) => (await run({ curl }, async (api) => {
      await api.get('/missing');
      await api.get('/boom');
      await api.get('/ok');
    })).scripts.map((s) => s.name);
    void calls;
    assert.deepEqual(await names('5xx'), ['curl.sh']);
    assert.deepEqual(await names(undefined), ['curl.sh']);
    assert.deepEqual((await names('4xx+')).length, 2);
    assert.deepEqual((await names('always')).length, 3);
    assert.deepEqual(await names('never'), []);
    assert.deepEqual(await names(false), []);
    assert.deepEqual((await names(true)).length, 3, 'true is "always"');
    assert.deepEqual((await names('on-failure')).length, 2, 'on-failure is 4xx+');
  });

  test('several scripts are named curl-{n}-{METHOD}-{lastPathSegment}.sh', async () => {
    const out = await run({ curl: '4xx+' }, async (api) => {
      await api.get('/missing');
      await api.post('/boom?a=1', { data: {} });
    });
    assert.deepEqual(out.scripts.map((s) => s.name), ['curl-1-GET-missing.sh', 'curl-2-POST-boom.sh']);
    assert.deepEqual(out.attachment?.calls.map((c) => c.curlFile), ['curl-1-GET-missing.sh', 'curl-2-POST-boom.sh']);
    assert.equal(curlFileName(1, 1, 'get', 'https://h.test/a'), 'curl.sh');
    assert.equal(curlFileName(3, 4, 'delete', 'https://h.test/'), 'curl-3-DELETE-root.sh');
    assert.equal(curlFileName(2, 2, 'get', 'https://h.test/a/b%20c?x=1'), 'curl-2-GET-b-20c.sh');
  });

  test('curlFormat.file: false keeps the curl in the block but attaches no script, and says nothing of one', async () => {
    const out = await run({ curlFormat: { file: false } }, (api) => api.get('/boom'));
    assert.equal(out.scripts.length, 0);
    assert.ok(out.printed.includes('curl '));
    assert.ok(!out.printed.includes('replay'));
  });

  test('curlFormat.multiline: false puts the curl on one line', async () => {
    const out = await run({ curlFormat: { multiline: false } }, (api) => api.post('/boom', { data: { a: 1 }, headers: { 'X-A': 'b' } }));
    const curl = out.attachment?.calls[0]?.curl ?? '';
    assert.ok(!curl.includes('\n'), curl);
    assert.match(curl, /^curl -X POST '.*' -H 'X-A: b' .*--data-raw '\{"a":1\}'$/);
  });

  test('logBody: false and logHeaders: false keep bodies and headers out of the record', async () => {
    const out = await run({ logBody: false, logHeaders: false }, (api) => api.post('/boom', { data: { a: 1 }, headers: { 'X-A': 'b' } }));
    const [record] = out.attachment?.calls ?? [];
    assert.equal(record?.requestBody, undefined);
    assert.equal(record?.responseBody, undefined);
    assert.equal(record?.requestHeaders, undefined);
    assert.equal(strip(out.printed.split('\n')[1] ?? ''), '    │ ← 500 Internal Server Error');
  });

  test('the display options travel with the JSON, curl modes mapped', async () => {
    const out = await run({ curl: 'on-failure', slowThresholdMs: 50, timeColumn: 'auto', bodyPreviewChars: 5, theme: 'dark', ascii: true, details: 'always' }, (api) => api.get('/ok'));
    assert.deepEqual(out.attachment?.options, {
      slowThresholdMs: 50, timeColumn: 'auto', details: 'always', bodyPreviewChars: 5, theme: 'dark', ascii: true, curl: '4xx+',
    });
  });

  test('options are validated with a warning and fall back', async () => {
    const warnings: string[] = [];
    const original = process.emitWarning;
    process.emitWarning = ((w: string | Error) => warnings.push(String(w))) as typeof process.emitWarning;
    try {
      const cfg = resolveConfig({ slowThresholdMs: -1, timeColumn: 'wide' as never, details: 'x' as never, theme: 'neon' as never, format: 'fancy' as never, mask: 5 as never });
      assert.equal(cfg.slowThresholdMs, 1000);
      assert.equal(cfg.timeColumn, 82);
      assert.equal(cfg.details, 'failed-tests');
      assert.equal(cfg.theme, 'ansi');
      assert.equal(cfg.format, 'compact');
    } finally {
      process.emitWarning = original;
    }
  });
});

describe('masking', () => {
  const secretApi = (api: APIRequestContext) => api.post(`/boom?token=${SECRET}&api_key=${SECRET}&q=1`, {
    headers: {
      Authorization: `Bearer ${SECRET}`, 'X-Auth-Token': SECRET, 'Proxy-Authorization': SECRET, Cookie: `sid=${SECRET}`, 'Content-Type': 'application/json',
    },
    data: { user: 'jo', password: SECRET, nested: { cardToken: SECRET, items: [{ CVV: SECRET }, { pin: SECRET }], list: [[{ accessToken: SECRET }]] } },
  });

  test('leak test: the secret is nowhere in the output, the JSON or any curl script', async () => {
    const out = await run({ curl: 'always', details: 'always' }, secretApi);
    assert.ok(out.printed.includes('***'));
    assert.ok(out.scripts.length > 0 && out.attachment);
    assert.ok(!out.everything.includes(SECRET), out.everything);
    assert.ok(!out.everything.includes('SECRET'), 'not even a part of it');
    // the response carried it too, under accessToken and in set-cookie
    assert.equal(out.attachment?.calls[0]?.responseBody?.kind, 'text');
  });

  test('keys match case-insensitively, at any depth, inside arrays; headers whole, Bearer included', async () => {
    const out = await run({ curl: 'always' }, secretApi);
    const [record] = out.attachment?.calls ?? [];
    const body = JSON.parse(record?.requestBody ?? '{}') as Record<string, unknown>;
    assert.equal(body.password, '***');
    assert.deepEqual(body.nested, { cardToken: '***', items: [{ CVV: '***' }, { pin: '***' }], list: [[{ accessToken: '***' }]] });
    assert.equal(record?.requestHeaders?.Authorization, '***');
    assert.equal(record?.requestHeaders?.Cookie, '***');
    assert.equal(record?.requestHeaders?.['X-Auth-Token'], '***');
    assert.equal(record?.requestHeaders?.['Proxy-Authorization'], '***');
    assert.equal(record?.url, `${baseURL}/boom?token=***&api_key=***&q=1`);
  });

  test('mask: merges with the defaults and with the older redact* options; the mask is always ***', async () => {
    const cfg = resolveConfig({ mask: { headers: ['X-Mine'], query: ['mine'], bodyKeys: ['mine'] }, redactHeaders: ['X-Old'] });
    assert.deepEqual(cfg.redactHeaders, [...DEFAULT_REDACT_HEADERS, 'X-Old', 'X-Mine']);
    assert.deepEqual(cfg.redactQueryParams, [...DEFAULT_REDACT_QUERY_PARAMS, 'mine']);
    assert.deepEqual(cfg.redactBodyKeys, [...DEFAULT_REDACT_BODY_KEYS, 'mine']);
    const out = await run({ mask: { headers: ['x-mine'], query: ['mine'], bodyKeys: ['mine'] } }, (api) => api.post('/boom?mine=zzz', {
      headers: { 'X-Mine': 'zzz' }, data: { mine: 'zzz' },
    }));
    assert.ok(!out.everything.includes('zzz'), out.everything);
    assert.equal(out.attachment?.calls[0]?.requestHeaders?.['X-Mine'], '***');
  });
});

describe('curl and curl.sh', () => {
  const parts = (info: Parameters<typeof buildCurlParts>[0]) => buildCurlParts(info, {
    redactHeaders: DEFAULT_REDACT_HEADERS, redactQueryParams: DEFAULT_REDACT_QUERY_PARAMS, redactBodyKeys: DEFAULT_REDACT_BODY_KEYS, multiline: true,
  });
  const bash = (script: string): void => {
    const file = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'plp-sh-')), 'curl.sh');
    fs.writeFileSync(file, script);
    execFileSync('bash', ['-n', file]);
  };

  test('envName: UPPER_SNAKE_CASE from any spelling of the key', () => {
    assert.equal(envName('Authorization'), 'AUTHORIZATION');
    assert.equal(envName('x-api-key'), 'X_API_KEY');
    assert.equal(envName('cardToken'), 'CARD_TOKEN');
    assert.equal(envName('access_token'), 'ACCESS_TOKEN');
    assert.equal(envName('APIKey'), 'APIKEY');
    assert.equal(envName('2fa code'), '_2FA_CODE');
    assert.equal(envName('---'), 'SECRET');
  });

  test('the script: shebang, strict mode, a guard per variable, placeholders in double quotes, bash -n clean', () => {
    const { script, terminal, variables } = parts({
      method: 'POST',
      url: 'https://api.shop.test/v1/checkout?token=t0&currency=EUR',
      headers: { Authorization: 'Bearer a', 'Content-Type': 'application/json', Host: 'x', 'Content-Length': '9', Connection: 'close', 'Accept-Encoding': 'gzip' },
      data: { cartId: 'c_812', cardToken: 'tok' },
    });
    assert.deepEqual(variables, ['TOKEN', 'AUTHORIZATION', 'CARD_TOKEN']);
    const lines = script.split('\n');
    assert.equal(lines[0], '#!/usr/bin/env bash');
    assert.equal(lines[1], 'set -euo pipefail');
    assert.ok(lines.includes(': "${TOKEN:?export TOKEN first}"'));
    assert.ok(lines.includes(': "${AUTHORIZATION:?export AUTHORIZATION first}"'));
    assert.ok(lines.includes(': "${CARD_TOKEN:?export CARD_TOKEN first}"'));
    assert.ok(script.includes(`curl -X POST 'https://api.shop.test/v1/checkout?token='"\${TOKEN}"'&currency=EUR' \\`), script);
    assert.ok(script.includes(`  -H 'Authorization: '"\${AUTHORIZATION}" \\`), script);
    assert.ok(script.includes(`  --data-raw '{"cartId":"c_812","cardToken":"'"\${CARD_TOKEN}"'"}'`), script);
    assert.ok(!script.includes('***'));
    assert.ok(!/host:|content-length|connection|accept-encoding/i.test(script + terminal), 'noise headers are left out');
    bash(script);
    assert.equal(terminal, [
      "curl -X POST 'https://api.shop.test/v1/checkout?token=***&currency=EUR' \\",
      "  -H 'Authorization: ***' \\",
      "  -H 'Content-Type: application/json' \\",
      `  --data-raw '{"cartId":"c_812","cardToken":"***"}'`,
    ].join('\n'));
  });

  test('a GET without a body leaves out -X GET; a GET with one keeps it', () => {
    assert.ok(parts({ method: 'GET', url: 'https://h.test/a' }).terminal.startsWith("curl 'https://h.test/a'"));
    assert.ok(parts({ method: 'GET', url: 'https://h.test/a', data: { a: 1 } }).terminal.startsWith("curl -X GET 'https://h.test/a'"));
  });

  test("single quotes in arguments are escaped as '\\'' and the script still parses", () => {
    const { terminal, script } = parts({
      method: 'POST', url: "https://h.test/it's?q=it's", headers: { 'X-Note': "it's $HOME `x`" }, data: `{"name":"O'Neil"}`,
    });
    assert.ok(terminal.includes(`'https://h.test/it'\\''s?q=it'\\''s'`), terminal);
    assert.ok(terminal.includes(`'X-Note: it'\\''s $HOME \`x\`'`), terminal);
    assert.ok(terminal.includes(`--data-raw '{"name":"O'\\''Neil"}'`), terminal);
    bash(script);
  });

  test('multipart: one -F / --form-string per field, secrets replaced in both forms', () => {
    const { terminal, script } = parts({
      method: 'POST', url: 'https://h.test/up',
      multipart: { title: 'hello', password: 'pw', file: { name: 'a.txt', mimeType: 'text/plain', buffer: Buffer.from('hi') } },
    });
    assert.ok(terminal.includes("--form-string 'title=hello'"), terminal);
    assert.ok(terminal.includes("--form-string 'password=***'"), terminal);
    assert.ok(terminal.includes("-F 'file=@a.txt;type=text/plain'"), terminal);
    assert.ok(script.includes(`--form-string 'password='"\${PASSWORD}"`), script);
    bash(script);
  });

  test('form bodies: masked values become placeholders too', () => {
    const { script, variables } = parts({ method: 'POST', url: 'https://h.test/f', form: { user: 'jo', secret: 's', token: 't' } });
    assert.deepEqual(variables, ['SECRET', 'TOKEN']);
    bash(script);
  });

  test('a body over 2 KB is cut with … in the terminal and whole in curl.sh', () => {
    const big = 'x'.repeat(5000);
    const { terminal, script } = parts({ method: 'POST', url: 'https://h.test/big', data: big });
    assert.ok(terminal.includes(`--data-raw '${'x'.repeat(2048)}…'`), terminal.slice(0, 200));
    assert.ok(!terminal.includes('x'.repeat(2049)));
    assert.match(terminal, /^# request body cut at 2048 of 5000 characters/);
    assert.ok(script.includes(`--data-raw '${big}'`));
    bash(script);
  });

  test('replay: with the variables exported the script sends the original request', async () => {
    const out = await run({ curl: 'always' }, (api) => api.post(`/ok?token=${SECRET}&n=1`, {
      headers: { Authorization: `Bearer ${SECRET}`, 'Content-Type': 'application/json' },
      data: { user: "o'neil", cardToken: SECRET },
    }));
    const original = received.at(-1) as Received;
    received.length = 0;
    const script = out.scripts[0]?.body ?? '';
    bash(script);
    const file = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'plp-replay-')), 'curl.sh');
    fs.writeFileSync(file, script);
    // (the shared context's cookie jar holds a cookie from an earlier test: it is sent, so it is a variable)
    const env = { PATH: process.env.PATH, TOKEN: SECRET, AUTHORIZATION: `Bearer ${SECRET}`, CARD_TOKEN: SECRET, COOKIE: original.headers.cookie ?? 'none' };
    // Asynchronous: the server that answers lives in this very process.
    await promisify(execFile)('bash', [file], { env });
    const replayed = received.at(-1) as Received;
    assert.equal(replayed.method, original.method);
    assert.equal(replayed.url, original.url);
    assert.equal(replayed.headers.authorization, original.headers.authorization);
    assert.deepEqual(JSON.parse(replayed.body), JSON.parse(original.body));
    // and without the variables it refuses to run
    assert.throws(() => execFileSync('bash', [file], { env: { PATH: process.env.PATH }, stdio: 'ignore' }));
  });

  test('the script names the spec location, never the test title', async () => {
    const out = await run({ curl: 'always' }, (api) => api.get('/boom'));
    const script = out.scripts[0]?.body ?? '';
    assert.ok(script.includes('# tests/a.spec.ts:7'), script);
    assert.ok(!script.includes('a test'));
    assert.equal(out.scripts[0]?.contentType, 'text/x-shellscript');
  });
});

describe('the fixture and the reporter', () => {
  test('reporterActive: through the environment of the runner, or the configured reporters', () => {
    const none = { config: { reporter: [['list', null]] } } as never;
    assert.equal(reporterActive(none, {}, 10), false);
    assert.equal(reporterActive(none, { PLP_REPORTER: '10' }, 10), true);
    assert.equal(reporterActive(none, { PLP_REPORTER: '11' }, 10), false, 'a value left by another process is ignored');
    for (const name of ['playwright-logger-pro/reporter', '/x/node_modules/playwright-logger-pro/dist/reporter.js', '/repo/src/reporter.ts']) {
      assert.equal(reporterActive({ config: { reporter: [['list', null], [name, {}]] } } as never, {}, 10), true, name);
    }
  });

  test('with a reporter nothing is printed here; the JSON is still attached', async () => {
    const printed: string[] = [];
    const cfg = resolveConfig({ baseURL, colors: false, sink: (l) => printed.push(l) });
    const calls: CompactCall[] = [];
    await wrapRequestContext(ctx, cfg, { onCall: (c) => calls.push(c) }).get('/boom');
    const { attached, info } = fakeTestInfo();
    await finishCompact(calls, info, { cfg, customSink: false, reporter: true });
    assert.deepEqual(printed, []);
    assert.deepEqual(attached.map((a) => a.name), ['curl.sh', ATTACHMENT_NAME]);
    // ... unless the sink is the user's own
    await finishCompact(calls, info, { cfg, customSink: true, reporter: true });
    assert.equal(printed.length, 1);
  });

  test('without onCall the wrapper prints the line and the block itself', async () => {
    const printed: string[] = [];
    await wrapRequestContext(ctx, { baseURL, colors: false, sink: (l) => printed.push(l) }).get('/boom');
    assert.equal(printed.length, 1);
    assert.match(printed[0] ?? '', /\[500\].*\n.*← 500 Internal Server Error/);
  });
});
