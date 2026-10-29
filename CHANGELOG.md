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

### Known limitations

- Playwright's own traces, HTML-report step parameters and `error-context.md` record raw action parameters (including values typed into password fields). This logger only redacts its own outputs.
- `test.step` integration needs Playwright 1.48+ (older versions cannot keep the step location); actions are still logged there, without step markers.
- A password field whose selector, label and placeholder do not look like one is only detected with `redact.inspectInputType: true`, `redact.values`, a custom `redact.selectors` entry, or `redact.fillValues: 'always'`.
