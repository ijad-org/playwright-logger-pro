import { warnOnce } from '../warn';
import {
  MIN_LEARNED_SECRET_LENGTH, headerSecretValues, matchesAny, normalizeSecretValues, redactText, secretVariants,
} from '../redact';
import { splitChars } from '../format';
import { isPrintableKey, renderArgs, typedSecretStrings } from './args';
import type { RenderedArgs } from './args';
import { describeFrame, describeLocator, quote } from './describe';
import { installContextPrototypes, installElementHandlePrototype, installPagePrototypes } from './install';
import { attachContextListeners, attachPageListeners } from './listeners';
import { OrderedPrinter } from './ordered';
import { getRegistry } from './registry';
import type { ActionRecord, ActionSink, BeginInput, Binding } from './registry';
import { callSite } from './callSite';
import { calledFromRunner } from './stackHygiene';
import { renderBrowserEventText, renderBrowserTimeline } from './render';
import type { MethodSpec } from './methods';
import type { ActionCategory, ActionTarget, BrowserLogEvent, ResolvedBrowserConfig, ResolvedRedactConfig } from './types';

export { callSite } from './callSite';

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
  pageObj?: object;
  /** goto(url): the requested URL, so the navigation it causes is not logged twice. */
  navUrl?: string;
  step?: string[];
  location?: { file: string; line: number; column: number };
  /** Re-render the arguments with the secret masked (or not). Dropped once the call is decided. */
  rerender?: (mask: boolean) => RenderedArgs;
  /** inspectInputType: the DOM probe that decides whether the typed value was a secret. */
  probe?: { page: object | undefined; selector: string; locator: () => unknown };
  /** Typed values learned as secrets while the probe is undecided (taken back if the field turns out ordinary). */
  learned?: string[];
  /** The call has finished (the probe may still be running). */
  done?: { end: number; error?: unknown };
}

