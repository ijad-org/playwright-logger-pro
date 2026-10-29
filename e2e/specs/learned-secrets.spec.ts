import { test, expect, lib } from '../lib';
import type { BrowserLogHandle } from '../lib';
import type { BrowserLogEvent } from '../../src/browser';

// Built at run time: the canaries must not appear in Playwright's own source snippets.
const PW = ['hunt', 'er2-', 'Zq9!', 'x&y=1'].join('');
const CARD = ['4111', '1111', '1111', '1111'].join('');
const PIN = ['pin', '-', '48151623'].join('');
const NICK = ['plain', 'nick', '77'].join('-');

/** Everything the logger can hand out for this test. */
function everything(h: BrowserLogHandle): string {
  const events = h.events();
  return [
    JSON.stringify(events),
    h.render('text'),
    h.render('jsonl'),
    ...events.map((e) => lib.renderBrowserEventText(e)),
    ...events.map((e) => lib.renderBrowserEventJsonl(e)),
  ].join('\n');
}

const kinds = (events: readonly BrowserLogEvent[], kind: string): BrowserLogEvent[] => events.filter((e) => e.kind === kind);

test.describe('PCL-30: typed secrets are learned for the rest of the test', () => {
  test.use({ browserLog: { network: 'all', browserConsole: 'all' } });

  test('what the page echoes of a masked value is masked: console, page error, network URL, navigation', async ({ page, browserLogger }) => {
    await page.goto('/echo');
    await page.locator('#password').fill(PW);
    await page.getByLabel('Card').fill(CARD);
    await page.locator('#nick').fill(NICK);
    await page.click('#send');
    await expect.poll(() => kinds(browserLogger.events(), 'pageerror').length).toBe(1);
    await expect.poll(() => kinds(browserLogger.events(), 'navigation').length).toBeGreaterThan(0);

    const out = everything(browserLogger);
    expect(out).not.toContain(PW);
    expect(out).not.toContain(encodeURIComponent(PW));
    expect(out).not.toContain(CARD);
    // The page really did echo them, so the checks above mean something.
    const events = browserLogger.events();
    expect(kinds(events, 'console').map((e) => (e.kind === 'console' ? e.text : ''))).toEqual(
        expect.arrayContaining(['debug password=***', 'card=***']));
    expect(events.some((e) => e.kind === 'network' && e.url.includes('/api/ok?token=***'))).toBe(true);
    expect(events.some((e) => e.kind === 'navigation' && e.url.endsWith('/echo?session=***'))).toBe(true);
    expect(events.some((e) => e.kind === 'pageerror' && e.message === 'boom ***')).toBe(true);
    // An ordinary field is not learned: its echo stays readable.
    expect(out).toContain(`nick=${NICK}`);
    expect(out).toContain(`n=${NICK}`);
  });

  test('a prompt answer typed into a sensitive dialog is masked where the page echoes it', async ({ page, browserLogger }) => {
    page.once('dialog', (d) => { void d.accept(PIN); });
    await page.goto('/echo');
    await page.click('#ask');
    await expect(page.locator('#o')).toHaveText(PIN);
    await expect.poll(() => kinds(browserLogger.events(), 'console').length).toBe(1);
    const out = everything(browserLogger);
    expect(out).not.toContain(PIN);
    expect(out).toContain('prompt answer ***');
  });

  test('keyboard.type into a focused password field is learned too', async ({ page, browserLogger }) => {
    await page.goto('/echo');
    await page.locator('#password').click();
    await page.keyboard.type(PW);
    await page.click('#send');
    await expect.poll(() => kinds(browserLogger.events(), 'console').length).toBeGreaterThan(1);
    expect(everything(browserLogger)).not.toContain(PW);
  });

  test('short typed values are not learned (they would shred ordinary text)', async ({ page, browserLogger }) => {
    await page.goto('/echo');
    await page.locator('#password').fill('abc');
    await page.click('#send');
    await expect.poll(() => kinds(browserLogger.events(), 'console').length).toBeGreaterThan(1);
    expect(everything(browserLogger)).toContain('debug password=abc');
  });
});

test.describe('PCL-30: the action line need not be logged for the value to be learned', () => {
  test.use({ browserLog: { actions: false, browserConsole: 'all' } });
  test('actions: false still masks the echo', async ({ page, browserLogger }) => {
    await page.goto('/echo');
    await page.locator('#password').fill(PW);
    await page.click('#send');
    await expect.poll(() => kinds(browserLogger.events(), 'console').length).toBeGreaterThan(1);
    expect(browserLogger.events().filter((e) => e.kind === 'action' && e.method === 'fill')).toEqual([]);
    expect(everything(browserLogger)).not.toContain(PW);
  });
});

test.describe('PCL-30: inspectInputType decides provisionally learned values', () => {
  test.use({ browserLog: { browserConsole: 'all', redact: { inspectInputType: true } } });
  test('a value typed into a probed password field is learned; an ordinary one is not', async ({ page, browserLogger }) => {
    await page.goto('/login');
    await page.locator('#field7').fill(PW);
    await page.locator('#nick').fill(NICK);
    await expect.poll(() => browserLogger.events().filter((e) => e.kind === 'action' && e.method === 'fill').length).toBe(2);
    await page.evaluate(([a, b]) => { console.error(`pw=${a} nick=${b}`); }, [PW, NICK]);
    await expect.poll(() => kinds(browserLogger.events(), 'console').length).toBe(1);
    const out = everything(browserLogger);
    expect(out).toContain(`nick=${NICK}`);
    expect(out).toContain('pw=***');
    expect(out).not.toContain(PW);
  });
});

test.describe('PCL-31: card fields are recognised from what the selector shows', () => {
  test('#card, getByLabel("Card") and [name=cardnumber] are masked with the default config', async ({ page, browserLogger }) => {
    await page.goto('/echo');
    await page.locator('#card').fill(CARD);
    await page.getByLabel('Card').fill(CARD + '1');
    await page.fill('input[name="cardnumber"]', CARD + '2');
    const out = everything(browserLogger);
    expect(out).not.toContain(CARD);
    expect(out).toContain("locator('#card').fill(***)");
    expect(out).toContain("getByLabel('Card').fill(***)");
    expect(out).toContain("page.fill('input[name=\"cardnumber\"]', ***)");
  });
});
