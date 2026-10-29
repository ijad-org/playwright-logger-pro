import { test, expect } from '../lib';
import type { BrowserLogEvent } from '../../src/browser';

const CANARY = 'PLP-CANARY-7f3a';
const dialogs = (events: readonly BrowserLogEvent[]) => events.filter((e) => e.kind === 'dialog');
const calls = (events: readonly BrowserLogEvent[]): string[] =>
  events.filter((e) => e.kind === 'action').map((e) => (e.kind === 'action' ? `${e.subject}.${e.method}(${e.args})` : ''));

test('an alert with no handler does not hang: auto-dismiss is intact', async ({ page, browserLogger }) => {
  await page.goto('/dialog');
  await page.click('#alert');
  await expect(page.locator('#o')).toHaveText('after alert');
  expect(dialogs(browserLogger.events())).toMatchObject([{ kind: 'dialog', dialogType: 'alert', message: 'hello alert' }]);
});

test('a prompt answered by the test: the answer is masked because the message is sensitive', async ({ page, browserLogger }) => {
  page.once('dialog', (d) => { void d.accept(CANARY); });
  await page.goto('/dialog');
  await page.click('#prompt');
  await expect(page.locator('#o')).toHaveText(CANARY);
  const events = browserLogger.events();
  expect(dialogs(events)).toMatchObject([{ dialogType: 'prompt', message: 'Your PIN?' }]);
  expect(calls(events)).toContain("dialog(prompt 'Your PIN?').accept(***)");
  expect(JSON.stringify(events)).not.toContain(CANARY);
});

test('a context-level handler still gets the dialog', async ({ page, context }) => {
  context.once('dialog', (d) => { void d.accept('from-context'); });
  await page.goto('/dialog');
  await page.click('#prompt');
  await expect(page.locator('#o')).toHaveText('from-context');
});

test('a handler added later wins over our default; after it is gone the default applies again', async ({ page }) => {
  await page.goto('/dialog');
  page.once('dialog', (d) => { void d.accept('first'); });
  await page.click('#prompt');
  await expect(page.locator('#o')).toHaveText('first');
  await page.click('#prompt'); // no handler now: dismissed -> prompt returns null
  await expect(page.locator('#o')).toHaveText('null');
});

test.describe('fillValues: always', () => {
  test.use({ browserLog: { redact: { fillValues: 'always' } } });
  test('every prompt answer is masked', async ({ page, browserLogger }) => {
    page.once('dialog', (d) => { void d.accept(CANARY); });
    await page.goto('/dialog');
    await page.click('#prompt');
    await expect(page.locator('#o')).toHaveText(CANARY);
    expect(JSON.stringify(browserLogger.events())).not.toContain(CANARY);
  });
});
