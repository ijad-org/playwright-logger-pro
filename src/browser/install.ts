import { PATCHED, getRegistry } from './registry';
import type { ActionSink, Binding, Registry } from './registry';
import { METHOD_TABLES } from './methods';
import type { MethodSpec, TableTarget } from './methods';

function isThenable(v: unknown): v is PromiseLike<unknown> {
  return v !== null && (typeof v === 'object' || typeof v === 'function') &&
    typeof (v as { then?: unknown }).then === 'function';
}

function safe(sink: ActionSink, fn: () => void): void {
  try {
    fn();
  } catch (error) {
    try {
      sink.fail(error);
    } catch {
      // the logger must never throw into the test
    }
  }
}

function pageOf(self: object): object | undefined {
  try {
    return (self as { page(): object }).page();
  } catch {
    return undefined;
  }
}

function resolveBinding(reg: Registry, self: object, target: TableTarget): Binding | undefined {
  switch (target) {
    case 'page': return reg.pages.get(self);
    case 'frame':
    case 'locator': {
      const page = pageOf(self);
      return page ? reg.pages.get(page) : undefined;
    }
    case 'keyboard':
    case 'mouse':
    case 'touchscreen':
    case 'clock':
    case 'dialog':
    case 'download':
    case 'elementHandle': {
      const owner = reg.ownerOf.get(self);
      return owner ? reg.pages.get(owner) : undefined;
    }
    case 'context': return reg.contexts.get(self);
    case 'browser': return reg.activeSession ? { session: reg.activeSession } : undefined;
  }
}

function sinkOf(reg: Registry, binding: Binding): ActionSink {
  return binding.floating && reg.activeSession ? reg.activeSession : binding.session;
}

/**
 * Define `name` on `proto` as our wrapper. The original is kept under a
 * per-method Symbol on the same prototype and called as `this[origKey](...)`
 * (not Reflect.apply / call / apply): on Playwright 1.30-1.48 step titles are
 * derived from stack frame names, and those would read `locator.apply(...)`.
 * See docs/adr/0001-browser-capture.md (g).
 */
function patchMethod(proto: object, name: string, target: TableTarget, spec: MethodSpec): void {
  const current = (proto as Record<string, unknown>)[name];
  if (typeof current !== 'function') return;
  if (Object.prototype.hasOwnProperty.call(current, PATCHED)) return;

  const origKey = Symbol(`playwright-logger-pro/original:${target}.${name}`);
  const own = Object.getOwnPropertyDescriptor(proto, name);
  Object.defineProperty(proto, origKey, { value: current, writable: true, configurable: true, enumerable: false });

  const wrapped = function (this: Record<symbol, (...a: unknown[]) => unknown>, ...args: unknown[]): unknown {
    const reg = getRegistry();
    const store = reg.als.getStore();
    if (store !== undefined && store.inAction) return this[origKey](...args);
    const binding = resolveBinding(reg, this, target);
    if (!binding) return this[origKey](...args);
    const sink = sinkOf(reg, binding);
    if (!sink.capturing) return this[origKey](...args);

    let rec: ReturnType<ActionSink['beginAction']>;
    safe(sink, () => {
      rec = sink.beginAction({ self: this, target, method: name, spec, args });
    });
    // Run the original inside the store even when the call is not recorded, so
    // calls it delegates to (locator.clear -> fill) are not logged either.
    return reg.als.run({ ...store, inAction: true }, () => {
      let result: unknown;
      try {
        result = this[origKey](...args);
      } catch (error) {
        if (rec) safe(sink, () => sink.endAction(rec!, error));
        throw error;
      }
      const done = (value: unknown, error?: unknown, failed = false): void => {
        safe(sink, () => {
          if (!failed && spec.result) sink.onResult(spec.result, value, this, args);
          if (rec) sink.endAction(rec, failed ? (error ?? new Error('rejected')) : undefined);
        });
      };
      if (isThenable(result)) {
        // Both outcomes are handled here, so this never adds an unhandled rejection.
        result.then((v) => done(v), (e) => done(undefined, e, true));
      } else {
        done(result);
      }
      return result; // the original promise, untouched
    });
  };
  Object.defineProperty(wrapped, 'name', { value: name, configurable: true });
  Object.defineProperty(wrapped, PATCHED, { value: current });
  Object.defineProperty(proto, name, {
    value: wrapped,
    writable: true,
    configurable: true,
    enumerable: own ? own.enumerable : false,
  });
}

/** Patch every method of `table` that exists on `proto` (older versions lack some). Idempotent. */
function patchPrototype(proto: unknown, target: TableTarget): void {
  if (proto === null || typeof proto !== 'object') return;
  const reg = getRegistry();
  if (reg.installed.has(proto)) return;
  reg.installed.add(proto);
  for (const [name, spec] of Object.entries(METHOD_TABLES[target])) patchMethod(proto, name, target, spec);
}

function proto(get: () => unknown): unknown {
  try {
    const obj = get();
    return obj ? Object.getPrototypeOf(obj) : undefined;
  } catch {
    return undefined;
  }
}

/** Patch Page, Frame, Locator, Keyboard, Mouse, Touchscreen and Clock, discovered from a live page. */
export function installPagePrototypes(page: object): void {
  const p = page as {
    mainFrame(): object; locator(s: string): object; keyboard: object; mouse: object; touchscreen: object; clock?: object;
  };
  patchPrototype(Object.getPrototypeOf(page), 'page');
  patchPrototype(proto(() => p.mainFrame()), 'frame');
  patchPrototype(proto(() => p.locator('html')), 'locator');
  patchPrototype(proto(() => p.keyboard), 'keyboard');
  patchPrototype(proto(() => p.mouse), 'mouse');
  patchPrototype(proto(() => p.touchscreen), 'touchscreen');
  patchPrototype(proto(() => p.clock), 'clock');
}

/** Patch BrowserContext (and its Browser, when there is one). */
export function installContextPrototypes(context: object): void {
  patchPrototype(Object.getPrototypeOf(context), 'context');
  const browser = (() => {
    try {
      return (context as { browser(): object | null }).browser();
    } catch {
      return null;
    }
  })();
  if (browser) installBrowserPrototype(Object.getPrototypeOf(browser));
}

function installBrowserPrototype(browserProto: unknown): void {
  patchPrototype(browserProto, 'browser');
}

/** Dialog, Download and ElementHandle prototypes are patched the first time an instance is seen. */
export function installDialogPrototype(dialog: object): void {
  patchPrototype(Object.getPrototypeOf(dialog), 'dialog');
}
export function installDownloadPrototype(download: object): void {
  patchPrototype(Object.getPrototypeOf(download), 'download');
}
export function installElementHandlePrototype(handle: object): void {
  patchPrototype(Object.getPrototypeOf(handle), 'elementHandle');
}

/** Called from the worker-scoped `browser` fixture: browser.newContext / newPage auto-attach. */
export function installBrowserHooks(browser: object): void {
  installBrowserPrototype(Object.getPrototypeOf(browser));
}

/** Test helper: is `proto[name]` one of our wrappers? */
export function isMethodPatched(proto: object, name: string): boolean {
  const fn = (proto as Record<string, unknown>)[name];
  return typeof fn === 'function' && Object.prototype.hasOwnProperty.call(fn, PATCHED);
}
