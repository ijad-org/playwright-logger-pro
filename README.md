# Playwright Logger Pro

**Documentation:** <https://ijad-org.github.io/playwright-logger-pro/> · [Changelog](CHANGELOG.md)

Colorful **API and browser-action** logging for Playwright. Request/response logging for `APIRequestContext` — optionally with a copy-pastable `curl` command for every request (or only for failures) and secret headers redacted; plus a per-test timeline of what a test did in the browser, with secrets masked, attached to the report when a test fails.

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
2. **On** when `FORCE_COLOR` (any other value) or `DEBUG_COLORS` is set. `playwright test` sets both for its workers, so the logger emits colors even though the workers' stdout is a pipe. Whether you *see* them depends on Playwright's reporter (see the note below).
3. **On** when `PLAYWRIGHT_FORCE_TTY` is set (anything but `0`/`false`).
4. **On** when stdout or stderr is a TTY (unless `TERM=dumb`); **off** otherwise.

If your runner or CI does not set `FORCE_COLOR` for the workers and the output is piped, colors are off. Force them with `colors: true`, which also wins over `NO_COLOR`:

```ts
use: { apiLog: { colors: true } }
```

> **Note:** `colors: true` only controls what the logger writes. On Playwright 1.64 (checked on 1.64.1), when the reporter's own output is piped (not a TTY), Playwright strips every ANSI code from the test stdout it forwards, so the console shows no colors even with `colors: true`. Run in a terminal, or send the lines to a `sink` (a file, an attachment): the `sink` receives them with the colors intact.

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
| URLs | The password in `https://user:pass@host` is always masked. **Query strings are not masked by browserLog yet**: put tokens that appear in URLs into `redact.values`. |
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

**Custom field names.** Extend the defaults rather than replacing them:

```ts
import { DEFAULT_SENSITIVE_SELECTORS } from 'playwright-logger-pro';

use: { browserLog: { redact: { selectors: [...DEFAULT_SENSITIVE_SELECTORS, '#pin-pad'] } } }
```

**Strict CI:** `redact: { fillValues: 'always' }` masks every typed value (`'never'` masks none; `redact.values` still applies).

**Query strings.** Only learned and configured values are masked in URLs; there is still no masking by query-parameter name. A token the page puts in a URL that the test never typed or configured needs `redact.values`.

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
| `selectors` | `(string \| RegExp)[]` | `DEFAULT_SENSITIVE_SELECTORS` | Matched against the target's description (strings: case-insensitive substrings). Replaces the default list; spread the default to extend it. |
| `values` | `string[]` | `[]` | Literal secrets masked everywhere (plus the ones collected automatically). |
| `keys` | `(string \| RegExp)[]` | sensitive keys | Object keys masked inside arguments. |
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
- Query-string redaction for browserLog
- Opt-in body-key redaction defaults for apiLog (its request bodies can contain `password` fields today; see `DEFAULT_SENSITIVE_KEYS`)

## License

MIT
