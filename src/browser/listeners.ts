import { maskUrl } from '../redact';
import { getRegistry } from './registry';
import { installDialogPrototype, installDownloadPrototype } from './install';
import type { BrowserLogSession } from './session';
import type { ConsoleLevel } from './types';

type Listener = (...args: never[]) => void;
type Emitter = {
  on(event: string, listener: Listener): unknown;
  off?(event: string, listener: Listener): unknown;
  removeListener?(event: string, listener: Listener): unknown;
};

function listen(target: object, event: string, listener: Listener): () => void {
  const t = target as Emitter;
  t.on(event, listener);
  return () => {
    try {
      (t.off ?? t.removeListener)?.call(t, event, listener);
    } catch {
      // ignore
    }
  };
}

/** Run a listener body so that a logger bug can never reach Playwright's event emitter. */
function guard(session: BrowserLogSession, fn: (...args: never[]) => void): Listener {
  return ((...args: never[]) => {
    try {
      fn(...args);
    } catch (error) {
      session.fail(error);
    }
  }) as Listener;
}

const CONSOLE_RANK: Record<string, number> = { error: 3, assert: 3, warning: 2, info: 1, log: 1 };

/** Minimum rank to record for each `browserConsole` setting (0 = everything). */
const CONSOLE_MIN: Record<Exclude<ConsoleLevel, false>, number> = { error: 3, warning: 2, info: 1, all: 0 };

/**
 * Passive listeners for one context: new pages (popups, `context.newPage()`),
 * and network traffic when asked for. None of them changes Playwright's
 * behaviour. Returns a disposer.
 */
export function attachContextListeners(
    session: BrowserLogSession,
    context: object,
    onPage: (page: object, popup: boolean) => void,
): () => void {
  const disposers: Array<() => void> = [];
  disposers.push(listen(context, 'page', guard(session, ((page: object) => onPage(page, true)) as Listener)));

  const mode = session.cfg.network;
  if (mode !== false) {
    const started = new WeakMap<object, number>();
    const take = (r: { url(): string; method(): string; resourceType(): string }): boolean => {
      const filter = session.cfg.networkFilter;
      if (!filter) return true;
      try {
        return filter({ url: r.url(), method: r.method(), resourceType: r.resourceType() }) !== false;
      } catch {
        return true;
      }
    };
    const wanted = (resourceType: string, failed: boolean): boolean => {
      if (mode === 'all') return true;
      if (mode === 'failed') return failed;
      return failed || ['document', 'xhr', 'fetch'].includes(resourceType);
    };
    type Req = { url(): string; method(): string; resourceType(): string; failure?(): { errorText?: string } | null; frame?(): { page(): object } };
    const pageOfRequest = (r: Req): object | undefined => {
      try {
        return r.frame?.().page();
      } catch {
        return undefined;
      }
    };
    disposers.push(listen(context, 'request', guard(session, ((r: object) => {
      started.set(r, performance.now());
    }) as Listener)));
    disposers.push(listen(context, 'response', guard(session, ((response: { status(): number; request(): Req }) => {
      const request = response.request();
      const status = response.status();
      if (!wanted(request.resourceType(), status >= 400) || !take(request)) return;
      const t0 = started.get(request);
      session.emit({
        kind: 'network',
        method: request.method(),
        url: maskUrl(request.url(), session.values(), session.cfg.redact.mask),
        resourceType: request.resourceType(),
        status,
        ...(t0 !== undefined ? { durationMs: Math.round(performance.now() - t0) } : {}),
      }, pageOfRequest(request));
    }) as Listener)));
    disposers.push(listen(context, 'requestfailed', guard(session, ((request: Req) => {
      if (!wanted(request.resourceType(), true) || !take(request)) return;
      const t0 = started.get(request);
      session.emit({
        kind: 'network',
        method: request.method(),
        url: maskUrl(request.url(), session.values(), session.cfg.redact.mask),
        resourceType: request.resourceType(),
        failure: session.scrub(request.failure?.()?.errorText ?? 'request failed'),
        ...(t0 !== undefined ? { durationMs: Math.round(performance.now() - t0) } : {}),
      }, pageOfRequest(request));
    }) as Listener)));
  }
  return () => disposers.splice(0).forEach((d) => d());
}

