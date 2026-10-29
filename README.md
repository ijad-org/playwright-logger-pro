# Playwright Logger Pro

Colorful request/response logging for Playwright's `APIRequestContext` — the spiritual successor of `superagent-logger` for Playwright API tests. Optionally prints a copy-pastable `curl` command for every request (or only for failures), with secret headers redacted.

```
→ POST /vegetables
  {
    "name": "Orange",
    "price": 1
  }
← POST http://localhost:3000/vegetables 201 Created (23ms)
  content-type: application/json
  date: Thu, 29 Oct 2026 09:12:25 GMT
  content-length: 43
  {"id":7,"msg":"Successfully added: Orange"}
curl -X POST 'http://localhost:3000/vegetables' \
  -H 'Content-Type: application/json' \
  --data-raw '{"name":"Orange","price":1}'
```

Request headers (when the call sets any) and response headers are printed before each body; turn them off with `logHeaders: false`.

Methods and statuses are color-coded (GET cyan, POST green, DELETE red, … / 2xx green, 4xx yellow, 5xx red). Colors follow the usual environment variables (see [Colors](#colors)); set `colors: true` to force them on whatever the environment says.

## Install

```sh
npm i -D playwright-logger-pro
# or
pnpm add -D playwright-logger-pro
```

`@playwright/test` >= 1.30 is a peer dependency — you already have it in a Playwright project. Node.js >= 18 is required.

TypeScript types resolve with every `moduleResolution` setting (`node`/`node10`, `node16`/`nodenext` and `bundler`).

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

**Force colors in CI logs** (for example with a custom `sink`, or when `NO_COLOR` is set). Locally `undefined` keeps auto-detection:

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

> **Custom redaction lists are added to the defaults — they never replace them.**
> `redactHeaders`, `redactQueryParams` and `redactBodyKeys` are merged with the built-in lists
> (case-insensitively, without duplicates), so adding `x-internal-token` keeps `authorization`,
> `cookie`, `set-cookie` and `x-api-key` redacted. The built-in lists are exported as
> `DEFAULT_REDACT_HEADERS`, `DEFAULT_REDACT_QUERY_PARAMS` and `DEFAULT_REDACT_BODY_KEYS`.
> To use *only* your own lists, set `replaceDefaultRedaction: true` (see below).

**Redact your own secret headers** (on top of the defaults: authorization, cookie, set-cookie, x-api-key):

```ts
use: { apiLog: { redactHeaders: ['authorization', 'x-internal-token'] } }
```

**Redact secrets in query strings** (on top of the defaults: `api_key`, `apikey`, `token`, `access_token`, `password`, `secret`). The values are masked in every logged URL, in `Location` headers and in the curl:

```ts
use: { apiLog: { redactQueryParams: ['api_key', 'token', 'sig'] } }
// → GET /search?sig=***&q=shoes   (password=… and access_token=… are still masked)
```

**Redact secrets in request/response bodies** (no body keys are redacted by default). Keys are matched case-insensitively at any depth in JSON bodies, and also in form (`form`, `application/x-www-form-urlencoded`) and multipart field bodies:

```ts
use: { apiLog: { redactBodyKeys: ['password', 'access_token', 'refreshToken'] } }
// {"user":"jo","password":"***"}
```

**Opt out of the built-in lists** — dangerous: anything not in your lists is printed in clear text, including `Authorization` and `Cookie` headers. With `replaceDefaultRedaction: true` only the lists you give are used, and a list you leave out redacts nothing:

```ts
use: { apiLog: { replaceDefaultRedaction: true, redactHeaders: ['x-internal-token'] } }
```

A redacted curl sends `***` in place of the secret, so fill the real value back in before replaying it.

## Configuration

| Option | Type | Default | Description |
| --- | --- | --- | --- |
| `enabled` | `boolean` | `true` | `false` makes the wrapper a no-op pass-through. |
| `colors` | `boolean` | auto | `true`/`false` force ANSI colors on/off (`true` wins over `NO_COLOR`). Auto: see [Colors](#colors). |
| `curl` | `boolean \| 'on-failure'` | `false` | Print equivalent curl: never / always / only when status isn't 2xx. |
| `logHeaders` | `boolean` | `true` | Log request/response headers. |
| `logBody` | `boolean` | `true` | Log request/response bodies. |
| `maxBodyLength` | `number` | `2000` | Truncate logged bodies beyond this many characters (a number >= 0; `Infinity` disables truncation). Also applies to the curl body, which then starts with a `# request body truncated…` comment. |
| `redactHeaders` | `string[]` | `[]` (+ the defaults: `authorization, cookie, set-cookie, x-api-key`) | **Extra** header names masked with `***` in logs **and** curl output. Merged with the defaults. |
| `redactQueryParams` | `string[]` | `[]` (+ the defaults: `api_key, apikey, token, access_token, password, secret`) | **Extra** query parameter names masked with `***` in logged URLs **and** curl output. Merged with the defaults. |
| `redactBodyKeys` | `string[]` | `[]` (no defaults) | **Extra** JSON/form body keys (and multipart field names) masked with `***` in logged request/response bodies **and** curl output. Merged with the (empty) defaults. |
| `replaceDefaultRedaction` | `boolean` | `false` | `true` drops the built-in lists: only the lists you pass are used. Dangerous, see Recipes. |
| `sink` | `(line: string) => void` | `console.log` | Redirect output (file, allure attachment, …). |
| `baseURL` | `string` | fixture: `use.baseURL` | Used to show absolute URLs. The fixture fills it in; pass it in Option B to get absolute URLs in error lines and their curl. |
| `extraHTTPHeaders` | `Record<string, string>` | fixture: `use.extraHTTPHeaders` | Headers the context sends with every request. They are shown in logged headers and the curl. The fixture fills it in; in Option B, pass the same headers you gave `newContext()`. |

An option set to `undefined` uses its default. An option with an invalid value (a string for a redact list, `maxBodyLength: NaN` or `-5`, `curl: 'always'`, a `sink` that is not a function, …) never fails the request: the logger prints a one-time `[playwright-logger-pro]` warning on the console and uses the default for that option. A `sink` that throws gets the same warning, and its lines go to `console.log` instead.

### Colors

With `colors` unset the logger decides like Playwright's own reporters do, in this order:

1. **Off** when `NO_COLOR` is set to a non-empty value, or `FORCE_COLOR` / `DEBUG_COLORS` is `0` or `false`.
2. **On** when `FORCE_COLOR` (any other value) or `DEBUG_COLORS` is set. `playwright test` sets both for its workers, which is why colors normally work in test output even though the workers' stdout is a pipe.
3. **On** when `PLAYWRIGHT_FORCE_TTY` is set (anything but `0`/`false`).
4. **On** when stdout or stderr is a TTY (unless `TERM=dumb`); **off** otherwise.

If your runner or CI does not set `FORCE_COLOR` for the workers and the output is piped, colors are off. Force them with `colors: true`, which also wins over `NO_COLOR`:

```ts
use: { apiLog: { colors: true } }
```

Some things to know about the output:

- **Errors.** When a request fails without a response (timeout, connection refused, …), the wrapper logs a `✖ GET <url> failed (Nms) <error>` line. If `curl` is `true` or `'on-failure'`, the curl follows it. The error is then rethrown unchanged.
- **Cookies in the curl.** Cookies from the context's cookie jar that match the URL are added to the curl as a `Cookie` header, which is redacted by default. The jar is read before the request is sent, so a cookie set by the response itself is never added. (This reads `storageState()` once per request when `curl` is on.)
- **Repeated response headers** (such as several `Set-Cookie`) are printed as one indented `name: value` line per value.
- **Binary request bodies** (a `Buffer` as `data`) are logged as `<Buffer N bytes>`.
- **Binary responses.** Responses with a non-text content type are logged as `<binary N bytes (type)>`. Control characters in text bodies (such as terminal escape sequences) are escaped, for example `\x1b`.

## curl limitations

The curl is meant to be pasted into a terminal to replay the request. Keep in mind:

- **POSIX shells only.** Values are single-quoted for `sh`, `bash` and `zsh`, and lines are continued with `\`. The command will not work as-is in PowerShell or `cmd.exe`.
- **Redacted values are sent literally.** A masked header, query parameter or body key is sent as the text `***`. Put the real value back before replaying.
- **Truncated bodies are incomplete.** When the request body is longer than `maxBodyLength`, the curl body is cut too, and the command starts with a `# request body truncated…` comment. Raise `maxBodyLength` to get a body that replays in full.
- **Binary bodies are read from a file.** A `Buffer` body cannot be pasted into a shell, so the curl sends `--data-binary '@request-body.bin'` and starts with a `# binary request body (N bytes) is not included…` comment. Save the bytes as `request-body.bin` in the current directory first.
- **Multipart files are read from disk.** File parts are sent with `-F 'name=@<file>'`. A file given as a path is read from that path. A file given as an in-memory buffer is read from its file name in the current directory, as the `# multipart file content…` comment says.
- **Redirects.** Playwright's rules differ from `curl -L`: a 303 turns any method except GET/HEAD into a GET without a body, a 301/302 turns a POST into a GET, and PUT/PATCH/DELETE keep their method and body on 301/302/307/308. A redirected GET or HEAD gets `-L`. Any other redirected request gets one curl per step, with the method, URL and body Playwright actually used (a step that became a GET has no body and no `Content-Type`/`Content-Length`; `Cookie` is left out of later steps, and `Authorization` when the redirect leaves the origin). The steps are read from Playwright's fetch log; if that is not available, a POST with a body is replayed with `-L` and any other method is replayed without following the redirect, with a comment saying so.
- **Invalid URLs.** If the URL cannot be parsed, the curl is replaced by `# could not build curl: invalid URL`.
- **Context state.** Headers from the context (`extraHTTPHeaders`) appear only when the logger knows them (the fixture fills them in; Option B needs the `extraHTTPHeaders` option). Cookies come from the context's cookie jar. Other context settings, such as `httpCredentials`, proxy, client certificates and `ignoreHTTPSErrors`, are not part of the curl.

## Roadmap / Planned

- Browser action logging (page actions, with secret redaction) - planned after the rename

## License

MIT
