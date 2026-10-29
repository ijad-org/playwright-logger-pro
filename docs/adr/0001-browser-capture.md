# ADR 0001 — Browser capture mechanism

Status: accepted (M0 spike complete) · Date: 2026-10-29 · Plan: `docs/PLAN-browser-logging.md`

## Decision

**Go** on PLAN §5.1: patch the public async methods on the prototypes of Page, Frame, Locator, … once per worker, and keep the capture backend behind an internal `ActionSource` interface.

The spike confirmed the plan's central risk (our wrapper frames hijack Playwright's step and error locations) and confirmed that the planned stack-hygiene adapters fix it. It also found three places where the plan's implementation details must change. They are listed under [Deviations](#deviations).

## Method

Throwaway spec files in `/tmp/spike` (not committed), run with `@playwright/test` installed in separate directories:

| Version | Browser | What ran |
| --- | --- | --- |
| 1.61.1 (latest installed; the plan text says 1.64.1) | Chromium | everything |
| 1.30.0 | Chromium | everything |
| 1.39.0, 1.48.0 | none | only what works without a browser: `request` fixture, `test.step`, adapter discovery |

Node 24.21 on Linux. "Wrapper" means a function in a file outside `node_modules/playwright*`, standing in for our `dist/` code.

## Findings

### (a) Location hijack is real, for prototype patches and for Proxies

A failing `locator.click()` / `request.get()` with a wrapper between the test and Playwright:

| Case | 1.30.0 | 1.39.0 | 1.48.0 | 1.61.1 |
| --- | --- | --- | --- | --- |
| Unwrapped: step location | spec | n/r | n/r | spec |
| Patched `Locator.prototype.click`: step location and `e.stack[0]` | wrapper | n/r | n/r | wrapper |
| **Existing `request` Proxy (apiLog)**: step location | wrapper | wrapper | wrapper | wrapper |
| Existing `request` Proxy: `e.stack[0]` | wrapper | wrapper | wrapper | wrapper |
| `TestError.location` | not provided | n/r | n/r | wrapper (so also hijacked) |

n/r = not run. 1.39.0 and 1.48.0 were installed without browsers, so only `request`-based cases ran there.

So the current apiLog Proxy already attributes `request.*` steps to `dist/` today. The fix in M2 therefore benefits apiLog too (PLAN §5.5-3).

### (b) Stack-hygiene adapters

Resolution must go `@playwright/test` → (`playwright`, when it exists) → `playwright-core`, using `createRequire` from the user's install. In 1.30 there is no `playwright` package, and `playwright-core` is a direct dependency of `@playwright/test`.

| Version | Working adapter | Verified by running |
| --- | --- | --- |
| 1.30.0 | `playwright-core/lib/utils` → `addStackIgnoreFilter(frame => …)` | yes |
| 1.39.0 | `playwright-core/lib/utils` → `addInternalStackPrefix(prefix)` | yes (`request`) |
| 1.48.0 | `playwright-core/lib/utils` → `addInternalStackPrefix(prefix)` | yes (`request`) |
| 1.61.1 | `playwright-core/lib/coreBundle` → `.utils.setBoxedStackPrefixes([playwrightRoot, LIB_DIR])` | yes |

- `playwright-core/lib/coreBundle` is not resolvable on 1.30–1.48 (`ERR_PACKAGE_PATH_NOT_EXPORTED`), and `playwright-core/lib/utils` is not resolvable on 1.61.1. The adapters are therefore mutually exclusive by version, and "try a, then b, then c" in the plan works as written.
- With the adapter installed, on every version above the step location and `e.stack[0]` become the spec file. On 1.61.1, `TestError.location` also becomes the spec file.
- `playwright-core/lib/utils` in 1.30 also exports `captureRawStack`, so the plan's fallback (c, scrubbing our frames from `e.stack`) remains available.

### (c) `String(locator)` formats

| Case | 1.30.0 | 1.61.1 |
| --- | --- | --- |
| `locator('#a')` | `Locator@#a` | `locator('#a')` |
| chained | `Locator@#a >> .b >> nth=0` | `locator('#a').locator('.b').first()` |
| `getByRole('button', {name:'Go'})` | `Locator@internal:role=button[name="Go"i]` | `getByRole('button', { name: 'Go' })` |
| `getByLabel('Password')` | `Locator@internal:label="Password"i` | `getByLabel('Password')` |
| `frameLocator('#f').getByText('x')` | `Locator@#f >> internal:control=enter-frame >> internal:text="x"i` | `locator('#f').contentFrame().getByText('x')` |
| `.nth(2)` | `Locator@li >> nth=2` | `locator('li').nth(2)` |
| `.filter({hasText})` | `Locator@li >> internal:has-text="x"i` | `locator('li').filter({ hasText: 'x' })` |

On 1.30 the description is a raw selector with `internal:` engines. The plan said "strip a `Locator@` prefix"; that is not enough to be readable. `describe.ts` will strip the prefix **and** rewrite the common `internal:role/label/text/placeholder/testid/alt/title` engines into their `getBy*` form, and leave the rest as the selector. Sensitive-selector matching (`password`, `type=password`) works on both forms because it is substring-based. 1.39 and 1.48 were not run (no browser); `describe.ts` handles both shapes by detection, not by version.

