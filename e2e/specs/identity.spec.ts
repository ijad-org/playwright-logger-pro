import { test, expect } from '../lib';

test('object identity, expect() and instanceof are unchanged', async ({ page, context }) => {
  await page.goto('/');
  expect(page).toBe(context.pages()[0]);
  expect(page.context()).toBe(context);
  expect(page.mainFrame().page()).toBe(page);

  const loc = page.locator('#go');
  expect(loc.page()).toBe(page);
  await expect(loc).toBeVisible();
  await expect(page.locator('#out')).toBeEmpty();
  await expect(page).toHaveTitle('Home');
  await loc.click();
  await expect(page.locator('#out')).toHaveText('went');

  expect(Object.getPrototypeOf(page).constructor.name).toMatch(/^_?Page$/);
  expect(loc.constructor.name).toMatch(/^_?Locator$/);
  expect(typeof page.click).toBe('function');
  expect(page.click.name).toBe('click');
});

test('the original promise is returned and errors keep their class', async ({ page }) => {
  await page.goto('/');
  const p = page.locator('#go').click();
  expect(p).toBeInstanceOf(Promise);
  await p;
  await expect(page.locator('#missing').click({ timeout: 200 })).rejects.toThrow(/Timeout 200ms exceeded/);
  expect(() => page.locator('#go').nth(1).first()).not.toThrow();
});
