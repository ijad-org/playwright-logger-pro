import { after, afterEach, before, beforeEach, describe, mock, test } from 'node:test';
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';
import { request, type APIRequestContext } from '@playwright/test';
import * as pkg from '../src/index';
import { buildCurl } from '../src/curl';
import { formatHeaders } from '../src/format';
import { parseFetchLog } from '../src/redirects';
import { detectColorSupport, resolveConfig } from '../src/types';
import { resetWarnings } from '../src/warn';
import { wrapRequestContext } from '../src/wrapRequestContext';

const execFileAsync = promisify(execFile);

interface Received {
  method: string;
  url: string;
  contentType: string;
  contentLength: string;
  body: string;
  cookie?: string;
}

const received: Received[] = [];
const server = http.createServer((req, res) => {
  const chunks: Buffer[] = [];
  req.on('data', (c: Buffer) => chunks.push(c));
  req.on('end', () => {
    received.push({
      method: req.method ?? '',
      url: req.url ?? '',
      contentType: req.headers['content-type'] ?? '',
      contentLength: req.headers['content-length'] ?? '',
      body: Buffer.concat(chunks).toString('utf8'),
      cookie: req.headers.cookie,
    });
    const route = new URL(req.url ?? '/', 'http://x');
    const redirect = /^\/r\/(\d{3})$/.exec(route.pathname);
    if (redirect) {
      res.writeHead(Number(redirect[1]), { location: `/echo?from=${redirect[1]}` });
      res.end();
    } else if (route.pathname === '/both') {
      res.writeHead(200, {
        'content-type': 'application/json',
        'set-cookie': ['sid=SECRET_SESSION; Path=/', 'other=SECRET_OTHER; Path=/'],
        'x-api-key': 'SECRET_RESP_KEY',
      });
      res.end(JSON.stringify({ password: 'SECRET_RESP_PW', refreshToken: 'SECRET_RESP_RT', ok: 1 }));
    } else if (route.pathname === '/first-cookie') {
      res.writeHead(200, { 'set-cookie': 'pre=EARLIER; Path=/' });
      res.end();
    } else if (route.pathname === '/fail-cookie') {
      res.writeHead(401, { 'set-cookie': 'late=SET_BY_FAILING_RESPONSE; Path=/' });
      res.end('no');
    } else {
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ method: req.method, path: route.pathname }));
    }
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
afterEach(() => resetWarnings());

function logged(
    config: Parameters<typeof wrapRequestContext>[1] = {},
    context: APIRequestContext = ctx,
) {
  const lines: string[] = [];
  const api = wrapRequestContext(context, {
    colors: false, curl: true, baseURL, ...config, sink: (l) => lines.push(l),
  });
  return { api, lines };
}

async function runCurl(cmd: string, cwd: string): Promise<void> {
  await execFileAsync('sh', ['-c', `${cmd} --silent --show-error --max-time 5 -o /dev/null`], { cwd });
}

async function inScratchDir<T>(fn: (dir: string) => Promise<T>): Promise<T> {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'pcl2-'));
  try {
    return await fn(dir);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

/** Collect console.warn calls (and silence them) while `fn` runs. */
async function withWarnings(fn: () => Promise<void> | void): Promise<string[]> {
  resetWarnings();
  const warn = mock.method(console, 'warn', () => undefined);
  try {
    await fn();
    return warn.mock.calls.map((c) => String(c.arguments[0]));
  } finally {
    warn.mock.restore();
    resetWarnings();
  }
}

const SECRETS = /SECRET_/;

describe('PCL-19: custom redaction lists are merged with the defaults', () => {
  // These are the README recipes, verbatim.
  const headerRecipe = { redactHeaders: ['authorization', 'x-internal-token'] };
  const queryRecipe = { redactQueryParams: ['api_key', 'token', 'sig'] };
  const bodyRecipe = { redactBodyKeys: ['password', 'access_token', 'refreshToken'] };

  test('PCL-19 the README still contains the recipes these tests use', async () => {
    const readme = await readFile(path.join(__dirname, '..', 'README.md'), 'utf8');
    for (const recipe of [
      "use: { apiLog: { redactHeaders: ['authorization', 'x-internal-token'] } }",
      "use: { apiLog: { redactQueryParams: ['api_key', 'token', 'sig'] } }",
      "use: { apiLog: { redactBodyKeys: ['password', 'access_token', 'refreshToken'] } }",
    ]) {
      assert.ok(readme.includes(recipe), recipe);
    }
  });

  test('PCL-19 resolveConfig merges case-insensitively and dedupes', () => {
    const cfg = resolveConfig({
      redactHeaders: ['Authorization', 'X-Internal-Token', 'x-internal-token'],
      redactQueryParams: ['TOKEN', 'sig'],
      redactBodyKeys: ['password', 'Password'],
    });
    assert.deepEqual(cfg.redactHeaders, ['authorization', 'cookie', 'set-cookie', 'x-api-key', 'X-Internal-Token']);
    assert.deepEqual(cfg.redactQueryParams,
        ['api_key', 'apikey', 'token', 'access_token', 'password', 'secret', 'sig']);
    assert.deepEqual(cfg.redactBodyKeys, ['password']);
  });

  test('PCL-19 the defaults are exported from the package entry', () => {
    assert.deepEqual([...pkg.DEFAULT_REDACT_HEADERS], ['authorization', 'cookie', 'set-cookie', 'x-api-key']);
    assert.deepEqual([...pkg.DEFAULT_REDACT_QUERY_PARAMS],
        ['api_key', 'apikey', 'token', 'access_token', 'password', 'secret']);
    assert.deepEqual([...pkg.DEFAULT_REDACT_BODY_KEYS], []);
    for (const list of [pkg.DEFAULT_REDACT_HEADERS, pkg.DEFAULT_REDACT_QUERY_PARAMS]) {
      assert.throws(() => (list as string[]).push('x'), TypeError);
    }
  });

  test('PCL-19 the README recipes redact Cookie, Set-Cookie, X-Api-Key, password and access_token everywhere', async () => {
    const { api, lines } = logged({ ...headerRecipe, ...queryRecipe, ...bodyRecipe });
    await api.post('/both?password=SECRET_PW&access_token=SECRET_AT&sig=SECRET_SIG&api_key=SECRET_AK&q=shoes', {
      headers: {
        Cookie: 'manual=SECRET_COOKIE',
        'X-Api-Key': 'SECRET_XKEY',
        'X-Internal-Token': 'SECRET_INT',
        Authorization: 'Bearer SECRET_AUTH',
      },
      data: { password: 'SECRET_BODY_PW', access_token: 'SECRET_BODY_AT', refreshToken: 'SECRET_BODY_RT', user: 'jo' },
    });
    const output = lines.join('\n');
    assert.doesNotMatch(output, SECRETS);
    // The log and the curl both ran and both kept the harmless parts.
    assert.match(output, /q=shoes/);
    assert.match(output, /^curl -X POST /m);
    assert.match(output, /-H 'Cookie: \*\*\*'/);
    assert.match(output, /-H 'X-Api-Key: \*\*\*'/);
    assert.match(output, /-H 'X-Internal-Token: \*\*\*'/);
    assert.match(output, /password=\*\*\*&access_token=\*\*\*&sig=\*\*\*/);
    assert.match(output, /set-cookie: \*\*\*/);
    assert.match(output, /x-api-key: \*\*\*/);
  });

  test('PCL-19 each recipe on its own still leaves the other defaults on', async () => {
    for (const recipe of [headerRecipe, queryRecipe, bodyRecipe]) {
      const { api, lines } = logged(recipe);
      await api.get('/both?password=SECRET_PW&access_token=SECRET_AT', {
        headers: { Cookie: 'manual=SECRET_COOKIE', 'X-Api-Key': 'SECRET_XKEY' },
      });
      assert.doesNotMatch(lines.join('\n').replace(/SECRET_(SESSION|OTHER|RESP_\w+)/g, ''), SECRETS,
          JSON.stringify(recipe));
    }
  });

  test('PCL-19 replaceDefaultRedaction: true uses only the given lists', async () => {
    const cfg = resolveConfig({ redactHeaders: ['x-only'], replaceDefaultRedaction: true });
    assert.deepEqual(cfg.redactHeaders, ['x-only']);
    assert.deepEqual(cfg.redactQueryParams, []);
    assert.equal(cfg.replaceDefaultRedaction, true);
    assert.equal(resolveConfig().replaceDefaultRedaction, false);

    const { api, lines } = logged({ redactHeaders: ['x-only'], replaceDefaultRedaction: true });
    await api.get('/echo?token=VISIBLE_TOKEN', { headers: { Cookie: 'a=VISIBLE_COOKIE', 'X-Only': 'HIDDEN' } });
    const output = lines.join('\n');
    assert.match(output, /VISIBLE_TOKEN/);
    assert.match(output, /Cookie: a=VISIBLE_COOKIE/);
    assert.doesNotMatch(output, /HIDDEN/);
  });
});

describe('PCL-02/PCL-22: colour detection follows the runner and the standard variables', () => {
  const piped = [{ isTTY: false }];

  test('PCL-02 Playwright worker env (piped, FORCE_COLOR=1) is coloured, unless NO_COLOR', () => {
    assert.equal(detectColorSupport({ FORCE_COLOR: '1', DEBUG_COLORS: '1' }, piped), true);
    assert.equal(detectColorSupport({ FORCE_COLOR: '1', NO_COLOR: '1' }, piped), false);
    assert.equal(detectColorSupport({ FORCE_COLOR: '1', NO_COLOR: '' }, piped), true);
  });

  test('PCL-02 FORCE_COLOR=0/false and DEBUG_COLORS=0/false turn colours off, even on a TTY', () => {
    const tty = [{ isTTY: true }];
    assert.equal(detectColorSupport({ FORCE_COLOR: '0' }, tty), false);
    assert.equal(detectColorSupport({ FORCE_COLOR: 'false' }, tty), false);
    assert.equal(detectColorSupport({ DEBUG_COLORS: '0' }, tty), false);
    assert.equal(detectColorSupport({ DEBUG_COLORS: 'false', FORCE_COLOR: '1' }, tty), false);
    assert.equal(detectColorSupport({ FORCE_COLOR: '0', DEBUG_COLORS: '1' }, tty), false);
  });

  test('PCL-02 FORCE_COLOR levels and an empty FORCE_COLOR count as on', () => {
    for (const value of ['1', '2', '3', 'true', '']) {
      assert.equal(detectColorSupport({ FORCE_COLOR: value }, piped), true, value);
    }
    assert.equal(detectColorSupport({ DEBUG_COLORS: '1' }, piped), true);
  });

  test('PCL-02 PLAYWRIGHT_FORCE_TTY counts as a terminal', () => {
    for (const value of ['1', 'true', '120', '120x40']) {
      assert.equal(detectColorSupport({ PLAYWRIGHT_FORCE_TTY: value }, piped), true, value);
    }
    assert.equal(detectColorSupport({ PLAYWRIGHT_FORCE_TTY: '0' }, piped), false);
    assert.equal(detectColorSupport({ PLAYWRIGHT_FORCE_TTY: 'false' }, piped), false);
    assert.equal(detectColorSupport({ PLAYWRIGHT_FORCE_TTY: '1', NO_COLOR: '1' }, piped), false);
  });

  test('PCL-22 piped output with no hint is plain, a TTY is coloured, TERM=dumb is plain', () => {
    assert.equal(detectColorSupport({}, piped), false);
    assert.equal(detectColorSupport({}, [{ isTTY: true }]), true);
    assert.equal(detectColorSupport({ TERM: 'dumb' }, [{ isTTY: true }]), false);
  });

  test('PCL-22 the README states when colours are on', async () => {
    const readme = await readFile(path.join(__dirname, '..', 'README.md'), 'utf8');
    assert.doesNotMatch(readme, /Colors are on by default under `playwright test`/);
    assert.match(readme, /FORCE_COLOR/);
    assert.match(readme, /PLAYWRIGHT_FORCE_TTY/);
    assert.match(readme, /colors: true/);
  });
});

describe('PCL-20: the curl only has cookies that were sent', () => {
  for (const curl of ['on-failure', true] as const) {
    test(`PCL-20 curl: ${JSON.stringify(curl)} leaves out the cookie set by the failing response`, async () => {
      const own = await request.newContext({ baseURL });
      try {
        await own.get('/first-cookie');
        received.length = 0;
        const { api, lines } = logged(
            { curl, redactHeaders: [], replaceDefaultRedaction: true }, own,
        );
        const response = await api.get('/fail-cookie');
        assert.equal(response.status(), 401);
        assert.equal(received[0].cookie, 'pre=EARLIER');
        const output = lines[lines.length - 1];
        assert.match(output, /-H 'Cookie: pre=EARLIER'/);
        assert.doesNotMatch(output, /SET_BY_FAILING_RESPONSE|late=/);
      } finally {
        await own.dispose();
      }
    });
  }

  test('PCL-20 an empty jar gives no Cookie header; cookies that were sent are redacted', async () => {
    const own = await request.newContext({ baseURL });
    try {
      const first = logged({ curl: 'on-failure' }, own);
      await first.api.get('/fail-cookie');
      assert.doesNotMatch(first.lines[first.lines.length - 1], /-H 'Cookie/i);

      // The failing response set `late`; the next request really sends it.
      const second = logged({ curl: 'on-failure' }, own);
      received.length = 0;
      await second.api.get('/fail-cookie');
      assert.equal(received[0].cookie, 'late=SET_BY_FAILING_RESPONSE');
      assert.match(second.lines[second.lines.length - 1], /-H 'Cookie: \*\*\*'/);
      assert.doesNotMatch(second.lines[second.lines.length - 1], /SET_BY_FAILING_RESPONSE/);
    } finally {
      await own.dispose();
    }
  });
});

describe('PCL-21/PCL-25: the curl matches the redirects Playwright followed', () => {
  const statuses = [301, 302, 303, 307, 308];
  const methods = ['post', 'put', 'patch', 'delete'] as const;

  for (const method of methods) {
    for (const status of statuses) {
      test(`PCL-21 ${method.toUpperCase()} + ${status} replays with the same requests`, async () => {
        const { api, lines } = logged();
        received.length = 0;
        await api[method](`/r/${status}`, method === 'delete' ? {} : { data: { a: 1 } });
        const original = received.map((r) => `${r.method} ${r.url} ${r.body}`);
        const originalHop2 = { ...received[1] };
        assert.equal(original.length, 2);

        const curl = lines[lines.length - 1];
        received.length = 0;
        await inScratchDir((dir) => runCurl(curl, dir));
        assert.deepEqual(received.map((r) => `${r.method} ${r.url} ${r.body}`), original, curl);
        // PCL-25: whatever the redirected request carried, the replay carries too.
        assert.equal(received[1].contentType, originalHop2.contentType, curl);
        assert.equal(received[1].contentLength, originalHop2.contentLength, curl);
        if (originalHop2.method === 'GET') {
          assert.equal(received[1].contentType, '');
          assert.doesNotMatch(curl.slice(curl.indexOf('# step 2')), /Content-Type|Content-Length|--data/i);
        }
      });
    }
  }

  test('PCL-21 303 switches PUT and DELETE to GET without a body; 302 keeps a PUT body', async () => {
    const put303 = logged();
    await put303.api.put('/r/303', { data: 'x' });
    const step2 = put303.lines[put303.lines.length - 1].split('# step 2')[1];
    assert.match(step2, /^ of 2 \(response: 200\)\ncurl '/);
    assert.doesNotMatch(step2, /-X|--data/);

    const del303 = logged();
    await del303.api.delete('/r/303');
    assert.doesNotMatch(del303.lines[del303.lines.length - 1].split('# step 2')[1], /-X DELETE/);

    const put302 = logged();
    await put302.api.put('/r/302', { data: 'x' });
    assert.match(put302.lines[put302.lines.length - 1].split('# step 2')[1], /-X PUT [^\n]*\n {2}--data-raw 'x'/);
  });

  test('PCL-21 a redirected GET stays one curl -L and replays', async () => {
    const own = await request.newContext({ baseURL });
    try {
      const { api, lines } = logged({}, own);
      received.length = 0;
      await api.get('/r/303');
      const curl = lines[lines.length - 1];
      assert.equal(curl, `curl -L '${baseURL}/r/303'`);
      received.length = 0;
      await inScratchDir((dir) => runCurl(curl, dir));
      assert.deepEqual(received.map((r) => `${r.method} ${r.url}`), ['GET /r/303', 'GET /echo?from=303']);
    } finally {
      await own.dispose();
    }
  });

  test('PCL-21 buildCurl steps: cookies dropped, Authorization dropped across origins, body headers dropped on GET', () => {
    const curl = buildCurl({
      method: 'post',
      url: 'http://a.test/x',
      headers: {
        Authorization: 'Bearer T', Cookie: 'c=1', 'Content-Type': 'application/json',
        'Content-Length': '7', 'X-Keep': 'k',
      },
      data: { a: 1 },
      followRedirects: true,
      redirects: [
        { method: 'POST', url: 'http://a.test/x', status: 307 },
        { method: 'POST', url: 'http://b.test/y', status: 303 },
        { method: 'GET', url: 'http://b.test/z', status: 200 },
      ],
    });
    const [, s1, s2, s3] = curl.split(/^# step \d of 3.*$/m);
    assert.match(s1, /-X POST 'http:\/\/a\.test\/x'/);
    assert.match(s1, /Authorization: Bearer T/);
    assert.match(s1, /Cookie: c=1/);
    // 307: same method and body; the cookie is re-derived by Playwright, so it is left out.
    assert.match(s2, /-X POST 'http:\/\/b\.test\/y'/);
    assert.doesNotMatch(s2, /Authorization|Cookie/);
    assert.match(s2, /Content-Type: application\/json/);
    assert.match(s2, /--data-raw '\{"a":1\}'/);
    assert.match(s2, /X-Keep: k/);
    // 303: GET, no body, no body headers.
    assert.match(s3, /^\ncurl 'http:\/\/b\.test\/z' \\\n {2}-H 'X-Keep: k'$/);
  });

  test('PCL-21 without the hop list, -L is only used where curl matches Playwright', () => {
    const base = { url: 'http://a.test/x', followRedirects: true };
    assert.match(buildCurl({ ...base, method: 'get' }), /^curl -L 'http:\/\/a\.test\/x'$/);
    assert.match(buildCurl({ ...base, method: 'post', data: 'x' }), /^curl -L 'http/);
    const put = buildCurl({ ...base, method: 'put', data: 'x' });
    assert.doesNotMatch(put, /^curl .*-L/m);
    assert.match(put, /^# the request was redirected; PUT is not followed with -L/);
    assert.match(put, /\ncurl -X PUT 'http:\/\/a\.test\/x'/);
  });

  test('PCL-21 parseFetchLog reads the requests and statuses, ignoring headers and retries', () => {
    assert.deepEqual(parseFetchLog([
      '→ PUT http://h/a', '  content-type: application/json', '→ PUT http://h/a',
      '← 303 See Other', '  location: /b', '→ GET http://h/b', '  accept: */*', '← 200 OK',
    ]), [
      { method: 'PUT', url: 'http://h/a', status: 303 },
      { method: 'GET', url: 'http://h/b', status: 200 },
    ]);
    assert.deepEqual(parseFetchLog(['nothing useful']), []);
  });
});

describe('PCL-23: invalid options warn once and fall back to the defaults', () => {
  const defaults = resolveConfig({ colors: false });

  test('PCL-23 non-array redact lists use the defaults and never throw', async () => {
    const warnings = await withWarnings(async () => {
      for (const bad of ['authorization', null, 5, {}, true]) {
        const cfg = resolveConfig({
          redactHeaders: bad as never, redactQueryParams: bad as never, redactBodyKeys: bad as never,
        });
        assert.deepEqual(cfg.redactHeaders, defaults.redactHeaders);
        assert.deepEqual(cfg.redactQueryParams, defaults.redactQueryParams);
        assert.deepEqual(cfg.redactBodyKeys, defaults.redactBodyKeys);
      }
      const { api, lines } = logged({ redactHeaders: 'authorization' as never, redactBodyKeys: null as never });
      const response = await api.get('/echo?token=SECRET_T', { headers: { Authorization: 'SECRET_A' } });
      assert.equal(response.status(), 200);
      assert.doesNotMatch(lines.join('\n'), SECRETS);
    });
    assert.ok(warnings.some((w) => /redactHeaders.*array of strings.*the string "authorization"/.test(w)), warnings.join('\n'));
    assert.ok(warnings.some((w) => /redactBodyKeys.*null/.test(w)));
    assert.ok(warnings.every((w) => w.startsWith('[playwright-logger-pro] ')));
  });

  test('PCL-23 non-string entries in a list are ignored', async () => {
    const warnings = await withWarnings(() => {
      const cfg = resolveConfig({ redactHeaders: ['x-a', 3, null, '', '  x-b '] as never });
      assert.deepEqual(cfg.redactHeaders, [...pkg.DEFAULT_REDACT_HEADERS, 'x-a', 'x-b']);
    });
    assert.equal(warnings.length, 1);
    assert.match(warnings[0], /not strings/);
  });

  test('PCL-23 bad maxBodyLength falls back to 2000 and no NaN is printed', async () => {
    const warnings = await withWarnings(async () => {
      for (const bad of [NaN, -5, '10', null, {}]) {
        assert.equal(resolveConfig({ maxBodyLength: bad as never }).maxBodyLength, 2000, String(bad));
      }
      const { api, lines } = logged({ maxBodyLength: NaN, curl: false });
      await api.post('/echo', { data: { text: 'y'.repeat(2500) } });
      const output = lines.join('\n');
      assert.doesNotMatch(output, /NaN|-5/);
      assert.match(output, /\.\.\. \(\d+ more chars\)/);
    });
    assert.ok(warnings.some((w) => /maxBodyLength.*a number >= 0.*NaN/.test(w)), warnings.join('\n'));
    assert.ok(warnings.some((w) => /maxBodyLength.*number -5/.test(w)), warnings.join('\n'));
  });

  test('PCL-23 valid maxBodyLength values are kept (0, Infinity, fractions floored)', async () => {
    const warnings = await withWarnings(() => {
      assert.equal(resolveConfig({ maxBodyLength: 0 }).maxBodyLength, 0);
      assert.equal(resolveConfig({ maxBodyLength: Infinity }).maxBodyLength, Infinity);
      assert.equal(resolveConfig({ maxBodyLength: 10.9 }).maxBodyLength, 10);
    });
    assert.deepEqual(warnings, []);
  });

  test('PCL-23 unknown curl values fall back to false (no curl) with a warning', async () => {
    const warnings = await withWarnings(async () => {
      assert.equal(resolveConfig({ curl: 'always' as never }).curl, false);
      assert.equal(resolveConfig({ curl: 1 as never }).curl, false);
      assert.equal(resolveConfig({ curl: 'on-failure' }).curl, 'on-failure');
      const { api, lines } = logged({ curl: 'always' as never });
      await api.get('/echo');
      assert.ok(!lines.some((l) => l.startsWith('curl')));
    });
    assert.ok(warnings.some((w) => /curl.*'on-failure'.*"always"/.test(w)), warnings.join('\n'));
  });

  test('PCL-23 other options of the wrong type and unknown options warn', async () => {
    const warnings = await withWarnings(() => {
      const cfg = resolveConfig({
        enabled: 'yes' as never, colors: 'yes' as never, logHeaders: 0 as never, logBody: null as never,
        replaceDefaultRedaction: 'no' as never, baseURL: 5 as never, extraHTTPHeaders: [] as never,
        sink: 'console' as never, typoOption: true,
      } as never);
      assert.equal(cfg.enabled, true);
      assert.equal(cfg.logHeaders, true);
      assert.equal(cfg.logBody, true);
      assert.equal(cfg.replaceDefaultRedaction, false);
      assert.equal(cfg.colors, detectColorSupport());
      assert.equal(cfg.baseURL, undefined);
      assert.equal(cfg.extraHTTPHeaders, undefined);
      assert.equal(typeof cfg.sink, 'function');
      resolveConfig(null as never);
      resolveConfig('curl' as never);
    });
    for (const name of ['enabled', 'colors', 'logHeaders', 'logBody', 'replaceDefaultRedaction',
      'baseURL', 'extraHTTPHeaders', 'sink', 'typoOption']) {
      assert.ok(warnings.some((w) => w.includes(`"${name}"`)), name);
    }
    assert.ok(warnings.some((w) => /must be an object/.test(w)));
  });

  test('PCL-23 each warning is printed once per process', async () => {
    const warnings = await withWarnings(() => {
      for (let i = 0; i < 5; i++) resolveConfig({ curl: 'always' as never });
    });
    assert.equal(warnings.length, 1);
  });

  test('PCL-23 a throwing sink does not fail the request', async () => {
    const printed: string[] = [];
    const log = mock.method(console, 'log', (line: string) => printed.push(line));
    try {
      const warnings = await withWarnings(async () => {
        const api = wrapRequestContext(ctx, {
          colors: false, curl: true, baseURL, sink: () => {
            throw new Error('sink boom');
          },
        });
        const response = await api.get('/echo');
        assert.equal(response.status(), 200);
        await api.get('/echo');
      });
      assert.equal(warnings.length, 1);
      assert.match(warnings[0], /"sink" option threw \(sink boom\)/);
      assert.ok(printed.some((l) => l.startsWith('→ GET')));
    } finally {
      log.mock.restore();
    }
  });

  test('PCL-23 a request with bad redact options still succeeds', async () => {
    await withWarnings(async () => {
      const { api } = logged({
        redactHeaders: 'x' as never, redactQueryParams: null as never, redactBodyKeys: 7 as never,
        maxBodyLength: 'lots' as never,
      });
      assert.equal((await api.post('/both', { data: { a: 1 } })).status(), 200);
    });
  });
});

describe('PCL-24: every value of a multi-value header is indented', () => {
  const cfg = resolveConfig({ colors: false, replaceDefaultRedaction: true, redactHeaders: [] });

  test('PCL-24 formatHeaders prints one indented line per value', () => {
    assert.equal(
        formatHeaders({ 'set-cookie': 'a=1\nb=2\nc=3', 'content-type': 'text/plain' }, cfg),
        '  set-cookie: a=1\n  set-cookie: b=2\n  set-cookie: c=3\n  content-type: text/plain',
    );
  });

  test('PCL-24 a redacted multi-value header is a single masked line', () => {
    assert.equal(
        formatHeaders({ 'set-cookie': 'a=1\nb=2' }, resolveConfig({ colors: false })),
        '  set-cookie: ***',
    );
  });

  test('PCL-24 a real response with two Set-Cookie headers has no unindented line', async () => {
    const { api, lines } = logged({ curl: false, replaceDefaultRedaction: true, redactHeaders: [] });
    await api.get('/both');
    const all = lines.join('\n').split('\n');
    assert.deepEqual(all.filter((l) => /set-cookie/.test(l)),
        ['  set-cookie: sid=SECRET_SESSION; Path=/', '  set-cookie: other=SECRET_OTHER; Path=/']);
    assert.ok(all.every((l) => l.startsWith('  ') || /^[→←✖]/.test(l)), all.join('\n'));
  });
});

describe('PCL-26: an invalid URL does not produce a broken curl', () => {
  test('PCL-26 buildCurl returns a clear comment', () => {
    for (const url of ['http://exa mple.invalid/?token=SECRET_T', 'not a url', '/relative', '']) {
      assert.equal(buildCurl({ method: 'get', url }), '# could not build curl: invalid URL', url);
    }
    assert.match(buildCurl({ method: 'get', url: 'http://ok.test/' }), /^curl 'http:\/\/ok\.test\/'$/);
  });

  test('PCL-26 a request to an invalid URL logs the error and the comment, then rethrows', async () => {
    const { api, lines } = logged({ baseURL: undefined });
    await assert.rejects(api.get('http://exa mple.invalid/?api_key=SECRET_K'), /Invalid URL/);
    assert.equal(lines[lines.length - 1], '# could not build curl: invalid URL');
    assert.doesNotMatch(lines.join('\n'), SECRETS);
  });
});
