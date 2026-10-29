import { after, before, describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';
import { request, type APIRequestContext } from '@playwright/test';
import { buildCurl } from '../src/curl';
import { formatRequestLine } from '../src/format';
import { detectColorSupport, resolveConfig } from '../src/types';
import { wrapRequestContext } from '../src/wrapRequestContext';

const execFileAsync = promisify(execFile);
const ANSI = /\u001b\[/;

interface Received {
  method: string;
  url: string;
  contentType: string;
  body: string;
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
    });
    if (req.url?.startsWith('/redirect')) {
      res.writeHead(302, { location: '/echo?redirected=1' });
      res.end();
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
