import { test, expect } from '../../lib';

// The repro: the server answers 201, the test asserts 200. Secrets are built from parts so the
// source holds no literal the secret scan would match; they are in the requests, never in the output.
const SECRET = ['SECRET', '123'].join('-');

test('creates an order', async ({ request }) => {
  await request.get(`/status/200?step=list&token=${SECRET}`);
  const res = await request.post(`/status/201?step=create&token=${SECRET}`, {
    data: { item: 'book', password: SECRET },
    headers: { Authorization: `Bearer ${SECRET}` },
  });
  expect(res.status()).toBe(200);
});

test('a passing test', async ({ request }) => {
  const res = await request.get('/status/201?step=passing');
  expect(res.status()).toBe(201);
});

test('a call after a soft failure', async ({ request }) => {
  const res = await request.post('/status/201?step=create-2');
  expect.soft(res.status()).toBe(200);
  await request.delete('/status/204?step=after-soft');
});
