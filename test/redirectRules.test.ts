import { after, before, describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { mkdtemp, rm } from 'node:fs/promises';
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';
import { request, type APIRequestContext } from '@playwright/test';
import { buildCurl } from '../src/curl';
import { detectPlaywrightVersion, redirectRulesFor } from '../src/playwrightVersion';
import type { RequestInfo } from '../src/types';
import { wrapRequestContext } from '../src/wrapRequestContext';

const execFileAsync = promisify(execFile);

/** The curl of each step, without the `# step` comment lines. */
function steps(curl: string): string[] {
  return curl.split(/^# step \d+ of \d+.*$/m).slice(1).map((s) => s.trim());
}

const hop = (method: string, url: string, status?: number) => ({ method, url, status });

describe('PCL-27: a body dropped by one redirect does not come back on a later step', () => {
  const chain = (extra: Partial<RequestInfo> = {}): RequestInfo => ({
    method: 'POST',
    url: 'http://a.test/chain/4',
    data: { a: 1 },
    followRedirects: true,
    redirects: [
      hop('POST', 'http://a.test/chain/4', 302),
      hop('GET', 'http://a.test/chain/3', 307),
      hop('GET', 'http://a.test/chain/2', 302),
      hop('GET', 'http://a.test/chain/1', 307),
      hop('GET', 'http://a.test/echo', 200),
    ],
    ...extra,
  });

  test('PCL-27 steps 2..N of a 302 then 307/302/307 chain are bodiless GETs', () => {
    const all = steps(buildCurl(chain()));
    assert.equal(all.length, 5);
    assert.match(all[0], /-X POST/);
    assert.match(all[0], /Content-Type: application\/json/);
    assert.match(all[0], /--data-raw '\{"a":1\}'/);
    for (const [i, step] of all.slice(1).entries()) {
      assert.doesNotMatch(step, /-X|--data|Content-Type|-H/, `step ${i + 2}: ${step}`);
      assert.match(step, /^curl 'http:\/\/a\.test\//);
    }
  });

  test('PCL-27 the same holds for explicit body headers, a form and a 303 in the middle', () => {
    const explicit = steps(buildCurl(chain({
      headers: { 'Content-Type': 'application/json', 'X-Keep': 'k' },
      data: '{"a":1}',
    })));
    for (const step of explicit.slice(1)) {
      assert.doesNotMatch(step, /--data|Content-Type/);
      assert.match(step, /X-Keep: k/);
    }

    const form = steps(buildCurl(chain({ data: undefined, form: { a: '1' } })));
    for (const step of form.slice(1)) assert.doesNotMatch(step, /--data/);

    // PUT keeps its body on 307, loses it on 303 and stays without it on the 307 after that.
    const put = steps(buildCurl({
      method: 'PUT',
      url: 'http://a.test/a',
      data: 'x',
      headers: { 'Content-Type': 'text/plain' },
      followRedirects: true,
      redirects: [
        hop('PUT', 'http://a.test/a', 307),
        hop('PUT', 'http://a.test/b', 303),
        hop('GET', 'http://a.test/c', 307),
        hop('GET', 'http://a.test/d', 200),
      ],
    }));
    assert.match(put[1], /-X PUT[^]*Content-Type: text\/plain[^]*--data-raw 'x'/);
    for (const step of put.slice(2)) assert.doesNotMatch(step, /--data|Content-Type|-X/);
  });

  test('PCL-27 a method that never changes keeps its body on every 307/308 step', () => {
    const all = steps(buildCurl({
      method: 'POST',
      url: 'http://a.test/a',
      data: { a: 1 },
      followRedirects: true,
      redirects: [
        hop('POST', 'http://a.test/a', 307),
        hop('POST', 'http://a.test/b', 308),
        hop('POST', 'http://a.test/c', 200),
      ],
    }));
    for (const step of all) {
      assert.match(step, /-X POST/);
      assert.match(step, /Content-Type: application\/json/);
      assert.match(step, /--data-raw '\{"a":1\}'/);
    }
  });
});

describe('PCL-28: step curls follow the redirect header rules of the running Playwright', () => {
  const base = (headers: Record<string, string>, extra: Partial<RequestInfo> = {}): RequestInfo => ({
    method: 'POST',
    url: 'http://a.test/x',
    headers,
    data: 'body',
    followRedirects: true,
    ...extra,
  });
  const sameOrigin = [hop('POST', 'http://a.test/x', 307), hop('POST', 'http://a.test/y', 200)];
  const crossOrigin = [hop('POST', 'http://a.test/x', 307), hop('POST', 'http://b.test/y', 200)];
  const secret = ['authorization', 'cookie'];

  test('PCL-28 redirectRulesFor maps a version to its rules; unknown gets the newest', () => {
    const old = { exactCaseRemoval: false, dropAuthorizationCrossOrigin: false };
    const mid = { exactCaseRemoval: true, dropAuthorizationCrossOrigin: false };
    const latest = { exactCaseRemoval: false, dropAuthorizationCrossOrigin: true };
    for (const v of ['1.30.0', '1.31.2']) assert.deepEqual(redirectRulesFor(v), old, v);
    for (const v of ['1.32.0', '1.45.0', '1.45.3', '1.59.1']) assert.deepEqual(redirectRulesFor(v), mid, v);
    for (const v of ['1.60.0', '1.64.1', '1.70.0-alpha-1', '2.0.0', undefined, '', 'next', 'v1']) {
      assert.deepEqual(redirectRulesFor(v), latest, String(v));
    }
  });

  test('PCL-28 the installed Playwright version is detected', () => {
    assert.match(detectPlaywrightVersion() ?? '', /^\d+\.\d+\.\d+/);
  });

  test('PCL-28 1.45: an explicit Cookie header is forwarded, in any origin; Authorization too', () => {
    const headers = { Cookie: 'sid=SECRET_C', Authorization: 'Bearer SECRET_A', 'X-Keep': 'k' };
    for (const redirects of [sameOrigin, crossOrigin]) {
      const step2 = steps(buildCurl(base(headers, { redirects, playwrightVersion: '1.45.0' })))[1];
      assert.match(step2, /Cookie: sid=SECRET_C/);
      assert.match(step2, /Authorization: Bearer SECRET_A/);
      assert.match(step2, /X-Keep: k/);
    }
  });

  test('PCL-28 1.45: removal is by exact lower-case name, so a lower-case cookie is dropped', () => {
    const step2 = steps(buildCurl(base(
        { cookie: 'sid=1', Cookie2: 'kept', Authorization: 'a' },
        { redirects: sameOrigin, playwrightVersion: '1.45.0' },
    )))[1];
    assert.doesNotMatch(step2, /cookie: sid=1/);
    assert.match(step2, /Cookie2: kept/);
  });

  test('PCL-28 1.45: the cookie jar cookie is still left out of later steps', () => {
    const step2 = steps(buildCurl(base(
        { Cookie: 'jar=1', 'X-Keep': 'k' },
        { redirects: sameOrigin, playwrightVersion: '1.45.0', cookieFromJar: true },
    )))[1];
    assert.doesNotMatch(step2, /Cookie/);
    assert.match(step2, /X-Keep: k/);
  });

  test('PCL-28 1.45: a caller-cased Content-Type survives the switch to GET; lower-case does not', () => {
    const redirects = [hop('POST', 'http://a.test/x', 302), hop('GET', 'http://a.test/y', 200)];
    const cased = steps(buildCurl(base(
        { 'Content-Type': 'text/plain' }, { redirects, playwrightVersion: '1.45.0' },
    )))[1];
    assert.equal(cased, "curl 'http://a.test/y' \\\n  -H 'Content-Type: text/plain'");
    const lower = steps(buildCurl(base(
        { 'content-type': 'text/plain' }, { redirects, playwrightVersion: '1.45.0' },
    )))[1];
    assert.equal(lower, "curl 'http://a.test/y'");
    // The Content-Type Playwright adds for a JSON body is lower-case, so it goes.
    const json = steps(buildCurl({
      ...base({}, { redirects, playwrightVersion: '1.45.0' }), data: { a: 1 },
    }))[1];
    assert.equal(json, "curl 'http://a.test/y'");
  });

  test('PCL-28 1.30: Authorization is forwarded cross-origin, Cookie of any casing is dropped', () => {
    const step2 = steps(buildCurl(base(
        { Cookie: 'sid=1', Authorization: 'Bearer T', 'Content-Type': 'text/plain' },
        { redirects: crossOrigin, playwrightVersion: '1.30.0' },
    )))[1];
    assert.match(step2, /Authorization: Bearer T/);
    assert.doesNotMatch(step2, /Cookie/);
    const get = steps(buildCurl(base(
        { 'Content-Type': 'text/plain' },
        {
          redirects: [hop('POST', 'http://a.test/x', 303), hop('GET', 'http://a.test/y', 200)],
          playwrightVersion: '1.30.0',
        },
    )))[1];
    assert.doesNotMatch(get, /Content-Type/);
  });

  test('PCL-28 1.64 (and an unknown version): Cookie dropped, Authorization only kept in the origin', () => {
    const headers = { Cookie: 'sid=1', authorization: 'Bearer T', 'X-Keep': 'k' };
    for (const playwrightVersion of ['1.64.1', '1.60.0', undefined]) {
      const same = steps(buildCurl(base(headers, { redirects: sameOrigin, playwrightVersion })))[1];
      assert.match(same, /authorization: Bearer T/);
      assert.doesNotMatch(same, /Cookie/);
      const cross = steps(buildCurl(base(headers, { redirects: crossOrigin, playwrightVersion })))[1];
      assert.doesNotMatch(cross, /authorization|Cookie/i);
      assert.match(cross, /X-Keep: k/);
    }
  });

  test('PCL-28 a forwarded secret is still redacted in every step', () => {
    for (const playwrightVersion of ['1.30.0', '1.45.0', '1.64.1']) {
      const curl = buildCurl(
          base(
              { Cookie: 'sid=SECRET_C', Authorization: 'Bearer SECRET_A' },
              { redirects: crossOrigin, playwrightVersion },
          ),
          secret,
      );
      assert.doesNotMatch(curl, /SECRET_/, playwrightVersion);
    }
    const step2 = steps(buildCurl(
        base(
            { Cookie: 'sid=SECRET_C', Authorization: 'Bearer SECRET_A' },
            { redirects: crossOrigin, playwrightVersion: '1.45.0' },
        ),
        secret,
    ))[1];
    assert.match(step2, /Authorization: \*\*\*/);
    assert.match(step2, /Cookie: \*\*\*/);
  });
});

describe('PCL-27/PCL-28: the step curls replay what the installed Playwright sent', () => {
  interface Received {
    method: string;
    url: string;
    host: string;
    contentType: string;
    body: string;
    authorization: boolean;
    cookie: boolean;
  }
  const received: Received[] = [];
  let origin = '';
  let other = '';
  let ctx: APIRequestContext;

  const handler = (req: http.IncomingMessage, res: http.ServerResponse) => {
    const chunks: Buffer[] = [];
    req.on('data', (c: Buffer) => chunks.push(c));
    req.on('end', () => {
      received.push({
        method: req.method ?? '',
        url: req.url ?? '',
        host: req.headers.host ?? '',
        contentType: req.headers['content-type'] ?? '',
        body: Buffer.concat(chunks).toString('utf8'),
        authorization: req.headers.authorization !== undefined,
        cookie: req.headers.cookie !== undefined,
      });
      const route = new URL(req.url ?? '/', 'http://x');
      const chain = /^\/chain\/(\d+)$/.exec(route.pathname);
      const cross = /^\/xo\/(\d{3})$/.exec(route.pathname);
      if (chain) {
        const n = Number(chain[1]);
        res.writeHead(n % 2 ? 307 : 302, { location: n > 0 ? `/chain/${n - 1}` : '/echo?end=1' });
      } else if (cross) {
        res.writeHead(Number(cross[1]), { location: `${other}/echo?xo=${cross[1]}` });
      } else {
        res.writeHead(200);
      }
      res.end();
    });
  };
  const first = http.createServer(handler);
  const second = http.createServer(handler);

  before(async () => {
    await Promise.all([first, second].map(
        (s) => new Promise<void>((resolve) => s.listen(0, '127.0.0.1', resolve)),
    ));
    origin = `http://127.0.0.1:${(first.address() as AddressInfo).port}`;
    other = `http://127.0.0.1:${(second.address() as AddressInfo).port}`;
    ctx = await request.newContext({ baseURL: origin });
  });

  after(async () => {
    await ctx.dispose();
    for (const s of [first, second]) {
      s.closeAllConnections();
      await new Promise<void>((resolve) => s.close(() => resolve()));
    }
  });

  async function replayMatches(
      send: (api: APIRequestContext) => Promise<unknown>,
  ): Promise<{ original: Received[]; replay: Received[]; curl: string }> {
    const lines: string[] = [];
    const api = wrapRequestContext(ctx, { format: 'verbose',
      colors: false, curl: true, baseURL: origin, sink: (l) => lines.push(l),
    });
    received.length = 0;
    await send(api);
    const original = received.splice(0).map((r) => ({ ...r }));
    const curl = lines[lines.length - 1];
    const dir = await mkdtemp(path.join(os.tmpdir(), 'pcl27-'));
    try {
      await execFileAsync(
          'sh', ['-c', `${curl.replace(/^curl /gm, 'curl --silent --max-time 5 -o /dev/null ')}`], { cwd: dir },
      );
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
    const replay = received.splice(0).map((r) => ({ ...r }));
    return { original, replay, curl };
  }

  test('PCL-27 POST /chain/6 (302, 307, 302, ...) replays step for step', async () => {
    const { original, replay, curl } = await replayMatches(
        (api) => api.post('/chain/6', { data: { a: 1 } }),
    );
    assert.equal(original.length, 8);
    assert.deepEqual(original.slice(1).map((r) => [r.method, r.body, r.contentType]),
        Array(7).fill(['GET', '', '']));
    assert.deepEqual(replay, original, curl);
  });

  test('PCL-27 PUT /chain/1 (307, 302) keeps its body on every step', async () => {
    const { original, replay, curl } = await replayMatches(
        (api) => api.put('/chain/1', { data: 'x', headers: { 'Content-Type': 'text/plain' } }),
    );
    assert.equal(original.length, 3);
    assert.deepEqual(replay, original, curl);
  });

  test('PCL-28 explicit Cookie and Authorization: the replay sends what Playwright sent', async () => {
    for (const target of ['/chain/1', '/xo/307', '/xo/302']) {
      const { original, replay, curl } = await replayMatches((api) => api.post(target, {
        data: { a: 1 },
        headers: { Cookie: 'sid=SECRET_C', Authorization: 'Bearer SECRET_A' },
      }));
      assert.ok(original.length >= 2, target);
      assert.deepEqual(replay, original, `${target}\n${curl}`);
      assert.doesNotMatch(curl, /SECRET_/);
    }
  });
});
