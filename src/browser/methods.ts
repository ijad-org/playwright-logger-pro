import type { ActionCategory, ActionTarget } from './types';

/** Which argument (if any) can carry a typed-in secret. */
export type SecretKind = 'value' | 'text' | 'key' | 'options';

export type RenderKind =
  | 'url'
  | 'urlPattern'
  | 'files'
  | 'evaluate'
  | 'html'
  | 'script'
  | 'headers'
  | 'cookies'
  | 'credentials'
  | 'predicate'
  | 'har';

export interface MethodSpec {
  category: ActionCategory;
  /** Page/Frame methods whose first argument is a selector string. */
  selector?: boolean;
  secret?: { index: number; kind: SecretKind };
  render?: RenderKind;
  /** Skip the call when Playwright's own fixtures make it (fixture setup / teardown). */
  runnerCheck?: boolean;
  /** Browser.newContext / newPage: attach the returned context / page to the active session. */
  result?: 'context' | 'page' | 'handle' | 'handles';
  /** Only recorded when `mouseMoves` is on. */
  noisy?: boolean;
}

type Table = Record<string, MethodSpec>;

function group(category: ActionCategory, names: string, extra: Partial<MethodSpec> = {}): Table {
  const out: Table = {};
  for (const name of names.split(/\s+/).filter(Boolean)) out[name] = { category, ...extra };
  return out;
}

/** Selector-first methods on Page and Frame; `n` shifts the secret index past the selector. */
function selectorFirst(): Table {
  return {
    ...group('action', 'click dblclick tap hover focus check uncheck setChecked dragAndDrop dispatchEvent', { selector: true }),
    fill: { category: 'action', selector: true, secret: { index: 1, kind: 'value' } },
    type: { category: 'action', selector: true, secret: { index: 1, kind: 'text' } },
    press: { category: 'action', selector: true, secret: { index: 1, kind: 'key' } },
    selectOption: { category: 'action', selector: true, secret: { index: 1, kind: 'options' } },
    setInputFiles: { category: 'action', selector: true, render: 'files' },
    waitForSelector: { category: 'wait', selector: true, result: 'handle' },
    $: { category: 'query', selector: true, result: 'handle' },
    ...group('query', '$eval $$eval', { selector: true }),
    $$: { category: 'query', selector: true, result: 'handles' },
    ...group('query', 'textContent innerText innerHTML inputValue getAttribute isVisible isHidden isEnabled isDisabled isEditable isChecked', { selector: true }),
  };
}

const PAGE_FRAME_COMMON: Table = {
  ...selectorFirst(),
  ...group('navigation', 'goto', { render: 'url' }),
  ...group('wait', 'waitForLoadState waitForTimeout'),
  ...group('wait', 'waitForURL', { render: 'url' }),
  ...group('wait', 'waitForNavigation waitForFunction', { render: 'predicate' }),
  ...group('action', 'evaluate evaluateHandle', { render: 'evaluate' }),
  setContent: { category: 'action', render: 'html' },
  ...group('action', 'addScriptTag addStyleTag', { render: 'script' }),
};

const PAGE: Table = {
  ...PAGE_FRAME_COMMON,
  ...group('navigation', 'reload goBack goForward'),
  ...group('action', 'close bringToFront setViewportSize emulateMedia screenshot pdf pause addLocatorHandler removeLocatorHandler'),
  addInitScript: { category: 'action', render: 'script' },
  ...group('action', 'exposeFunction exposeBinding unrouteAll hideHighlight'),
  ...group('action', 'route unroute routeWebSocket', { render: 'urlPattern' }),
  routeFromHAR: { category: 'action', render: 'har' },
  setExtraHTTPHeaders: { category: 'action', render: 'headers' },
  ...group('wait', 'waitForRequest waitForResponse', { render: 'urlPattern' }),
  waitForEvent: { category: 'wait', render: 'predicate' },
  ...group('query', 'title content'),
};
// page.close() is also called by Playwright's own fixtures.
PAGE.close = { category: 'action', runnerCheck: true };
PAGE.screenshot = { category: 'action', runnerCheck: true };

const FRAME: Table = { ...PAGE_FRAME_COMMON, ...group('query', 'title content') };

