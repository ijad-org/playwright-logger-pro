import { test } from '../../lib';

// Which curl output is coloured is decided by the environment the meta test starts this
// run with (CI, FORCE_COLOR, NO_COLOR, PLAYWRIGHT_FORCE_TTY); see curlcolor.test.ts.
async function send(request: import('@playwright/test').APIRequestContext): Promise<void> {
  await request.get('/api/ok?token=secret-1&n=1', { headers: { Authorization: 'Bearer secret-2' } });
  await request.post('/api/echo-headers', { data: { user: 'jo', n: 1 }, headers: { 'X-Note': 'hi' } });
}

test.describe('auto', () => {
  test.use({ apiLog: { format: 'verbose', curl: true } });
  test('curl color: auto', async ({ request }) => {
    await send(request);
  });
});

test.describe('top-level colors: true', () => {
  test.use({ apiLog: { format: 'verbose', curl: true, colors: true } });
  test('curl color: top-level colors true', async ({ request }) => {
    await send(request);
  });
});

test.describe('curlFormat.colors: true', () => {
  test.use({ apiLog: { format: 'verbose', curl: true, curlFormat: { colors: true } } });
  test('curl color: explicit curlFormat true', async ({ request }) => {
    await send(request);
  });
});
