/**
 * Prototype drift check: lists public async methods that the installed
 * @playwright/test has on Page, Frame, Locator, Keyboard, Mouse, Touchscreen,
 * BrowserContext, Browser, Clock and ElementHandle but that browserLog's method
 * tables (src/browser/methods.ts) neither log nor deliberately ignore.
 *
 *   tsx scripts/check-prototype-drift.ts            # report, exit 0
 *   tsx scripts/check-prototype-drift.ts --strict   # exit 1 when something is unlisted
 *
 * In CI it runs weekly against the latest Playwright and emits a warning
 * annotation per unlisted method.
 */
import { chromium } from '@playwright/test';
import { METHOD_TABLES } from '../src/browser/methods';
import type { TableTarget } from '../src/browser/methods';

/** Async methods that are deliberately not logged (results are returned, or they are protocol plumbing). */
const IGNORED: Record<string, readonly string[]> = {
  page: [
    'opener', 'frames', 'consoleMessages', 'pageErrors', 'requests', 'requestGC', 'workers', 'bringToFront',
    'addInitScript', 'removeAllListeners', 'screenshot', 'video', 'ariaSnapshot', 'pickLocator', 'cancelPickLocator',
    'mainFrame', 'viewportSize', 'isClosed', 'context', 'url', 'setDefaultTimeout', 'setDefaultNavigationTimeout',
    'waitForConsoleMessage', 'waitForPopup', 'waitForDownload', 'waitForFileChooser', 'waitForWebSocket',
    'waitForWorker', 'startScreencast', 'stopScreencast', 'showActions', 'hideActions', 'clearConsoleMessages',
    'clearPageErrors',
  ],
  frame: ['waitForTimeout', 'frameElement', 'childFrames', 'parentFrame', 'detached', 'isDetached', 'name', 'url'],
  locator: ['page', 'describe', 'description', 'contentFrame', 'owner', 'normalize'],
  browser: ['close', 'newBrowserCDPSession', 'startTracing', 'stopTracing', 'bind', 'unbind', 'disconnect'],
  context: [
    'cookies', 'newCDPSession', 'serviceWorkers', 'backgroundPages', 'pages', 'browser', 'setDefaultTimeout',
    'setDefaultNavigationTimeout', 'unrouteAll', 'removeCookies', 'setStorageState', 'indexedDB', 'storageState',
    'exposeBinding', 'exposeFunction', 'route', 'unroute', 'routeFromHAR', 'routeWebSocket', 'waitForPage',
    'waitForConsoleMessage', 'enableDebugConsole', 'debugger',
    // Not patched on purpose: Playwright's `page` fixture calls it and the runner would link the
    // "Create page" step to our wrapper. Pages are registered from the `page` event instead.
    'newPage',
  ],
  keyboard: [],
  mouse: [],
  touchscreen: [],
  clock: [],
  elementHandle: [
    'ownerFrame', 'contentFrame', 'getAttribute', 'textContent', 'innerText', 'innerHTML', 'inputValue', 'isChecked',
    'isDisabled', 'isEditable', 'isEnabled', 'isHidden', 'isVisible', 'boundingBox', 'waitForElementState',
    'waitForSelector', '$', '$$', '$eval', '$$eval', 'asElement', 'jsonValue', 'getProperties', 'getProperty',
    'evaluate', 'evaluateHandle', 'dispose',
  ],
};

type Proto = Record<string, unknown>;

function asyncMethods(proto: object): string[] {
  const names = new Set<string>();
  for (let p: object | null = proto; p && p !== Object.prototype; p = Object.getPrototypeOf(p)) {
    const ctor = (p as { constructor?: { name?: string } }).constructor?.name ?? '';
    if (/^(ChannelOwner|EventEmitter|SdkObject)$/.test(ctor)) break;
    for (const name of Object.getOwnPropertyNames(p)) {
      if (name === 'constructor' || name.startsWith('_')) continue;
      const d = Object.getOwnPropertyDescriptor(p, name);
      const fn = d?.value as { constructor?: { name?: string } } | undefined;
      if (typeof d?.value === 'function' && fn?.constructor?.name === 'AsyncFunction') names.add(name);
    }
  }
  return [...names].sort();
}

async function main(): Promise<void> {
  const strict = process.argv.includes('--strict');
  const browser = await chromium.launch();
  const context = await browser.newContext();
  const page = await context.newPage();
  await page.setContent('<html><body><input id="x"></body></html>');
  const handle = await page.$('#x');
  const targets: Array<[TableTarget, object | null | undefined]> = [
    ['page', Object.getPrototypeOf(page)],
    ['frame', Object.getPrototypeOf(page.mainFrame())],
    ['locator', Object.getPrototypeOf(page.locator('html'))],
    ['keyboard', Object.getPrototypeOf(page.keyboard)],
    ['mouse', Object.getPrototypeOf(page.mouse)],
    ['touchscreen', Object.getPrototypeOf(page.touchscreen)],
    ['clock', (page as { clock?: object }).clock ? Object.getPrototypeOf((page as { clock?: object }).clock) : undefined],
    ['context', Object.getPrototypeOf(context)],
    ['browser', Object.getPrototypeOf(browser)],
    ['elementHandle', handle ? Object.getPrototypeOf(handle) : undefined],
  ];
  const version = (await import('@playwright/test/package.json', { with: { type: 'json' } }).catch(() => ({ default: { version: '?' } }))).default.version;
  let missing = 0;
  let stale = 0;
  for (const [target, proto] of targets) {
    if (!proto) continue;
    const present = new Set(asyncMethods(proto as Proto));
    const table = METHOD_TABLES[target];
    const ignored = new Set(IGNORED[target] ?? []);
    const unlisted = [...present].filter((m) => !(m in table) && !ignored.has(m));
    const gone = Object.keys(table).filter((m) => !present.has(m) && typeof (proto as Proto)[m] !== 'function');
    for (const m of unlisted) {
      missing++;
      console.log(`::warning title=Unlisted Playwright method::${target}.${m} exists in @playwright/test ${version} but is not in src/browser/methods.ts`);
    }
    stale += gone.length;
    if (gone.length > 0) console.log(`note: ${target}: listed but not present in ${version}: ${gone.join(', ')} (fine for newer-only methods)`);
  }
  await browser.close();
  console.log(`prototype drift against @playwright/test ${version}: ${missing} unlisted, ${stale} listed-but-absent`);
  if (strict && missing > 0) process.exit(1);
}

main().catch((error) => {
  console.error(error);
  process.exit(2);
});
