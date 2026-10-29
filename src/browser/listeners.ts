import type { BrowserLogSession } from './session';

type Emitter = {
  on(event: string, listener: (...args: never[]) => void): unknown;
  off?(event: string, listener: (...args: never[]) => void): unknown;
  removeListener?(event: string, listener: (...args: never[]) => void): unknown;
};

function listen(target: object, event: string, listener: (...args: never[]) => void): () => void {
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

/**
 * Passive listeners for one context. None of them changes Playwright's
 * behaviour (see PLAN §5.7). Returns a disposer.
 */
export function attachContextListeners(
    session: BrowserLogSession,
    context: object,
    onPage: (page: object, popup: boolean) => void,
): () => void {
  void session;
  return listen(context, 'page', ((page: object) => onPage(page, true)) as never);
}

/** Passive listeners for one page. Returns a disposer. */
export function attachPageListeners(session: BrowserLogSession, page: object, popup: boolean): () => void {
  void session;
  void page;
  void popup;
  return () => {};
}
