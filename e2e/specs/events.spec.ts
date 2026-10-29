import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { test, expect } from '../lib';
import type { BrowserLogEvent } from '../../src/browser';

type Kind<K extends BrowserLogEvent['kind']> = Extract<BrowserLogEvent, { kind: K }>;
const ofKind = <K extends BrowserLogEvent['kind']>(events: readonly BrowserLogEvent[], kind: K): Array<Kind<K>> =>
  events.filter((e): e is Kind<K> => e.kind === kind);

test.describe('navigation', () => {
  test('link clicks and SPA navigations are logged; the goto it caused is not repeated; duplicates are dropped', async ({ page, browserLogger }) => {
    await page.goto('/');
    await page.click('#to-login');
    await page.waitForURL('**/login');
    await page.evaluate(() => history.pushState({}, '', '/hash'));
    await page.evaluate(() => history.pushState({}, '', '/hash'));
    const urls = ofKind(browserLogger.events(), 'navigation').map((e) => new URL(e.url).pathname);
    expect(urls).toEqual(['/login', '/hash']);
  });

  test.describe('navigation: false', () => {
    test.use({ browserLog: { navigation: false } });
    test('no navigation or page lifecycle lines (the goto action itself is still an action)', async ({ page, context, browserLogger }) => {
      await page.goto('/');
      await page.click('#to-login');
      const extra = await context.newPage();
      await extra.close();
      const events = browserLogger.events();
      expect(ofKind(events, 'navigation')).toEqual([]);
      expect(ofKind(events, 'page')).toEqual([]);
      expect(ofKind(events, 'action').some((a) => a.method === 'goto')).toBe(true);
    });
  });
});

test.describe('console and page errors', () => {
  test('default level is warning: warnings and errors only, with source location', async ({ page, browserLogger }) => {
    await page.goto('/console');
    await expect.poll(() => ofKind(browserLogger.events(), 'pageerror').length).toBe(1);
    const consoles = ofKind(browserLogger.events(), 'console');
    expect(consoles.map((c) => `${c.level}:${c.text}`)).toEqual(['warning:warn msg', 'error:error msg']);
    expect(consoles[0].location).toMatch(/^console:\d+$/);
    const err = ofKind(browserLogger.events(), 'pageerror')[0];
    expect(err.message).toContain('boom from page');
    expect(err.stack).toMatch(/at /);
  });

  test.describe('all levels', () => {
    test.use({ browserLog: { browserConsole: 'all' } });
    test('log, info, warning and error are recorded', async ({ page, browserLogger }) => {
      await page.goto('/console');
      const levels = ofKind(browserLogger.events(), 'console').map((c) => c.level);
      expect(levels).toEqual(['log', 'info', 'warning', 'error']);
    });
  });

  test.describe('error only, no page errors', () => {
    test.use({ browserLog: { browserConsole: 'error', pageErrors: false } });
    test('thresholds and switches are honoured', async ({ page, browserLogger }) => {
      await page.goto('/console');
      await page.waitForTimeout(150);
      expect(ofKind(browserLogger.events(), 'console').map((c) => c.level)).toEqual(['error']);
      expect(ofKind(browserLogger.events(), 'pageerror')).toEqual([]);
    });
  });

  test.describe('console off', () => {
    test.use({ browserLog: { browserConsole: false } });
    test('nothing is recorded', async ({ page, browserLogger }) => {
      await page.goto('/console');
      expect(ofKind(browserLogger.events(), 'console')).toEqual([]);
    });
  });

  test.describe('secrets in page output', () => {
    test.use({ browserLog: { browserConsole: 'all', redact: { values: ['PLP-CANARY-7f3a'] } } });
    test('console text and page errors are scrubbed', async ({ page, browserLogger }) => {
      await page.goto('/');
      await page.evaluate(() => {
        console.log('token=PLP-CANARY-7f3a');
        setTimeout(() => { throw new Error('bad PLP-CANARY-7f3a'); }, 0);
      });
      await expect.poll(() => ofKind(browserLogger.events(), 'pageerror').length).toBe(1);
      expect(JSON.stringify(browserLogger.events())).not.toContain('PLP-CANARY-7f3a');
      expect(ofKind(browserLogger.events(), 'console')[0].text).toBe('token=***');
    });
  });
});

