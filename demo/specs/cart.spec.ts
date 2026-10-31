import { test, expect } from '../../src/fixtures';
import { API, until } from '../helpers';

// The reported location of each test (cart.spec.ts:8:5) is the one the docs show: the line numbers
// of the three spec files are deliberate.


test('adds product to cart', async ({ request }) => {
  const started = Date.now();
  await request.get(`${API}/v1/products?page=2&limit=20`);
  await request.post(`${API}/v1/cart/items`, { data: { productId: 1, qty: 1 } });
  const res = await request.put(`${API}/v1/cart/items/42`, { data: { qty: 2 } });
  expect(res.ok()).toBe(true);
  await until(started, 1200);
});
