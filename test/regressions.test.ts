import { after, before, describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { copyFile, mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import fs from 'node:fs';
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';
import { request, type APIRequestContext } from '@playwright/test';
import ts from 'typescript';
import { cookieHeaderFor } from '../src/cookies';
import { buildCurl } from '../src/curl';
import { describeResponseBody, formatBody, formatRequestLine } from '../src/format';
import { DEFAULT_CONFIG, detectColorSupport, resolveConfig } from '../src/types';
import { wrapRequestContext } from '../src/wrapRequestContext';

const execFileAsync = promisify(execFile);
const ANSI = /\u001b\[/;

interface Received {
  method: string;
  url: string;
  contentType: string;
  body: string;
  authorization?: string;
  cookie?: string;
}

// Echo server that records every request it receives.
const received: Received[] = [];
const server = http.createServer((req, res) => {
  const chunks: Buffer[] = [];
  req.on('data', (c: Buffer) => chunks.push(c));
  req.on('end', () => {
    received.push({
      method: req.method ?? '',
      url: req.url ?? '',
      contentType: req.headers['content-type'] ?? '',
      body: Buffer.concat(chunks).toString('utf8'),
      authorization: req.headers.authorization,
      cookie: req.headers.cookie,
    });
    const route = new URL(req.url ?? '/', 'http://x');
    if (req.url?.startsWith('/redirect')) {
      res.writeHead(302, { location: '/echo?redirected=1' });
      res.end();
      return;
    }
    if (route.pathname === '/quiet') {
      res.writeHead(204);
      res.end();
      return;
    }
    if (route.pathname === '/slow') {
      const timer = setTimeout(() => res.end('late'), Number(route.searchParams.get('ms')));
      res.on('close', () => clearTimeout(timer));
      return;
    }
    if (route.pathname === '/binary') {
      res.writeHead(200, { 'content-type': 'image/png' });
      res.end(Buffer.from('\x89PNG\x1b[31mRED\x00', 'latin1'));
      return;
    }
    if (route.pathname === '/ansi') {
      res.writeHead(200, { 'content-type': 'text/plain' });
      res.end('before\x1b[31mred\x07after');
      return;
    }
    if (route.pathname === '/set-cookie') {
      res.writeHead(200, { 'set-cookie': ['sid=SECRET_SESSION_1; Path=/', 'other=SECRET_OTHER_2; Path=/'] });
      res.end();
      return;
    }
    if (route.pathname === '/login') {
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ user: 'jo', access_token: 'SECRET_RESP_TOKEN' }));
      return;
    }
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ method: req.method, url: req.url }));
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

function logged(config: Parameters<typeof wrapRequestContext>[1] = {}) {
  const lines: string[] = [];
  const api = wrapRequestContext(ctx, { colors: false, curl: true, ...config, sink: (l) => lines.push(l) });
  return { api, lines };
}

/** Run a logged curl command (multi-line, with `\` continuations) in a shell. */
async function runCurl(cmd: string, cwd: string): Promise<void> {
  await execFileAsync('sh', ['-c', `${cmd} --silent --show-error --max-time 5 -o /dev/null`], { cwd });
}

async function withScratchDir<T>(fn: (dir: string) => Promise<T>): Promise<T> {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'pcl-'));
  try {
    return await fn(dir);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

describe('PCL-01: multipart requests are logged and replayable with curl -F', () => {
  test('PCL-01 buildCurl emits --form-string for fields and -F @file for files', () => {
    const cmd = buildCurl({
      method: 'post',
      url: 'http://x/upload',
      multipart: {
        field: 'v1',
        literal: '@not-a-file',
        file: { name: 'a.txt', mimeType: 'text/plain', buffer: Buffer.from('FILEDATA') },
      },
    });
    assert.match(cmd, /--form-string 'field=v1'/);
    assert.match(cmd, /--form-string 'literal=@not-a-file'/);
    assert.match(cmd, /-F 'file=@a\.txt;type=text\/plain'/);
    assert.match(cmd, /^# multipart file content is read from local file\(s\): a\.txt\n/);
    assert.doesNotMatch(cmd, /--data-raw/);
  });

  test('PCL-01 multipart body is logged and the curl replays an equivalent upload', async () => {
    const { api, lines } = logged();
    received.length = 0;
    await api.post('/echo', {
      multipart: {
        field: 'v1',
        file: { name: 'a.txt', mimeType: 'text/plain', buffer: Buffer.from('FILEDATA') },
      },
    });
    const original = received[0];
    assert.match(original.contentType, /^multipart\/form-data/);

    const log = lines.join('\n');
    assert.match(log, /field: v1/);
    assert.match(log, /file: <file a\.txt \(text\/plain, 8 bytes\)>/);

    const curl = lines[lines.length - 1];
    assert.match(curl, /-F 'file=@a\.txt;type=text\/plain'/);

    await withScratchDir(async (dir) => {
      await writeFile(path.join(dir, 'a.txt'), 'FILEDATA');
      received.length = 0;
      await runCurl(curl, dir);
    });
    const replay = received[0];
    assert.equal(replay.method, 'POST');
    assert.equal(replay.url, '/echo');
    assert.match(replay.contentType, /^multipart\/form-data/);
    for (const needle of [
      'name="field"', 'v1', 'name="file"; filename="a.txt"', 'content-type: text/plain', 'FILEDATA',
    ]) {
      assert.ok(original.body.toLowerCase().includes(needle.toLowerCase()), `original body has ${needle}`);
      assert.ok(replay.body.toLowerCase().includes(needle.toLowerCase()), `replayed body has ${needle}`);
    }
  });
});

describe('PCL-02: colors default to on under the Playwright runner', () => {
  test('PCL-02 detectColorSupport honours FORCE_COLOR, TTYs and NO_COLOR', () => {
    const piped = [{ isTTY: undefined }, { isTTY: undefined }];
    // Playwright worker: stdout/stderr piped, FORCE_COLOR=1 set by the runner.
    assert.equal(detectColorSupport({ FORCE_COLOR: '1' }, piped), true);
    assert.equal(detectColorSupport({ FORCE_COLOR: '1', TERM: 'dumb' }, piped), true);
    assert.equal(detectColorSupport({}, [{ isTTY: true }, undefined]), true);
    assert.equal(detectColorSupport({}, [{ isTTY: false }, { isTTY: true }]), true);
    assert.equal(detectColorSupport({}, piped), false);
    assert.equal(detectColorSupport({ TERM: 'dumb' }, [{ isTTY: true }]), false);
    assert.equal(detectColorSupport({ FORCE_COLOR: '0' }, [{ isTTY: true }]), false);
    assert.equal(detectColorSupport({ FORCE_COLOR: 'false' }, piped), false);
    assert.equal(detectColorSupport({ NO_COLOR: '1', FORCE_COLOR: '1' }, [{ isTTY: true }]), false);
  });

  test('PCL-02 default config is colored in a Playwright-like worker env, plain with NO_COLOR', () => {
    const saved = { ...process.env };
    try {
      delete process.env.NO_COLOR;
      delete process.env.CI;
      process.env.FORCE_COLOR = '1';
      const cfg = resolveConfig({ curl: true });
      assert.equal(cfg.colors, true);
      assert.match(formatRequestLine('get', '/x', cfg), ANSI);
      // Explicit undefined (README CI recipe) still means auto-detect.
      assert.equal(resolveConfig({ colors: undefined }).colors, true);

      process.env.NO_COLOR = '1';
      assert.equal(resolveConfig().colors, false);
      assert.doesNotMatch(formatRequestLine('get', '/x', resolveConfig()), ANSI);
      // colors: true wins over NO_COLOR.
      assert.match(formatRequestLine('get', '/x', resolveConfig({ colors: true })), ANSI);
    } finally {
      process.env = saved;
    }
  });
});

describe('PCL-03: redirects log and curl the original request', () => {
  test('PCL-03 response line shows original URL and notes the final URL', async () => {
    const { api, lines } = logged({ baseURL });
    received.length = 0;
    await api.post('/redirect', { data: { a: 1 } });
    assert.deepEqual(received.map((r) => `${r.method} ${r.url}`), [
      'POST /redirect', 'GET /echo?redirected=1',
    ]);

    const responseLine = lines.find((l) => l.startsWith('←'));
    assert.equal(
        responseLine?.replace(/\(\d+ms\)/, '(Nms)'),
        `← POST ${baseURL}/redirect 200 OK (Nms) (redirected to ${baseURL}/echo?redirected=1)`,
    );

    const curl = lines[lines.length - 1];
    assert.match(curl, new RegExp(`^curl -L '${baseURL}/redirect'`));
    assert.match(curl, /--data-raw '\{"a":1\}'/);

    received.length = 0;
    await withScratchDir((dir) => runCurl(curl, dir));
    assert.deepEqual(received.map((r) => `${r.method} ${r.url} ${r.body}`), [
      'POST /redirect {"a":1}', 'GET /echo?redirected=1 ',
    ]);
  });

  test('PCL-03 redirect is detected without a configured baseURL, params included', async () => {
    const { api, lines } = logged();
    await api.put('/redirect', { params: { q: 'a b' }, data: 'x' });
    const curl = lines[lines.length - 1];
    assert.match(curl, new RegExp(`^curl -X PUT -L '${baseURL}/redirect\\?q=a\\+b'`));
    assert.ok(lines.some((l) => l.includes(`(redirected to ${baseURL}/echo?redirected=1)`)));
  });

  test('PCL-03 non-redirected requests are unchanged', async () => {
    const { api, lines } = logged();
    await api.post('/echo', { data: { a: 1 } });
    const curl = lines[lines.length - 1];
    assert.match(curl, new RegExp(`^curl -X POST '${baseURL}/echo'`));
    assert.doesNotMatch(curl, / -L /);
    assert.ok(!lines.some((l) => l.includes('redirected to')));
  });
});

/** Run `fn` with the given environment variables set (undefined = unset), then restore. */
function withEnv<T>(vars: Record<string, string | undefined>, fn: () => T): T {
  const saved = { ...process.env };
  try {
    for (const [key, value] of Object.entries(vars)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
    return fn();
  } finally {
    process.env = saved;
  }
}

describe('PCL-04: colors: true forces ANSI whatever the environment says', () => {
  test('PCL-04 colors: true is colored under NO_COLOR, FORCE_COLOR=0, TERM=dumb and piped output', async () => {
    const envs: Array<Record<string, string | undefined>> = [
      { NO_COLOR: '1', FORCE_COLOR: undefined, CI: undefined, TERM: 'xterm' },
      { NO_COLOR: undefined, FORCE_COLOR: '0', CI: undefined, TERM: 'dumb' },
      { NO_COLOR: undefined, FORCE_COLOR: undefined, CI: 'true', TERM: undefined },
    ];
    for (const env of envs) {
      const lines: string[] = [];
      const api = withEnv(env, () => wrapRequestContext(ctx, { colors: true, sink: (l) => lines.push(l) }));
      await api.get('/echo');
      assert.match(lines[0], ANSI, JSON.stringify(env));
      assert.match(lines.find((l) => l.startsWith('\u001b[34m←')) ?? '', ANSI, JSON.stringify(env));
    }
  });

  test('PCL-04 colors: false is plain even when FORCE_COLOR=1', () => {
    withEnv({ FORCE_COLOR: '1', NO_COLOR: undefined }, () => {
      assert.doesNotMatch(formatRequestLine('get', '/x', resolveConfig({ colors: false })), ANSI);
    });
  });
});

describe('PCL-05: options explicitly set to undefined fall back to their defaults', () => {
  test('PCL-05 resolveConfig ignores undefined values', () => {
    const cfg = resolveConfig({
      enabled: undefined,
      curl: undefined,
      logHeaders: undefined,
      logBody: undefined,
      maxBodyLength: undefined,
      redactHeaders: undefined,
      redactQueryParams: undefined,
      redactBodyKeys: undefined,
      sink: undefined,
    });
    for (const key of [
      'enabled', 'curl', 'logHeaders', 'logBody', 'maxBodyLength', 'redactHeaders',
      'redactQueryParams', 'redactBodyKeys', 'sink',
    ] as const) {
      assert.equal(cfg[key], DEFAULT_CONFIG[key], key);
    }
    assert.equal(formatBody('abc', resolveConfig({ colors: false, maxBodyLength: undefined })), '  abc');
  });

  test('PCL-05 colors: undefined (README CI recipe) means auto-detection', () => {
    for (const env of [{ FORCE_COLOR: '1', NO_COLOR: undefined }, { FORCE_COLOR: undefined, NO_COLOR: '1' }]) {
      withEnv(env, () => {
        assert.equal(resolveConfig({ colors: !!process.env.PCL_UNSET_CI || undefined }).colors, detectColorSupport());
      });
    }
  });

  test('PCL-05 a request with sink: undefined logs to console.log instead of throwing', async () => {
    const original = console.log;
    const lines: string[] = [];
    console.log = (line: string) => void lines.push(line);
    try {
      await wrapRequestContext(ctx, { colors: false, sink: undefined, maxBodyLength: undefined }).get('/echo');
    } finally {
      console.log = original;
    }
    assert.equal(lines[0], '→ GET /echo');
    assert.ok(!lines.join('\n').includes('NaN'));
  });
});

describe('PCL-06: request errors are logged, with a curl for on-failure', () => {
  test('PCL-06 timeout logs an error line and the curl, then rethrows unchanged', async () => {
    const { api, lines } = logged({ curl: 'on-failure', baseURL });
    await assert.rejects(api.get('/slow?ms=3000', { timeout: 300 }), /Timeout 300ms exceeded/);
    assert.equal(lines[0], '→ GET /slow?ms=3000');
    assert.match(lines[1], new RegExp(`^✖ GET ${baseURL}/slow\\?ms=3000 failed \\(\\d+ms\\) .*Timeout 300ms exceeded`));
    assert.doesNotMatch(lines[1], /\n/);
    assert.equal(lines[2], `curl '${baseURL}/slow?ms=3000'`);
  });

  test('PCL-06 connection refused logs an error line and the curl', async () => {
    const { api, lines } = logged({ curl: 'on-failure' });
    await assert.rejects(api.get('http://127.0.0.1:1/x'), /ECONNREFUSED/);
    assert.match(lines[1], /^✖ GET http:\/\/127\.0\.0\.1:1\/x failed \(\d+ms\) .*ECONNREFUSED/);
    assert.equal(lines[2], `curl 'http://127.0.0.1:1/x'`);
  });

  test('PCL-06 curl: false logs the error line but no curl', async () => {
    const { api, lines } = logged({ curl: false });
    await assert.rejects(api.get('http://127.0.0.1:1/x'));
    assert.equal(lines.length, 2);
    assert.match(lines[1], /^✖ GET /);
  });
});

describe('PCL-07: curl replays GET with a body and HEAD with the right method', () => {
  test('PCL-07 buildCurl emits -X GET for GET with a body and --head for HEAD', () => {
    assert.match(buildCurl({ method: 'get', url: 'http://x/y', data: { a: 1 } }), /^curl -X GET 'http:\/\/x\/y'/);
    assert.equal(buildCurl({ method: 'head', url: 'http://x/y' }), `curl --head 'http://x/y'`);
    assert.doesNotMatch(buildCurl({ method: 'head', url: 'http://x/y' }), /-X HEAD/);
    assert.equal(buildCurl({ method: 'get', url: 'http://x/y' }), `curl 'http://x/y'`);
  });

  test('PCL-07 replayed GET+body arrives as GET, replayed HEAD completes', async () => {
    const { api, lines } = logged();
    await api.get('/echo', { data: { a: 1 } });
    const getCurl = lines[lines.length - 1];
    await api.head('/echo');
    const headCurl = lines[lines.length - 1];

    received.length = 0;
    await withScratchDir(async (dir) => {
      await runCurl(getCurl, dir);
      await runCurl(headCurl, dir);
    });
    assert.deepEqual(received.map((r) => `${r.method} ${r.url} ${r.body}`), [
      'GET /echo {"a":1}', 'HEAD /echo ',
    ]);
  });
});

describe('PCL-08: binary and control characters in bodies are not dumped raw', () => {
  test('PCL-08 binary response is logged as a placeholder', async () => {
    const { api, lines } = logged({ curl: false });
    await api.get('/binary');
    const log = lines.join('\n');
    assert.match(log, /^ {2}<binary 13 bytes \(image\/png\)>$/m);
    assert.doesNotMatch(log, /\u001b|PNG/);
  });

  test('PCL-08 control characters in text bodies are escaped', async () => {
    const { api, lines } = logged({ curl: false });
    await api.get('/ansi');
    assert.ok(lines.includes('  before\\x1b[31mred\\x07after'));
    assert.doesNotMatch(lines.join('\n'), /\u001b|\u0007/);
    assert.equal(formatBody('a\r\nb\u001b', plainCfg), '  a\n  b\\x1b');
  });

  test('PCL-08 describeResponseBody sniffs bodies without a content type', () => {
    assert.equal(describeResponseBody(Buffer.from('{"a":1}')), '{"a":1}');
    assert.equal(describeResponseBody(Buffer.from([0xff, 0xfe, 0x00])), '<binary 3 bytes>');
    assert.equal(describeResponseBody(Buffer.from('a\u0000b')), '<binary 3 bytes>');
    assert.equal(describeResponseBody(Buffer.from('{}'), 'application/problem+json; charset=utf-8'), '{}');
    assert.equal(describeResponseBody(Buffer.alloc(0), 'image/png'), '');
  });
});

const plainCfg = resolveConfig({ colors: false });

describe('PCL-09: context headers and cookies are reflected in logs and curl', () => {
  test('PCL-09 extraHTTPHeaders and jar cookies appear (redacted) and replay equivalently', async () => {
    const extraHTTPHeaders = { Authorization: 'Bearer SECRET_CTX_AUTH', 'X-Ctx': 'c1' };
    const own = await request.newContext({ baseURL, extraHTTPHeaders });
    try {
      await own.get('/set-cookie');

      // Default redaction: present but masked.
      const lines: string[] = [];
      const api = wrapRequestContext(own, {
        colors: false, curl: true, baseURL, extraHTTPHeaders, sink: (l) => lines.push(l),
      });
      await api.get('/echo', { headers: { 'x-ctx': 'call' } });
      const log = lines.join('\n');
      assert.match(log, /^ {2}Authorization: \*\*\*$/m);
      assert.match(log, /^ {2}x-ctx: call$/m);
      assert.doesNotMatch(log, /X-Ctx: c1|SECRET_/);
      const curl = lines[lines.length - 1];
      assert.match(curl, /-H 'Authorization: \*\*\*'/);
      assert.match(curl, /-H 'Cookie: \*\*\*'/);

      // Without redaction the replay sends what the original request sent.
      const raw: string[] = [];
      const unredacted = wrapRequestContext(own, {
        colors: false, curl: true, baseURL, extraHTTPHeaders, redactHeaders: [], sink: (l) => raw.push(l),
      });
      received.length = 0;
      await unredacted.get('/echo');
      const original = received[0];
      assert.equal(original.authorization, 'Bearer SECRET_CTX_AUTH');
      assert.equal(original.cookie, 'sid=SECRET_SESSION_1; other=SECRET_OTHER_2');
      received.length = 0;
      await withScratchDir((dir) => runCurl(raw[raw.length - 1], dir));
      assert.equal(received[0].authorization, original.authorization);
      assert.equal(received[0].cookie, original.cookie);
    } finally {
      await own.dispose();
    }
  });

  test('PCL-09 cookieHeaderFor matches domain, path, secure and expiry', () => {
    const now = Date.UTC(2026, 0, 1);
    const base = { path: '/', expires: -1, secure: false };
    const cookies = [
      { ...base, name: 'host', value: '1', domain: 'api.example.com' },
      { ...base, name: 'dom', value: '2', domain: '.example.com' },
      { ...base, name: 'other', value: '3', domain: 'other.com' },
      { ...base, name: 'path', value: '4', domain: 'api.example.com', path: '/v1' },
      { ...base, name: 'sec', value: '5', domain: 'api.example.com', secure: true },
      { ...base, name: 'old', value: '6', domain: 'api.example.com', expires: now / 1000 - 1 },
    ];
    assert.equal(cookieHeaderFor('http://api.example.com/v1/x', cookies, now), 'host=1; dom=2; path=4');
    assert.equal(cookieHeaderFor('https://api.example.com/v10', cookies, now), 'host=1; dom=2; sec=5');
    assert.equal(cookieHeaderFor('http://example.com/', cookies, now), 'dom=2');
    assert.equal(cookieHeaderFor('/relative', cookies, now), undefined);
  });
});

describe('PCL-10: secrets in the query string and bodies are redacted', () => {
  test('PCL-10 default redactQueryParams masks api_key, token, ... in every logged URL and the curl', async () => {
    const { api, lines } = logged();
    const params = {
      api_key: 'SECRET_1', APIKEY: 'SECRET_2', token: 'SECRET_3', access_token: 'SECRET_4',
      password: 'SECRET_5', secret: 'SECRET_6', page: '2',
    };
    received.length = 0;
    await api.get('/quiet', { params });
    assert.match(received[0].url, /api_key=SECRET_1/);
    const log = lines.join('\n');
    assert.doesNotMatch(log, /SECRET_/);
    const masked = 'api_key=***&APIKEY=***&token=***&access_token=***&password=***&secret=***&page=2';
    assert.equal(lines[0], `→ GET /quiet?${masked}`);
    assert.ok(lines[1].startsWith(`← GET ${baseURL}/quiet?${masked} 204`));
    assert.equal(lines[lines.length - 1], `curl '${baseURL}/quiet?${masked}'`);
  });

  test('PCL-10 redactQueryParams is configurable and keeps the rest of the URL', () => {
    const cmd = buildCurl({ method: 'get', url: 'http://x/y?sig=S1&a=1#h' }, [], { redactQueryParams: ['SIG'] });
    assert.equal(cmd, `curl 'http://x/y?sig=***&a=1#h'`);
  });

  test('PCL-10 redactBodyKeys masks JSON, JSON-string, form and multipart bodies', async () => {
    const { api, lines } = logged({ redactBodyKeys: ['password', 'access_token'] });
    await api.post('/quiet', { data: { user: 'jo', nested: [{ Password: 'SECRET_PW_1' }] } });
    await api.post('/quiet', { data: '{"password":"SECRET_PW_2"}', headers: { 'content-type': 'application/json' } });
    await api.post('/quiet', { form: { user: 'jo', password: 'SECRET_PW_3' } });
    await api.post('/quiet', {
      data: 'user=jo&password=SECRET_PW_4', headers: { 'content-type': 'application/x-www-form-urlencoded' },
    });
    await api.post('/quiet', { multipart: { user: 'jo', password: 'SECRET_PW_5' } });
    await api.post('/login', { data: { user: 'jo' } });
    const log = lines.join('\n');
    assert.doesNotMatch(log, /SECRET_/);
    assert.match(log, /"Password": "\*\*\*"/);
    assert.match(log, /--data-raw '\{"user":"jo","nested":\[\{"Password":"\*\*\*"\}\]\}'/);
    assert.match(log, /--data-raw '\{"password":"\*\*\*"\}'/);
    assert.match(log, /--data-urlencode 'password=\*\*\*'/);
    assert.match(log, /--data-raw 'user=jo&password=\*\*\*'/);
    assert.match(log, /--form-string 'password=\*\*\*'/);
    assert.match(log, /\{"user":"jo","access_token":"\*\*\*"\}/);
  });

  test('PCL-10 bodies are untouched without redactBodyKeys', () => {
    const cmd = buildCurl({ method: 'post', url: 'http://x/y', data: '{"password": "p"}' }, [], {});
    assert.match(cmd, /--data-raw '\{"password": "p"\}'/);
  });
});

describe('PCL-11: maxBodyLength applies to the curl body', () => {
  test('PCL-11 a huge body is truncated in the curl, with a note', async () => {
    const { api, lines } = logged({ maxBodyLength: 100 });
    await api.post('/quiet', { data: 'x'.repeat(5_000_000) });
    const curl = lines[lines.length - 1];
    assert.ok(curl.length < 400, `curl is ${curl.length} chars`);
    assert.match(curl, /^# request body truncated to maxBodyLength \(100 of 5000000 chars\); the replayed body is incomplete\n/);
    assert.ok(curl.includes(`--data-raw '${'x'.repeat(100)}'`));
  });

  test('PCL-11 form values and default-sized bodies', () => {
    const form = buildCurl({ method: 'post', url: 'http://x/y', form: { a: 'abcdef' } }, [], { maxBodyLength: 3 });
    assert.match(form, /--data-urlencode 'a=abc'/);
    assert.match(form, /^# request body truncated/);
    const small = buildCurl({ method: 'post', url: 'http://x/y', data: 'abc' }, [], { maxBodyLength: 3 });
    assert.doesNotMatch(small, /truncated/);
  });
});

describe('PCL-13: the request line includes params', () => {
  test('PCL-13 object, string and URLSearchParams params appear on the → line', async () => {
    const { api, lines } = logged({ curl: false, logHeaders: false, logBody: false });
    await api.get('/echo', { params: { q: 'a b&c' } });
    await api.get('/echo?x=1', { params: { q: '2' } });
    await api.get('/echo', { params: 'q=s' });
    await api.get('/echo', { params: new URLSearchParams({ q: 'u' }) });
    await api.get('/echo');
    assert.deepEqual(lines.filter((l) => l.startsWith('→')), [
      '→ GET /echo?q=a+b%26c',
      '→ GET /echo?x=1&q=2',
      '→ GET /echo?q=s',
      '→ GET /echo?q=u',
      '→ GET /echo',
    ]);
    assert.ok(lines[1].startsWith(`← GET ${baseURL}/echo?q=a+b%26c 200`));
  });
});

describe('PCL-14: fixtures subpath types resolve under every moduleResolution', () => {
  test('PCL-14 playwright-logger-pro/fixtures resolves with node10, node16 and bundler', async () => {
    await withScratchDir(async (dir) => {
      const pkg = path.join(dir, 'node_modules', 'playwright-logger-pro');
      await mkdir(path.join(pkg, 'dist'), { recursive: true });
      await copyFile(path.join(__dirname, '..', 'package.json'), path.join(pkg, 'package.json'));
      for (const file of ['index.d.ts', 'index.d.mts', 'fixtures.d.ts', 'fixtures.d.mts']) {
        await writeFile(path.join(pkg, 'dist', file), 'export {};\n');
      }
      const importer = path.join(dir, 'spec.ts');
      const settings: Array<[string, ts.CompilerOptions]> = [
        ['node10', { moduleResolution: ts.ModuleResolutionKind.Node10, module: ts.ModuleKind.CommonJS }],
        ['node16', { moduleResolution: ts.ModuleResolutionKind.Node16, module: ts.ModuleKind.Node16 }],
        ['bundler', { moduleResolution: ts.ModuleResolutionKind.Bundler, module: ts.ModuleKind.ESNext }],
      ];
      for (const [name, options] of settings) {
        for (const [specifier, file] of [
          ['playwright-logger-pro/fixtures', 'fixtures.d.ts'],
          ['playwright-logger-pro', 'index.d.ts'],
        ]) {
          const resolved = ts.resolveModuleName(specifier, importer, options, ts.sys).resolvedModule;
          assert.equal(
              resolved && path.relative(pkg, fs.realpathSync(resolved.resolvedFileName)),
              path.join('dist', file),
              `${specifier} with ${name}`,
          );
        }
      }
    });
  });
});
