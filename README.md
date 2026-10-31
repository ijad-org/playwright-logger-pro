# Playwright Logger Pro

[![npm version](https://img.shields.io/npm/v/playwright-logger-pro.svg)](https://www.npmjs.com/package/playwright-logger-pro)

**Documentation:** <https://ijad-org.github.io/playwright-logger-pro/> · [npm](https://www.npmjs.com/package/playwright-logger-pro) · [Changelog](CHANGELOG.md)

**API and browser-action** logging for Playwright. One line per API call and detail only where something went wrong, with a `curl` that replays the failed request and secrets masked; plus a per-test timeline of what a test did in the browser, attached to the report when a test fails.

<picture>
  <source media="(prefers-color-scheme: dark)" srcset="https://raw.githubusercontent.com/ijad-org/playwright-logger-pro/main/docs/assets/compact-dark.png">
  <img alt="Compact output: a line per API call under each test, a detail block with a curl for the failed 500, and a one-line total" src="https://raw.githubusercontent.com/ijad-org/playwright-logger-pro/main/docs/assets/compact-light.png">
</picture>

Dark: <https://raw.githubusercontent.com/ijad-org/playwright-logger-pro/main/docs/assets/compact-dark.png> · light: <https://raw.githubusercontent.com/ijad-org/playwright-logger-pro/main/docs/assets/compact-light.png>

The same output as text (the screenshots are rendered from `npm run demo`, see [Demo](#demo)):

```
  ✓  1 [chromium] › cart.spec.ts:8:5 › adds product to cart (1.2s)
    GET    200  https://api.shop.test/v1/products?page=2&limit=20            142ms
    POST   201  https://api.shop.test/v1/cart/items                           88ms
    PUT    200  https://api.shop.test/v1/cart/items/42                        97ms
  ✘  2 [chromium] › checkout.spec.ts:21:5 › places an order (2.4s)
    GET    404  https://api.shop.test/v1/orders/99999                         73ms
    │ ← 404 Not Found  {"error":"order not found"}
    POST   500  https://api.shop.test/v1/checkout?token=***&currency=EUR   ▲ 1.83s
    │ ← 500 Internal Server Error  {"error":"payment gateway timeout"}
    │
    │ curl -X POST 'https://api.shop.test/v1/checkout?token=***&currency=EUR' \
    │   -H 'Authorization: ***' \
    │   -H 'Content-Type: application/json' \
    │   --data-raw '{"cartId":"c_812","cardToken":"***"}'
    │
    │ ↳ replay: curl.sh attached to the HTML report

  1 failed
    [chromium] › checkout.spec.ts:21:5 › places an order
  2 passed (4.3s)
  8 requests · 2 errors · 1 slow ≥1s
```

The test lines and the `1 failed` summary are Playwright's list reporter; this package prints the request lines, the `│` blocks and the last line.

## Quick start

```sh
npm i -D playwright-logger-pro
```

```ts
// playwright.config.ts: register the reporter AFTER `list`
import { defineConfig } from '@playwright/test';

export default defineConfig({
  reporter: [['list'], ['playwright-logger-pro/reporter', { /* options, see below */ }]],
});
```

```ts
// your specs: import test/expect from the package
import { test, expect } from 'playwright-logger-pro/fixtures';
```

Without the reporter the fixture prints the same lines itself (above the result line, no total). To keep the 0.3 line-by-line output set `apiLog: { format: 'verbose' }` (see [Verbose format](#verbose-format-the-03-output)).

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
    apiLog: { curl: '4xx+' },
  },
  reporter: [['list'], ['playwright-logger-pro/reporter']],
});
```

…or per suite / per test:

```ts
test.describe('debugging this flow', () => {
  test.use({ apiLog: { curl: 'always', details: 'always' } });
  // ...
});
```

### Option B — wrap any APIRequestContext manually

```ts
import { request } from '@playwright/test';
import { wrapRequestContext } from 'playwright-logger-pro';

const ctx = wrapRequestContext(
    await request.newContext({ baseURL: 'https://api.example.com' }),
    { curl: 'always' },
);
const res = await ctx.get('/users'); // prints its line (and, for a failed call, its block) at once
```

The wrapper is a transparent proxy: everything on `APIRequestContext` (including `dispose()` and `storageState()`) keeps working; only the HTTP verb methods gain logging.

## Compact output

An API call prints one line: `METHOD STATUS  URL  TIMING`. The host is dimmed, masked values are `***`, a call of at least `slowThresholdMs` shows `▲ 1.83s`, and a 4xx, 5xx or network error (`ERR`) has a coloured **chip** in the status column (no extra characters, so columns do not shift). Past the terminal width the middle of the **query string** is replaced by `…`; the host and the path never are.

A request with status >= 400, or no response, gets a `│` block directly under its line **when its test failed** (`details: 'failed-tests'`, the default). A 404 in a passing negative test keeps its chip and gets no block. The block starts with `← 404 Not Found  {…}`, the response body as one line (JSON minified, text its first line, cut at `bodyPreviewChars` with `…`, `<empty body>`, or `<binary 12.4 KB application/pdf>`); a network error shows `← ECONNREFUSED  connect ECONNREFUSED 127.0.0.1:9`. With `curl: '5xx'` (the default) a 5xx or network error also shows its curl and `↳ replay: curl.sh attached to the HTML report`.

### Reporter

```ts
reporter: [['list'], ['playwright-logger-pro/reporter', { details: 'failed-tests', slowThresholdMs: 1000 }]],
```

The `test` fixture records every call of a test (masked) in a `playwright-logger-pro.json` attachment and the replay scripts in `curl*.sh`; the reporter, in the runner process, prints them when the test ends and adds the total after Playwright's summary: `8 requests · 2 errors · 1 slow ≥1s` (a zero segment is left out; errors are status >= 400 plus network failures). Printing from the workers cannot give this layout, because worker output reaches the terminal before the result line and interleaves between parallel tests.

| Reporter option | Default | Description |
| --- | --- | --- |
| `slowThresholdMs` | `1000` | A call at least this slow gets `▲` and a yellow time, and counts in the total. |
| `timeColumn` | `82` | Column where the timing ends; `'auto'` fits the terminal width. |
| `details` | `'failed-tests'` | `'failed-tests'`, `'always'` or `'never'`. |
| `bodyPreviewChars` | `200` | Preview length. |
| `theme` | `'ansi'` | `'ansi'` (the 16 basic colours of your terminal theme, readable on dark and light), `'dark'` or `'light'` (true colour, the palette of the screenshots). |
| `ascii` | `false` | ASCII symbols (`\|` `<-` `^` `->` `ok` `x`). Automatic on legacy Windows consoles (no `WT_SESSION`). |
| `curl` | from `apiLog.curl` | `'5xx'`, `'4xx+'`, `'always'`, `'never'`: which calls show their curl. |
| `colors` | `'auto'` | `true` forces colours; see [Colours](#compact-colours-ci-and-ascii). |

The same display options (`slowThresholdMs`, `timeColumn`, `details`, `bodyPreviewChars`, `theme`, `ascii`) work in `apiLog`; the fixture hands them to the reporter in the JSON attachment, and the reporter's own options win.

### curl.sh

For a failed test (or `details: 'always'`) each call that has a curl gets a script attached to the report: `curl.sh` when the test has one, else `curl-{n}-{METHOD}-{lastPathSegment}.sh`. **A script never contains a secret**: every masked value becomes an environment variable named after its key in UPPER_SNAKE_CASE, with a guard:

```sh
#!/usr/bin/env bash
set -euo pipefail
: "${TOKEN:?export TOKEN first}"
: "${AUTHORIZATION:?export AUTHORIZATION first}"
: "${CARD_TOKEN:?export CARD_TOKEN first}"
# tests/checkout.spec.ts:21

curl -X POST 'https://api.shop.test/v1/checkout?token='"${TOKEN}"'&currency=EUR' \
  -H 'Authorization: '"${AUTHORIZATION}" \
  -H 'Content-Type: application/json' \
  --data-raw '{"cartId":"c_812","cardToken":"'"${CARD_TOKEN}"'"}'
```

`export` the variables (the whole header value, `Bearer` included) and run it. The script has the whole body; the terminal cuts bodies over 2 KB with `…`. Two masked values with the same key name share one variable. `curlFormat.file: false` turns the scripts off. Headers curl adds itself (`host`, `content-length`, `connection`, `accept-encoding`) are left out; `-X GET` is left out of a GET without a body.

### Masking

The mask is always exactly `***`, never the length of the value, and it is the same in the line, the body preview, the curl, the scripts (as placeholders) and the JSON attachment. Defaults, case-insensitive, **merged** with what you add (`mask: { headers, query, bodyKeys }`, or the older `redactHeaders`, `redactQueryParams`, `redactBodyKeys`):

- headers: `authorization`, `proxy-authorization`, `cookie`, `set-cookie`, `x-api-key`, `x-auth-token` (the whole value);
- query parameters: `token`, `access_token`, `refresh_token`, `api_key`, `apikey`, `key`, `password`, `secret`, `signature`, `sig`;
- JSON/form body keys, at any depth and inside arrays: `password`, `token`, `accessToken`, `refreshToken`, `secret`, `apiKey`, `cardToken`, `cardNumber`, `cvv`, `pin` (and `access_token`, `refresh_token`, `api_key`, `card_number`).

### Compact colours, CI and ASCII

The compact output follows the colour rules of [`curlFormat.colors: 'auto'`](#when-the-curl-is-coloured): colours only in a real terminal, never on CI, with `NO_COLOR`, `FORCE_COLOR=0` or `TERM=dumb`; `FORCE_COLOR` alone does not colour CI logs or piped output. `colors: true` on the reporter (or `curlFormat.colors: true` for the fixture) forces them. Without colours the status column is 5 wide so a failure still stands out: ` 200 ` and `[404]`. `▲`, `│` and `***` stay as they are.

### Ordering with the list reporter

- **No terminal (CI, a pipe), any number of workers:** each test's lines sit under its result line. Without colours the list reporter writes through a stream that finishes a line on the next tick, so the reporter prints one `setImmediate` later; blocks of tests that end in the same tick carry a title line.
- **Terminal, one worker:** the list reporter rewrites its result line in place; nothing runs in parallel, so the lines go out at once, under it.
- **Terminal, several workers:** the list reporter counts the rows it printed and rewrites by moving the cursor up that many rows, so any extra line printed while a test is still running makes the next rewrite land on the wrong row (garbled output). The reporter therefore **holds its lines until no test is running**, then prints them with a title line (`✓  [chromium] › cart.spec.ts:8:5 › …`), at the latest at the end of the run. Nothing is garbled, but with many workers most blocks come after the result lines.
- With `NO_COLOR` in a terminal, Playwright's list reporter strips its own cursor movements and glues lines together, with or without this package.

### Demo

`npm run demo` runs three tests (the scenario above) against a mock shop API, with the list reporter and this package's reporter. `npm run screenshots` renders the real output of the demo, dark and light, to `docs/assets/compact-dark.png` and `compact-light.png` (needs Chromium); `docs/assets` is not part of the npm package.

### Verbose format (the 0.3 output)

`apiLog: { format: 'verbose' }` prints every call as before, live: request line and body, response line, headers, body and (with `curl`) the curl:

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

Request headers (when the call sets any) and response headers are printed before each body; turn them off with `logHeaders: false`. Methods and statuses are color-coded (GET cyan, POST green, DELETE red, … / 2xx green, 4xx yellow, 5xx red). In this format `curl` defaults to `false`, `curlFormat.file` writes the `#!/bin/sh` `curl.sh` described under [curl.sh (verbose)](#curlsh-verbose), and the sections below on the curl output, `logHeaders`, `logBody` and `maxBodyLength` apply as they did in 0.3.

## Browser action logging

The same import now also records what a test does in the browser. Nothing to configure:

```ts
import { test, expect } from 'playwright-logger-pro/fixtures';

test('rejects a wrong password', async ({ page }) => {
  await page.goto('/login');
  await test.step('Log in', async () => {
    await page.getByLabel('Email').fill('jo@example.com');
    await page.getByLabel('Password').fill(process.env.E2E_PASSWORD!);
    await page.getByRole('button', { name: 'Sign in' }).click();
  });
  await page.locator('.toast-success').click({ timeout: 5000 });
});
```

By default the logger is **quiet while a test passes**. When a test fails it prints one block and attaches the same text to the report as `browser-log`:

```
── browser log · login.spec.ts › rejects a wrong password · chromium · failed ──
+0.000s  page#1 opened
+0.011s  ✓ page.goto('/login')  412ms
+0.425s  ▸ Log in
+0.427s  │ ✓ getByLabel('Email').fill('jo@example.com')  18ms
+0.446s  │ ✓ getByLabel('Password').fill(***)  15ms
+0.462s  │ ✓ getByRole('button', { name: 'Sign in' }).click()  96ms
+0.560s  │ ⚠ console.error  Failed to load resource: the server responded with a status of 401 (Unauthorized)  (app.js:12)
+0.563s  ◂ Log in  passed  138ms
+0.570s  ✗ locator('.toast-success').click({ timeout: 5000 })  5003ms  TimeoutError: locator.click: Timeout 5000ms exceeded.
```

**What is logged**

- Actions on `page`, frames, locators, element handles, `keyboard`, `mouse`, `touchscreen`, `clock`, `context` and `browser`, with a duration (slow ones are highlighted), the error of a failed one, and `⧗ … still pending` for an action that never settled when the test timed out.
- Main-frame navigations, pages opening/closing, popups, downloads and dialogs.
- Console messages (warnings and errors by default), uncaught page errors, and optionally network traffic.
- `test.step` boundaries (Playwright 1.48+), and the step each action ran in.
- Not logged: `expect()` assertions, return values of queries, `page.request` traffic, route handler calls, workers, screenshots/videos (Playwright already records those).

### Browser recipes

**Live timeline locally, quiet block on failure in CI:**

```ts
// playwright.config.ts
import { defineConfig } from '@playwright/test';
import type { LoggerOptions } from 'playwright-logger-pro/fixtures';

export default defineConfig<LoggerOptions>({
  use: {
    apiLog: { curl: 'on-failure' },
    browserLog: {
      print: process.env.CI ? 'on-failure' : true,
      network: 'failed',
      redact: { values: [process.env.E2E_PASSWORD ?? ''] },
    },
  },
});
```

**JSONL artifacts** for tooling (one event per line, schema `v: 1`):

```ts
use: { browserLog: { file: 'on-failure', fileFormat: 'jsonl', fileDir: 'logs/browser' } }
```

Files are named `<test title>-<id>[-retryN][-repeatN].jsonl`; with no `fileDir` they go to `testInfo.outputPath('browser-log.jsonl')`. The logger never deletes or cleans any directory.

**Network failures** (`failed` = request failures and status >= 400, `documents` = document/xhr/fetch, `all`):

```ts
use: { browserLog: { network: 'failed' } }
```

**A page shared from `beforeAll`:**

```ts
import { attachBrowserLogger } from 'playwright-logger-pro';

test.beforeAll(async ({ browser }) => {
  page = await browser.newPage();
  attachBrowserLogger(page); // its events go to whichever test is running
});
```

**Extend our `test` or merge fixtures** and keep the step integration — use `.extend()` on our `test`, or our `mergeTests` (Playwright 1.39+):

```ts
import { test as base, mergeTests } from 'playwright-logger-pro/fixtures';
```

**Add a note** to the timeline (masked like everything else):

```ts
test('x', async ({ page, browserLogger }) => {
  browserLogger.note('seeded user 42');
});
```

**Turn it off** for a suite or a project:

```ts
test.use({ browserLog: { enabled: false } });
```

When it is off nothing is installed or listened to for that test.

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

### apiLog options

| Option | Type | Default | Description |
| --- | --- | --- | --- |
| `enabled` | `boolean` | `true` | `false` makes the wrapper a no-op pass-through. |
| `colors` | `boolean` | auto | `true`/`false` force ANSI colors on/off (`true` wins over `NO_COLOR` for the log lines; the curl follows [its own rule](#when-the-curl-is-coloured)). Auto: see [Colors](#colors); with a custom `sink` auto means off. |
| `format` | `'compact' \| 'verbose'` | `'compact'` | One line per call and detail where it failed ([Compact output](#compact-output)), or the 0.3 output ([Verbose format](#verbose-format-the-03-output)). |
| `curl` | `boolean \| 'on-failure' \| '5xx' \| '4xx+' \| 'always' \| 'never'` | `'5xx'` (`false` with `format: 'verbose'`) | Which calls get a curl: `'5xx'` status >= 500 and network errors, `'4xx+'` status >= 400 and network errors, `'always'` (= `true`), `'never'` (= `false`); legacy `'on-failure'` is any non-2xx. |
| `slowThresholdMs` | `number` | `1000` | A call at least this slow gets `▲` and counts in the total. |
| `timeColumn` | `number \| 'auto'` | `82` | Column where the timing ends. |
| `details` | `'failed-tests' \| 'always' \| 'never'` | `'failed-tests'` | When a failed request gets its `│` block. |
| `bodyPreviewChars` | `number` | `200` | Response preview length in the block. |
| `theme` | `'ansi' \| 'dark' \| 'light'` | `'ansi'` | 16 basic colours of your terminal, or a true-colour palette. |
| `ascii` | `boolean` | `false` (`true` on legacy Windows consoles) | ASCII instead of Unicode symbols. |
| `mask` | `{ headers?, query?, bodyKeys? }` | `{}` | **Extra** names masked with `***`, merged with the defaults and with `redactHeaders`, `redactQueryParams`, `redactBodyKeys`. |
| `curlFormat` | `{ colors?, multiline?, file? }` | `{ colors: 'auto', multiline: true, file: true }` | How the curl looks and is saved: ANSI colours (`true`, `false` or `'auto'`; in compact also the output the fixture prints without the reporter), one option per line or a single line, and the `curl*.sh` attachments. See [curl output](#curl-output). |
| `logHeaders` | `boolean` | `true` | Log request/response headers (compact: keep them in the JSON attachment). |
| `logBody` | `boolean` | `true` | Log request/response bodies (compact: keep them in the JSON attachment and show the response preview). |
| `maxBodyLength` | `number` | `2000` | Truncate logged bodies beyond this many characters (a number >= 0; `Infinity` disables truncation). In verbose it also applies to the curl body, which then starts with a `# request body truncated…` comment; the compact curl is cut at 2 KB. |
| `redactHeaders` | `string[]` | `[]` (+ the defaults: `authorization, proxy-authorization, cookie, set-cookie, x-api-key, x-auth-token`) | **Extra** header names masked with `***` in logs **and** curl output. Merged with the defaults. |
| `redactQueryParams` | `string[]` | `[]` (+ the defaults: `api_key, apikey, token, access_token, refresh_token, key, password, secret, signature, sig`) | **Extra** query parameter names masked with `***` in logged URLs **and** curl output. Merged with the defaults. |
| `redactBodyKeys` | `string[]` | `[]` (+ the defaults: `password, token, accessToken, refreshToken, secret, apiKey, cardToken, cardNumber, cvv, pin, access_token, refresh_token, api_key, card_number`) | **Extra** JSON/form body keys (and multipart field names) masked with `***` in logged request/response bodies **and** curl output. Merged with the defaults. |
| `replaceDefaultRedaction` | `boolean` | `false` | `true` drops the built-in lists: only the lists you pass are used. Dangerous, see Recipes. |
| `sink` | `(line: string) => void` | `console.log` | Redirect output (file, allure attachment, …). With a custom `sink` and no explicit `colors`, colors default to **off**, so ANSI codes do not end up in a file. |
| `baseURL` | `string` | fixture: `use.baseURL` | Used to show absolute URLs. The fixture fills it in; pass it in Option B to get absolute URLs in error lines and their curl. |
| `extraHTTPHeaders` | `Record<string, string>` | fixture: `use.extraHTTPHeaders` | Headers the context sends with every request. They are shown in logged headers and the curl. The fixture fills it in; in Option B, pass the same headers you gave `newContext()`. |

An option set to `undefined` uses its default. An option with an invalid value (a string for a redact list, `maxBodyLength: NaN` or `-5`, `curl: 'always'`, a `sink` that is not a function, …) never fails the request: the logger prints a one-time `[playwright-logger-pro]` warning on the console and uses the default for that option. A `sink` that throws gets the same warning, and its lines go to `console.log` instead.

### Colors

With `colors` unset the logger decides like Playwright's own reporters do, in this order:

1. **Off** when `NO_COLOR` is set to a non-empty value, or `FORCE_COLOR` / `DEBUG_COLORS` is `0` or `false`.
2. **On** when `FORCE_COLOR` (any other value) or `DEBUG_COLORS` is set. `playwright test` sets both for its workers, so the logger emits colors even though the workers' stdout is a pipe. Whether you *see* them depends on Playwright's reporter (see the note below).
3. **On** when `PLAYWRIGHT_FORCE_TTY` is set (anything but `0`/`false`).
4. **On** when stdout or stderr is a TTY (unless `TERM=dumb`); **off** otherwise.

If your runner or CI does not set `FORCE_COLOR` for the workers and the output is piped, colors are off. Force them with `colors: true`, which also wins over `NO_COLOR`:

```ts
use: { apiLog: { colors: true } }
```

**Custom `sink`.** When you pass a `sink` and do not set `colors`, colors default to **off** for every line (the sink may write to a file, and ANSI codes in a file are noise). An explicit `colors: true` keeps them, for a sink that feeds a terminal or a CI log that renders them. The curl has its own, stricter rule: see [When the curl is coloured](#when-the-curl-is-coloured).

> **Note:** `colors: true` only controls what the logger writes. On Playwright 1.64 (checked on 1.64.1), when the reporter's own output is piped (not a TTY), Playwright strips every ANSI code from the test stdout it forwards, so the console shows no colors even with `colors: true`. Run in a terminal, or send the lines to a `sink` (a file, an attachment): the `sink` receives them with the colors intact.

Some things to know about the output:

- **Errors.** When a request fails without a response (timeout, connection refused, …), the wrapper logs a `✖ GET <url> failed (Nms) <error>` line. If `curl` is `true` or `'on-failure'`, the curl follows it. The error is then rethrown unchanged.
- **Cookies in the curl.** Cookies from the context's cookie jar that match the URL are added to the curl as a `Cookie` header, which is redacted by default. The jar is read before the request is sent, so a cookie set by the response itself is never added. (This reads `storageState()` once per request when `curl` is on.)
- **Repeated response headers** (such as several `Set-Cookie`) are printed as one indented `name: value` line per value.
- **Binary request bodies** (a `Buffer` as `data`) are logged as `<Buffer N bytes>`.
- **Binary responses.** Responses with a non-text content type are logged as `<binary N bytes (type)>`. Control characters in text bodies (such as terminal escape sequences) are escaped, for example `\x1b`.

## curl output

With `format: 'verbose'`, `curl: true` (or `'on-failure'`) puts a command you can paste into a POSIX shell after every request; in compact output the command is part of the `│` block (see above). `curlFormat` controls how it is printed:

```ts
use: { apiLog: { curl: true, curlFormat: { colors: 'auto', multiline: true, file: true } } }
```

| `curlFormat` option | Default | Effect |
| --- | --- | --- |
| `colors` | `'auto'` | `true` / `false` force colours on / off. `'auto'` colours only in a real terminal, outside CI and without `NO_COLOR`, on the default console sink (see [When the curl is coloured](#when-the-curl-is-coloured)). `true` is an explicit override that skips those checks. |
| `multiline` | `true` | `false` prints the command on one line, options joined by single spaces. Comments (`# …` notes, redirect steps) stay on their own lines above the command. |
| `file` | `true` | With the `test` fixture, collect the test's curls into a `curl.sh` file, attach it to the report and print a one-line notice. Only applies while `curl` is on. |

**Colours.** `curl` is bold; the method, URL, parameter and header names, JSON keys and strings and `#` comments each have their own colour (table below); a masked `***` is bold and reversed. A JSON body gets coloured keys and strings only when it is valid JSON. Flags (`-X`, `-H`, `--data-raw`, …), the `\` continuations, quotes and punctuation keep your terminal's default colour. Colours only decorate the text: removing the ANSI codes always gives exactly the plain command, so quoting stays safe. With colours off the output is byte-for-byte the plain command.

The colours are picked to read on both a black and a white terminal background: every one has a WCAG contrast of at least 4.5:1 on both in the 256-colour palette, and at least 3:1 in the 16-colour one. They are xterm's default palette indexes, so a theme that redefines the first 16 colours changes the 16-colour variant (the 256-colour cube and greys are fixed). The 256-colour codes (`38;5;N`) are used when `COLORTERM` is `truecolor`/`24bit`, `TERM` contains `256color` or the terminal reports at least 8 bits of colour; otherwise the 16 basic colours. The 16-colour palette has no green that reaches 3:1 on white, so POST and strings are not green there. Contrast of each element (black / white background):

| Element | 256 colours (index, colour) | black / white | 16 colours (index, colour) | black / white |
| --- | --- | --- | --- | --- |
| URL, JSON key, `-X GET` | 63 `#5f5fff` | 4.57 / 4.60 | 12 `#5c5cff` | 4.43 / 4.74 |
| Query parameter and header names | 163 `#d700af` | 4.51 / 4.66 | 5 `#cd00cd` | 4.48 / 4.69 |
| JSON string, `-X POST` | 29 `#00875f` | 4.63 / 4.53 | 9 `#ff0000` (POST: 5 `#cd00cd`) | 5.25 / 4.00 (POST: 4.48 / 4.69) |
| `-X PUT`, `-X PATCH` | 98 `#875fd7` | 4.65 / 4.52 | 13 `#ff00ff` | 6.70 / 3.14 |
| `-X DELETE` | 131 `#af5f5f` | 4.62 / 4.54 | 1 `#cd0000` | 3.60 / 5.84 |
| `#` comments | 243 `#767676` | 4.62 / 4.54 | 8 `#7f7f7f` | 5.24 / 4.00 |
| `curl`, other methods | bold, default foreground | | bold, default foreground | |
| Masked `***` | bold + inverse | | bold + inverse | |

`npm run contrast` prints these ratios from the palette in `src/curlPalette.ts`, and a unit test fails when one drops below the limits above.

### When the curl is coloured

With `curlFormat.colors: 'auto'` (the default) the curl is coloured only when **all** of these hold:

1. `NO_COLOR` is not set to a non-empty value. It always wins under `'auto'`, even over a top-level `colors: true`.
2. The process is not on CI: none of `CI`, `GITHUB_ACTIONS`, `GITLAB_CI`, `BUILDKITE`, `CIRCLECI`, `TRAVIS`, `APPVEYOR`, `TF_BUILD`, `TEAMCITY_VERSION`, `JENKINS_URL`, `BITBUCKET_BUILD_NUMBER`, `CODEBUILD_BUILD_ID`, `DRONE` is set to a value other than `0` or `false`.
3. The output really reaches a terminal: `process.stdout` is a TTY, or the test runner's own stdout is one (see [Local runs](#local-runs-in-a-terminal-need-no-setting)), or `PLAYWRIGHT_FORCE_TTY` is set (anything but `0`/`false`); and `TERM` is not `dumb`.
4. The resolved [`colors`](#colors) is true and the sink is the default console sink (a custom `sink` keeps the curl plain).

`FORCE_COLOR` does not count: `playwright test` sets `FORCE_COLOR=1` for its workers, but their stdout is a pipe. A top-level `colors: true` alone does not colour the curl in CI or when the output is piped; it still colours the other log lines.

#### Local runs in a terminal need no setting

A worker cannot see the runner's terminal, but the runner can. When a spec file imports `playwright-logger-pro` (or `/fixtures`), that import runs in the runner process, which checks whether its own stdout is a real terminal (`isatty(1)`). If it is, and the runner is not on CI, `NO_COLOR` is unset, `FORCE_COLOR`/`DEBUG_COLORS` are not `0`/`false` and `TERM` is not `dumb`, it sets `PLP_RUNNER_TTY=<runner pid>:<colour depth>` in its environment, which every worker inherits. A worker that finds its parent's pid in the variable counts the output as a terminal, and still applies every other check above (CI, `NO_COLOR`, `TERM=dumb`, the resolved `colors`, the sink). So a plain `npx playwright test` in a terminal prints a coloured curl, and `playwright test | cat`, CI and `NO_COLOR=1 npx playwright test` print a plain one.

Limits:

- The variable is tied to the runner's pid, so it is ignored in any process that is not a direct child of the runner. A copy inherited by a nested `playwright test` started from a test, or one you set yourself (`PLP_RUNNER_TTY=1`), does nothing. To force colours, use `PLAYWRIGHT_FORCE_TTY=1` or `curlFormat.colors: true`.
- The package must be imported while the runner loads the spec files (an `import` at the top of a spec or of a fixture file they import). A `require()` made only inside a test body runs in the worker, too late. This holds on Playwright 1.30, 1.39, 1.48 and the latest, where the runner process loads the spec files.
- Only a runner whose stdout is a terminal counts. Output that goes through a pipe (`| tee`, an IDE test panel, a CI step) stays plain; use `curlFormat.colors: true` if that output renders colours.

`curlFormat.colors: true` is an **explicit override**: the curl is coloured whatever `NO_COLOR`, CI, the terminal, the top-level `colors` and the sink say. Use it when you know where the output goes; ANSI codes will end up in CI logs, files or a custom sink. `curlFormat.colors: false` never colours. The `curl.sh` file and its attachment are never coloured.

```sh
npx playwright test                          # in a terminal: coloured curl
PLAYWRIGHT_FORCE_TTY=1 npx playwright test | tee run.log   # you assert the output is a terminal
```

### curl.sh (verbose)

With `format: 'verbose'` and the `test` fixture, the commands a test printed are also written, plain and redacted, to `curl.sh` in the test's output directory and attached to the report as `curl.sh` (`text/plain`). The file starts with:

```sh
#!/bin/sh
# tests/users.spec.ts:42
# redacted curl commands of this test; run with: sh curl.sh
```

The second line is the spec file, relative to the config's `rootDir` (or the project's `testDir`), and the line of the test. **The test title is not written to the file**: titles can contain data, and Playwright keeps them in the report anyway. The location has escape sequences and control characters removed.

One line goes through the sink when the file is ready, and it names no path, because Playwright derives the output folder from the test title:

```
curl.sh: attached to the test report (see "curl.sh" in the HTML report; also saved in this test's output folder)
```

Turn the file off with `curlFormat: { file: false }`. It is written at the end of the test, passed or failed, and only if at least one curl was produced (`curl: 'on-failure'` with only 2xx responses produces none). The file follows `multiline`.

**Redaction.** The printed curl, `curl.sh` and its attachment use the same builder and the same redaction lists (`redactHeaders`, `redactQueryParams`, `redactBodyKeys`), so a masked value is `***` everywhere. There is no switch that writes unredacted values; fill the real ones in before replaying. `redactBodyKeys` has a default list (see above): add the body keys of your API (it masks JSON and form keys and multipart field names only; XML and other raw text bodies are not scrubbed). Playwright's own HTML report step titles show the full request URLs of `request.get(...)` calls; the logger cannot mask them (see [Secrets & redaction](#secrets--redaction)).

```sh
sh curl.sh   # after replacing the *** placeholders
```

## curl limitations

The curl is meant to be pasted into a terminal to replay the request. Keep in mind:

- **POSIX shells only.** Values are single-quoted for `sh`, `bash` and `zsh`, and lines are continued with `\` (not with `curlFormat: { multiline: false }`). The command will not work as-is in PowerShell or `cmd.exe`.
- **Redacted values are sent literally.** A masked header, query parameter or body key is sent as the text `***`. Put the real value back before replaying.
- **Truncated bodies are incomplete.** When the request body is longer than `maxBodyLength`, the curl body is cut too, and the command starts with a `# request body truncated…` comment. Raise `maxBodyLength` to get a body that replays in full.
- **Binary bodies are read from a file.** A `Buffer` body cannot be pasted into a shell, so the curl sends `--data-binary '@request-body.bin'` and starts with a `# binary request body (N bytes) is not included…` comment. Save the bytes as `request-body.bin` in the current directory first.
- **Multipart files are read from disk.** File parts are sent with `-F 'name=@<file>'`. A file given as a path is read from that path. A file given as an in-memory buffer is read from its file name in the current directory, as the `# multipart file content…` comment says.
- **Redirects.** Playwright's rules differ from `curl -L`: a 303 turns any method except GET/HEAD into a GET without a body, a 301/302 turns a POST into a GET, and PUT/PATCH/DELETE keep their method and body on 301/302/307/308. A redirected GET or HEAD gets `-L`. Any other redirected request gets one curl per step, with the method, URL and body Playwright actually used (a step that became a GET has no body and no `Content-Type`/`Content-Length`, and it stays a bodiless GET on later 307/308 steps; which headers are forwarded depends on the Playwright version, see below). The steps are read from Playwright's fetch log; if that is not available, a POST with a body is replayed with `-L` and any other method is replayed without following the redirect, with a comment saying so.
- **Redirect headers by Playwright version.** Which headers Playwright forwards to a redirect target changed between releases, and the step curls follow the version that is installed (read from its `package.json`; when it cannot be found the 1.60+ rules are used). Secrets are redacted in every step as usual.

  | Playwright | `Cookie` you set | `Authorization` to another origin |
  | --- | --- | --- |
  | 1.30 – 1.31 | dropped | forwarded |
  | 1.32 – 1.59 | forwarded if spelled `Cookie`, dropped if spelled `cookie`; the same exact-case rule applies to `Content-Type` and the other body headers when a redirect becomes a GET | forwarded |
  | 1.60+ | dropped | dropped |

  Cookies from the cookie jar are never carried over: Playwright re-reads the jar for each step, and they are not in the printed steps. Note that on 1.30 – 1.59 a replayed step curl really does send your `Authorization` (and, on 1.32 – 1.59, `Cookie`) to the other origin, because Playwright did; the values in the printed curl are still redacted.
- **Invalid URLs.** If the URL cannot be parsed, the curl is replaced by `# could not build curl: invalid URL`.
- **Context state.** Headers from the context (`extraHTTPHeaders`) appear only when the logger knows them (the fixture fills them in; Option B needs the `extraHTTPHeaders` option). Cookies come from the context's cookie jar. Other context settings, such as `httpCredentials`, proxy, client certificates and `ignoreHTTPSErrors`, are not part of the curl.

## Secrets & redaction

Masked by default (`***`), in everything the logger outputs: the console block, the attachment, files and the in-memory events.

| What | How |
| --- | --- |
| Values typed with `fill()`, `type()`, `pressSequentially()`, `keyboard.type()`/`press()`, dialog prompt answers | Masked when the target looks sensitive: its selector, label or placeholder matches `redact.selectors` (`password`, `passcode`, `secret`, `token`, `otp`, `pin`, `cvv`, `api key`, `type=password`, `autocomplete=current-password` …). Card fields are recognised by the hints a selector shows (including expiry and PAN: `[autocomplete=cc-exp]`, `cc-exp-month`, `cc-exp-year`, `cc-csc`, `getByLabel('Expiry date')`, `getByLabel('Expiration')`, `#expDate`, `getByLabel('PAN')`, `#pan`; whole words only, so `company`, `panel` or `expires in` are not matched): `#card`, `[name=cardnumber]`, `[autocomplete=cc-number]`, `getByLabel('Card')`, `getByLabel('Credit card')`, `#cvc`, `#securityCode`, `#totp` … (a CSS class such as `.card` or `getByText('Card')` is not a field). `keyboard` input is masked while the last targeted field was sensitive; a navigation resets that. |
| Typed values that were masked | **Learned for the rest of the test**: whatever the page echoes of such a value (console messages, page errors, network and navigation URLs including query strings, dialog text, notes, apiLog lines) is masked too, in the spellings listed under *Which spellings are masked* below. Values shorter than 4 characters (after trimming) are never learned, since masking them would shred ordinary text; they stay masked in their own action line. The logger remembers the newest 256 typed secrets. A value is learned from the moment it is typed, so output recorded earlier is not changed. A key pressed with `press()` is a single character and is not learned. With `inspectInputType` a value is learned provisionally until the probe says whether the field is a password. Learning does not need the action line itself to be logged (`actions: false`). |
| Literal secrets in `redact.values` | Masked everywhere: arguments, URLs, console text, page errors, error messages, notes, apiLog lines. Values shorter than 4 characters are ignored (with a warning). Playwright's `httpCredentials.password` and the values of sensitive `extraHTTPHeaders` are added automatically; cookie values from `addCookies`, sensitive header values from `setExtraHTTPHeaders` and `setHTTPCredentials` passwords are learned at runtime. For an `Authorization: Bearer X` (or `Basic`, `Token`, …) header both the whole value and the bare token `X` are learned (`Basic` also its decoded password); a `Cookie` header also yields each cookie value. |
| Object keys inside arguments (`evaluate` args, option bags) | Keys matching `redact.keys` (`password`, `token`, `secret`, `api_key`, `authorization`, `cookie`, …). |
| URLs | The password in `https://user:pass@host` is always masked, and so are the values of sensitive query parameters (`api_key`, `apikey`, `token`, `access_token`, `password`, `secret`: the same logic and default list as apiLog's `redactQueryParams`) in every URL browserLog prints: `goto` and other arguments, navigations and redirect targets, popups, downloads, network lines, and URLs inside console text and error messages. Other parameters are kept. Add names with `redact.queryParams` (or apiLog's `redactQueryParams`); `redact.values` still masks literal values on top. |
| Headers, cookies, credentials | `setExtraHTTPHeaders` values for the apiLog header list; `addCookies` values always; `setHTTPCredentials` password always. Same header list as apiLog (`redactHeaders`). |
| Files and big payloads | `setInputFiles` shows file names only; `setContent` is `<html 1.2 KB>`; scripts are `<script 340 B>`. |

**Which spellings are masked.** Each secret that is *learned* at runtime (values typed into a masked field, `addCookies` values, `setExtraHTTPHeaders` values, `setHTTPCredentials` passwords) is masked as the literal value and in exactly these forms (computed once when it is learned; forms shorter than 4 characters are dropped):

- **Percent-encoded:** `encodeURIComponent`, `encodeURI`, the RFC 3986 form that also encodes `!'()*`, each with upper- or lower-case hex and with `+` for spaces.
- **Legacy `escape()`:** `%XX` for characters below U+0100 and `%uXXXX` above, one escape per UTF-16 code unit (an emoji is `%uD83D%uDE00`), upper- or lower-case hex.
- **JSON string bodies:** `JSON.stringify`; the same with `\/` for every slash; PHP `json_encode` defaults (`\/` plus every non-ASCII character as `\uXXXX`, a surrogate pair as two escapes); Python `json.dumps` with `ensure_ascii` (non-ASCII as `\uXXXX`, slashes left alone); and every character written as `\uXXXX`. `\u` hex is matched in lower and upper case.

Configured `redact.values` and the automatic values (`httpCredentials.password`, sensitive `extraHTTPHeaders`) are masked as the literal value only.

One sensitive-key list serves both loggers: `DEFAULT_SENSITIVE_KEYS` is used by browserLog by default; apiLog still redacts no body keys by default, but you can opt in with `redactBodyKeys: [...DEFAULT_SENSITIVE_KEYS]`.

When a masked call fails, its secret is also removed from the logged error message (Playwright's call log can echo arguments).

**How selectors are matched.** The selector text (id, name, label, placeholder) is checked as written and again after it is split on camelCase, `_` and `-` boundaries, so `#cardExpDate`, `cardPAN` and `pan_number` are read as "card Exp Date", "card PAN" and "pan number" and caught by the whole-word patterns. Only real case changes are split, so `Japan`, `company` and `panel` stay clear. The same two-step check applies to your own `redact.selectors` (strings match case-insensitively as substrings, regular expressions are tested as-is), so a string such as `'card pan'` also matches `#card_pan`. The placeholders `MM/YY` and `MM/YYYY` are detected as expiry fields, as are the labels "Valid thru" and "Valid through".

**Custom field names.** `redact.selectors` and `redact.keys` are added to the defaults, as with apiLog's lists; the defaults stay masked:

```ts
use: { browserLog: { redact: { selectors: ['#pin-pad'], keys: ['nickname'] } } }
```

To use *only* your own lists, set `replaceDefaultRedaction: true` in the `apiLog` option (the same switch as for apiLog; it also drops the default headers and query parameters). Dangerous: a list you leave out then masks nothing.

**Strict CI:** `redact: { fillValues: 'always' }` masks every typed value (`'never'` masks none; `redact.values` still applies).

**Query strings.** Sensitive query parameters are masked by name in every URL browserLog prints (see *URLs* above). A secret the page puts in a URL under another parameter name needs `redact.queryParams` or `redact.values`. Response bodies that echo a query, and notes you write yourself, are outside the logger's reach.

**`inspectInputType` (opt-in).** A password field whose selector, label and placeholder give no hint (`locator('#field7')` for `<input type=password>`) is not detected by the heuristics. With `redact: { inspectInputType: true }` the logger asks the page once per field (`type=password`, sensitive `autocomplete`) after a fill succeeds, and masks the value when the answer is yes, when the probe fails, or when the fill itself failed. The cost is one extra round trip per distinct field, and the probe shows up as an `evaluate` step in traces and the HTML report. It is off by default; the entry for such a fill appears once the probe has answered. If the test ends before the probe answers, the fill is reported as completed (it did complete) with the value still masked, because its sensitivity is unknown.

> **Limitation: masking is literal-form based.** A value is found only as its literal text or in one of the spellings above. These are **not** detected and appear in clear:
>
> - base64 (or any other encoding not listed above); the only base64 learned is the token of a `Basic` header you set, as written;
> - double encoding (`%2540`, a JSON-escaped value inside a percent-encoded URL);
> - HTML entities (`&amp;`, `&#38;`) and other markup escapes;
> - a value split across several `console.log` arguments (each argument is checked on its own) or otherwise broken up, and pieces of a value;
> - fragments typed with `keyboard.type()`/`press()` into the middle of a field: only the strings passed to a call are learned, not the field's final content, and a key pressed with `press()` is one character that is never learned;
> - cookies the server sets with `Set-Cookie` in a response: the logger only learns cookie values your test passes to `addCookies` (or a `Cookie` header it sets), so a server-set cookie value that the page or a network line echoes is not masked. Put such values in `redact.values`, or read them with `context.cookies()` and add them yourself.
>
> - a value that mixes escaped and literal forms (for example half of it `\u`-escaped and half plain), or mixes upper- and lower-case hex within one value (`%2f` next to `%2F`, `\u00e9` next to `\u00C9`). "Lower and upper case" means per value: each value written all-lower or all-upper.
>
> What helps: list the values (and the transformed forms you know the page produces, such as the base64 string) in `redact.values`; use `redact.selectors`/`redact.keys` for fields and keys; turn off the channels that echo values (`browserConsole: false`, `network: false`, which is the default); and avoid logging such values in the page. Do not rely on this logger as the only barrier for real secrets.
>
> Turning off `browserConsole` and `network` does **not** cover everything else the logger records: **action lines** (a base64 value passed as an argument to `page.evaluate(...)` is printed as given), **page errors**, **dialog text** and **navigation URLs**. For these, add the encoded form to `redact.values`, or switch the channel off: `actions: false`, `pageErrors: false`, `navigation: false` (dialogs and navigation URLs are part of `navigation`).
>
> `httpCredentials` in `test.use`: Playwright reads `test.use({ httpCredentials: [a, b] })` as `[value, options]`, not as a list of two credentials. To pass an array, write `test.use({ httpCredentials: [[a, b], { scope: 'test' }] })`.

> **Limitation: Playwright-owned artifacts are outside this logger.** Masking covers what *this logger* outputs (console block, attachment, files, events, sink). Artifacts that Playwright itself writes can contain the raw values, **even with traces off** (`trace: 'off'`):
>
> - **HTML report step titles.** Playwright puts action arguments into step titles, and the report keeps them: on newer versions as `Fill "<the value>"` (seen on 1.64), and on older versions some steps carry values too. Do not assume any version is clean.
> - **Request URLs in step titles.** The steps of `request.get(...)` and the other `APIRequestContext` calls show the full request URL in Playwright's HTML report, query string included. The logger cannot mask them: keep secrets out of URLs (send them in headers or the body) or do not share the report.
> - **`error-context.md`.** For failed tests newer Playwright versions attach a page snapshot that includes the current values of form fields (seen on 1.64).
> - **Traces, screenshots and videos** (when enabled) hold raw action parameters and page content.
> - The same raw values are visible to other reporters (`json`, `blob`, `junit`, custom ones) and in Playwright's own error messages and call logs.
>
> `redact.values`, `redact.selectors` and the other `redact` options do not affect Playwright's report, traces or snapshots. What helps: use test-only credentials instead of real secrets; keep `trace`, `screenshot` and `video` off for such tests; do not publish or share `playwright-report/`, `test-results/` and CI artifacts of runs that type real secrets (or restrict who can open them); and check your Playwright version's reporter and artifact options. Whether a given version lets you switch the HTML step titles or `error-context.md` off is up to Playwright, not this logger, and this README does not promise it.

## browserLog options

All options are optional and flat, like `apiLog`. `test.use({ browserLog })` replaces the whole object; `redact` is merged one level deep with the defaults.

An option set to `undefined` uses its default. An unknown option or an invalid value (`print: 'yes'`, `browserConsole: 'verbose'`, `network: 'some'`, `slowActionMs: 'x'`, `redact.fillValues: 'sometimes'`, a `sink` that is not a function, `maxEvents: 0` …) never fails a test: the logger prints a one-time `[playwright-logger-pro]` warning naming the option and uses its default. In particular `maxEvents` must be a positive integer, so a bad value can never silently switch the failure block off.

| Option | Type | Default | Description |
| --- | --- | --- | --- |
| `enabled` | `boolean` | `true` | `false`: no patches, listeners or session for the test. |
| `colors` | `boolean` | auto ([Colors](#colors)) | Colors for `print` only. Files and attachments are always plain text. |
| `actions` | `boolean` | `true` | Interactions and navigations (`click`, `fill`, `goto`, …). |
| `waits` | `boolean` | `true` | `waitFor*`, `locator.waitFor`, `waitForTimeout`. |
| `queries` | `boolean` | `false` | Read-only async calls (`textContent`, `isVisible`, `count`, …). Results are never logged. |
| `mouseMoves` | `boolean` | `false` | `mouse.move` (noisy). |
| `navigation` | `boolean` | `true` | Main-frame navigations, page open/close/popup/crash, dialogs, downloads. |
| `browserConsole` | `false \| 'error' \| 'warning' \| 'info' \| 'all'` | `'warning'` | Minimum console level to record. |
| `pageErrors` | `boolean` | `true` | Uncaught page exceptions. |
| `network` | `false \| 'failed' \| 'documents' \| 'all'` | `false` | Network capture. Subscribing adds protocol traffic, so it is off by default. |
| `networkFilter` | `(r: { url; method; resourceType }) => boolean` | — | Extra filter applied after `network`. |
| `steps` | `boolean \| 'auto'` | `'auto'` | `test.step` integration: on for Playwright 1.48+, unavailable below (see [Compatibility](#compatibility)). `false` turns it off. |
| `includeApiLog` | `boolean` | `true` | Copy apiLog lines into the attachment/file (never printed twice). |
| `logStart` | `boolean` | `false` | Also print a line when an action starts (needs `print: true`). |
| `slowActionMs` | `number` | `1000` | Highlight slower actions; JSONL gets `slow: true`. |
| `location` | `boolean` | `false` | Append the call site in your spec (`(login.spec.ts:14)`) to each action. Costs one stack capture per action. |
| `maxArgLength` | `number` | `200` | Truncate each rendered argument and console message. |
| `maxEvents` | positive integer | `5000` | Ring buffer per test; the oldest events are dropped and a marker says how many. `0`, negative or fractional values warn and use the default. |
| `redact` | `BrowserRedactConfig` | see below | Secret masking. |
| `print` | `boolean \| 'on-failure'` | `'on-failure'` | Print to `sink`: live (`true`) or one block when the test failed. |
| `attach` | `boolean \| 'on-failure'` | `'on-failure'` | Attach `browser-log` to the report. |
| `attachFormat` | `'text' \| 'jsonl'` | `'text'` | |
| `file` | `boolean \| 'on-failure'` | `false` | Write a per-test file. |
| `fileFormat` | `'text' \| 'jsonl'` | `'text'` | |
| `fileDir` | `string` | `testInfo.outputPath()` | Directory for per-test files. Never cleaned by the logger. |
| `sink` | `(line: string) => void` | `console.log` | Where printed text goes. |

"Failed" means the test's status differs from its expected status, so `test.fail()` works and timeouts and interruptions count as failures. Sessions without browser activity (API-only tests) produce no output.

### browserLog.redact

| Option | Type | Default | Description |
| --- | --- | --- | --- |
| `mask` | `string` | `'***'` | Replacement for masked values. |
| `fillValues` | `'auto' \| 'always' \| 'never'` | `'auto'` | Masking of typed values. |
| `selectors` | `(string \| RegExp)[]` | `DEFAULT_SENSITIVE_SELECTORS` | Matched against the target's description (strings: case-insensitive substrings). Added to the defaults; apiLog's `replaceDefaultRedaction: true` replaces them. |
| `values` | `string[]` | `[]` | Literal secrets masked everywhere (plus the ones collected automatically). |
| `keys` | `(string \| RegExp)[]` | sensitive keys | Object keys masked inside arguments. Added to the defaults; apiLog's `replaceDefaultRedaction: true` replaces them. |
| `queryParams` | `string[]` | apiLog's resolved list | Extra query-parameter names masked in printed URLs, added to apiLog's `redactQueryParams` (defaults included). |
| `headers` | `string[]` | apiLog's resolved list | Extra header names, added to apiLog's `redactHeaders` (defaults included). |
| `inspectInputType` | `boolean` | `false` | Opt-in DOM probe, see above. |

## Compatibility

`@playwright/test` >= 1.30, Node.js >= 18, CommonJS and ESM. Verified in CI against 1.30, 1.39, 1.48 and the latest release.

| | 1.30 – 1.38 | 1.39 – 1.47 | >= 1.48 |
| --- | --- | --- | --- |
| Actions on page / frame / locator / keyboard / mouse / context | ✓ | ✓ | ✓ |
| Methods added later (`pressSequentially`, `clock`, …) | skipped when absent | ✓ when present | ✓ |
| Locator descriptions | rewritten from the raw `internal:` selector | readable | readable |
| Step/error locations in the report point at your spec | ✓ | ✓ | ✓ |
| `test.step` markers and step path | — | — | ✓ |
| `mergeTests` with step integration | n/a | ✓ | ✓ |

Before 1.48 `test.step` records the direct caller as the step location, which would be this library, so the integration is left off there; actions are still logged, without step markers.

## How it works

- The public async methods of Playwright's classes are instrumented **once per worker, on the prototypes**. Objects are never wrapped, so `page === context.pages()[0]`, `instanceof` and `expect(locator)` behave exactly as before, and delegated calls (`locator.click` → `frame.click`) are logged once.
- The only listeners added are passive (`console`, `pageerror`, `framenavigated`, `popup`, `close`, `download`, …, and request events when `network` is on). For dialogs, a single listener repeats Playwright's default (dismiss) when nobody else handles the dialog, so a missing handler never hangs a test.
- Wrapper frames are hidden from Playwright's stack attribution, so step and error locations stay in your spec (this also applies to the apiLog fixture).
- Events are redacted when they are recorded; files and attachments never contain ANSI colors.
- The timeline is in chronological order: an action sits at the time it *started*, followed by what happened while it ran (a dialog it opened, a page it closed). With `print: true` the line of a running action is printed when it finishes, and lines that follow it are held until then, so live output has the same order as the failure block (use `logStart: true` for an immediate "started" line).
- The logger never deletes folders, never fails a test because of its own errors (it disables itself for that test and prints one warning), and adds no extra protocol round trips unless you opt in (`network`, `redact.inspectInputType`).

## Roadmap / Planned

- `expect()` assertion logging
- `page.request` / `context.request` traffic

## License

MIT
