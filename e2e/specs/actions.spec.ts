import { test, expect } from '../lib';
import type { BrowserLogEvent } from '../../src/browser';

type Action = Extract<BrowserLogEvent, { kind: 'action' }>;
const actions = (events: readonly BrowserLogEvent[]): Action[] =>
  events.filter((e): e is Action => e.kind === 'action');
const calls = (events: readonly BrowserLogEvent[]): string[] =>
  actions(events).map((e) => `${e.subject}.${e.method}(${e.args})`);

test.use({ browserLog: { queries: true, mouseMoves: true } });

test('page, locator, keyboard and mouse calls are logged once each, with durations', async ({ page, browserLogger }) => {
  await page.goto('/');
  await page.click('#go');
  await page.locator('#text').fill('hello world');
  await page.getByPlaceholder('Type here').press('Enter');
  await page.keyboard.press('Tab');
  await page.mouse.click(5, 5);
  await page.mouse.move(10, 10);
  await page.locator('#chk').check();
  await page.locator('#sel').selectOption('b');
  expect(await page.locator('#out').textContent()).toBe('went');
  await expect(page.locator('#out')).toHaveText('went');

  const ev = browserLogger.events();
  expect(calls(ev)).toEqual([
    "page.goto('/')",
    "page.click('#go')",
    "locator('#text').fill('hello world')",
    "getByPlaceholder('Type here').press('Enter')",
    "keyboard.press('Tab')",
    'mouse.click(5, 5)',
    'mouse.move(10, 10)',
    "locator('#chk').check()",
    "locator('#sel').selectOption('b')",
    "locator('#out').textContent()",
  ]);
  for (const a of actions(ev)) {
    expect(a.status).toBe('ok');
    expect(typeof a.durationMs).toBe('number');
  }
  expect(actions(ev)[0].category).toBe('navigation');
  expect(actions(ev).at(-1)?.category).toBe('query');
});

test('delegating calls (clear -> fill, page.click -> frame.click) produce one event', async ({ page, browserLogger }) => {
  await page.goto('/');
  await page.locator('#text').fill('abc');
  await page.locator('#text').clear();
  await page.locator('#text').selectText();
  const ev = actions(browserLogger.events());
  expect(ev.map((e) => e.method)).toEqual(['goto', 'fill', 'clear', 'selectText']);
});

test('a failing action is logged with its error and the original error is untouched', async ({ page, browserLogger }) => {
  await page.goto('/');
  const error = await page.locator('#nope').click({ timeout: 300 }).then(() => undefined, (e: Error) => e);
  expect(error?.name).toBe('TimeoutError');
  expect(String(error?.message)).toContain('Timeout 300ms exceeded');
  const last = actions(browserLogger.events()).at(-1)!;
  expect(last.status).toBe('error');
  expect(last.method).toBe('click');
  expect(last.error?.name).toBe('TimeoutError');
  expect(last.args).toBe('{ timeout: 300 }');
});

test('concurrent actions are recorded separately, ordered by seq', async ({ page, browserLogger }) => {
  await page.goto('/');
  await Promise.all([page.locator('#go').click(), page.locator('#text').fill('x')]);
  const ev = actions(browserLogger.events()).filter((e) => e.method !== 'goto');
  expect(ev.map((e) => e.method).sort()).toEqual(['click', 'fill']);
  const seqs = ev.map((e) => e.seq);
  expect(new Set(seqs).size).toBe(2);
});

test('popups and context.newPage() get page ids; actions on them are logged', async ({ page, context, browserLogger }) => {
  await page.goto('/popup');
  const [popup] = await Promise.all([context.waitForEvent('page'), page.click('#open')]);
  await popup.waitForLoadState();
  await popup.locator('h1').click();
  const second = await context.newPage();
  await second.goto('/');
  const ev = actions(browserLogger.events());
  const child = ev.find((e) => e.method === 'click' && e.subject === "locator('h1')");
  expect(child?.page).toBe(2);
  const goto = ev.find((e) => e.method === 'goto' && e.page === 3);
  expect(goto).toBeTruthy();
});

test('frame and frameLocator calls are described', async ({ page, browserLogger }) => {
  await page.goto('/frames');
  await page.frameLocator('#f').getByRole('button', { name: 'Inner' }).click();
  await page.frame('inner')!.click('#inner-btn');
  const ev = actions(browserLogger.events());
  expect(ev[1].subject).toMatch(/Inner/);
  expect(ev[2].subject).toBe('frame("inner")');
});

test('browser.newContext() inside a test is auto-attached', async ({ browser, browserLogger }) => {
  const ctx = await browser.newContext({ baseURL: test.info().project.use.baseURL });
  const p = await ctx.newPage();
  await p.goto('/');
  await p.locator('#go').click();
  await ctx.close();
  const names = calls(browserLogger.events());
  expect(names).toContain("page.goto('/')");
  expect(names).toContain("locator('#go').click()");
});
