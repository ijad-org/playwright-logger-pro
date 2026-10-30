import * as path from 'node:path';
import { test, expect } from '../../lib';

const CANARY = 'PLP-CANARY-7f3a';

test('default: failing test', async ({ page }) => {
  await page.goto('/login');
  await page.getByLabel('Email').fill('jo@example.com');
  await page.locator('#nope').click({ timeout: 300 });
});

test('default: passing test', async ({ page }) => {
  await page.goto('/login');
  await page.getByLabel('Email').fill('jo@example.com');
});

test('default: expected failure', async ({ page }) => {
  test.fail();
  await page.goto('/login');
  await page.locator('#nope').click({ timeout: 300 });
});

test('default: expected failure that passes unexpectedly', async ({ page }) => {
  test.fail();
  await page.goto('/login');
});

test('default: skipped in the body', async ({ page }) => {
  await page.goto('/login');
  test.skip(true, 'skip me');
});

test('default: api and browser together', async ({ page, request }) => {
  await page.goto('/');
  await request.get('/api/ok?x=1');
  await page.locator('#nope').click({ timeout: 300 });
});

test.describe('timeout', () => {
  test('hangs: action never settles', async ({ page }) => {
    test.setTimeout(1800);
    await page.goto('/');
    await page.locator('#never-appears').click();
  });
});

test.describe('print: true', () => {
  test.use({ browserLog: { print: true, colors: false } });
  test('live: passing', async ({ page }) => {
    await page.goto('/login');
    await page.locator('#email').fill('jo@example.com');
  });
});

test.describe('everything on, jsonl file in fileDir', () => {
  test.use({
    browserLog: {
      print: true, colors: false, attach: true, attachFormat: 'jsonl', file: true, fileFormat: 'jsonl',
      fileDir: path.join(process.env.PLP_META_OUTPUT_DIR ?? '.', '..', 'plp-files'),
    },
  });
  test('files: passing', async ({ page }) => {
    await page.goto('/login');
    await page.locator('#email').fill('jo@example.com');
  });
});

test.describe('file: true in outputPath', () => {
  test.use({ browserLog: { file: true, attach: false, print: false } });
  test('file default location', async ({ page }) => {
    await page.goto('/login');
  });
});

test.describe('disabled', () => {
  test.use({ browserLog: { enabled: false } });
  test('disabled: failing test', async ({ page }) => {
    await page.goto('/login');
    await page.locator('#nope').click({ timeout: 300 });
  });
});

test.describe('quiet reader', () => {
  test('no browser used: api-only test', async ({ request }) => {
    const res = await request.get('/api/ok');
    expect(res.status()).toBe(500);
  });
});

test.describe('canary', () => {
  test.use({
    browserLog: {
      print: true, attach: true, file: true, fileFormat: 'jsonl', browserConsole: 'all', network: 'all',
      redact: { values: [CANARY] },
      fileDir: path.join(process.env.PLP_META_OUTPUT_DIR ?? '.', '..', 'plp-canary-files'),
    },
  });
  test('canary: secrets everywhere', async ({ page, context, request, browserLogger }) => {
    await page.goto(`/api/ok?token=${CANARY}`);
    await context.addCookies([{ name: 'sid', value: CANARY, domain: '127.0.0.1', path: '/' }]);
    await page.setExtraHTTPHeaders({ Authorization: `Bearer ${CANARY}` });
    await page.goto('/login');
    await page.locator('#password').fill(CANARY);
    await page.getByLabel('Password').fill(CANARY);
    await page.locator('#password').click();
    await page.keyboard.type(CANARY);
    await page.evaluate((s: string) => { console.log(`log ${s}`); console.error(`err ${s}`); }, CANARY);
    await page.evaluate((s: string) => { setTimeout(() => { throw new Error(`page error ${s}`); }, 0); }, CANARY);
    await page.waitForTimeout(100);
    browserLogger.note(`note ${CANARY}`);
    await request.get(`/api/ok?token=${CANARY}`, { headers: { Authorization: `Bearer ${CANARY}` } });
    await test.step(`step ${CANARY}`, async () => {
      await page.locator('#nope').fill(CANARY, { timeout: 300 });
    });
  });
});

test.describe('steps', () => {
  test('steps: failing inside a step', async ({ page }) => {
    await test.step('Open the login page', async () => {
      await page.goto('/login');
    });
    await test.step('Submit', async () => {
      await page.locator('#nope').click({ timeout: 300 });
    });
  });
});

export { CANARY };
