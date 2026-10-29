# Changelog

## 0.2.0

### Added

- **Browser action logging (`browserLog`).** A per-test timeline of what the test did in the browser: actions on page, frame, locator, keyboard, mouse, touchscreen, context and browser, navigations, console messages, page errors, popups, downloads, dialogs, optional network, `test.step` boundaries, and a duration for every action. See the README section *Browser action logging*.
- **`playwright-logger-pro/fixtures` now provides both loggers.** New `browserLog` option fixture, `browserLogger` fixture (`note()`, `events()`, `render()`), `LoggerOptions` type for `defineConfig<LoggerOptions>()`, and a `mergeTests` that keeps the step integration (Playwright 1.39+).
- `attachBrowserLogger(pageOrContext, config?)` for pages you manage yourself (scripts, global setup, a page shared from `beforeAll`).
- Secret masking by default: `fill()`/`type()` into password-like targets, keyboard input after such a target, literal `redact.values`, sensitive object keys inside arguments, header/cookie/credential values, URL userinfo passwords, console text and page errors. Opt-in `redact.inspectInputType` DOM probe. One shared sensitive-key list (`DEFAULT_SENSITIVE_KEYS`) for both loggers.
- Outputs: live `print`, an `'on-failure'` block, a `browser-log` report attachment (text or JSONL), and per-test files (`file`, `fileFormat`, `fileDir`). ANSI never reaches files or attachments.
- apiLog lines are copied into the browser log's attachment and files (`includeApiLog`), never printed twice.
- CI matrix (Playwright 1.30 / 1.39 / 1.48 / latest, Chromium; latest also Firefox and WebKit), a weekly prototype-drift job, a package check (`publint`, `attw`, CJS and ESM smoke tests) and an overhead benchmark.

### Changed

- **`browserLog` is enabled by default, with quiet defaults**: nothing is printed or attached while a test passes; on failure the timeline is printed once and attached to the report. Opt out per project or suite with `browserLog: { enabled: false }`. When disabled, no page-level patch or listener is installed for that test.
- **Step locations stay in your spec file.** Wrapper frames of this library are hidden from Playwright's stack attribution, which also fixes `request.*` steps and errors of the existing apiLog fixture (they used to point into `dist/`).
- On Playwright 1.30–1.48 the step title of a logged request is `apiRequestContext.get(...)` again (it was `apiRequestContext.apply(...)`).
- `package.json` `exports` now has per-condition types (`.d.mts` for `import`, `.d.ts` for `require`) and exposes `./package.json`; the build targets Node 16 syntax and ships shims for `__dirname`/`import.meta.url`.
- `redactHeaders()` accepts an optional third argument (the mask, default `***`).

### Fixed (QA findings on this release)

- **PCL-30 (critical): typed secrets are learned.** A value typed into a field that is masked in its action line (`fill`, `type`, `pressSequentially`, `keyboard.type`, `insertText`, prompt answers) is now masked everywhere the logger outputs, for the rest of the test: console messages, page errors, network and navigation URLs (query strings included, also percent-encoded), dialog text, notes, attachment, files, JSONL and sink events. Values shorter than 4 characters are not learned. Query-string redaction by parameter name is still not a feature.
- **PCL-31: card fields.** `#card`, `[name=cardnumber]`, `[autocomplete=cc-number]`, `getByLabel('Card')`, `getByLabel('Credit card')`, `#cvc`, `#securityCode`, `#totp` … are detected from the selector. `inspectInputType` stays off by default.
- **PCL-32: Authorization tokens.** `Bearer X` / `Basic …` / `Token X` set through `setExtraHTTPHeaders` (or the `extraHTTPHeaders` option) also masks the bare token `X`, the decoded Basic password and the values of a `Cookie` header.
- **PCL-33 (docs): Playwright-owned artifacts.** The README now says that HTML report step titles, `error-context.md` and traces can contain raw values even with traces off, and that `redact.*` does not affect them.
- **PCL-34: malformed `test.step` location.** Stack frames without parentheses (`at /abs/file.ts:11:5`) no longer keep the `at ` prefix; `file://` URLs and Windows paths are handled.
- **PCL-35: `location: true`** reports the spec file and line instead of this library's `dist/` file (library, Playwright and node frames are skipped).
- **PCL-36: option validation.** `browserLog` warns once on unknown options and on invalid types or values and falls back to the defaults; `maxEvents` of `0`, negative or fractional values no longer suppress the failure block.
- **PCL-37: `inspectInputType` status.** A fill that completed is reported as completed (value still masked) when the test ends before the probe answers, not as "still pending".
- **PCL-38: chronological timeline.** Actions are ordered by their start, followed by the events that happened while they ran, in the stored events, the failure block and live output. A page's "opened" line carries the time the page appeared.
- **PCL-39 (critical): more spellings of a learned secret are masked.** On top of the literal value and the percent-encoded and plain `JSON.stringify` forms, each learned secret (typed values, `addCookies`, `setExtraHTTPHeaders`, `setHTTPCredentials`) is now also masked as JSON with escaped slashes (`\/`), as `\uXXXX` JSON (PHP `json_encode` defaults, Python `ensure_ascii`, every character escaped; lower and upper case hex, surrogate pairs as two escapes) and as legacy `escape()` (`%XX` / `%uXXXX`, both hex cases). The variants are computed once when a secret is learned and deduplicated. The README lists exactly these forms.
- **PCL-40 (docs): masking is literal-form based.** Base64, double encoding, HTML entities, values split across `console.log` arguments and fragments typed with `keyboard.type()` mid-field are not detected; the README limits section says so and what to do instead (`redact.values`, turning off the console and network channels, not logging such values).
- **PCL-41: expiry and PAN fields.** `autocomplete` `cc-exp`, `cc-exp-month`, `cc-exp-year`, `cc-csc`, and names, ids, labels or placeholders such as "Expiry date", "Expiration", "Exp date", "card expiry", "PAN" and "card number" are treated as sensitive. Whole words only, so `company`, `panel` or `expires in` stay clear.
- **PCL-42 (docs): server-set cookies.** Cookies set by a `Set-Cookie` response header are not learned or masked; documented in the limits section.
- **PCL-43: Playwright 1.64 types.** `httpCredentials` may be an array (one entry per origin); every password in it is collected. `mergeTests` is typed so that `src/fixtures.ts` also compiles against the 1.30 types. Typecheck and build verified against the lowest supported and the latest `@playwright/test` types.

### Known limitations

- Secret masking is literal-form based: base64, double encoding, HTML entities, values split across `console.log` arguments, and fragments typed with `keyboard.type()` mid-field are not detected, and cookies set by the server with `Set-Cookie` are not masked. Use `redact.values`, turn off the console and network channels, or avoid logging such values.
- Playwright's own artifacts record raw action parameters and page state, **even with traces off**: HTML report step titles (newer versions: `Fill "<value>"`), the `error-context.md` snapshot, traces, screenshots and videos. This logger only redacts its own outputs; `redact.*` does not affect Playwright's. See the README for what helps.
- `test.step` integration needs Playwright 1.48+ (older versions cannot keep the step location); actions are still logged there, without step markers.
- A password field whose selector, label and placeholder do not look like one is only detected with `redact.inspectInputType: true`, `redact.values`, a custom `redact.selectors` entry, or `redact.fillValues: 'always'`.
