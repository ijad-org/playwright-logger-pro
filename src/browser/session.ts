import { warnOnce } from '../warn';
import { matchesAny, normalizeSecretValues, redactText } from '../redact';
import { isPrintableKey, renderArgs } from './args';
import type { RenderedArgs } from './args';
import { describeFrame, describeLocator } from './describe';
import { installContextPrototypes, installPagePrototypes } from './install';
import { attachContextListeners, attachPageListeners } from './listeners';
import { getRegistry } from './registry';
import type { ActionRecord, ActionSink, BeginInput, Binding } from './registry';
import { calledFromRunner } from './stackHygiene';
import { renderBrowserEventText, renderBrowserTimeline } from './render';
import type { MethodSpec } from './methods';
import type { ActionCategory, ActionTarget, BrowserLogEvent, ResolvedBrowserConfig, ResolvedRedactConfig } from './types';

type Distribute<T> = T extends unknown ? Omit<T, 'v' | 'seq' | 't' | 'ts'> & { seq?: number; t?: number } : never;
export type NewEvent = Distribute<BrowserLogEvent>;

/** The public handle returned by `attachBrowserLogger` and the `browserLogger` fixture. */
export interface BrowserLogHandle {
  /** Add a custom line to the timeline (redacted like everything else). */
  note(message: string): void;
  /** Redacted, structured events recorded so far. */
  events(): readonly BrowserLogEvent[];
  /** The timeline as plain text (never ANSI) or JSONL. */
  render(format?: 'text' | 'jsonl'): string;
  /** Stop recording for the objects attached through this handle. */
  detach(): void;
}

export const NOOP_HANDLE: BrowserLogHandle = {
  note() {},
  events: () => [],
  render: () => '',
  detach() {},
};

interface Pending {
  seq: number;
  started: number;
  startedWall: string;
  startT: number;
  category: ActionCategory;
  target: ActionTarget;
  subject: string;
  method: string;
  args: string;
  redacted: boolean;
  secrets: string[];
  page?: number;
  step?: string[];
  location?: { file: string; line: number; column: number };
  /** Re-render the arguments with the secret masked (or not). Dropped once the call is decided. */
  rerender?: (mask: boolean) => RenderedArgs;
  /** inspectInputType: the DOM probe that decides whether the typed value was a secret. */
  probe?: { page: object | undefined; selector: string; locator: () => unknown };
}

/** Evaluated in the page by the inspectInputType probe. */
const PROBE_FN = (el: unknown): [string, string] => {
  const e = el as { type?: unknown; autocomplete?: unknown };
  return [String(e.type ?? ''), String(e.autocomplete ?? '')];
};
const SENSITIVE_AUTOCOMPLETE = /current-password|new-password|one-time-code|cc-number|cc-csc/i;

const now = (): number => performance.now();

function errorName(error: unknown): string {
  if (error instanceof Error) return error.name || 'Error';
  return 'Error';
}

function errorMessage(error: unknown): string {
  if (error instanceof Error) return String(error.message);
  try {
    return String(error);
  } catch {
    return 'unknown error';
  }
}

