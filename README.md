# Playwright Logger Pro

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
npm i -D playwright-logger-pro
# or
pnpm add -D playwright-logger-pro
```

`@playwright/test` >= 1.30 is a peer dependency — you already have it in a Playwright project.

## Usage

### Option A — drop-in test fixture (recommended)

Replace the import of `test`/`expect` and every use of the built-in `request` fixture is logged automatically:

```ts
import { test, expect } from 'playwright-logger-pro/fixtures';

test('create vegetable', async ({ request }) => {
  const res = await request.post('/vegetables', { data: { name: 'Orange', price: 1 } });
  expect(res.status()).toBe(201);
});
```

Configure globally in `playwright.config.ts`:

```ts
import { defineConfig } from '@playwright/test';
import type { ApiLoggerOptions } from 'playwright-logger-pro/fixtures';

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
import { wrapRequestContext } from 'playwright-logger-pro';

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

**Redact secrets in query strings** (defaults already cover `api_key`, `apikey`, `token`, `access_token`, `password`, `secret`). The values are masked in every logged URL, in `Location` headers and in the curl:

```ts
use: { apiLog: { redactQueryParams: ['api_key', 'token', 'sig'] } }
// → GET /search?sig=***&q=shoes
```

**Redact secrets in request/response bodies.** Keys are matched case-insensitively at any depth in JSON bodies, and also in form (`form`, `application/x-www-form-urlencoded`) and multipart field bodies:

```ts
use: { apiLog: { redactBodyKeys: ['password', 'access_token', 'refreshToken'] } }
// {"user":"jo","password":"***"}
```

A redacted curl sends `***` in place of the secret, so fill the real value back in before replaying it.

## Configuration

| Option | Type | Default | Description |
| --- | --- | --- | --- |
| `enabled` | `boolean` | `true` | `false` makes the wrapper a no-op pass-through. |
| `colors` | `boolean` | auto | `true`/`false` force ANSI colors on/off (`true` wins over `NO_COLOR`). Auto: on for a TTY or when `FORCE_COLOR` is set (as it is in Playwright workers), off with `NO_COLOR`. |
| `curl` | `boolean \| 'on-failure'` | `false` | Print equivalent curl: never / always / only when status isn't 2xx. |
| `logHeaders` | `boolean` | `true` | Log request/response headers. |
| `logBody` | `boolean` | `true` | Log request/response bodies. |
| `maxBodyLength` | `number` | `2000` | Truncate logged bodies beyond this many characters. Also applies to the curl body, which then starts with a `# request body truncated…` comment. |
| `redactHeaders` | `string[]` | `authorization, cookie, set-cookie, x-api-key` | Header values masked with `***` in logs **and** curl output. |
| `redactQueryParams` | `string[]` | `api_key, apikey, token, access_token, password, secret` | Query parameter values masked with `***` in logged URLs **and** curl output. |
| `redactBodyKeys` | `string[]` | `[]` | JSON/form body keys (and multipart field names) whose values are masked with `***` in logged request/response bodies **and** curl output. |
| `sink` | `(line: string) => void` | `console.log` | Redirect output (file, allure attachment, …). |
| `baseURL` | `string` | fixture: `use.baseURL` | Used to show absolute URLs. The fixture fills it in; pass it in Option B to get absolute URLs in error lines and their curl. |
| `extraHTTPHeaders` | `Record<string, string>` | fixture: `use.extraHTTPHeaders` | Headers the context sends with every request. They are shown in logged headers and the curl. The fixture fills it in; in Option B, pass the same headers you gave `newContext()`. |

An option set to `undefined` uses its default.

Some things to know about the output:

- **Errors.** When a request fails without a response (timeout, connection refused, …), the wrapper logs a `✖ GET <url> failed (Nms) <error>` line. If `curl` is `true` or `'on-failure'`, the curl follows it. The error is then rethrown unchanged.
- **Cookies in the curl.** Cookies from the context's cookie jar that match the URL are added to the curl as a `Cookie` header, which is redacted by default.
- **Binary responses.** Responses with a non-text content type are logged as `<binary N bytes (type)>`. Control characters in text bodies (such as terminal escape sequences) are escaped, for example `\x1b`.

## Roadmap / Planned

- Browser action logging (page actions, with secret redaction) - planned after the rename

## License

MIT
