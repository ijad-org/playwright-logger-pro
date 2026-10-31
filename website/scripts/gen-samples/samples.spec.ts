// Produces the coloured output shown in the docs, from the real library.
// Run: node website/scripts/gen-doc-samples.mjs (needs the repository's dependencies and Chromium).
import * as fs from 'node:fs';
import * as http from 'node:http';
import * as path from 'node:path';
import { test, expect } from '../../../src/fixtures';

const OUT = process.env.PLP_SAMPLES_OUT!;
// The curl command is coloured since 0.3.0; `colors: true` asks for it even though stdout is a pipe here.
// The palette depth (256 colours) is detected from COLORTERM/TERM, which ../gen-doc-samples.mjs sets.
const curlFormat = { colors: true };
const sinkTo = (name: string) => (line: string) => fs.appendFileSync(path.join(OUT, `${name}.ansi`), `${line}\n`);

let server: http.Server;
test.beforeAll(async () => {
  fs.mkdirSync(OUT, { recursive: true });
  server = http.createServer((req, res) => {
    const url = new URL(req.url ?? '/', 'http://x');
    const json = (status: number, body: unknown) => {
      res.writeHead(status, { 'content-type': 'application/json' });
      res.end(JSON.stringify(body));
    };
    if (req.method === 'POST' && url.pathname === '/vegetables') return json(201, { id: 7, msg: 'Successfully added: Orange' });
    if (url.pathname === '/vegetables/99') return json(404, { error: 'Vegetable 99 not found' });
    if (url.pathname === '/vegetables') return json(200, [{ id: 1, name: 'Carrot' }]);
    if (req.method === 'POST' && url.pathname === '/api/session') return json(401, { error: 'invalid credentials' });
    if (url.pathname === '/login') {
      res.writeHead(200, { 'content-type': 'text/html' });
      return void res.end(`<!doctype html><title>Login</title><h1>Sign in</h1>
        <label>Email <input id="email" type="text"></label>
        <label>Password <input id="password" type="password"></label>
        <button id="submit">Sign in</button><div id="msg"></div>
        <script>document.getElementById('submit').onclick = async () => {
          const r = await fetch('/api/session', { method: 'POST' });
          document.getElementById('msg').textContent = r.ok ? 'Welcome' : 'Invalid email or password';
        };</script>`);
    }
    res.writeHead(404); res.end();
  });
  await new Promise<void>((resolve) => server.listen(4399, '127.0.0.1', resolve));
});
test.afterAll(() => server.close());

test.describe('api-post', () => {
  test.use({ apiLog: { colors: true, curl: true, curlFormat, sink: sinkTo('api-post') } });
  test('create', async ({ request }) => {
    const res = await request.post('/vegetables', { data: { name: 'Orange', price: 1 } });
    expect(res.status()).toBe(201);
  });
});

test.describe('api-failure', () => {
  test.use({ apiLog: { colors: true, curl: 'on-failure', curlFormat, logHeaders: false, sink: sinkTo('api-failure') } });
  test('missing', async ({ request }) => {
    const res = await request.get('/vegetables/99');
    expect(res.status()).toBe(404);
  });
});

test.describe('api-refused', () => {
  test.use({ apiLog: { colors: true, curl: 'on-failure', curlFormat, sink: sinkTo('api-refused') } });
  test('connection refused', async ({ request }) => {
    await expect(request.get('http://127.0.0.1:9/health', { timeout: 3000 })).rejects.toThrow();
  });
});

test.describe('api-redaction', () => {
  test.use({ apiLog: { colors: true, curl: true, curlFormat, sink: sinkTo('api-redaction'), redactBodyKeys: ['password'] } });
  test('login', async ({ request }) => {
    await request.post('/api/session?api_key=sk_live_123&q=shoes', {
      headers: { Authorization: 'Bearer eyJhbGciOiJIUzI1NiJ9.demo' },
      data: { user: 'jo', password: 'hunter2hunter2' },
    });
  });
});

// This test fails on purpose: the failure block is what the sample shows.
test.describe('browser-failure', () => {
  test.use({ browserLog: { colors: true, sink: sinkTo('browser-failure') } });
  test('rejects a wrong password', async ({ page }) => {
    await page.goto('/login');
    await test.step('Log in', async () => {
      await page.getByLabel('Email').fill('jo@example.com');
      await page.getByLabel('Password').fill('correct-horse-battery');
      await page.getByRole('button', { name: 'Sign in' }).click();
    });
    await page.locator('.toast-success').click({ timeout: 1500 });
  });
});

test.describe('browser-live', () => {
  test.use({ browserLog: { colors: true, print: true, network: 'failed', sink: sinkTo('browser-live') } });
  test('live timeline', async ({ page, browserLogger }) => {
    browserLogger.note('seeded user 42');
    await page.goto('/login');
    await page.getByLabel('Password').fill('correct-horse-battery');
    await page.getByRole('button', { name: 'Sign in' }).click();
    await expect(page.locator('#msg')).toHaveText('Invalid email or password');
  });
});