/** Typed secrets remembered for the rest of the test; the oldest are forgotten beyond this. */
const MAX_TYPED_SECRETS = 256;

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
  private readonly openers = new WeakMap<object, object>();
  private readonly lastNav = new WeakMap<object, string>();
  private readonly handleDescriptions = new WeakMap<object, string>();
  /** inspectInputType results per page and target description; cleared on navigation. */
  private probeCache = new WeakMap<object, Map<string, boolean>>();
  private readonly trackedPages = new Set<object>();
  private readonly trackedContexts = new Set<object>();
  private readonly disposers: Array<() => void> = [];
  private red: ResolvedRedactConfig;
  /** Configured and runtime-learned (cookies, headers, credentials) secrets. */
  private baseValues: string[];
  /** Values typed into sensitive fields -> how many unresolved probes vouch for them. Insertion ordered. */
  private readonly typed = new Map<string, number>();
  /** When true, events print live to `sink` as they are recorded. */
  live: boolean;
  floating = false;
  private readonly printer = new OrderedPrinter((text) => this.print(text));

  constructor(readonly cfg: ResolvedBrowserConfig, meta: SessionMeta = {}, live = cfg.print === true) {
    this.meta = meta;
    this.live = live;
    this.red = { ...cfg.redact, values: [...cfg.redact.values] };
    this.baseValues = [...cfg.redact.values];
  }

  // -- redaction ------------------------------------------------------------

  /** Mask a literal secret learned at runtime (cookie values, header values, ...). */
  addSecret(value: unknown): void {
    if (typeof value !== 'string') return;
    this.addSecrets([value]);
  }

  /** Learn several secrets at once, each with its URL-encoded spellings. */
  addSecrets(values: readonly string[]): void {
    const all = values.flatMap((v) => (typeof v === 'string' && v.length > 0 ? [v, ...secretVariants(v)] : []));
    if (all.length === 0) return;
    this.baseValues = normalizeSecretValues([...this.baseValues, ...all]);
    this.rebuildValues();
  }

  /**
   * Learn values typed into a field that is masked in its action line, so a page
   * echoing them (console, URLs, errors, dialogs) is masked too. Values shorter
   * than MIN_LEARNED_SECRET_LENGTH are not learned. Returns what was registered.
   */
  learnTyped(values: readonly string[]): string[] {
    const learned: string[] = [];
    let changed = false;
    for (const v of values) {
      if (typeof v !== 'string' || v.trim().length < MIN_LEARNED_SECRET_LENGTH) continue;
      learned.push(v);
      const n = this.typed.get(v);
      this.typed.set(v, (n ?? 0) + 1);
      if (n === undefined) changed = true;
    }
    for (const oldest of this.typed.keys()) {
      if (this.typed.size <= MAX_TYPED_SECRETS) break;
      this.typed.delete(oldest);
      changed = true;
    }
    if (changed) this.rebuildValues();
    return learned;
  }

  /** Take back values learned with `learnTyped` (the probe found an ordinary field). */
  private unlearnTyped(values: readonly string[]): void {
    let changed = false;
    for (const v of values) {
      const n = this.typed.get(v);
      if (n === undefined) continue;
      if (n <= 1) {
        this.typed.delete(v);
        changed = true;
      } else this.typed.set(v, n - 1);
    }
    if (changed) this.rebuildValues();
  }

  private rebuildValues(): void {
    const typed = [...this.typed.keys()].flatMap((v) => secretVariants(v));
    this.red.values = normalizeSecretValues([...this.baseValues, ...typed]);
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

  /** Milliseconds since the session started, on the clock events are stamped with. */
  elapsed(): number {
    return now() - this.t0;
  }

  /**
   * Reserve a place in the timeline for an event that is recorded a moment
   * later (a page that just opened). Pass the result as `seq` (and `t`) to
   * `emit`, or `unreserve` it.
   */
  reserve(): number {
    const seq = this.nextSeq();
    if (this.live) this.printer.hold(seq);
    return seq;
  }

  unreserve(seq: number): void {
    this.printer.release(seq);
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

  /**
   * Store an event in timeline order. Actions are stored when they finish but
   * carry the `seq` and time of their start, so they are slotted in before the
   * events that happened while they ran.
   */
  protected push(ev: BrowserLogEvent, print: boolean): BrowserLogEvent {
    const buffer = this.buffer;
    let at = buffer.length;
    while (at > 0 && buffer[at - 1].seq > ev.seq) at--;
    if (at === buffer.length) buffer.push(ev);
    else buffer.splice(at, 0, ev);
    const limit = this.cfg.maxEvents;
    if (buffer.length > limit + Math.max(16, limit >> 2)) this.trim();
    if (print && this.live && ev.kind !== 'api') {
      this.printer.put(ev.seq, renderBrowserEventText(ev, { colors: this.cfg.colors }));
    }
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

  onResult(kind: 'context' | 'page' | 'handle' | 'handles', value: unknown, self: object, args: unknown[]): void {
    if (value === null || typeof value !== 'object') return;
    if (kind === 'context') this.attachContext(value);
    else if (kind === 'page') this.attachPage(value);
    else {
      const handles = kind === 'handles' ? (Array.isArray(value) ? value : []) : [value];
      if (handles.length === 0) return;
      let page: object | undefined;
      try {
        page = typeof (self as { page?: unknown }).page === 'function' ? (self as { page(): object }).page() : self;
      } catch {
        page = undefined;
      }
      if (!page) return;
      const from = typeof args[0] === 'string' ? args[0] : describeLocator(self);
      for (const handle of handles as object[]) {
        getRegistry().ownerOf.set(handle, page);
        this.handleDescriptions.set(handle, from);
      }
      installElementHandlePrototype(handles[0] as object);
    }
  }

  values(): readonly string[] {
    return this.red.values;
  }

  /** Cut free text (console messages, page errors) to `maxArgLength`. */
  truncate(text: string): string {
    const { head, rest } = splitChars(text, this.cfg.maxArgLength);
    return rest > 0 ? `${head}…(+${rest})` : head;
  }

  hasPage(page: object): boolean {
    return this.trackedPages.has(page);
  }

  setOpener(child: object, opener: object): void {
    this.openers.set(child, opener);
  }

  openerOf(page: object): object | undefined {
    return this.openers.get(page);
  }

  /** A main-frame navigation happened. */
  onNavigated(page: object, url: string): void {
    // A new document: the focused field is unknown again, and probe answers may no longer hold.
    this.sensitiveFocus.set(page, false);
    this.probeCache.delete(page);
    if (this.lastNav.get(page) === url) return;
    this.lastNav.set(page, url);
    for (const rec of this.pending.values()) {
      if (rec.pageObj === page && rec.navUrl !== undefined && (url === rec.navUrl || url.endsWith(rec.navUrl))) return;
    }
    this.emit({ kind: 'navigation', url }, page);
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
      case 'keyboard': case 'mouse': case 'touchscreen': case 'clock':
      case 'dialog': case 'download': case 'elementHandle':
        return reg.ownerOf.get(self);
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
    } else if (target === 'dialog') {
      try {
        const d = self as { type(): string; message(): string };
        selector = d.message();
        subject = `dialog(${d.type()} ${quote(this.scrub(splitChars(selector, 40).head))})`;
      } catch {
        subject = 'dialog';
      }
    } else if (target === 'download') {
      try {
        subject = `download(${quote(this.scrub((self as { suggestedFilename(): string }).suggestedFilename()))})`;
      } catch {
        subject = 'download';
      }
    } else if (target === 'elementHandle') {
      subject = `handle(${this.handleDescriptions.get(self) ?? '?'})`;
      selector = this.handleDescriptions.get(self);
    }

    const sensitiveSelector = selector !== undefined && matchesAny(selector, this.red.selectors);
    if (page) {
      if (spec.category === 'navigation') this.sensitiveFocus.set(page, false);
      else if (selector !== undefined && spec.category === 'action' && (target === 'locator' || target === 'page' || target === 'frame')) {
        this.sensitiveFocus.set(page, sensitiveSelector);
      }
    }

    this.learnSecrets(spec, args);
    if (page && spec.category === 'navigation') this.probeCache.delete(page);

    const wanted = this.wants(spec);
    let maskSecret = false;
    let needsProbe = false;
    if (spec.secret) {
      const mode = this.red.fillValues;
      if (mode === 'always') maskSecret = true;
      else if (mode === 'auto') {
        maskSecret = selector !== undefined ? sensitiveSelector : (page ? this.sensitiveFocus.get(page) === true : false);
        // The probe is a round trip, so it only runs for calls that are logged.
        if (!maskSecret && wanted && selector !== undefined && this.red.inspectInputType && page &&
          (target === 'locator' || target === 'page' || target === 'frame') &&
          (spec.secret.kind !== 'key' || (typeof args[spec.secret.index] === 'string' && isPrintableKey(args[spec.secret.index] as string)))) {
          const cached = this.probeCache.get(page)?.get(selector);
          if (cached === undefined) needsProbe = true;
          else maskSecret = cached;
        }
      }
    }

    // What is masked in the action line is also masked everywhere else from now on
    // (the page echoes it into console messages, URLs, errors, dialogs), whether or not
    // the action itself is logged. Undecided probe calls are learned provisionally.
    const learned = maskSecret || needsProbe ? this.learnTyped(typedSecretStrings(spec, args)) : [];

    if (!wanted) return undefined;
    if (spec.runnerCheck && calledFromRunner()) return undefined;

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
      pageObj: page,
      navUrl: spec.render === 'url' && method === 'goto' && typeof args[0] === 'string' ? args[0] : undefined,
      step: store?.step && store.step.length > 0 ? store.step : undefined,
      location: this.cfg.location ? callSite(getRegistry().libDirs) : undefined,
      ...(needsProbe ? { learned } : {}),
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
    if (this.live) {
      if (this.cfg.logStart) {
        this.print(renderBrowserEventText(this.actionEvent(rec, 'pending', now()), { colors: this.cfg.colors }).replace(/still pending after \d+ms/, 'started'));
      } else {
        // The line appears when the call finishes; what happens meanwhile follows it.
        this.printer.hold(rec.seq);
      }
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
        // If the test ends before the probe answers, the call is still reported as finished.
        rec.done = { end: now() };
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
    this.push(this.actionEvent(rec, error === undefined ? 'ok' : 'error', rec.done?.end ?? now(), error), true);
  }

  /** inspectInputType: ask the page whether the field the value went into is a password field. */
  private runProbe(rec: Pending): void {
    const probe = rec.probe;
    if (!probe) return;
    const decide = (sensitive: boolean): void => {
      if (!sensitive && rec.learned) this.unlearnTyped(rec.learned);
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
          // `Bearer X` is learned whole and as the bare token X.
          if (names.has(name.toLowerCase())) this.addSecrets(headerSecretValues(name, value));
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
        // Sensitivity still unknown: keep the value masked (safe side).
        const masked = rec.rerender(true);
        rec.args = masked.text;
        rec.redacted = masked.redacted;
        rec.secrets = masked.secrets;
        rec.rerender = undefined;
        rec.probe = undefined;
      }
      if (rec.done) {
        // The call completed and only the probe is outstanding: it is not pending.
        this.push(this.actionEvent(rec, rec.done.error === undefined ? 'ok' : 'error', rec.done.end, rec.done.error), true);
      } else {
        this.push(this.actionEvent(rec, 'pending', end), true);
      }
    }
    this.printer.flush();
  }

  /** Run the body of a `test.step`, recording its boundaries and tagging actions with the step path. */
  runStep(title: string, run: () => unknown): unknown {
    const reg = getRegistry();
    const store = reg.als.getStore();
    const name = this.scrub(title);
    const started = now();
    this.emit({ kind: 'step', phase: 'start', title: name });
    const finish = (status: 'passed' | 'failed'): void => {
      if (this.failed) return;
      this.emit({ kind: 'step', phase: 'end', title: name, status, durationMs: Math.round(now() - started) });
    };
    const inner = { ...store, inAction: store?.inAction ?? false, step: [...(store?.step ?? []), name] };
    let result: unknown;
    try {
      result = reg.als.run(inner, run);
    } catch (error) {
      finish('failed');
      throw error;
    }
    if (result !== null && typeof result === 'object' && typeof (result as PromiseLike<unknown>).then === 'function') {
      (result as PromiseLike<unknown>).then(() => finish('passed'), () => finish('failed'));
    } else {
      finish('passed');
    }
    return result;
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
    this.printer.flush();
    warnOnce(`browserLog disabled for this test after an internal error: ${errorMessage(error)}`);
  }

  // -- teardown -------------------------------------------------------------

  /** Remove listeners and registry entries. The patched prototypes stay (inert). */
  detach(): void {
    this.printer.flush();
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