### (d) Dialog events: the "emit shadow" does **not** work on 1.61

- 1.30.0: shadowing `Page.prototype.emit` sees the `dialog` event (`ret: false`, auto-dismiss intact). Works as planned.
- 1.61.1: the shadow sees **nothing**. The client only subscribes to the server's `dialog` event when a listener exists (a subscription table in `coreBundle.js`); without a listener the server dismisses the dialog itself and the client never hears about it. A shadow on both `Page.prototype.emit` and `BrowserContext.prototype.emit` was also silent.
- Alternative that works on **both** 1.30 and 1.61.1: register one passive `dialog` listener, and have it replicate the default when nobody else is listening: `if (page.listenerCount('dialog') <= 1) dialog.dismiss()` (`accept()` for `beforeunload`). With a user listener added later, ours does not act, and a user `accept('userval')` reaches the page. Verified with `prompt()`.
- Trade-off: the dismiss then comes from our code, not the server. This is an M4 decision (`listeners.ts`); M2 does not touch dialogs. The plan's rule "never add a `dialog` listener" (§2.2-7, §5.7) is withdrawn *only* in favour of this emulated-default listener, and requires the `emit` shadow to be dropped.

### (e) Colours inside workers

- 1.61.1: worker `process.stdout.isTTY` is `undefined`; `FORCE_COLOR` is `'1'` **even when the parent has `FORCE_COLOR=0`** (the runner sets `FORCE_COLOR: '1'` unconditionally, `runner/index.js`). `NO_COLOR` is inherited.
- 1.30.0: worker `process.stdout.isTTY` is **`true`** (the worker sets `stream.isTTY = true`), `FORCE_COLOR` is `'1'`, `NO_COLOR` inherited.
- Consequence for `detectColors()` (PLAN §8.1): in a worker (`TEST_WORKER_INDEX` defined), `isTTY` and `FORCE_COLOR` carry no information. The order becomes: explicit option → `NO_COLOR` → *if in a worker:* `!CI` → `FORCE_COLOR` 0/false → `isTTY` → off.
- The pre-existing `DEFAULT_CONFIG.colors` (`isTTY` only) is therefore false in 1.61 workers and true in 1.30 workers; the bug described in PLAN §2.2-5 is confirmed for current versions.

### (f) `test.step` location

| Variant | 1.30.0 | 1.39.0 | 1.48.0 | 1.61.1 |
| --- | --- | --- | --- | --- |
| Plain `test.step` | spec | spec | spec | spec |
| Our wrapper, no `location` option, **`async` wrapper that awaits** | wrapper | wrapper | wrapper | wrapper |
| Same, with `location` | wrapper (ignored) | wrapper (ignored) | **spec** | **spec** |
| Our wrapper, no `location`, **non-async wrapper that returns the promise** | wrapper | n/r | n/r | **spec** |

- `location` is honoured from 1.48 (verified on 1.48.0 and 1.61.1; ignored on 1.39.0 and 1.30.0). That confirms the `steps: 'auto'` gate at ≥ 1.48.
- On 1.61.1 `_step` awaits before capturing its stack, so a non-async wrapper frame drops out of V8's async stack. This is incidental and not relied on: the wrapper passes `location` explicitly.

### (g) Titles on old versions

In 1.30–1.48 the step title for `pw:api` steps is derived from the stack (the deepest core→non-core frame). Calling the original with `Reflect.apply`, `fn.call` or `fn.apply` makes V8 report `Locator.click [as apply]`, so the title becomes **`locator.apply(#nope)`** (1.30) instead of `locator.click(#nope)`. The existing apiLog Proxy has the same problem: `apiRequestContext.apply(http://…)` on 1.30, 1.39 and 1.48 (1.61 is not affected; titles come from the protocol there).

Measured on 1.30.0 (title of the failing click step):

| How the wrapper calls the original | Title |
| --- | --- |
| `Reflect.apply(orig, this, args)` | `locator.apply(…)` ✗ |
| `orig.call(this, …)` | `locator.call(…)` ✗ |
| `Function.prototype.call.call(holder[name], this, …)` | `locator.call(…)` ✗ |
| `this[symbolKey](...args)` (original stored under a hidden symbol on the same prototype) | `locator.click(…)` ✓ |
| `this['__plp_click'](...args)` | `locator.click(…)` ✓ |

## Verified compatibility cells (PLAN §11)

| Capability | 1.30 | 1.39 | 1.48 | 1.61.1 |
| --- | --- | --- | --- | --- |
| Stack hygiene adapter | b: `addStackIgnoreFilter` ✓ | b: `addInternalStackPrefix` ✓ | b: `addInternalStackPrefix` ✓ | a: `setBoxedStackPrefixes` ✓ |
| Locator description | `Locator@<selector>` with `internal:` engines | not run | not run | readable |
| Dialog observation | emit shadow works | not run | not run | needs emulated-default listener |
| `test.step` `location` option | ignored | ignored | honoured | honoured |
| `pw:api` titles derived from stack | yes | yes | yes | no |
| Worker `isTTY` / `FORCE_COLOR` | `true` / `1` | not run | not run | `undefined` / `1` |
| Fixture `box` | **not verified** | not verified | not verified | not verified |