/** Passive listeners for one page. Returns a disposer. */
export function attachPageListeners(session: BrowserLogSession, page: object, popup: boolean): () => void {
  const cfg = session.cfg;
  const reg = getRegistry();
  const disposers: Array<() => void> = [];
  const p = page as {
    mainFrame(): object;
    url(): string;
    listenerCount(event: string): number;
    context(): { listenerCount(event: string): number; emit(event: string, ...args: unknown[]): boolean };
  };

  // -- lifecycle -------------------------------------------------------------
  if (cfg.navigation) {
    // The context's `page` event fires before the opener's `popup` event, so wait a tick to tell them apart.
    // The event keeps the place (and time) the page appeared at, not the tick it was reported in.
    const seq = session.reserve();
    const t = session.elapsed();
    setImmediate(() => {
      if (session.failed || !session.hasPage(page)) {
        session.unreserve(seq);
        return;
      }
      const opener = session.openerOf(page);
      let url: string | undefined;
      try {
        url = p.url();
      } catch {
        url = undefined;
      }
      session.emit({
        kind: 'page',
        seq,
        t,
        event: opener ? 'popup' : 'opened',
        page: session.idFor(page),
        ...(opener ? { opener: session.idFor(opener) } : {}),
        ...(url && url !== 'about:blank' ? { url: maskUrl(url, session.values(), cfg.redact.mask) } : {}),
      }, page);
    });
    void popup;

    disposers.push(listen(page, 'popup', guard(session, ((child: object) => {
      session.setOpener(child, page);
    }) as Listener)));
    disposers.push(listen(page, 'close', guard(session, (() => {
      session.emit({ kind: 'page', event: 'closed', page: session.idFor(page) }, page);
    }) as Listener)));
    disposers.push(listen(page, 'crash', guard(session, (() => {
      session.emit({ kind: 'page', event: 'crashed', page: session.idFor(page) }, page);
    }) as Listener)));

    // -- main-frame navigations ----------------------------------------------
    disposers.push(listen(page, 'framenavigated', guard(session, ((frame: { url(): string; parentFrame?(): unknown }) => {
      if (frame !== p.mainFrame() && (typeof frame.parentFrame !== 'function' || frame.parentFrame() !== null)) return;
      session.onNavigated(page, maskUrl(frame.url(), session.values(), cfg.redact.mask));
    }) as Listener)));

    // -- downloads -----------------------------------------------------------
    disposers.push(listen(page, 'download', guard(session, ((download: { url(): string; suggestedFilename(): string }) => {
      reg.ownerOf.set(download, page);
      installDownloadPrototype(download);
      session.emit({
        kind: 'download',
        url: maskUrl(download.url(), session.values(), cfg.redact.mask),
        suggestedFilename: session.scrub(download.suggestedFilename()),
      }, page);
    }) as Listener)));

    // -- dialogs -------------------------------------------------------------
    // Playwright's default (no listener): dismiss the dialog (accept `beforeunload`). Listening to
    // observe the dialog switches that default off, so our listener repeats it when nobody else
    // handles the dialog. See docs/adr/0001-browser-capture.md (d).
    disposers.push(listen(page, 'dialog', guard(session, ((dialog: { type(): string; message(): string; accept(): Promise<void>; dismiss(): Promise<void> }) => {
      reg.ownerOf.set(dialog, page);
      installDialogPrototype(dialog);
      session.emit({ kind: 'dialog', dialogType: dialog.type(), message: session.scrub(dialog.message()) }, page);
      if (p.listenerCount('dialog') > 1) return; // somebody else handles it
      const context = p.context();
      if (context.listenerCount('dialog') > 0) {
        context.emit('dialog', dialog);
        return;
      }
      const result = dialog.type() === 'beforeunload' ? dialog.accept() : dialog.dismiss();
      Promise.resolve(result).catch(() => undefined);
    }) as Listener)));
  }

  // -- console and page errors ------------------------------------------------
  if (cfg.browserConsole !== false) {
    const min = CONSOLE_MIN[cfg.browserConsole];
    disposers.push(listen(page, 'console', guard(session, ((msg: {
      type(): string; text(): string; location(): { url?: string; lineNumber?: number };
    }) => {
      const level = msg.type();
      if ((CONSOLE_RANK[level] ?? 0) < min) return;
      const loc = msg.location();
      const where = loc && loc.url ? session.scrub(`${loc.url.split(/[\\/]/).pop()?.split('?')[0] ?? ''}:${loc.lineNumber ?? 0}`) : undefined;
      session.emit({
        kind: 'console',
        level,
        text: session.truncate(session.scrub(msg.text())),
        ...(where ? { location: where } : {}),
      }, page);
    }) as Listener)));
  }
  if (cfg.pageErrors) {
    disposers.push(listen(page, 'pageerror', guard(session, ((err: { message?: string; stack?: string } | string) => {
      const message = typeof err === 'string' ? err : String(err.message ?? err);
      const stack = typeof err === 'string' ? undefined : err.stack;
      const frames = stack ? stack.split('\n').filter((l) => /^\s+at /.test(l)).slice(0, 5).join('\n') : undefined;
      session.emit({
        kind: 'pageerror',
        message: session.truncate(session.scrub(message.split('\n')[0] ?? message)),
        ...(frames ? { stack: session.scrub(frames) } : {}),
      }, page);
    }) as Listener)));
  }
  return () => disposers.splice(0).forEach((d) => d());
}
