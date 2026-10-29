/* eslint-disable @typescript-eslint/no-require-imports */
import { test, expect, lib, mergeTests } from '../lib';
import type { BrowserLogEvent } from '../../src/browser';

type Step = Extract<BrowserLogEvent, { kind: 'step' }>;
const steps = (events: readonly BrowserLogEvent[]): string[] =>
  events.filter((e): e is Step => e.kind === 'step').map((e) => `${e.phase}:${e.title}:${(e.step ?? []).join('>')}`);
const actionPaths = (events: readonly BrowserLogEvent[]): string[] =>
  events.filter((e) => e.kind === 'action').map((e) => (e.kind === 'action' ? `${e.method}@${(e.step ?? []).join('>')}` : ''));

const STEPS = (() => {
  const [maj, min] = String((require('@playwright/test/package.json') as { version: string }).version).split('.').map(Number);
  return maj > 1 || min >= 48;
})();
test.skip(!STEPS, 'test.step integration needs Playwright 1.48+');

test('step markers and the step path on actions', async ({ page, browserLogger }) => {
  const value = await test.step('Log in', async () => {
    await page.goto('/login');
    await test.step('Fill the form', async () => {
      await page.locator('#email').fill('jo@example.com');
    });
    await page.locator('#nick').fill('joe');
    return 42;
  });
  expect(value).toBe(42);
  await page.goto('/');

  const events = browserLogger.events();
  expect(steps(events)).toEqual([
    'start:Log in:',
    'start:Fill the form:Log in',
    'end:Fill the form:Log in',
    'end:Log in:',
  ]);
  expect(actionPaths(events)).toEqual(['goto@Log in', 'fill@Log in>Fill the form', 'fill@Log in', 'goto@']);
  const end = events.find((e): e is Step => e.kind === 'step' && e.phase === 'end' && e.title === 'Log in');
  expect(end?.status).toBe('passed');
  expect(typeof end?.durationMs).toBe('number');
  expect(browserLogger.render('text')).toMatch(/│ ✓ locator\('#email'\)\.fill/);
});

test('a failing step is recorded as failed and the error still propagates', async ({ page, browserLogger }) => {
  await page.goto('/');
  await expect(test.step('Explode', async () => {
    await page.locator('#go').click();
    throw new Error('step failure');
  })).rejects.toThrow('step failure');
  const end = browserLogger.events().find((e): e is Step => e.kind === 'step' && e.phase === 'end');
  expect(end?.status).toBe('failed');
  test.info().annotations.push({ type: 'expected', description: 'a failed step inside expect().rejects' });
});

test('steps keep working with test.extend and mergeTests', async ({ page, browserLogger }) => {
  // eslint-disable-next-line no-empty-pattern
  const extended = test.extend<{ marker: string }>({ marker: async ({}, use) => { await use('m'); } });
  expect(typeof extended.step).toBe('function');
  expect(extended.step).not.toBe(test.step);
  void browserLogger;
  void page;
  // mergeTests exists from Playwright 1.39.
  if (mergeTests && typeof (require('@playwright/test') as { mergeTests?: unknown }).mergeTests === 'function') {
    const merged = mergeTests(test, extended);
    expect(typeof merged.step).toBe('function');
  }
});

test.describe('steps: false', () => {
  test.use({ browserLog: { steps: false } });
  test('no step events and no step path', async ({ page, browserLogger }) => {
    await test.step('Quiet', async () => {
      await page.goto('/');
    });
    const events = browserLogger.events();
    expect(steps(events)).toEqual([]);
    expect(actionPaths(events)).toEqual(['goto@']);
  });
});

test('test.step static members survive (step.skip where Playwright has it)', async () => {
  const skip = (test.step as unknown as { skip?: unknown }).skip;
  if (skip !== undefined) expect(typeof skip).toBe('function');
  expect(lib).toBeTruthy();
});