## Deviations

Changes relative to the approved plan. Each is applied in code from M1/M2 unless noted.

1. **Call the original through a hidden symbol-keyed property** (`this[origKey](...args)`), not `Reflect.apply` (PLAN §5.2 snippet). Reason: finding (g). The original is stored non-enumerably on the same prototype under a per-method `Symbol`; the `PATCHED` marker is on the wrapper.
2. **Dialog "emit shadow" dropped; an emulated-default `dialog` listener replaces it** (PLAN §5.7, §2.2-7, §12 #12). Reason: finding (d). Implemented in M4, not in this run.
3. **`detectColors()` order differs inside workers** (PLAN §8.1). Reason: finding (e). `FORCE_COLOR=0` cannot be honoured inside a worker because the runner overwrites it; `NO_COLOR` and the explicit `colors` option still win.
4. **`describe.ts` rewrites `internal:` selectors on old Playwright** instead of only stripping `Locator@` (PLAN §11 "Locator description"). Reason: finding (c).
5. **`box: true` on the `_plpSession` fixture is omitted** (PLAN §4.1 note). Reason: not verified in M0 and not needed for correctness. Revisit in M6 if the report shows our fixture as a step.
6. **`wrapRequestContext` title regression on 1.30–1.48 is not fixed in M2.** The stack-hygiene adapter fixes the *location* for apiLog, but the `apply` title (finding g) needs a change inside `src/wrapRequestContext.ts`, which is being edited on another branch. Deferred to M6 (or to after that branch merges).

### Implementation deviations (recorded while building M1–M2)

7. **Superseded: deviation 3 and the `detectColors()` / `warnOnce` / `redactUrl` / `redactHeaders` of M1.** The `lqa-fixes` branch (merged underneath this work) already has Playwright-style colour detection (`detectColorSupport`, which trusts the runner's `FORCE_COLOR=1`), `src/warn.ts` and `src/redact.ts` with `redactUrl(url, keys)`. browserLog now uses those: no second colour detector, no second warning system. Only additive primitives were added to `src/redact.ts`: `maskUrl` (userinfo password + literal values), `redactText`, `normalizeSecretValues`, `matchesAny`, `sanitizeDeep`, `DEFAULT_SENSITIVE_KEYS`. `redactHeaders` (in `format.ts`) only gained an optional `mask` argument. browserLog's header list is apiLog's resolved list (defaults plus its extras, honouring `replaceDefaultRedaction`) plus `browserLog.redact.headers`.
8. **No query-string redaction in browserLog (yet), and no `apiLog.redactQuery` option.** Decision D7 / round-2 instruction: `lqa-fixes` already ships `redactQueryParams` for apiLog; browserLog logs URLs as-is apart from the userinfo password and literal `redact.values`. `BrowserRedactConfig.query` and `DEFAULT_REDACT_QUERY` were removed. Use `redact.values` for tokens that appear in URLs.
9. **One shared sensitive-key list (D7).** `DEFAULT_SENSITIVE_KEYS` (plain names) lives in `src/redact.ts` and is exported. browserLog compiles it into patterns (short names such as `pin` must stand alone) for object keys inside arguments and, with a few selector-only extras, for `fill()`/`type()` target detection. apiLog is unchanged: `DEFAULT_REDACT_BODY_KEYS` stays empty; users can opt in with `redactBodyKeys: [...DEFAULT_SENSITIVE_KEYS]`.
10. **`context.newPage` is not patched.** Playwright's own `page` fixture calls it, and the runner then falls back to the first non-Playwright frame for the "Create page" step, which was our wrapper (the boxed-prefix list is only used for steps that carry a client stack). Pages are registered from the context's `page` event instead, which fires before `newPage()` resolves. Same reasoning applies to any wrapped method called by Playwright's fixtures; the others (`browser.newContext`, `close`, `screenshot`) are skipped for runner callers via `runnerCheck`.
11. **Hygiene fixes found by running real versions:** (a) frames of ES modules and of tsx-loaded sources are `file://` URLs, so both spellings are hidden; (b) frames of `dist/` code are source-mapped to `<package>/src/*.ts`, so `LIB_DIRS` also covers the sibling `src/`; (c) the `playwright` package is only used when its version equals `@playwright/test`'s, because `NODE_PATH` (pnpm, npx) can make `require.resolve` find a foreign install.
12. **Deviation 6 is resolved in M2:** `wrapRequestContext` now calls the method directly instead of `target.apply(...)`, so 1.30–1.48 step titles read `apiRequestContext.get(...)` again; a meta test asserts this.
13. **Dialogs, downloads, lazy handles:** unchanged from deviation 2 (to be done in M4).

