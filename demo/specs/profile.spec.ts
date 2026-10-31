import { test, expect } from '../../src/fixtures';
import { API, CDN, until } from '../helpers';

// profile.spec.ts:14:5. Calls to a second host: the host is dimmed, the path is not.









test('updates profile and clears sessions', async ({ request }) => {
  const started = Date.now();
  await request.patch(`${API}/v1/users/7`, { data: { name: 'Ada' } });
  await request.delete(`${API}/v1/sessions/old`);
  const res = await request.get(`${CDN}/assets/catalog.json`);
  expect(res.status()).toBe(304);
  await until(started, 640);
});
