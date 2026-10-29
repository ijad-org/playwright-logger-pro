import * as path from 'node:path';
import { test, expect } from '../../lib';

// Built at run time so that Playwright's own source snippets never contain the value.
export const TYPED = ['typed', 'secret', '9c1e', 'x y'].join('-');

test.describe('PCL-30: a typed secret reaches no output the logger owns', () => {
  test.use({
    browserLog: {
      print: true, attach: true, attachFormat: 'text', file: true, fileFormat: 'jsonl',
      browserConsole: 'all', network: 'all', colors: false,
      fileDir: path.join(process.env.PLP_META_OUTPUT_DIR ?? '.', '..', 'plp-typed-files'),
    },
  });
  test('typed-only: the value is never registered as redact.values', async ({ page }) => {
    await page.goto('/echo');
    await page.locator('#password').fill(TYPED);
    await page.click('#send');
    await page.waitForTimeout(200);
    await page.locator('#nope').click({ timeout: 300 });
  });
});

test.describe('PCL-35: location points at the spec', () => {
  test.use({ browserLog: { location: true } });
  test('location: true', async ({ page }) => {
    await page.goto('/'); // LOC-MARK
    await page.locator('#nope').click({ timeout: 300 }); // LOC-MARK
  });
});

test.describe('PCL-37: a fill that completed is not reported as pending', () => {
  test.use({ browserLog: { redact: { inspectInputType: true } } });
  test('probe still running at test end', async ({ page }) => {
    await page.goto('/vanish');
    await page.locator('#gone').fill('plain-value');
    expect(1).toBe(2); // the test ends while the probe waits for the element that is gone
  });
});

test.describe('PCL-38: chronological order', () => {
  test.use({ browserLog: { print: true, colors: false } });
  test('order: dialog and close', async ({ page }) => {
    await page.goto('/dialog');
    await page.click('#alert');
    await expect(page.locator('#o')).toHaveText('after alert');
    await page.close();
    expect(1).toBe(2);
  });
});

test.describe('PCL-36: invalid options warn and fall back', () => {
  test.use({ browserLog: { maxEvents: 0, print: 'yes', bogus: 1 } as never });
  test('invalid options', async ({ page }) => {
    await page.goto('/');
    await page.locator('#nope').click({ timeout: 300 });
  });
});
