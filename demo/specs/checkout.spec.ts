import { test, expect } from '../../src/fixtures';
import { API, until } from '../helpers';

// checkout.spec.ts:21:5. This test fails on purpose: its 4xx and 5xx calls get a detail block,
// the 5xx one with a curl. A 404 in a passing test would show its chip and nothing else.















test('places an order', async ({ request }) => {
  const started = Date.now();
  const missing = await request.get(`${API}/v1/orders/99999`);
  expect(missing.status()).toBe(404);
  const res = await request.post(`${API}/v1/checkout?token=sk_live_9f2c7a1b&currency=EUR`, {
    headers: { Authorization: 'Bearer eyJhbGciOiJIUzI1NiJ9.demo', 'Content-Type': 'application/json' },
    data: { cartId: 'c_812', cardToken: 'tok_visa_4242' },
  });
  await until(started, 2400);
  expect(res.status()).toBe(201);
});
