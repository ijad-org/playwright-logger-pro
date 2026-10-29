import { AsyncLocalStorage } from 'node:async_hooks';
import type { ActionTarget } from './types';
import type { MethodSpec } from './methods';

/** Marker set on every wrapper we install; points at the original function. */
export const PATCHED = Symbol.for('playwright-logger-pro/patched');

const REGISTRY_KEY = Symbol.for('playwright-logger-pro/browser@1');

export interface Store {
  /** Set by the outermost patched call; nested patched calls pass through. */
  inAction: boolean;
  /** test.step title path (filled in by the steps integration). */
  step?: string[];
}

/** Handle for one in-flight action. */
export interface ActionRecord {
  readonly seq: number;
}

export interface BeginInput {
  self: object;
  target: ActionTarget;
  method: string;
  spec: MethodSpec;
  args: unknown[];
}

/** What the patched methods talk to. Implemented by BrowserLogSession. */
export interface ActionSink {
  readonly capturing: boolean;
  /** Returns undefined when this call should not be recorded. */
  beginAction(input: BeginInput): ActionRecord | undefined;
  endAction(rec: ActionRecord, error?: unknown): void;
  /** The resolved value of a patched call that creates a context / page (attach it). */
  onResult(kind: 'context' | 'page', value: unknown): void;
  /** Called when the logger itself fails; capture stops for the session. */
  fail(error: unknown): void;
}

export interface Binding {
  session: ActionSink;
  /** Follow `activeSession` (a shared page from beforeAll) instead of `session`. */
  floating?: boolean;
}

export interface Registry {
  v: 1;
  als: AsyncLocalStorage<Store>;
  pages: WeakMap<object, Binding>;
  contexts: WeakMap<object, Binding>;
  /** keyboard / mouse / touchscreen / clock -> owning Page */
  ownerOf: WeakMap<object, object>;
  activeSession: ActionSink | null;
  /** Prototypes already patched. */
  installed: WeakSet<object>;
  /** Directories whose frames must stay out of Playwright's stack attribution. */
  libDirs: Set<string>;
  /** Playwright package directories (calls coming from them are "runner" calls). */
  pwDirs: string[];
  hygiene?: { mode: string };
}

export function getRegistry(): Registry {
  const g = globalThis as unknown as Record<symbol, Registry | undefined>;
  let reg = g[REGISTRY_KEY];
  if (!reg) {
    reg = {
      v: 1,
      als: new AsyncLocalStorage<Store>(),
      pages: new WeakMap(),
      contexts: new WeakMap(),
      ownerOf: new WeakMap(),
      activeSession: null,
      installed: new WeakSet(),
      libDirs: new Set(),
      pwDirs: [],
    };
    g[REGISTRY_KEY] = reg;
  }
  return reg;
}

/** True if `fn` is one of our wrappers. */
export function isPatched(fn: unknown): boolean {
  return typeof fn === 'function' && Object.prototype.hasOwnProperty.call(fn, PATCHED);
}
