import { test, expect } from '../../lib';

test('browser action fails', async ({ page }) => {
  await page.goto('/');
  await page.locator('#does-not-exist').click({ timeout: 300 });
});

test('request fails', async ({ request }) => {
  const res = await request.get('/api/ok?x=1');
  expect(res.status()).toBe(201);
});

test('request network error', async ({ request }) => {
  await request.get('http://127.0.0.1:1/never');
});

test('passes', async ({ page, request }) => {
  await page.goto('/');
  await request.get('/api/ok');
});