const LOCATOR: Table = {
  ...group('action', 'click dblclick tap clear check uncheck setChecked hover focus blur selectText scrollIntoViewIfNeeded screenshot highlight hideHighlight dispatchEvent drop'),
  fill: { category: 'action', secret: { index: 0, kind: 'value' } },
  type: { category: 'action', secret: { index: 0, kind: 'text' } },
  pressSequentially: { category: 'action', secret: { index: 0, kind: 'text' } },
  press: { category: 'action', secret: { index: 0, kind: 'key' } },
  selectOption: { category: 'action', secret: { index: 0, kind: 'options' } },
  setInputFiles: { category: 'action', render: 'files' },
  dragTo: { category: 'action' },
  ...group('action', 'evaluate evaluateAll evaluateHandle', { render: 'evaluate' }),
  waitFor: { category: 'wait' },
  elementHandle: { category: 'query', result: 'handle' },
  elementHandles: { category: 'query', result: 'handles' },
  ...group('query', 'textContent innerText innerHTML inputValue getAttribute isVisible isHidden isEnabled isDisabled isEditable isChecked count boundingBox allTextContents allInnerTexts ariaSnapshot all'),
};
LOCATOR.screenshot = { category: 'action', runnerCheck: true };

const KEYBOARD: Table = {
  ...group('action', 'down up', { secret: { index: 0, kind: 'key' } }),
  press: { category: 'action', secret: { index: 0, kind: 'key' } },
  type: { category: 'action', secret: { index: 0, kind: 'text' } },
  insertText: { category: 'action', secret: { index: 0, kind: 'text' } },
};

const MOUSE: Table = {
  ...group('action', 'click dblclick down up wheel'),
  move: { category: 'action', noisy: true },
};

const TOUCHSCREEN: Table = group('action', 'tap');

const CLOCK: Table = group('action', 'install fastForward runFor pauseAt resume setFixedTime setSystemTime');

const CONTEXT: Table = {
  ...group('action', 'addCookies clearCookies grantPermissions clearPermissions setGeolocation setOffline storageState exposeBinding exposeFunction'),
  addCookies: { category: 'action', render: 'cookies' },
  setHTTPCredentials: { category: 'action', render: 'credentials' },
  setExtraHTTPHeaders: { category: 'action', render: 'headers' },
  ...group('action', 'route unroute', { render: 'urlPattern' }),
  routeFromHAR: { category: 'action', render: 'har' },
  addInitScript: { category: 'action', render: 'script' },
  // No `newPage`: Playwright's `page` fixture calls it, and its "Create page" step would then be
  // located at our wrapper (the runner falls back to the first non-Playwright frame). Pages are
  // registered from the context's `page` event instead.
  close: { category: 'action', runnerCheck: true },
  waitForEvent: { category: 'wait', render: 'predicate' },
};

const BROWSER: Table = {
  newContext: { category: 'action', runnerCheck: true, result: 'context' },
  newPage: { category: 'action', runnerCheck: true, result: 'page' },
};

// Created later (a dialog event, a download event, a returned handle); patched on first sight.
const DIALOG: Table = {
  accept: { category: 'action', secret: { index: 0, kind: 'text' } },
  dismiss: { category: 'action' },
};

const DOWNLOAD: Table = {
  saveAs: { category: 'action' },
};

const ELEMENT_HANDLE: Table = {
  ...group('action', 'click dblclick tap check uncheck setChecked hover focus selectText scrollIntoViewIfNeeded screenshot dispatchEvent'),
  fill: { category: 'action', secret: { index: 0, kind: 'value' } },
  type: { category: 'action', secret: { index: 0, kind: 'text' } },
  press: { category: 'action', secret: { index: 0, kind: 'key' } },
  selectOption: { category: 'action', secret: { index: 0, kind: 'options' } },
  setInputFiles: { category: 'action', render: 'files' },
};
ELEMENT_HANDLE.screenshot = { category: 'action', runnerCheck: true };

export type TableTarget = Extract<
  ActionTarget,
  'page' | 'frame' | 'locator' | 'keyboard' | 'mouse' | 'touchscreen' | 'clock' | 'context' | 'browser' |
  'dialog' | 'download' | 'elementHandle'
>;

export const METHOD_TABLES: Record<TableTarget, Table> = {
  page: PAGE,
  frame: FRAME,
  locator: LOCATOR,
  keyboard: KEYBOARD,
  mouse: MOUSE,
  touchscreen: TOUCHSCREEN,
  clock: CLOCK,
  context: CONTEXT,
  browser: BROWSER,
  dialog: DIALOG,
  download: DOWNLOAD,
  elementHandle: ELEMENT_HANDLE,
};