/** First stack frame outside our library and node internals. */
function callSite(libDirs: Iterable<string>): { file: string; line: number; column: number } | undefined {
  const dirs = [...libDirs];
  const limit = Error.stackTraceLimit;
  Error.stackTraceLimit = 20;
  const stack = new Error().stack ?? '';
  Error.stackTraceLimit = limit;
  for (const raw of stack.split('\n').slice(1)) {
    const m = /\(?((?:[a-zA-Z]:)?[^():]+|file:\/\/[^():]+):(\d+):(\d+)\)?$/.exec(raw.trim());
    if (!m) continue;
    const file = m[1].replace(/^file:\/\//, '');
    if (file.startsWith('node:') || dirs.some((d) => file.startsWith(d))) continue;
    return { file, line: Number(m[2]), column: Number(m[3]) };
  }
  return undefined;
}

export interface SessionMeta {
  title?: string;
  project?: string;
}

/**
 * One timeline of browser activity: usually one per test, or one standalone
 * session created by `attachBrowserLogger` outside a test. Everything stored
 * is already redacted.
 */
export class BrowserLogSession implements ActionSink {
  capturing = true;
  failed = false;
  readonly meta: SessionMeta;
  protected buffer: BrowserLogEvent[] = [];
  protected droppedCount = 0;
  private seqCounter = 0;
  private readonly t0 = now();
  private readonly wall0 = Date.now();
  private readonly pending = new Map<number, Pending>();
  private readonly pageIds = new WeakMap<object, number>();
  private pageCount = 0;
  private readonly sensitiveFocus = new WeakMap<object, boolean>();
  /** inspectInputType results per page and target description; cleared on navigation. */
  private probeCache = new WeakMap<object, Map<string, boolean>>();
  private readonly trackedPages = new Set<object>();
  private readonly trackedContexts = new Set<object>();
  private readonly disposers: Array<() => void> = [];
  private red: ResolvedRedactConfig;
  /** When true, events print live to `sink` as they are recorded. */
  live: boolean;
  floating = false;

  constructor(readonly cfg: ResolvedBrowserConfig, meta: SessionMeta = {}, live = cfg.print === true) {
    this.meta = meta;
    this.live = live;
    this.red = { ...cfg.redact, values: [...cfg.redact.values] };
  }

  // -- redaction ------------------------------------------------------------

  /** Mask a literal secret learned at runtime (cookie values, header values, ...). */
  addSecret(value: unknown): void {
    if (typeof value !== 'string') return;
    this.red.values = normalizeSecretValues([...this.red.values, value]);
  }

  /** Redact free text: literal secrets only. */
  scrub(text: string): string {
    return redactText(text, this.red.values, this.red.mask);
  }

  protected scrubError(message: string, secrets: readonly string[]): string {
    let out = this.scrub(message);
    for (const s of secrets) {
      if (s.length >= 4) {
        if (out.includes(s)) out = out.split(s).join(this.red.mask);
      } else if (s.length > 0) {
        // Too short to mask everywhere; mask it where Playwright echoes it quoted.
        for (const quote of ['"', "'", '`']) out = out.split(`${quote}${s}${quote}`).join(`${quote}${this.red.mask}${quote}`);
      }
    }
    return out;
  }

  // -- events ---------------------------------------------------------------

  private stamp(t = now() - this.t0): { v: 1; t: number; ts: string } {
    return { v: 1, t: Math.round(t * 1000) / 1000, ts: new Date(this.wall0 + t).toISOString() };
  }

  nextSeq(): number {
    return this.seqCounter++;
  }

  /** Record an event. `page` is set automatically when the session has several pages. */
  emit(event: NewEvent, pageObject?: object): BrowserLogEvent {
    const store = getRegistry().als.getStore();
    const ev = {
      ...event,
      ...this.stamp(event.t),
      seq: event.seq ?? this.nextSeq(),
      ...(this.pageCount > 1 && pageObject && this.pageIds.has(pageObject) && (event as { page?: number }).page === undefined ?
        { page: this.pageIds.get(pageObject) } : {}),
      ...((event as { step?: string[] }).step === undefined && store?.step && store.step.length > 0 ?
        { step: store.step } : {}),
    } as BrowserLogEvent;
    return this.push(ev, true);
  }

  protected push(ev: BrowserLogEvent, print: boolean): BrowserLogEvent {
    this.buffer.push(ev);
    const limit = this.cfg.maxEvents;
    if (this.buffer.length > limit + Math.max(16, limit >> 2)) this.trim();
    if (print && this.live && ev.kind !== 'api') this.print(renderBrowserEventText(ev, { colors: this.cfg.colors }));
    return ev;
  }

  private trim(): void {
    const extra = this.buffer.length - this.cfg.maxEvents;
    if (extra > 0) {
      this.buffer.splice(0, extra);
      this.droppedCount += extra;
    }
  }

  protected print(text: string): void {
    try {
      this.cfg.sink(text);
    } catch (error) {
      warnOnce(`the browserLog "sink" threw (${errorMessage(error)})`);
    }
  }

  events(): readonly BrowserLogEvent[] {
    if (this.buffer.length > this.cfg.maxEvents) this.trim();
    if (this.droppedCount === 0) return [...this.buffer];
    const first = this.buffer[0];
    const marker: BrowserLogEvent = {
      v: 1, seq: -1, t: first ? first.t : 0, ts: first ? first.ts : new Date(this.wall0).toISOString(),
      kind: 'dropped', count: this.droppedCount,
    };
    return [marker, ...this.buffer];
  }

  note(message: string): void {
    if (this.failed) return;
    this.emit({ kind: 'note', message: this.scrub(String(message)) });
  }

  /** A teed apiLog line (already ANSI-free). Stored, never printed again. */
  addApi(text: string): void {
    if (this.failed || !this.cfg.includeApiLog) return;
    this.push({ seq: this.nextSeq(), ...this.stamp(), kind: 'api', text: this.scrub(text) } as BrowserLogEvent, false);
  }

  /** Wrap an apiLog config so its lines are also recorded in this session. */
  teeApiLog<T extends { sink?: (line: string) => void }>(apiLog: T): T {
    const original = apiLog.sink ?? ((line: string) => console.log(line));
    return {
      ...apiLog,
      sink: (line: string) => {
        try {
          // eslint-disable-next-line no-control-regex
          this.addApi(String(line).replace(/\x1b\[[0-9;]*m/g, ''));
        } catch {
          // never fail the request for logging
        }
        original(line);
      },
    };
  }

  // -- pages and contexts ---------------------------------------------------

  /** Page number (page#N) within this session; allocated on first use. */
  idFor(page: object): number {
    let id = this.pageIds.get(page);
    if (id === undefined) {
      id = ++this.pageCount;
      this.pageIds.set(page, id);
    }
    return id;
  }

  pageIdOf(page: object): number | undefined {
    return this.pageIds.get(page);
  }

  get pages(): number {
    return this.pageCount;
  }

  private binding(): Binding {
    return { session: this, floating: this.floating };
  }

  attachContext(context: object): void {
    if (this.failed) return;
    const reg = getRegistry();
    const existing = reg.contexts.get(context);
    if (existing && existing.session === this) return;
    installContextPrototypes(context);
    reg.contexts.set(context, this.binding());
    this.trackedContexts.add(context);
    const c = context as { pages(): object[] };
    let initial: object[] = [];
    try {
      initial = c.pages();
    } catch {
      // closed context
    }
    this.disposers.push(attachContextListeners(this, context, (page, popup) => this.attachPage(page, popup)));
    for (const page of initial) this.attachPage(page, false);
  }

  attachPage(page: object, popup = false): void {
    if (this.failed) return;
    const reg = getRegistry();
    const existing = reg.pages.get(page);
    if (existing && existing.session === this) return;
    installPagePrototypes(page);
    reg.pages.set(page, this.binding());
    this.trackedPages.add(page);
    const p = page as { keyboard?: object; mouse?: object; touchscreen?: object; clock?: object };
    for (const owned of [p.keyboard, p.mouse, p.touchscreen, p.clock]) if (owned) reg.ownerOf.set(owned, page);
    this.idFor(page);
    this.disposers.push(attachPageListeners(this, page, popup));
  }

  onResult(kind: 'context' | 'page', value: unknown): void {
    if (value === null || typeof value !== 'object') return;
    if (kind === 'context') this.attachContext(value);
    else this.attachPage(value);
  }

  // -- actions --------------------------------------------------------------

  wants(spec: MethodSpec): boolean {
    const c = this.cfg;
    if (spec.noisy && !c.mouseMoves) return false;
    switch (spec.category) {
      case 'action': return c.actions;
      case 'wait': return c.waits;
      case 'query': return c.queries;
      case 'navigation': return c.actions || c.navigation;
    }
  }

  /** Page this call acts on, for per-page state. */
  private pageFor(self: object, target: ActionTarget): object | undefined {
    const reg = getRegistry();
    switch (target) {
      case 'page': return self;
      case 'frame':
      case 'locator':
        try {
          return (self as { page(): object }).page();
        } catch {
          return undefined;
        }
      case 'keyboard': case 'mouse': case 'touchscreen': case 'clock': return reg.ownerOf.get(self);
      default: return undefined;
    }
  }

  beginAction(input: BeginInput): ActionRecord | undefined {
    if (!this.capturing || this.failed) return undefined;
    const { self, target, method, spec, args } = input;
    const page = this.pageFor(self, target);

    let subject: string = target;
    let selector: string | undefined;
    if (target === 'locator') {
      subject = describeLocator(self);
      selector = subject;
    } else if (target === 'frame') {
      subject = describeFrame(self);
      if (spec.selector && typeof args[0] === 'string') selector = args[0];
    } else if (target === 'page' && spec.selector && typeof args[0] === 'string') {
      selector = args[0];
    }

    const sensitiveSelector = selector !== undefined && matchesAny(selector, this.red.selectors);
    if (page) {
      if (spec.category === 'navigation') this.sensitiveFocus.set(page, false);
      else if (selector !== undefined && spec.category === 'action') this.sensitiveFocus.set(page, sensitiveSelector);
    }

    this.learnSecrets(spec, args);
    if (page && spec.category === 'navigation') this.probeCache.delete(page);

    if (!this.wants(spec)) return undefined;
    if (spec.runnerCheck && calledFromRunner()) return undefined;

    let maskSecret = false;
    let needsProbe = false;
    if (spec.secret) {
      const mode = this.red.fillValues;
      if (mode === 'always') maskSecret = true;
      else if (mode === 'auto') {
        maskSecret = selector !== undefined ? sensitiveSelector : (page ? this.sensitiveFocus.get(page) === true : false);
        if (!maskSecret && selector !== undefined && this.red.inspectInputType && page &&
          (target === 'locator' || target === 'page' || target === 'frame') &&
          (spec.secret.kind !== 'key' || (typeof args[spec.secret.index] === 'string' && isPrintableKey(args[spec.secret.index] as string)))) {
          const cached = this.probeCache.get(page)?.get(selector);
          if (cached === undefined) needsProbe = true;
          else maskSecret = cached;
        }
      }
    }

    const ctx = { redact: this.red, maxArgLength: this.cfg.maxArgLength, maskSecret };
    // An undecided call is rendered masked (fail closed) until the probe says otherwise.
    const rendered = renderArgs(spec, args, needsProbe ? { ...ctx, maskSecret: true } : ctx);
    const t = now();
    const store = getRegistry().als.getStore();
    const pageId = this.pageCount > 1 && page && this.pageIds.has(page) ? this.pageIds.get(page) : undefined;
    const rec: Pending = {
      seq: this.nextSeq(),
      started: t,
      startedWall: new Date(this.wall0 + (t - this.t0)).toISOString(),
      startT: t - this.t0,
      category: spec.category,
      target,
      subject: this.scrub(target === 'page' ? 'page' : subject),
      method,
      args: rendered.text,
      redacted: rendered.redacted,
      secrets: rendered.secrets,
      page: pageId,
      step: store?.step && store.step.length > 0 ? store.step : undefined,
      location: this.cfg.location ? callSite(getRegistry().libDirs) : undefined,
    };
    if (needsProbe && selector !== undefined) {
      const sel = selector;
      rec.probe = {
        page,
        selector: sel,
        locator: () => (target === 'locator' ? self : (self as { locator(s: string): unknown }).locator(sel)),
      };
      rec.rerender = (mask) => renderArgs(spec, args, { ...ctx, maskSecret: mask });
      // Until the probe has run, keyboard input that follows is treated as sensitive too.
      if (page) this.sensitiveFocus.set(page, true);
    }
    this.pending.set(rec.seq, rec);
    if (this.cfg.logStart && this.live) {
      this.print(renderBrowserEventText(this.actionEvent(rec, 'pending', now()), { colors: this.cfg.colors }).replace(/still pending after \d+ms/, 'started'));
    }
    return { seq: rec.seq };
  }

  private actionEvent(rec: Pending, status: 'ok' | 'error' | 'pending', end: number, error?: unknown): BrowserLogEvent {
    const durationMs = Math.max(0, Math.round(end - rec.started));
    const ev: BrowserLogEvent = {
      v: 1, seq: rec.seq, t: Math.round(rec.startT * 1000) / 1000, ts: rec.startedWall,
      ...(rec.page !== undefined ? { page: rec.page } : {}),
      ...(rec.step ? { step: rec.step } : {}),
      kind: 'action',
      category: rec.category,
      target: rec.target,
      subject: rec.subject,
      method: rec.method,
      args: rec.args,
      ...(rec.redacted ? { redacted: true } : {}),
      status,
      durationMs,
      ...(status !== 'pending' && durationMs >= this.cfg.slowActionMs ? { slow: true } : {}),
      ...(error !== undefined ? {
        error: {
          name: errorName(error),
          message: this.scrubError(errorMessage(error), rec.secrets).slice(0, 2000),
        },
      } : {}),
      ...(rec.location ? { location: rec.location } : {}),
    };
    return ev;
  }

  endAction(handle: ActionRecord, error?: unknown): void {
    const rec = this.pending.get(handle.seq);
    if (!rec) return; // already flushed as pending
    if (rec.probe) {
      if (error !== undefined) {
        // The call failed, so there is nothing to inspect: the value stays masked.
        this.settle(rec, rec.rerender ? rec.rerender(true) : undefined, error);
      } else {
        this.runProbe(rec);
      }
      return;
    }
    this.pending.delete(handle.seq);
    this.push(this.actionEvent(rec, error === undefined ? 'ok' : 'error', now(), error), true);
  }

  private settle(rec: Pending, args: RenderedArgs | undefined, error?: unknown): void {
    if (!this.pending.delete(rec.seq)) return;
    if (args) {
      rec.args = args.text;
      rec.redacted = args.redacted;
      rec.secrets = args.secrets;
    }
    rec.rerender = undefined;
    rec.probe = undefined;
    this.push(this.actionEvent(rec, error === undefined ? 'ok' : 'error', now(), error), true);
  }

  /** inspectInputType: ask the page whether the field the value went into is a password field. */
  private runProbe(rec: Pending): void {
    const probe = rec.probe;
    if (!probe) return;
    const decide = (sensitive: boolean): void => {
      if (probe.page) {
        let cache = this.probeCache.get(probe.page);
        if (!cache) this.probeCache.set(probe.page, (cache = new Map()));
        cache.set(probe.selector, sensitive);
        this.sensitiveFocus.set(probe.page, sensitive);
      }
      this.settle(rec, rec.rerender ? rec.rerender(sensitive) : undefined);
    };
    try {
      const locator = probe.locator() as { first(): { evaluate(fn: unknown, arg?: unknown, options?: unknown): Promise<unknown> } };
      // Run inside our own zone so the probe is not logged as an action.
      const result = getRegistry().als.run({ inAction: true }, () =>
        locator.first().evaluate(PROBE_FN, undefined, { timeout: 1000 }));
      Promise.resolve(result).then(
          (value) => {
            const [type = '', autocomplete = ''] = Array.isArray(value) ? (value as string[]) : [];
            decide(type.toLowerCase() === 'password' || SENSITIVE_AUTOCOMPLETE.test(autocomplete));
          },
          () => decide(true),
      );
    } catch {
      decide(true);
    }
  }

  /** Mask values that Playwright options are about to carry (cookies, auth headers, credentials). */
  private learnSecrets(spec: MethodSpec, args: unknown[]): void {
    try {
      const first = args[0];
      if (spec.render === 'headers' && first !== null && typeof first === 'object') {
        const names = new Set(this.red.headers.map((h) => h.toLowerCase()));
        for (const [name, value] of Object.entries(first as Record<string, unknown>)) {
          if (names.has(name.toLowerCase())) this.addSecret(value);
        }
      } else if (spec.render === 'cookies' && Array.isArray(first)) {
        for (const cookie of first) this.addSecret((cookie as { value?: unknown } | null)?.value);
      } else if (spec.render === 'credentials' && first !== null && typeof first === 'object') {
        this.addSecret((first as { password?: unknown }).password);
      }
    } catch {
      // never fail a call because of logging
    }
  }

  /** Emit every unresolved action as `pending` (a test that timed out). */
  flushPending(): void {
    const left = [...this.pending.values()].sort((a, b) => a.seq - b.seq);
    this.pending.clear();
    const end = now();
    for (const rec of left) {
      if (rec.rerender) {
        const masked = rec.rerender(true);
        rec.args = masked.text;
        rec.redacted = masked.redacted;
        rec.secrets = masked.secrets;
        rec.rerender = undefined;
        rec.probe = undefined;
      }
      this.push(this.actionEvent(rec, 'pending', end), true);
    }
  }

  /** Stop recording (Playwright's own fixture teardown follows). */
  endCapture(): void {
    if (!this.capturing) return;
    this.capturing = false;
    this.flushPending();
  }

  fail(error: unknown): void {
    if (this.failed) return;
    this.failed = true;
    this.capturing = false;
    warnOnce(`browserLog disabled for this test after an internal error: ${errorMessage(error)}`);
  }

  // -- teardown -------------------------------------------------------------

  /** Remove listeners and registry entries. The patched prototypes stay (inert). */
  detach(): void {
    const reg = getRegistry();
    for (const dispose of this.disposers.splice(0)) {
      try {
        dispose();
      } catch {
        // ignore
      }
    }
    for (const page of this.trackedPages) if (reg.pages.get(page)?.session === this) reg.pages.delete(page);
    for (const context of this.trackedContexts) if (reg.contexts.get(context)?.session === this) reg.contexts.delete(context);
    this.trackedPages.clear();
    this.trackedContexts.clear();
  }

  get handle(): BrowserLogHandle {
    return {
      note: (m) => this.note(m),
      events: () => this.events(),
      render: (format = 'text') => renderBrowserTimeline(this.events(), { format, colors: false }),
      detach: () => this.detach(),
    };
  }
}
