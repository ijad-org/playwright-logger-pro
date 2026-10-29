# PLAN — Browser / page-action logging (`browserLog`)

Status: proposal · Target release: `0.2.0` · Branch: `feat/browser-logging` · Date: 2026-10-29

---

## 1. Context

Playwright Logger Pro currently logs only `APIRequestContext` traffic: `wrapRequestContext()` in `src/wrapRequestContext.ts`, applied to the built-in `request` fixture in `src/fixtures.ts`. The README roadmap promises "Browser action logging (page actions, with secret redaction)".

**Outcome we want:** a per-test timeline of what the test did in the browser:

- actions on page, frame, locator, keyboard and mouse
- navigations, console messages and page errors
- network (optional)
- `test.step` boundaries
- a duration for every action

It must meet these requirements:

- Secrets are masked by default.
- Output is coloured on a TTY.
- Files contain clean plain text or JSONL.
- The log is attached to the Playwright report.
- Turning it off costs nothing.
- It ships as CJS and ESM.
- It works with Playwright ≥ 1.30.
- One import (`playwright-logger-pro/fixtures`) gives both API and browser logging.

**Non-goals (v0.2):**

- logging `expect()` assertions
- logging return values of queries
- `page.request` / `context.request` traffic (apiLog's territory; see follow-ups)
- route-handler calls (`route.fulfill/continue`)
- Workers and ServiceWorkers
- Electron and Android
- screenshots and videos (Playwright already records them)
- redacting Playwright's own trace or HTML-report data

---

## 2. Starting point

### 2.1 Existing code we reuse

| Existing | Where | Reuse |
| --- | --- | --- |
| Flat config + `DEFAULT_CONFIG` + `resolveConfig()` | `src/types.ts:5-45` | Same pattern: `BrowserLoggerConfig`, `DEFAULT_BROWSER_CONFIG`, `resolveBrowserConfig()` |
| `palette(colors)` (private) | `src/format.ts:17` | Export it internally (not from `index.ts`) and extend it with browser colours. Network status colouring reuses `palette().status` |
| `redactHeaders()` | `src/format.ts:52` | Move it to the new `src/redact.ts` and add an optional `mask` param (default `'***'`). Re-export it from `format.ts` and `index.ts` so the public API doesn't change. `curl.ts` imports from `./redact` |
| `truncateBody()` / `stringifyBody()` | `src/format.ts:64-79` | Truncating args and console text |
| Option fixture `[{}, { option: true }]` | `src/fixtures.ts:18` | `browserLog: [{}, { option: true }]` |
| `enabled: false` returns the target untouched | `src/wrapRequestContext.ts:37` | Same no-op contract |
| tsup dual build, `picocolors` | `tsup.config.ts`, `package.json` | No new runtime deps. picocolors works from both CJS and ESM |
| node:test + tsx unit tests | `test/*.test.ts` | Same harness for the new unit tests |

Query-string redaction does **not** exist today; only header redaction does. It is added in `src/redact.ts`, used by browserLog, and offered to apiLog as an opt-in `redactQuery` option (§7.6).

### 2.2 Verified Playwright internals

I read these in the Playwright 1.64.1 source on this machine. The design depends on them.

1. **Stack attribution.** `ChannelOwner._wrapApiCall` captures the JS stack synchronously when an API is entered. `filterStackFile` then drops only frames under `playwright-core` and the "boxed stack prefixes". The runner uses the remaining `frames[0]` as the `pw:api` step location. On error it rebuilds `e.stack` from those frames.
   - Consequence: any wrapper between the test and Playwright (a Proxy or a patched method) becomes the step location and the top of the error stack.
   - The existing `wrapRequestContext` Proxy most likely already attributes `request.*` steps to our `dist/` file. M0 will confirm this.
2. `setBoxedStackPrefixes(prefixes)` is exported from `playwright-core/lib/coreBundle` (`.utils`). It **replaces** the list and has no getter. Playwright sets it to `[<playwright package root>]` when a worker starts.
3. Nested public calls share one "api zone": `page.click` → `frame.click` and `locator.click` → `frame.click` are reported as one step. Our hooks must dedupe in the same way.
4. The client instrumentation listener (`onApiCallBegin`) has the signature `(apiZone, { type, method, params })` with protocol-level params in 1.64 (e.g. `Frame.fill { selector:"internal:label=…", value }`). Older versions used different signatures. It is the runner's private hook, so it is rejected as the primary mechanism (§5.1).
5. Workers run with `FORCE_COLOR=1` and piped stdout, so `process.stdout.isTTY` is falsy there. That means today's `DEFAULT_CONFIG.colors` (`src/types.ts:33`) is effectively **always false inside test workers**. Fixed in §8.1.
6. `test.step(title, body, { location })` is honoured: the step's stack comes from `options.location`. This is a public option (≥ 1.48).
7. Adding a `dialog` listener disables Playwright's auto-dismiss, and adding a `filechooser` listener turns on file-chooser interception. **We must never add either listener.**

---

## 3. Architecture

```
playwright-logger-pro/fixtures
  test = wrapTestType(base.extend({ apiLog, browserLog, _plpSession(auto), context, browser(worker), request, browserLogger }))
                │
                ▼
     BrowserLogSession (one per test)  ◄── events are redacted at capture time
      │  ring buffer · clock · pending actions · page ids · step path (ALS)
      ├─► render.ts  → text (palette on/off) | JSONL
      └─► output.ts  → print (sink) | testInfo.attach | file
                ▲
   install.ts (once per worker, idempotent, global singleton)
      patches public async methods on the prototypes of
      Page · Frame · Locator · Keyboard · Mouse · Touchscreen · BrowserContext · Browser · Dialog · Download · ElementHandle · Clock
   listeners.ts (per attached page/context, passive only)
      console · pageerror · framenavigated · popup · close · crash · download · [request/response/requestfailed]
   steps.ts   test.step wrapper → step events + ALS step path
   stackHygiene.ts  hides our own frames from Playwright's stack attribution
```

---

## 4. Public API

### 4.1 Fixtures — one import gives both loggers

```ts
// src/fixtures.ts (shape)
export interface ApiLoggerOptions { apiLog: ApiLoggerConfig }            // unchanged
export interface BrowserLoggerOptions { browserLog: BrowserLoggerConfig } // new
export type LoggerOptions = ApiLoggerOptions & BrowserLoggerOptions;      // new, for defineConfig<LoggerOptions>()
export interface BrowserLoggerFixtures { browserLogger: BrowserLogHandle } // new: notes + access to events

export const test = wrapTestType(base.extend<LoggerOptions & BrowserLoggerFixtures & Internal>({
  apiLog:     [{}, { option: true }],
  browserLog: [{}, { option: true }],
  _plpSession: [async ({ browserLog, apiLog, httpCredentials, extraHTTPHeaders }, use, testInfo) => {
    const cfg = resolveBrowserConfig(browserLog, { apiLog, httpCredentials, extraHTTPHeaders });
    if (!cfg.enabled) return use(null);                 // true no-op: nothing installed, no listeners
    const session = startSession(cfg, testInfo);        // becomes registry.activeSession
    try { await use(session); } finally { await session.finish(testInfo); }
  }, { auto: true }],                                   // add box:true where the runner supports it (version-gated)
  context: async ({ context, _plpSession }, use) => {
    _plpSession?.attachContext(context);                // installs patches lazily, registers context + its pages
    await use(context);
    _plpSession?.endCapture();                          // ignore Playwright's own fixture teardown (tracing, close)
  },
  browser: [async ({ browser }, use) => {               // worker scope; only runs if a test uses the browser
    installBrowserHooks(browser);                       // browser.newContext/newPage auto-attach while a session is active
    await use(browser);
  }, { scope: 'worker' }],
  request: async ({ request, apiLog, _plpSession }, use) => {
    await use(wrapRequestContext(request, _plpSession?.teeApiLog(apiLog) ?? apiLog));
  },
  browserLogger: async ({ _plpSession }, use) => use(_plpSession?.handle ?? NOOP_HANDLE),
}));
export const mergeTests = /* wrapped base mergeTests (≥1.39) */;
export { expect } from '@playwright/test';
```

Notes:

- **Why `context` and not `page`.** Overriding `context` covers the default page, popups and any `context.newPage()`. The base `page` fixture is created through the patched `context.newPage`, after we've registered the context.
- **Why `_plpSession` is `auto`.** Tests that never touch a page (API-only) still get a session, but it records nothing and outputs nothing. Creating it costs one small object.

### 4.2 `BrowserLoggerConfig` (`src/browser/types.ts`)

All options are flat to match `ApiLoggerConfig`. As with apiLog, `test.use({ browserLog })` replaces the whole object. The exception is `redact`, which `resolveBrowserConfig` merges one level deep with the defaults.

| Option | Type | Default | Meaning |
| --- | --- | --- | --- |
| `enabled` | `boolean` | `true` | `false` means no patches, listeners or session for that test |
| `colors` | `boolean` | `detectColors()` | Colours for `print` only. Files and attachments are always plain |
| `actions` | `boolean` | `true` | Interactions and navigations (`click`, `fill`, `goto`, …) |
| `waits` | `boolean` | `true` | `waitFor*`, `locator.waitFor`, `waitForTimeout` |
| `queries` | `boolean` | `false` | Read-only async calls (`textContent`, `isVisible`, `count`, `inputValue`, …). Their results are never logged |
| `mouseMoves` | `boolean` | `false` | `mouse.move` (noisy) |
| `navigation` | `boolean` | `true` | Main-frame navigations, page open/close/popup/crash, dialogs, downloads |
| `browserConsole` | `false \| 'error' \| 'warning' \| 'info' \| 'all'` | `'warning'` | Minimum console level to record |
| `pageErrors` | `boolean` | `true` | Uncaught page exceptions |
| `network` | `false \| 'failed' \| 'documents' \| 'all'` | `false` | `failed` = request failures and status ≥ 400; `documents` = document/xhr/fetch |
| `networkFilter` | `(r: { url; method; resourceType }) => boolean` | — | Extra filter applied after `network` |
| `steps` | `boolean \| 'auto'` | `'auto'` | `test.step` integration. `'auto'` means on for Playwright ≥ 1.48, off below (§5.8) |
| `includeApiLog` | `boolean` | `true` | Copy apiLog lines into this test's file/attachment (never re-printed) |
| `logStart` | `boolean` | `false` | Also print a line when each action starts. Otherwise one line on completion |
| `slowActionMs` | `number` | `1000` | Highlight slow actions. JSONL gets `slow: true` |
| `location` | `boolean` | `false` | Append `(login.spec.ts:14)`. Costs one stack capture per action |
| `maxArgLength` | `number` | `200` | Truncate each rendered argument |
| `maxEvents` | `number` | `5000` | Ring buffer per test. The oldest events are dropped and a `dropped` marker is added |
| `redact` | `BrowserRedactConfig` | see §4.3 | Secret masking |
| `print` | `boolean \| 'on-failure'` | `'on-failure'` | Print to `sink`. `'on-failure'` buffers and prints one block if the test failed |
| `attach` | `boolean \| 'on-failure'` | `'on-failure'` | `testInfo.attach('browser-log', …)` |
| `attachFormat` | `'text' \| 'jsonl'` | `'text'` | |
| `file` | `boolean \| 'on-failure'` | `false` | Write a per-test file |
| `fileFormat` | `'text' \| 'jsonl'` | `'text'` | |
| `fileDir` | `string` | — | Default: `testInfo.outputPath()`. Never cleaned by us |
| `sink` | `(line: string) => void` | `console.log` | Same contract as `apiLog.sink` |

"Failed" means `testInfo.status !== testInfo.expectedStatus`, so `test.fail()` is handled correctly, and timedOut/interrupted count as failures.

### 4.3 `BrowserRedactConfig`

| Option | Type | Default | Meaning |
| --- | --- | --- | --- |
| `mask` | `string` | `'***'` | Same mask as header redaction today |
| `fillValues` | `'auto' \| 'always' \| 'never'` | `'auto'` | Masking of text-entry values (§7.2) |
| `selectors` | `(string \| RegExp)[]` | `DEFAULT_SENSITIVE_SELECTORS` | Matched against the target's description. Strings are case-insensitive substrings |
| `values` | `string[]` | `[]` plus auto-collected (§7.4) | Literal secrets masked **everywhere** |
| `keys` | `(string \| RegExp)[]` | `DEFAULT_SENSITIVE_KEYS` | Object keys masked inside args (`evaluate` args, cookies, options) |
| `headers` | `string[]` | `apiLog.redactHeaders` if set, else `DEFAULT_CONFIG.redactHeaders` | Reuses the apiLog list |
| `query` | `string[]` | `apiLog.redactQuery` if set, else `DEFAULT_REDACT_QUERY` | URL query/hash params to mask |
| `inspectInputType` | `boolean` | `false` | Opt-in DOM probe for `type=password` (§7.3) |

The defaults are exported so users can extend them: `selectors: [...DEFAULT_SENSITIVE_SELECTORS, '#pin-pad']`.

### 4.4 Manual API (`playwright-logger-pro`)

This mirrors Option B, `wrapRequestContext()`:

```ts
export function attachBrowserLogger(target: Page | BrowserContext, config?: BrowserLoggerConfig): BrowserLogHandle;

export interface BrowserLogHandle {
  note(message: string): void;                       // custom line in the timeline (redacted)
  events(): readonly BrowserLogEvent[];              // redacted, structured
  render(format?: 'text' | 'jsonl'): string;         // plain text, never ANSI
  detach(): void;                                    // remove listeners/registry entries (patches stay, inert)
}
export type { BrowserLoggerConfig, BrowserRedactConfig, BrowserLogEvent, ResolvedBrowserConfig };
export { DEFAULT_BROWSER_CONFIG, DEFAULT_SENSITIVE_SELECTORS, DEFAULT_SENSITIVE_KEYS, DEFAULT_REDACT_QUERY,
         resolveBrowserConfig, renderBrowserEventText, renderBrowserEventJsonl };
```

- **Outside a test** (scripts, global setup), the handle prints live to `sink`. `'on-failure'` is treated as `true`.
- **Inside a test** with an active fixture session (e.g. a shared page from `beforeAll`), events are routed into that test's session. They then follow the session's print/attach/file rules, and one test's log never bleeds into another's.

### 4.5 Configuration examples

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

---

## 5. Capture design

### 5.1 Mechanism: prototype-level instrumentation of public methods

We patch the **public async methods** on each class's prototype once per worker. The prototypes are discovered from live instances; we never import Playwright internals for this. Objects are **not** wrapped. Three alternatives were rejected:

| Option | Why not |
| --- | --- |
| Proxy around the `page` fixture (a naive Proxy-based page logger) | Only covers `page`. Locators, frames, popups and `context.pages()` come back unwrapped unless every return value is wrapped. Wrapping breaks identity (`page !== context.pages()[0]`). The wrapper frame also hijacks step locations (§2.2-1) |
| Runner instrumentation listener (`playwright._instrumentation`) | Private API with at least three historical signatures. Params are protocol-level (`internal:label=…`), and old versions provide no params at all, so ≥ 1.30 would get names only |
| Reporter `onStepBegin/End` | Runs in the main process. Not live per worker, no console/page-error access, and needs a separate reporter entry |

Patching public methods gives:

- user-level arguments (the Locator object, the `value` string), so redaction and rendering use the user's vocabulary
- the same behaviour from 1.30 to latest, because method names are semver-stable public API
- full coverage of every Locator/Frame/Page instance, including popups and pages from `browser.newPage()`
- unchanged `===`, `instanceof` and `expect(locator)`

The one downside, stack attribution, is handled in §5.5. The capture backend is behind an internal `ActionSource` interface (`beginAction/endAction`), so the instrumentation listener could be added later without touching redaction or output.

### 5.2 Prototype discovery and patching (`src/browser/install.ts`, `src/browser/methods.ts`)

- On the first `attachContext`/`attachPage` in a worker:
  - `Page` ← `Object.getPrototypeOf(page)`
  - `Frame` ← `page.mainFrame()`
  - `Locator` ← `page.locator('html')` (synchronous and local; no protocol call)
  - `Keyboard`/`Mouse`/`Touchscreen` ← `page.keyboard`/`page.mouse`/`page.touchscreen`
  - `Clock` ← `page.clock` if present
  - `BrowserContext` ← `page.context()`
  - `Browser` ← `context.browser()` (may be `null` for persistent contexts)
- `Dialog`, `Download` and `ElementHandle` prototypes are patched lazily, the first time an instance is seen (§5.6).
- `methods.ts` holds one table per type: `name → { category: 'action'|'wait'|'query'|'navigation', args: ArgSpec }`. A method is patched only if `typeof proto[name] === 'function'`, so methods missing in older versions (`pressSequentially`, `clear`, `addLocatorHandler`, …) are skipped automatically.
- `patchMethod()` defines the wrapper as an **own** property of the concrete prototype with `Object.defineProperty`. This shadows inherited members without touching shared base classes such as `ChannelOwner`/`EventEmitter`. The wrapper:
  - keeps `name`
  - sets a `PATCHED` symbol pointing at the original
  - skips methods that already carry `PATCHED` (idempotent)

```ts
const wrapped = function (this: object, ...args: unknown[]) {
  const reg = registry(); const store = reg.als.getStore();
  if (store?.inAction) return Reflect.apply(original, this, args);          // nested call → pass through
  const owner = reg.resolveOwner(this, spec.target);                         // WeakMap lookups only
  if (!owner) return Reflect.apply(original, this, args);                    // not attached → pass through
  const rec = safe(() => owner.session.beginAction(this, name, spec, args)); // never throws into the test
  return reg.als.run({ ...store, inAction: true }, () => {
    let result;
    try { result = Reflect.apply(original, this, args); }
    catch (e) { safe(() => owner.session.endAction(rec, e)); throw e; }
    if (isThenable(result)) result.then(() => safe(() => owner.session.endAction(rec)),
                                        (e) => safe(() => owner.session.endAction(rec, e)));
    else safe(() => owner.session.endAction(rec));
    return result;                                                           // the *original* promise, untouched
  });
};
```

Guarantees:

- The original is called exactly once, with the same `this` and args.
- The return value or rejection is identical, and the thrown error object is never mutated.
- Our `.then` handles both outcomes, so it never creates an unhandled rejection.
- Any internal logger error disables capture for that session and prints one warning line.

### 5.3 Ownership and gating (`src/browser/registry.ts`)

- The singleton lives at `globalThis[Symbol.for('playwright-logger-pro/browser@1')]`. It holds:
  - `als`
  - `pages: WeakMap<Page, Binding>` and `contexts: WeakMap<BrowserContext, Binding>`
  - `ownerOf: WeakMap<object, Page>` for keyboard, mouse, touchscreen, clock, dialog, download and element handles
  - `activeSession`
  - `installed: WeakSet<object>` of patched prototypes

  Because it is global, a CJS copy and an ESM copy loaded in the same worker share one registry and never double-patch.
- `Binding = { session, pageId }`. Page ids are `page#1…n` per session, assigned in `context.on('page')` order. They are only shown when the session has more than one page.
- `resolveOwner(this, target)`:

  | Target | Lookup |
  | --- | --- |
  | page | `pages.get(this)` |
  | frame / locator | `pages.get(this.page())` (guarded) |
  | keyboard, mouse, touchscreen, clock, dialog, download, elementHandle | `pages.get(ownerOf.get(this))` |
  | context | `contexts.get(this)` |
  | browser | `activeSession` (auto-attach only) |

- Anything not attached passes straight through. That covers contexts from `beforeAll`, other fixtures' private contexts, and objects in tests with `enabled: false`.
- **Auto-attach.** The patched `browser.newContext()`/`browser.newPage()` register the new context with `activeSession` when there is one. `context.on('page')` registers popups and new pages. Each test's `context` fixture is registered by our override.

### 5.4 Re-entrancy and dedupe

Playwright delegates internally:

- `page.click` → `mainFrame.click`
- `locator.click` → `frame.click(selector, { strict: true })`
- `locator.clear` → `locator.fill('')`
- `locator.selectText` / `screenshot` → `elementHandle.*` **after an await**

An `AsyncLocalStorage` store `{ inAction, step }`, set by the outermost wrapper, makes every nested patched call a pass-through. A synchronous depth counter would not catch the post-await delegations. `Promise.all([...])` at the user level produces separate contexts, so both calls are logged. Event callbacks (`page.on(...)`, route handlers) are dispatched from the connection, not from inside our store, so they are not suppressed. ALS is available on every Node version that Playwright ≥ 1.30 supports.

### 5.5 Stack hygiene (`src/browser/stackHygiene.ts`) — also fixes apiLog

Our wrapper frames must stay out of Playwright's stack attribution (§2.2-1). Otherwise step locations in the HTML report, the trace viewer's Source tab, and error stacks would point at `node_modules/playwright-logger-pro/dist/*.js`.

1. `LIB_DIR` is the directory of our compiled modules (`dist/`, or `src/` when running from this repo). It is **not** the package root, so the repo's own spec files are never hidden.
2. Resolve Playwright from the user's install: `createRequire(require.resolve('@playwright/test'))`. Our package does not depend on `playwright-core`, and pnpm's strict layout would otherwise hide it. Then try these adapters in order:
   - **a.** `playwright-core/lib/coreBundle` → `utils.setBoxedStackPrefixes`. There is no getter, so we pass `[<dirname of playwright/package.json>, LIB_DIR]` to rebuild Playwright's own entry. Verified to exist in 1.64.
   - **b.** `playwright-core/lib/utils` → `setBoxedStackPrefixes` or `addInternalStackPrefix(LIB_DIR)`. For older versions; M0 records which version has which.
   - **c.** If neither works, fall back: our wrapper removes lines containing `LIB_DIR` from errors' `stack` before Playwright's reporter sees them, and with `DEBUG=plp` it logs one warning. Step locations stay wrong in this case; this is documented and covered by tests.
3. Registration is idempotent and runs whenever apiLog **or** browserLog is enabled. The existing `request` Proxy therefore gets correct step locations too (§2.2-1).

### 5.6 Interception per object type

| Object | How the prototype is obtained | Mechanism | Logged methods (category) | Description |
| --- | --- | --- | --- | --- |
| **Page** | `getPrototypeOf(page)` | prototype patch | action: `goto reload goBack goForward setContent close bringToFront click dblclick tap fill type press check uncheck setChecked hover focus selectOption setInputFiles dragAndDrop dispatchEvent evaluate evaluateHandle addScriptTag addStyleTag addInitScript exposeFunction exposeBinding route unroute routeFromHAR setViewportSize emulateMedia setExtraHTTPHeaders screenshot pdf pause addLocatorHandler removeLocatorHandler` · wait: `waitForSelector waitForLoadState waitForURL waitForNavigation waitForTimeout waitForFunction waitForRequest waitForResponse waitForEvent` · query: `title content textContent innerText innerHTML inputValue getAttribute isVisible isHidden isEnabled isDisabled isEditable isChecked` | `page` / `page#2` |
| **Frame** | `page.mainFrame()` | prototype patch | Same selector-based subset as Page, plus `goto setContent waitForURL waitForNavigation waitForLoadState evaluate`. Page→mainFrame delegation is deduped | `frame("name")`, or `frame(<url>)` if unnamed |
| **Locator** | `page.locator('html')` | prototype patch | action: `click dblclick tap fill clear type pressSequentially press check uncheck setChecked hover focus blur selectOption selectText setInputFiles dragTo dispatchEvent scrollIntoViewIfNeeded screenshot highlight evaluate evaluateAll evaluateHandle` · wait: `waitFor` · query: `textContent innerText innerHTML inputValue getAttribute isVisible isHidden isEnabled isDisabled isEditable isChecked count boundingBox allTextContents allInnerTexts ariaSnapshot all` | `String(locator)`, normalised: strip a `Locator@` prefix (older versions). Fallback `locator(<?>)` |
| **FrameLocator** | — | not patched (factory only) | The locators it creates are Locators, so they are covered. The description includes the frame chain (`frameLocator('#pay').getByLabel('Card')`) | — |
| **Keyboard** | `page.keyboard` | prototype patch, owner via `ownerOf` | `down up press type insertText` | `keyboard` |
| **Mouse** | `page.mouse` | prototype patch | `click dblclick down up wheel`, plus `move` when `mouseMoves` | `mouse` |
| **Touchscreen** | `page.touchscreen` | prototype patch | `tap` | `touchscreen` |
| **Clock** (if present) | `page.clock` | prototype patch | `install fastForward runFor pauseAt resume setFixedTime setSystemTime` | `clock` |
| **BrowserContext** | `page.context()` | prototype patch | `newPage close addCookies clearCookies grantPermissions clearPermissions setGeolocation setOffline setExtraHTTPHeaders setHTTPCredentials route unroute routeFromHAR addInitScript exposeBinding exposeFunction storageState` · wait: `waitForEvent` | `context` |
| **Browser** | `context.browser()` / worker `browser` fixture | prototype patch | `newContext newPage` (logged, and auto-attaches) | `browser` |
| **Dialog** | First instance seen through the emit shadow (§5.7) | lazy prototype patch | `accept(promptText) dismiss` | `dialog(alert "…")` |
| **Download** | First `download` event | lazy prototype patch | `saveAs(path)` (`path`, `failure`, `createReadStream` are not logged) | `download("file.pdf")` |
| **ElementHandle** | First handle returned by a patched `$`, `waitForSelector` or `elementHandle` (owner recorded in `ownerOf`) | lazy prototype patch | `click dblclick tap fill type press check uncheck setChecked hover focus selectOption selectText setInputFiles scrollIntoViewIfNeeded screenshot dispatchEvent` | `handle(<selector it came from>)` |
| **APIRequestContext** | — | Not here: the `request` fixture goes through apiLog. `page.request` is out of scope | — | — |

Sync getters and factories (`locator`, `getBy*`, `first`, `nth`, `filter`, `url()`, `frames()`, `viewportSize()`, `on/off`) are never patched. They do no work and would flood the log.

### 5.7 Passive events (`src/browser/listeners.ts`)

These are attached per registered context/page and removed on `detach` and at session end. None of them change Playwright's behaviour.

| Source | Event | Recorded as |
| --- | --- | --- |
| context | `page` | Register the page and assign an id. `page#2 opened` (popups also log their opener) |
| page | `framenavigated` (main frame only) | `navigation` with the redacted URL. Consecutive duplicate URLs are deduped, and the line is dropped if it repeats the URL of an in-flight `goto/reload/goBack/goForward` |
| page | `console` | `console` with `msg.type()`, `msg.text()` (redacted, truncated) and `msg.location()`. Everything is synchronous; `msg.args()` handles are never resolved |
| page | `pageerror` | `pageerror` with message and the first 5 stack lines (redacted) |
| page | `close`, `crash` | lifecycle |
| page | `download` | `download` (suggested filename and URL) and registers the Download owner |
| context | `request` / `response` / `requestfailed` (only when `network` ≠ false) | `network` with method, redacted URL, `resourceType`, status (`response.status()`, sync), time from our own request→response timestamps and `failure().errorText`. **No** `await request.response()`, because that is an API call and would add report steps |
| dialogs | Shadow `emit` on `Page.prototype` and `BrowserContext.prototype` (own property; return value preserved) | `dialog` with type and message (redacted). Records `ownerOf(dialog)`, dedupes with a WeakSet and patches `Dialog.prototype` lazily. Auto-dismiss still happens because we add no listener. Playwright's own auto `dismiss()` call shows up as a `dialog.dismiss()` line |

Never subscribed: `dialog` and `filechooser` (§2.2-7); `request*` unless `network` is on, because subscribing adds protocol traffic for every resource.

### 5.8 `test.step` integration (`src/browser/steps.ts`)

- `wrapTestType(t)` returns `t` with these overridden:
  - `step`, preserving `step.skip` and other static props
  - `extend`, so that `ourTest.extend(...)` stays wrapped all the way down
  - an exported `mergeTests` wrapper, if base has `mergeTests` (≥ 1.39)
- The wrapped `step(title, body, options)`:
  1. captures the caller's location with `Error.captureStackTrace` (first frame outside `LIB_DIR`)
  2. calls the original with `{ ...options, location: options?.location ?? callerLocation }`, so the report's step location stays the user's line (§2.2-6)
  3. runs `body` inside `als.run({ ...store, step: [...path, title] })`
  4. records `step start` and `step end` (passed/failed/skipped, duration)
- Actions record `step` (the title path) from ALS. Text output indents by depth (`│ `).
- **Version gate.** `steps: 'auto'` turns on only when `@playwright/test` ≥ 1.48. The version is read via `createRequire(...)('@playwright/test/package.json')`; if that fails, steps stay off. Older runners capture the step location from the direct caller, and our wrapper would become that caller. `steps: true` forces it on (with a documented location caveat).
- **Limitation (documented).** `test.step` called through a plain `@playwright/test` `test`, or through `mergeTests` from `@playwright/test`, is not tracked. Its actions are still logged, just without step headers.

### 5.9 Timing and pending actions

- `performance.now()` is the monotonic clock. Each event stores `t` (ms since session start); JSONL also stores `ts` (ISO wall clock). Durations are measured in the wrapper around the original promise.
- In-flight actions are kept in a `Map<seq, rec>`. At `finish()`, every unresolved record is emitted as `⧗ … still pending after 30012ms (test timedOut)`. This is the most useful line when a test times out. With `logStart: true` the start line is printed live as well.

---

## 6. Event model (`src/browser/types.ts`)

```ts
interface BaseEvent { v: 1; seq: number; t: number; ts: string; page?: number; step?: string[] }
export type BrowserLogEvent = BaseEvent & (
  | { kind: 'action'; category: 'action' | 'wait' | 'query' | 'navigation';
      target: 'page' | 'frame' | 'locator' | 'elementHandle' | 'keyboard' | 'mouse' | 'touchscreen'
            | 'clock' | 'context' | 'browser' | 'dialog' | 'download';
      subject?: string; method: string; args: string; redacted?: boolean;
      status: 'ok' | 'error' | 'pending'; durationMs?: number; slow?: boolean;
      error?: { name: string; message: string };              // first line in text, ≤2000 chars in JSONL, redacted
      location?: { file: string; line: number; column: number } }
  | { kind: 'navigation'; url: string }
  | { kind: 'page'; event: 'opened' | 'popup' | 'closed' | 'crashed'; url?: string; opener?: number }
  | { kind: 'console'; level: string; text: string; location?: string }
  | { kind: 'pageerror'; message: string; stack?: string }
  | { kind: 'network'; method: string; url: string; resourceType: string; status?: number; durationMs?: number; failure?: string }
  | { kind: 'dialog'; dialogType: string; message: string }
  | { kind: 'download'; url: string; suggestedFilename: string }
  | { kind: 'step'; phase: 'start' | 'end'; title: string; status?: 'passed' | 'failed' | 'skipped'; durationMs?: number }
  | { kind: 'note'; message: string }
  | { kind: 'api'; text: string }                                 // teed apiLog line (ANSI stripped)
  | { kind: 'dropped'; count: number }
);
```

Events are **already redacted** when stored, so secrets never sit in memory, files or attachments. `v` versions the JSONL schema.

---

## 7. Secret redaction (`src/redact.ts`, `src/browser/sensitive.ts`, `src/browser/args.ts`)

### 7.1 Shared primitives in `src/redact.ts`

These are also used by apiLog.

- `redactHeaders(headers, names, mask = '***')`. Moved from `format.ts`; same behaviour.
- `redactUrl(url, { query, values, mask })` masks:
  - query params by case-insensitive name
  - `#a=b` hash params (OAuth implicit `#access_token=`)
  - the userinfo password (`https://u:***@host`), always

  Relative and invalid URLs fall back to a regex.
- `redactText(text, values, mask)` does literal replacement (split/join, so no regex escaping), longest value first. Values shorter than 4 characters are ignored, with one warning.
- `redactDeep(value, { keys, values, mask, maxDepth: 4 })` masks by key and handles cycles safely.
- `matchesAny(text, patterns)`.

### 7.2 Text-entry values (`fillValues`)

These args can carry secrets:

| Call | Secret-bearing argument |
| --- | --- |
| `locator.fill(value)`, `page.fill(selector, value)`, `frame.fill(selector, value)` | `value` |
| `type` / `pressSequentially` (locator, page, frame, element handle) | `text` |
| `keyboard.type` / `insertText` | `text` |
| `press` / `keyboard.press` / `down` / `up` | printable single-character keys |
| `dialog.accept` | `promptText` |
| `selectOption` | values |

Policy by mode:

- **`'always'`** masks all of them.
- **`'never'`** masks none of them; `values` still applies.
- **`'auto'`** (default) masks when any of these is true:
  1. The target's description (locator `toString`, or the selector string for page/frame) matches `redact.selectors`. `DEFAULT_SENSITIVE_SELECTORS` covers:
     - `pass(word|wd|code|phrase)`, `\bpass\b`, `pwd`
     - `secret`, `token`, `otp|one[-_ ]?time`, `\bpin\b`
     - `cvv|cvc|csc`, `card[-_ ]?number|cc-number`
     - `ssn`, `api[-_ ]?key`
     - `type=["']?password`, `current-password|new-password|one-time-code`
     - so `#password`, `getByLabel('Password')`, `input[type=password]` and `getByPlaceholder('Enter PIN')` all match
  2. **Keyboard focus is sensitive.** Each page keeps `lastTargetSensitive`. It is set by any selector or locator action on a sensitive target and cleared by an action on a non-sensitive target or by navigation. `keyboard.type/insertText/press(<printable>)` is masked while it is set.
  3. The value contains a `redact.values` entry.
  4. `inspectInputType` is on and the probe says sensitive (§7.3).

- The rendered value is `***`, e.g. `getByLabel('Password').fill(***)`. `redacted: true` is set and the length is not revealed.
- **Error scrubbing.** If the action fails, every secret value that was masked for this call is also removed from the logged error message. Playwright's call log can echo arguments.

### 7.3 Opt-in DOM probe (`inspectInputType`)

- Applies to fill-like calls on a locator whose description didn't match.
- **After** the action succeeds, run `locator.evaluate(el => [el.type, el.autocomplete])` inside our internal ALS (so it is not logged), with a 1000 ms timeout.
- It is sensitive if the type is `password`, or autocomplete is `current-password|new-password|one-time-code|cc-number|cc-csc`.
- Results are cached per `(pageId, description)` and the cache is cleared on navigation.
- It **fails closed**: if the probe errors or the action failed, the value is masked.
- **Off by default.** It adds one round-trip per distinct field, and the probe appears as an "Evaluate" step in traces and the HTML report.

### 7.4 Literal values (`values`) and auto-collected secrets

These values are masked in every string we emit: args, URLs, console text, page errors, error messages, notes and teed apiLog lines. The fixture adds these automatically:

- `httpCredentials.password`, from the built-in option fixture
- the values of `extraHTTPHeaders` whose names are in `redact.headers`
- at runtime, header values masked by `setExtraHTTPHeaders` and cookie values from `addCookies`

### 7.5 Other argument rules (`args.ts`)

The safe formatter handles cycles, `BigInt`, symbols, `RegExp`, `undefined` and depth > 3, so `JSON.stringify` never throws.

| Argument | Rendered as |
| --- | --- |
| URLs (`goto`, `waitForURL`, `route`, the `referer` option) | `redactUrl` |
| `setExtraHTTPHeaders(h)` | `redactHeaders` |
| `addCookies(cs)` | `[{ name, domain, path }]` with the value always `***` |
| `setHTTPCredentials` | password `***` |
| `setInputFiles` | file basenames only (`/home/jo/x.pdf` → `x.pdf`); `{ name, mimeType, buffer }` → `name (mime, 1234 B)`. Never bytes |
| `evaluate*` functions | `fn.name` or the first 80 chars of source. Args go through `redactDeep` (keys and values) |
| `setContent(html)` | `<html 1.2 KB>` |
| `addInitScript` / `addScriptTag` | `<script 340 B>` or the path |
| Locators / handles passed as args (`dragTo(target)`, `{ has }`) | their description |
| Predicates in `waitFor*` | `<predicate>` |
| Options objects | shown with `redactDeep` |
| Every argument | truncated to `maxArgLength` |

### 7.6 apiLog alignment (small, non-breaking)

- Add `redactQuery?: string[]` to `ApiLoggerConfig` (default `[]`, so behaviour is unchanged). It applies `redactUrl` to the printed URLs and the curl output.
- `browserLog.redact.headers`/`query` inherit from the **raw** user `apiLog` option when it is set (§4.3), so one list configures both.

---

## 8. Output (`src/browser/render.ts`, `src/browser/output.ts`, `src/colors.ts`)

### 8.1 Colours

New `detectColors()` in `src/colors.ts`. It is checked in order and the first match wins:

1. an explicit `colors` option
2. `NO_COLOR` set → off
3. `FORCE_COLOR` = `0`/`false` → off
4. `process.stdout.isTTY` → on
5. inside a Playwright worker (`TEST_WORKER_INDEX` defined) → `!process.env.CI`
6. otherwise off

`DEFAULT_CONFIG.colors` for apiLog switches to `detectColors()` as a bug fix (§2.2-5) once M0 confirms the current behaviour.

**ANSI never reaches files or attachments.** Events are structured and rendered per destination: `print` gets the palette, while files and attachments get the identity palette. Teed apiLog strings are ANSI-stripped with `/\x1b\[[0-9;]*m/g`.

Palette:

| Element | Colour |
| --- | --- |
| `✓` | green |
| `✗` | red |
| `⧗` pending / slow duration | yellow |
| subject | cyan |
| method | bold |
| navigation `↪` | blue |
| console warning / error | yellow / red |
| page error | red bold |
| network status | existing `palette().status` |
| steps | magenta |
| times | dim |

### 8.2 Text format

Plain text; identical to the console version minus colour:

```
── browser log · login.spec.ts › rejects wrong password · chromium · failed ──
+0.000s  page#1 opened
+0.010s  ✓ page.goto('https://app.test/login?next=%2Fhome&token=***')  412ms
+0.422s  ↪ https://app.test/login?next=%2Fhome&token=***
+0.425s  ▸ Log in
+0.427s  │ ✓ getByLabel('Email').fill('jo@example.com')  18ms
+0.446s  │ ✓ getByLabel('Password').fill(***)  15ms
+0.462s  │ ✓ getByRole('button', { name: 'Sign in' }).click()  96ms
+0.560s  │ ⚠ console.error  Failed to load resource: 401  (app.js:12)
+0.561s  │ ✗ network POST https://app.test/api/session 401  83ms
+0.563s  ◂ Log in  passed  138ms
+0.570s  ✗ locator('.toast-success').click()  5003ms  TimeoutError: locator.click: Timeout 5000ms exceeded.
```

### 8.3 JSONL

One `BrowserLogEvent` per line (§6), for example:

```json
{"v":1,"seq":5,"t":446,"ts":"2026-10-29T10:15:02.446Z","kind":"action","category":"action","target":"locator","subject":"getByLabel('Password')","method":"fill","args":"***","redacted":true,"status":"ok","durationMs":15,"step":["Log in"]}
```

### 8.4 Destinations and timing

| Destination | When | Path / name |
| --- | --- | --- |
| `print` | `true`: live, one line per event (step markers live). `'on-failure'`: one block at `finish()`, joined into a single `sink()` call so parallel output stays together. `api` events are never re-printed (apiLog already printed them) | `sink` |
| `attach` | at `finish()`, if `true` or failed | `testInfo.attach('browser-log', { body, contentType: 'text/plain' })`, or `browser-log.jsonl` with `application/x-ndjson` |
| `file` | at `finish()`, if `true` or failed | Default `testInfo.outputPath('browser-log.txt'\|'.jsonl')`, unique per test, retry and repeat. With `fileDir`: `<fileDir>/<slug(titlePath)>-<testId:8>[-retryN][-repeatN].<ext>` after `mkdir -p` |

- Nothing is written for a session with zero events.
- **We never delete or clean any directory.** `outputPath()` cleanup is Playwright's own `outputDir` behaviour.
- The buffer lives in memory (bounded by `maxEvents`) and is written once with `fs.promises.writeFile`. If the worker crashes, that test's file is lost; this is a documented trade-off that buys on-failure support and no partial files.

---

## 9. Performance and no-op guarantees

- **Disabled** (`enabled: false`). `_plpSession` returns `null`: no install, no listeners, no context registration.
  - The only footprint is the worker-scoped `browser` override, which installs pass-through hooks on `browser.newContext/newPage` (one flag check per call, and those calls are rare).
  - If another test in the same worker enabled logging earlier, patched methods on unattached objects cost one `als.getStore()` plus one WeakMap lookup, well under 1 µs.
- **Enabled hot path:** ALS run, two WeakMap lookups, `performance.now()`, bounded argument formatting with redaction (lazy fast paths for primitive args), and a ring-buffer push. Target: < 50 µs per action. Playwright actions take milliseconds.
- **No extra protocol round-trips by default:**
  - `inspectInputType` is off.
  - `network` is off.
  - We never await `request.response()` or resolve `msg.args()`.
  - Prototype discovery uses synchronous factories only.
- With the default `'on-failure'` outputs, passing tests do no I/O.
- `location: false` by default, so there is no per-action stack capture.
- **Benchmark** (`e2e/specs/perf.spec.ts`, tagged `@perf` and excluded from CI gating): 500 `fill` and 500 `click` calls on a static page, enabled vs disabled. Overhead goes into the job summary; the budget is ≤ 5%.

---

## 10. CJS + ESM

- Keep tsup `format: ['cjs', 'esm']`. Add `shims: true` (for `__dirname`/`import.meta.url` in `LIB_DIR`) and `target: 'node16'`. Add `playwright-core` to `external`; it is only loaded through `createRequire`.
- No new runtime dependencies (unlike chalk v5, which is ESM-only, picocolors works from both CJS and ESM). The Node built-ins we use are `node:async_hooks`, `node:fs/promises`, `node:path` and `node:module`.
- **Dual-package hazard:** the global registry and the `PATCHED` symbol (§5.3) make two loaded copies harmless.
- **`exports` map fix:**
  - give each entry per-condition types: `import: { types: './dist/*.d.mts', default: './dist/*.mjs' }` and `require: { types: './dist/*.d.ts', default: './dist/*.js' }`
  - add `"./package.json"`
  - add `"engines": { "node": ">=16" }`
- **CI checks:** `publint` and `@arethetypeswrong/cli --pack` (new devDeps), plus `scripts/smoke-dist.cjs` (`require`) and `scripts/smoke-dist.mjs` (`import`). Both assert the exports of `.` and `./fixtures`.

---

## 11. Playwright ≥ 1.30 compatibility

`peerDependencies` stays `>=1.30.0`. Features are gated by feature detection; versions are only used where detection is impossible (steps).

| Capability | 1.30–1.38 | 1.39–1.47 | ≥ 1.48 |
| --- | --- | --- | --- |
| Page/Frame/Locator/Keyboard/Mouse/Context actions | ✓ | ✓ | ✓ |
| Methods added later (`pressSequentially`, `addLocatorHandler`, `clock`, `ariaSnapshot`, …) | skipped when absent | ✓ when present | ✓ |
| Locator description | `Locator@sel`, normalised (verify in M0) | readable | readable |
| Dialog owner | from the emit shadow | `dialog.page()` when available | ✓ |
| `mergeTests` wrapper | not exported | ✓ | ✓ |
| `test.step` integration | off (`'auto'`) | off (`'auto'`) | ✓ |
| Stack hygiene adapter | b or c (verify) | b (verify) | a (verified on 1.64) |
| Fixture `box` | omitted | where supported (verify) | ✓ |

Every cell marked "verify" is settled in M0 and written into README §Compatibility.

---

## 12. Edge cases (each one gets a test in §13)

| # | Case | Handling |
| --- | --- | --- |
| 1 | Delegation, including after an await (`locator.selectText` → handle) | ALS dedupe: one event |
| 2 | Concurrent actions (`Promise.all`) | Separate records, ordered by `seq`. Text output is in completion order |
| 3 | An action never settles (test timeout) | Pending flush at `finish()` |
| 4 | Page or context closed mid-action | Error event "Target closed". No crash in the logger |
| 5 | Popups and `context.newPage()` | `context.on('page')` registers them and assigns ids |
| 6 | `browser.newContext()` inside a test | Auto-attach through the Browser hook. Detached at session end; we never close user contexts |
| 7 | Shared page from `beforeAll` | `attachBrowserLogger(page)`; events go to whichever test is active |
| 8 | Persistent context (`context.browser()` is `null`) | No Browser patch; everything else works |
| 9 | Context reuse (UI mode / `PW_TEST_REUSE_CONTEXT`) | Re-registered per session. Page ids reset; listeners removed at session end |
| 10 | CJS and ESM copies loaded together | Global registry, no double patch |
| 11 | User Proxies around page / other monkeypatches | We wrap whatever sits on the prototype at install time. A Proxy forwarding to the target still hits the patched prototype |
| 12 | Dialog auto-dismiss / file choosers | No `dialog`/`filechooser` listeners ever (emit shadow instead) |
| 13 | Secrets in URLs (query, hash, userinfo, `referer`) | `redactUrl` |
| 14 | `redact.values` contains `''`/`undefined`/short strings | Filtered out; values < 4 characters warn once |
| 15 | An error message echoes a fill value | Scrubbed from the logged message |
| 16 | `setInputFiles` buffers / huge `setContent` / long `evaluate` source | Summarised, never dumped |
| 17 | Cyclic, `BigInt`, `Symbol` or Playwright objects in args | Safe formatter |
| 18 | Retries, `repeatEach`, parallel workers | Per-attempt `outputPath`. The session is per test; workers run one test at a time |
| 19 | `test.fail()`, `test.skip()` in the body, interrupted runs | `status !== expectedStatus` decides on-failure |
| 20 | `beforeEach`/`afterEach` | Captured (inside the test-fixture scope). `beforeAll`/`afterAll` are not, unless manually attached |
| 21 | Playwright's own fixture teardown (`context.close`, tracing) | `endCapture()` after our `context` fixture's `use()` returns. User fixtures that depend on `page` still have their teardown captured |
| 22 | SPA `pushState` navigations | `framenavigated` fires; consecutive duplicates are deduped |
| 23 | A bug inside the logger | `safe()` wrapper; capture is disabled for that session with one warning; the test is unaffected |
| 24 | `steps` with `mergeTests` from `@playwright/test` | Not tracked (documented); use our `mergeTests` |
| 25 | `enabled` toggled per describe via `test.use` | Session decided per test; unattached objects pass through |

---

## 13. Test strategy

### 13.1 Unit tests

node:test + tsx, matching the existing `test/*.test.ts`. `package.json` gets `"test": "tsx --test test/*.test.ts"`.

| File | Covers |
| --- | --- |
| `test/redact.test.ts` | headers (moved; the existing format tests stay green), URL query/hash/userinfo, invalid URLs, `redactText` ordering and short values, `redactDeep` keys and cycles |
| `test/colors.test.ts` | env matrix for `detectColors` |
| `test/browser-config.test.ts` | defaults, `redact` deep merge, inheritance from apiLog, auto-collected values |
| `test/browser-args.test.ts` | safe formatter, truncation, per-method rules (§7.5), sensitive-selector matching, keyboard focus state machine |
| `test/browser-render.test.ts` | golden text lines, no `\x1b` in plain output, JSONL round-trip and schema `v` |
| `test/browser-install.test.ts` | **Fake classes** (`FakePage` → `FakeFrame` delegation, `FakeLocator` with post-await delegation). Checks: one event per call, pass-through when unattached, original promise identity, rejection passthrough, sync throws, idempotent install, two module instances sharing one registry |
| `test/browser-steps.test.ts` | `wrapTestType` with a fake TestType: `location` injected, `extend` re-wrapped, `step.skip` preserved, ALS step path |
| `test/stack-hygiene.test.ts` | adapter selection with fake module maps a/b/c, `LIB_DIR` computation, error-stack scrubbing fallback |

### 13.2 Integration with real Playwright (`e2e/`)

`e2e/playwright.config.ts` uses `webServer: node e2e/server.mjs`, a zero-dependency static server with login/frames/popup/console/dialog/download pages. It runs with `trace: 'off'` and Chromium; the latest Playwright also runs Firefox and WebKit.

Specs:

- `actions.spec.ts`: every row in §5.6 appears exactly once (asserted through `browserLogger.events()`), with subjects, durations and failures.
- `redaction.spec.ts`: canary secret `PLP-CANARY-7f3a` entered through:
  - `#password`, `getByLabel('Password')`, `type=password` with `inspectInputType`
  - `keyboard.type` after a click on the password field
  - `goto ?token=`, `setExtraHTTPHeaders`, `addCookies`
  - `console.log(canary)` with `values: [canary]`

  Asserts the canary never appears in events, the rendered text/JSONL, or the attachment body.
- `events.spec.ts`: navigation, console levels, pageerror, popup, close, download, `network: 'failed'`.
- `dialogs.spec.ts`: `alert()` without a handler does not hang (auto-dismiss intact); `prompt` with a handler logs a redacted `accept`.
- `steps.spec.ts` (≥ 1.48): step markers and step path on actions.
- `noop.spec.ts`: `enabled: false` in a dedicated project means the prototypes carry no `PATCHED` symbol, there are no attachments, and stdout is silent.
- `identity.spec.ts`: `page === context.pages()[0]`, `expect(locator).toBeVisible()`, and `instanceof` all still hold.

### 13.3 Meta tests

`e2e/meta/*.test.ts`, node:test spawning `playwright test` with `--reporter=json`. This checks behaviour that needs failing tests without making the main suite red:

- `print/attach/file: 'on-failure'` produce output only for the failing spec. `test.fail()` produces none.
- **Stack locations:** every `pw:api` step's `location.file` and every error `location.file` is the spec file, never `dist/` or `src/`. This covers browser actions **and** `request.*` (apiLog).
- Timeout spec → the pending line is present.
- The canary scan (`scripts/assert-no-canary.ts`) greps captured stdout, `test-results/**` and the JSON report.

### 13.4 Packaging

- `pnpm build`, then the smoke scripts (CJS and ESM), `publint`, and `attw --pack`.
- One e2e run imports from `dist` (`PLP_E2E_FROM=dist` switches the helper import).

### 13.5 CI (new `.github/workflows/ci.yml`)

- typecheck, unit tests, build, packaging checks
- e2e matrix: `@playwright/test` ∈ {1.30.0 (Node 18), 1.39.0, 1.48.0, latest} × Chromium, plus latest × {Firefox, WebKit}
- a weekly "prototype drift" job that diffs async prototype methods on the latest Playwright against `methods.ts` and opens a warning for new unlisted methods

---

## 14. README and docs updates

- **Tagline:** "Colorful API **and browser-action** logging for Playwright". Update `package.json` `description` and `keywords` (`browser`, `page`, `locator`, `e2e`).
- **New section "Browser action logging"** after Option B:
  - same import, nothing to configure
  - the defaults: quiet on success, timeline plus report attachment on failure
  - sample output (§8.2)
  - what is logged
- **Configuration:** split into "apiLog options" (add `redactQuery`), "browserLog options" (§4.2) and "browserLog.redact" (§4.3).
- **"Secrets & redaction":**
  - what is masked by default, `redact.values` with an env var (headline recipe), custom `selectors`, `fillValues: 'always'` for strict CI, the `inspectInputType` trade-off
  - **limitation:** Playwright's own traces and HTML-report steps record raw action parameters; this logger only redacts its own outputs
- **Recipes:**
  - live timeline locally and on-failure in CI
  - JSONL artifacts (`file: true, fileFormat: 'jsonl'`) with `fileDir`
  - `network: 'failed'`
  - shared page in `beforeAll` (`attachBrowserLogger`)
  - extending our `test` (use `.extend` or our `mergeTests`)
  - add a note (`browserLogger.note()`)
  - disable per suite
- **"Compatibility":** the table from §11, Node ≥ 16, CJS and ESM.
- **"How it works" (short):**
  - instruments Playwright's public methods once per worker
  - objects are never wrapped, so identity and `expect` behave normally
  - no listeners that change behaviour
  - never deletes folders, never writes ANSI to files
- **Roadmap:** remove the "planned" bullet. Add follow-ups: `expect` logging, `page.request` logging, key-based body redaction for apiLog (its request bodies can contain `password` fields today).
- **New `CHANGELOG.md`** with the 0.2.0 entry. Call out that browserLog is enabled by default with quiet defaults, the `colors` detection fix, and the step-location fix for apiLog.
- `.gitignore`: add `test-results/`, `playwright-report/`, `blob-report/`. `node_modules/` is already ignored and `files` already limits the package to `dist`.

---

## 15. Milestones

| Milestone | Scope | Exit criteria |
| --- | --- | --- |
| **M0 — Spike (S)** | Throwaway branch. Run on 1.30, 1.39, 1.48 and latest: (a) confirm the step/error-location hijack for the current apiLog Proxy and for a patched `Locator.prototype.click`; (b) which stack-hygiene adapter works per version; (c) `String(locator)` formats; (d) emit shadow keeps dialog auto-dismiss; (e) `isTTY`/`FORCE_COLOR` in workers; (f) `test.step` location behaviour before and after 1.48 | Short ADR `docs/adr/0001-browser-capture.md`. The "verify" cells in §11 filled in. Go/no-go on §5.1 (fallback: instrumentation backend behind `ActionSource`) |
| **M1 — Foundations (S)** | `src/redact.ts` (move `redactHeaders`, add URL/text/deep redaction), `src/colors.ts`, `src/browser/types.ts` (config, events, defaults, resolve), `render.ts`, `redactQuery` for apiLog | Unit tests green; existing tests untouched and green; public exports unchanged |
| **M2 — Capture core (M)** | `registry.ts`, `install.ts`, `methods.ts` (Page/Frame/Locator/Keyboard/Mouse/Touchscreen/Context/Browser), `describe.ts`, `args.ts`, `session.ts` (live print), `stackHygiene.ts` (also wired for apiLog), fixture integration (`browserLog`, `_plpSession`, `context`/`browser` overrides, `browserLogger`), `attachBrowserLogger` | `actions`, `identity`, `noop` specs and the stack-location meta test green on latest + 1.30 |
| **M3 — Redaction (M)** | `sensitive.ts` (selectors, keyboard focus state, `inspectInputType`), per-method arg rules, auto-collected values, error scrubbing | `redaction.spec` and the canary meta scan green |
| **M4 — Events (M)** | `listeners.ts`: navigation, console, pageerror, lifecycle, popup, download, network, dialog emit shadow; lazy Dialog/Download/ElementHandle/Clock patches; pending flush | `events`/`dialogs` specs green on all 3 browsers |
| **M5 — Outputs & steps (M)** | `output.ts` (on-failure print/attach/file, JSONL, `fileDir`, ring buffer), `steps.ts` (`wrapTestType`, `extend`, `mergeTests`), apiLog tee (`includeApiLog`), `location` option | Outputs and steps meta tests green |
| **M6 — Compat & release (S)** | CI matrix + drift job, tsup `shims`/`target`, exports map + `engines`, publint/attw/smoke, README/CHANGELOG, perf benchmark, version `0.2.0` | Full matrix green, perf overhead ≤ 5%, docs reviewed |

---

## 16. Risks and mitigations

| Risk | Likelihood / impact | Mitigation |
| --- | --- | --- |
| The stack-hygiene adapter relies on Playwright internals that may change | M / H (step locations would point at our file) | Three adapters plus error-stack scrubbing fallback. A meta test asserts locations on every matrix version. A failure in the drift/latest job is caught before users see it |
| Global prototype patching interferes with other tools | L / M | Own-property shadows only; idempotent; strict pass-through for unattached objects; no behaviour-changing listeners; `safe()` around all logger code; original promise returned |
| Redaction heuristics miss a custom password field | M / H | Layered defence: `values` (README headline), `selectors`, keyboard focus tracking, `fillValues: 'always'`, opt-in `inspectInputType`; canary leak suite in CI |
| Users assume Playwright traces/report are redacted too | M / M | Explicit README limitation |
| New Playwright public methods are not logged | M / L | Drift job; tables are data, so additions are one-line |
| Locator `toString` format changes | L / L | Normalisation + fallback; matrix tests |
| Default-on browserLog surprises existing users (attachments on failure) | M / L | Quiet defaults, a one-line opt-out (`browserLog: { enabled: false }`), CHANGELOG callout, 0.x minor |
| Step integration silently lost when users compose fixtures | M / L | Wrapped `extend` and `mergeTests`; docs; actions are still logged |
| Overhead in large suites | L / M | No round-trips by default, ring buffer, on-failure I/O, benchmark budget |
| Fixing apiLog colour detection changes its output | L / L | Called out in CHANGELOG; explicit `colors` still wins |

---

## 17. Internal comparison: naive Proxy-based page logger vs this plan

| Aspect | A naive Proxy-based page logger | Playwright Logger Pro `browserLog` |
| --- | --- | --- |
| Interception | Proxy around the `page` fixture only | Public methods patched on the prototypes of all relevant classes, once per worker |
| Coverage | `page` methods | Page, Frame, Locator (incl. via FrameLocator), Keyboard, Mouse, Touchscreen, Clock, BrowserContext, Browser, Dialog, Download, ElementHandle, popups and new contexts |
| Object identity / `expect(locator)` | Breaks (`proxy !== context.pages()[0]`, unwrapped return values) | Unchanged; objects are never wrapped |
| Nested calls | Not handled | ALS dedupe (one line per user call) |
| Secrets | `fill()` passwords printed via `JSON.stringify(args)` | Masked by selector heuristics, keyboard focus, literal values, keys, URL/query/headers/cookies; error-message scrubbing; optional DOM probe |
| Argument rendering | `JSON.stringify(args)` (cycles throw, Locators/Buffers/functions mangled) | Safe, truncated, type-aware formatter with locator descriptions |
| Timing | None | Per-action duration, slow highlighting, pending actions at timeout |
| Test steps | None | `test.step` markers, step path on every event, report locations preserved |
| Console / page errors / network | None | Console (levelled), page errors, lifecycle, dialogs, downloads, optional network |
| Console output | Always on, green/red | TTY-aware palette; quiet-on-success default |
| Files | Per-test files in `./logs`, ANSI codes inside | Plain text or JSONL in `testInfo.outputPath()` (or `fileDir`); never ANSI |
| Cleanup | Wipes the log folder on startup | Never deletes anything |
| Report integration | None | `testInfo.attach` (text or JSONL), on failure by default |
| Report/trace source locations | Point at the wrapper | Preserved via stack hygiene |
| Side effects | — | No `dialog`/`filechooser` listeners, no extra round-trips by default |
| Disabled cost | Proxy still in place | No-op: no install, no listeners |
| Module format | ESM-only (chalk) | CJS + ESM (picocolors), dual-package safe |
| Playwright versions | Unspecified | ≥ 1.30, feature-detected, CI matrix |
| Repo hygiene | `node_modules` committed | `node_modules` ignored, `files` allow-list, publint/attw |

---

## 18. Open decisions (recommendation in bold)

1. Is browserLog enabled by default? **Yes**, with `print`/`attach: 'on-failure'` and `file: false`. The alternative is opt-in until 1.0.
2. `inspectInputType` default: **`false`** (trace/report noise and round-trips). Revisit if users report leaks.
3. apiLog `redactQuery` default: **`[]` now**, and adopt `DEFAULT_REDACT_QUERY` at 1.0.
4. `steps` on Playwright < 1.48: **off** under `'auto'`, with `true` available as an explicit override.

---

## 19. Files touched (summary)

- **Modified:**
  - `src/fixtures.ts`, `src/index.ts`
  - `src/types.ts` (`redactQuery`, `detectColors` default)
  - `src/format.ts` (export `palette` internally, re-export `redactHeaders`)
  - `src/curl.ts` (import from `./redact`, apply `redactUrl`)
  - `src/wrapRequestContext.ts` (`redactUrl` for printed URLs)
  - `tsup.config.ts`, `package.json`, `README.md`, `.gitignore`
- **New:**
  - `src/redact.ts`, `src/colors.ts`
  - `src/browser/{types,registry,install,methods,describe,args,sensitive,listeners,session,render,output,steps,stackHygiene,attach,pwVersion,index}.ts`
  - `test/{redact,colors,browser-config,browser-args,browser-render,browser-install,browser-steps,stack-hygiene}.test.ts`
  - `e2e/{playwright.config.ts,server.mjs,pages/*,specs/*,meta/*}`
  - `scripts/{smoke-dist.cjs,smoke-dist.mjs,assert-no-canary.ts}`
  - `.github/workflows/ci.yml`, `CHANGELOG.md`, `docs/adr/0001-browser-capture.md`

## 20. Verification (end-to-end)

1. `pnpm typecheck && pnpm test`: unit tests, including the unchanged `curl`/`format` tests.
2. `pnpm build && node scripts/smoke-dist.cjs && node scripts/smoke-dist.mjs && pnpm check:pkg` (publint + attw).
3. `pnpm test:e2e`: Playwright specs against `e2e/server.mjs`. Then `PLP_E2E_FROM=dist pnpm test:e2e`.
4. `pnpm test:meta`: on-failure outputs, step/error locations point at spec files, pending-on-timeout, canary scan.
5. Manual check: run `e2e/meta/failing.spec.ts` with `--reporter=html` and confirm:
   - the `browser-log` attachment is readable plain text
   - step locations link to the spec
   - the console timeline is coloured in a terminal and plain with `NO_COLOR=1`
6. CI matrix green on Playwright 1.30 / 1.39 / 1.48 / latest.