test.describe('pages', () => {
  test('opened, popup (with opener) and closed lines', async ({ page, context, browserLogger }) => {
    await page.goto('/popup');
    const [popup] = await Promise.all([context.waitForEvent('page'), page.click('#open')]);
    await popup.waitForLoadState();
    const extra = await context.newPage();
    await extra.close();
    await popup.close();
    await expect.poll(() => ofKind(browserLogger.events(), 'page').length).toBeGreaterThanOrEqual(5);
    const pages = ofKind(browserLogger.events(), 'page').map((e) => `${e.event}#${e.page}${e.opener ? `<-${e.opener}` : ''}`);
    expect(pages).toEqual(['opened#1', 'popup#2<-1', 'opened#3', 'closed#3', 'closed#2']);
  });
});

test.describe('downloads', () => {
  test('download event and saveAs are logged', async ({ page, browserLogger }, testInfo) => {
    await page.goto('/download');
    const [download] = await Promise.all([page.waitForEvent('download'), page.click('#dl')]);
    const target = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'plp-dl-')), 'copy.txt');
    await download.saveAs(target);
    const events = browserLogger.events();
    const dl = ofKind(events, 'download')[0];
    expect(dl.suggestedFilename).toBe('report.txt');
    expect(dl.url).toMatch(/\/file\.txt$/);
    const save = ofKind(events, 'action').find((a) => a.method === 'saveAs');
    expect(save?.subject).toBe("download('report.txt')");
    expect(testInfo.errors).toEqual([]);
  });
});

test.describe('network', () => {
  const submit = async (page: import('@playwright/test').Page): Promise<void> => {
    await page.goto('/login');
    await page.getByRole('button', { name: 'Sign in' }).click();
    await expect(page.locator('#result')).toHaveText('status 401');
  };

  test('off by default', async ({ page, browserLogger }) => {
    await submit(page);
    expect(ofKind(browserLogger.events(), 'network')).toEqual([]);
  });

  test.describe('failed', () => {
    test.use({ browserLog: { network: 'failed' } });
    test('only failures: status >= 400', async ({ page, browserLogger }) => {
      await submit(page);
      const net = ofKind(browserLogger.events(), 'network');
      expect(net.map((n) => `${n.method} ${new URL(n.url).pathname} ${n.status}`)).toEqual(['POST /api/session 401']);
      expect(typeof net[0].durationMs).toBe('number');
    });
  });

  test.describe('documents', () => {
    test.use({ browserLog: { network: 'documents' } });
    test('documents and fetch/xhr', async ({ page, browserLogger }) => {
      await submit(page);
      const net = ofKind(browserLogger.events(), 'network').map((n) => `${n.resourceType} ${new URL(n.url).pathname}`);
      expect(net).toEqual(['document /login', 'fetch /api/session']);
    });
  });

  test.describe('all + filter', () => {
    test.use({ browserLog: { network: 'all', networkFilter: (r) => !r.url.includes('favicon') && r.method === 'POST' } });
    test('networkFilter narrows the selection', async ({ page, browserLogger }) => {
      await submit(page);
      const net = ofKind(browserLogger.events(), 'network').map((n) => `${n.method} ${new URL(n.url).pathname}`);
      expect(net).toEqual(['POST /api/session']);
    });
  });

  test.describe('request failures', () => {
    test.use({ browserLog: { network: 'failed' } });
    test('aborted requests are recorded with the failure text', async ({ page, browserLogger }) => {
      await page.route('**/api/ok', (route) => route.abort('connectionrefused'));
      await page.goto('/');
      await page.evaluate(() => fetch('/api/ok').catch(() => undefined));
      await expect.poll(() => ofKind(browserLogger.events(), 'network').length).toBe(1);
      expect(ofKind(browserLogger.events(), 'network')[0].failure).toMatch(/refused/i);
    });
  });
});
