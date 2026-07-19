# playwright-api-logger

Colorful request/response logging for Playwright's `APIRequestContext` — the spiritual successor of `superagent-logger` for Playwright API tests. Optionally prints a copy-pastable `curl` command for every request (or only for failures), with secret headers redacted.

```
→ POST /vegetables
  {
    "name": "Orange",
    "price": 1
  }
← POST http://localhost:3000/vegetables 201 Created (23ms)
  {"id":7,"msg":"Successfully added: Orange"}
curl -X POST 'http://localhost:3000/vegetables' \
  -H 'Content-Type: application/json' \
  --data-raw '{"name":"Orange","price":1}'
```

Methods and statuses are color-coded (GET cyan, POST green, DELETE red, … / 2xx green, 4xx yellow, 5xx red) when the output is a TTY.

## Install

```sh
npm i -D playwright-api-logger
# or
pnpm add -D playwright-api-logger
```

`@playwright/test` >= 1.30 is a peer dependency — you already have it in a Playwright project.

## Usage

### Option A — drop-in test fixture (recommended)

Replace the import of `test`/`expect` and every use of the built-in `request` fixture is logged automatically:

```ts
import { test, expect } from 'playwright-api-logger/fixtures';

test('create vegetable', async ({ request }) => {
  const res = await request.post('/vegetables', { data: { name: 'Orange', price: 1 } });
  expect(res.status()).toBe(201);
});
```

Configure globally in `playwright.config.ts`:

```ts
import { defineConfig } from '@playwright/test';
import type { ApiLoggerOptions } from 'playwright-api-logger/fixtures';

export default defineConfig<ApiLoggerOptions>({
  use: {
    baseURL: 'http://localhost:3000',
    apiLog: { curl: 'on-failure' },
  },
});
```

…or per suite / per test:

```ts
test.describe('debugging this flow', () => {
  test.use({ apiLog: { curl: true, maxBodyLength: 10000 } });
  // ...
});
```

### Option B — wrap any APIRequestContext manually

```ts
import { request } from '@playwright/test';
import { wrapRequestContext } from 'playwright-api-logger';

const ctx = wrapRequestContext(
    await request.newContext({ baseURL: 'https://api.example.com' }),
    { curl: true },
);
const res = await ctx.get('/users');
```

The wrapper is a transparent proxy: everything on `APIRequestContext` (including `dispose()` and `storageState()`) keeps working; only the HTTP verb methods gain logging.

## Recipes

**Print curl only when something fails** (great default for CI):

```ts
use: { apiLog: { curl: 'on-failure' } }
```

**Force colors in CI logs** (output is piped, so TTY auto-detection turns colors off):

```ts
use: { apiLog: { colors: !!process.env.CI || undefined } }
```

**Redirect logs to a file** instead of the console:

```ts
import fs from 'fs';

const stream = fs.createWriteStream('api.log', { flags: 'a' });
test.use({ apiLog: { colors: false, sink: (line) => stream.write(line + '\n') } });
```

**Silence the logger for a noisy suite:**

```ts
test.use({ apiLog: { enabled: false } });
```

**Redact your own secret headers** (defaults already cover authorization, cookie, set-cookie, x-api-key):

```ts
use: { apiLog: { redactHeaders: ['authorization', 'x-internal-token'] } }
```

## Configuration

| Option | Type | Default | Description |
| --- | --- | --- | --- |
| `enabled` | `boolean` | `true` | `false` makes the wrapper a no-op pass-through. |
| `colors` | `boolean` | auto (TTY) | ANSI colors on/off. |
| `curl` | `boolean \| 'on-failure'` | `false` | Print equivalent curl: never / always / only when status isn't 2xx. |
| `logHeaders` | `boolean` | `true` | Log request/response headers. |
| `logBody` | `boolean` | `true` | Log request/response bodies. |
| `maxBodyLength` | `number` | `2000` | Truncate logged bodies beyond this many characters. |
| `redactHeaders` | `string[]` | `authorization, cookie, set-cookie, x-api-key` | Header values masked with `***` in logs **and** curl output. |
| `sink` | `(line: string) => void` | `console.log` | Redirect output (file, allure attachment, …). |

## License

MIT
