import { test, expect, lib } from '../lib';
import type { BrowserLogHandle } from '../lib';

const CANARY = 'PLP-CANARY-7f3a';

/** Everything the logger can hand out for this test. */
function everything(h: BrowserLogHandle): string {
  const events = h.events();
  return [
    JSON.stringify(events),
    h.render('text'),
    h.render('jsonl'),
    ...events.map((e) => lib.renderBrowserEventText(e)),
    ...events.map((e) => lib.renderBrowserEventJsonl(e)),
    ...events.map((e) => lib.renderBrowserEventText(e, { colors: true })),
  ].join('\n');
}

test.describe('default policy', () => {
  test('password-like targets are masked: #password, getByLabel, type=password', async ({ page, browserLogger }) => {
    await page.goto('/login');
    await page.locator('#password').fill(CANARY);
    await page.getByLabel('Password').fill(CANARY);
    await page.fill('input[type=password]', CANARY);
    await page.type('#password', CANARY);
    await page.locator('#password').pressSequentially?.(CANARY);
    await page.locator('#password').press('x');
    const out = everything(browserLogger);
    expect(out).not.toContain(CANARY);
    expect(out).toContain("locator('#password').fill(***)");
    expect(out).toContain('fill(***)');
    expect(out).toContain("page.fill('input[type=password]', ***)");
    expect(browserLogger.events().some((e) => e.kind === 'action' && e.redacted)).toBe(true);
  });

  test('keyboard input after focusing a password field is masked; ordinary fields stay readable', async ({ page, browserLogger }) => {
    await page.goto('/login');
    await page.locator('#email').fill('jo@example.com');
    await page.keyboard.type('plain-visible');
    await page.locator('#password').click();
    await page.keyboard.type(CANARY);
    await page.keyboard.press('Enter');
    await page.locator('#email').click();
    await page.keyboard.type('plain-visible-2');
    const out = everything(browserLogger);
    expect(out).not.toContain(CANARY);
    expect(out).toContain('plain-visible-2');
    expect(out).toContain("keyboard.press('Enter')");
    expect(out).toContain('keyboard.type(***)');
  });

  test('a navigation resets the keyboard focus state', async ({ page, browserLogger }) => {
    await page.goto('/login');
    await page.locator('#password').click();
    await page.goto('/');
    await page.keyboard.type('after-navigation');
    expect(everything(browserLogger)).toContain("keyboard.type('after-navigation')");
  });
});

test.describe('literal values and runtime secrets', () => {
  test.use({ browserLog: { redact: { values: [CANARY] } } });

  test('values are masked in URLs, headers, cookies, evaluate args and selectors', async ({ page, context, browserLogger }) => {
    await page.goto(`/api/ok?token=${CANARY}`);
    await page.setExtraHTTPHeaders({ 'X-Trace': 'visible-trace', Authorization: `Bearer ${CANARY}` });
    await context.addCookies([{ name: 'sid', value: CANARY, domain: '127.0.0.1', path: '/' }]);
    await page.goto('/');
    await page.evaluate((x: unknown) => x, { note: `value ${CANARY}`, password: 'zzzzzzzz' });
    await page.locator('#text').fill(`hello ${CANARY}`);
    await page.getByText(CANARY).count().catch(() => 0);
    const out = everything(browserLogger);
    expect(out).not.toContain(CANARY);
    expect(out).toContain('visible-trace');
    expect(out).not.toContain('zzzzzzzz');
    expect(out).toContain("token=***");
  });

  test('a secret learned at runtime (cookie value, auth header) is masked in later output', async ({ page, context, browserLogger }) => {
    const runtime = 'runtime-secret-9981';
    await page.goto('/');
    await context.addCookies([{ name: 'sid', value: runtime, domain: '127.0.0.1', path: '/' }]);
    await page.setExtraHTTPHeaders({ 'X-Api-Key': 'api-key-secret-4412' });
    browserLogger.note(`cookie is ${runtime} and key is api-key-secret-4412`);
    await page.locator('#text').fill(`typed ${runtime}`);
    const out = everything(browserLogger);
    expect(out).not.toContain(runtime);
    expect(out).not.toContain('api-key-secret-4412');
    expect(out).toContain('typed ***');
  });
});

test.describe('known limitation and its mitigations', () => {
  const VALUE = 'visible-by-design-1';

  test('an unlabelled password field is NOT detected by default', async ({ page, browserLogger }) => {
    await page.goto('/login');
    await page.locator('#field7').fill(VALUE);
    expect(everything(browserLogger)).toContain(VALUE);
  });

  test.describe('inspectInputType', () => {
    test.use({ browserLog: { redact: { inspectInputType: true } } });

    test('the DOM probe masks type=password fields and is itself not logged', async ({ page, browserLogger }) => {
      await page.goto('/login');
      await page.locator('#field7').fill(CANARY);
      await page.keyboard.type(CANARY); // focus is on the probed password field
      await page.locator('#nick').fill('plain-nick');
      await page.locator('#nick').fill('plain-nick-2'); // cached: no second probe, stays readable
      // A probed fill is recorded once the probe has answered (one round trip later).
      await expect.poll(() => browserLogger.events().filter((e) => e.kind === 'action' && e.method === 'fill').length).toBe(3);
      const events = browserLogger.events();
      const out = everything(browserLogger);
      expect(out).not.toContain(CANARY);
      expect(out).toContain('plain-nick-2');
      expect(events.filter((e) => e.kind === 'action' && e.method === 'evaluate')).toEqual([]);
      expect(events.filter((e) => e.kind === 'action').length).toBe(5);
    });

    test('fails closed: a failing fill is masked', async ({ page, browserLogger }) => {
      await page.goto('/login');
      await page.fill('#does-not-exist', CANARY, { timeout: 300 }).catch(() => undefined);
      const out = everything(browserLogger);
      expect(out).not.toContain(CANARY);
      expect(out).toContain("page.fill('#does-not-exist', ***");
    });
  });

  test.describe('fillValues: always', () => {
    test.use({ browserLog: { redact: { fillValues: 'always' } } });
    test('every typed value is masked', async ({ page, browserLogger }) => {
      await page.goto('/login');
      await page.locator('#field7').fill(CANARY);
      await page.locator('#nick').fill(CANARY);
      expect(everything(browserLogger)).not.toContain(CANARY);
    });
  });

  test.describe('custom selectors', () => {
    test.use({ browserLog: { redact: { selectors: [...lib.DEFAULT_SENSITIVE_SELECTORS, '#field7'] } } });
    test('extending the default list masks the extra field', async ({ page, browserLogger }) => {
      await page.goto('/login');
      await page.locator('#field7').fill(CANARY);
      await page.locator('#password').fill(CANARY);
      expect(everything(browserLogger)).not.toContain(CANARY);
    });
  });
});
