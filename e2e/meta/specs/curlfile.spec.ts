import { test } from '../../lib';
import { TITLE_ESCAPES, TITLE_QUERY, TITLE_VALUE, VALUE_CANARY } from './curlfile-titles';

const CANARY = 'PLP-CANARY-7f3a';

async function send(request: import('@playwright/test').APIRequestContext): Promise<void> {
  await request.get(`/api/ok?token=${CANARY}&n=1`, { headers: { Authorization: `Bearer ${CANARY}` } });
  await request.post('/api/echo-headers', { data: { user: 'jo', pin: CANARY }, headers: { 'X-Note': "it's $HOME" } });
}

test.describe('curl.sh', () => {
  test.use({ apiLog: { curl: true, redactBodyKeys: ['pin'] } });

  test('curl file: default', async ({ request }) => {
    await send(request);
  });

  test('curl file: failing test still writes it', async ({ request }) => {
    await send(request);
    throw new Error('boom');
  });
});

test.describe('curl.sh off or not applicable', () => {
  test.describe('file: false', () => {
    test.use({ apiLog: { curl: true, curlFormat: { file: false } } });
    test('curl file: switched off', async ({ request }) => {
      await send(request);
    });
  });

  test.describe('curl: false', () => {
    test.use({ apiLog: { curl: false } });
    test('curl file: curl disabled', async ({ request }) => {
      await send(request);
    });
  });

  test.describe('on-failure', () => {
    test.use({ apiLog: { curl: 'on-failure' } });
    test('curl file: on-failure with only 2xx responses', async ({ request }) => {
      await send(request);
    });
  });
});

test.describe('custom sink', () => {
  test.use({
    apiLog: { curl: true, sink: (line: string) => console.log(`SINK|${JSON.stringify(line)}`) },
  });
  test('curl file: custom sink gets plain lines', async ({ request }) => {
    await send(request);
  });
});

test.describe('custom sink with explicit colors', () => {
  test.use({
    apiLog: { curl: true, colors: true, sink: (line: string) => console.log(`SINK|${JSON.stringify(line)}`) },
  });
  test('curl file: custom sink with colors true', async ({ request }) => {
    await send(request);
  });
});

test.describe('titles stay out of curl.sh', () => {
  test.use({ apiLog: { curl: true }, browserLog: { redact: { values: [VALUE_CANARY] } } });

  test(TITLE_QUERY, async ({ request }) => {
    await send(request);
  });

  test(TITLE_VALUE, async ({ request }) => {
    await send(request);
  });

  test(TITLE_ESCAPES, async ({ request }) => {
    await send(request);
  });
});
