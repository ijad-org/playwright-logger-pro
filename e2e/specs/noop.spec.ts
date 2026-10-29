import { test, expect } from '../lib';

const PATCHED = Symbol.for('playwright-logger-pro/patched');
const patched = (proto: object, name: string): boolean => {
  const fn = (proto as Record<string, unknown>)[name];
  return typeof fn === 'function' && Object.prototype.hasOwnProperty.call(fn, PATCHED);
};

test('enabled:false -> nothing installed, nothing recorded, nothing attached', async ({ page, browserLogger }, testInfo) => {
  await page.goto('/');
  await page.locator('#text').fill('x');
  await expect(page.locator('#text')).toHaveValue('x');

  const protos: Array<[string, object, string]> = [
    ['page', Object.getPrototypeOf(page), 'click'],
    ['frame', Object.getPrototypeOf(page.mainFrame()), 'click'],
    ['locator', Object.getPrototypeOf(page.locator('html')), 'click'],
    ['keyboard', Object.getPrototypeOf(page.keyboard), 'press'],
    ['mouse', Object.getPrototypeOf(page.mouse), 'click'],
    ['context', Object.getPrototypeOf(page.context()), 'newPage'],
  ];
  for (const [label, proto, name] of protos) expect(patched(proto, name), label).toBe(false);

  expect(browserLogger.events()).toEqual([]);
  expect(browserLogger.render()).toBe('');
  expect([...testInfo.attachments]).toEqual([]);
});
