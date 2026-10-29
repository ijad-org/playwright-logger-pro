import { test, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { BrowserLogSession } from '../src/browser/session';
import { isMethodPatched } from '../src/browser/install';
import { PATCHED, getRegistry } from '../src/browser/registry';
import { resolveBrowserConfig } from '../src/browser/types';
import type { BrowserLoggerConfig } from '../src/browser/types';
import { FakeContext, FakeLocator, FakePage, calls } from './helpers/fakes';

function session(config: BrowserLoggerConfig = {}): BrowserLogSession {
  return new BrowserLogSession(resolveBrowserConfig({ colors: false, print: false, ...config }), {}, false);
}
const actionCalls = (s: BrowserLogSession): string[] =>
  s.events().filter((e) => e.kind === 'action').map((e) => (e.kind === 'action' ? `${e.subject}.${e.method}(${e.args})` : ''));

beforeEach(() => {
  calls.length = 0;
  getRegistry().activeSession = null;
});

test('one event per user call, even when calls delegate (page -> frame, locator -> frame, after an await)', async () => {
  const s = session();
  const page = new FakePage();
  s.attachPage(page);
  await page.click('#a');
  await page.locator('#b').click();
  await page.locator('#c').clear();
  await page.locator('#d').selectText();
  assert.deepEqual(actionCalls(s), [
    "page.click('#a')",
    "locator('#b').click()",
    "locator('#c').clear()",
    "locator('#d').selectText()", // delegates to a handle after an await: still one event
  ]);
  assert.deepEqual(calls, [
    'frame.click(#a)', 'frame.click(#b)', 'frame.fill(#c,)', 'handle.selectText',
  ]);
});

test('objects that are not attached pass straight through', async () => {
  const attached = new FakePage();
  const other = new FakePage();
  const s = session();
  s.attachPage(attached);
  await other.click('#x');
  await other.locator('#y').fill('v');
  assert.deepEqual(s.events(), []);
  assert.deepEqual(calls, ['frame.click(#x)', 'frame.fill(#y,v)']);
});

test('the original promise is returned and results are untouched', async () => {
  const s = session();
  const page = new FakePage();
  s.attachPage(page);
  const orig = getOriginal(FakePage.prototype, 'goto');
  const p = page.goto('http://x.test/');
  assert.ok(p instanceof Promise);
  assert.equal(await p, 'response');
  assert.equal(typeof orig, 'function');
  assert.equal(actionCalls(s)[0], "page.goto('http://x.test/')");
});

/** Replace the stored original of a patched method; returns the restore function. */
function stubOriginal(proto: object, name: string, impl: (...a: never[]) => unknown): () => void {
  const sym = Object.getOwnPropertySymbols(proto).find((x) => (x.description ?? "").endsWith(`.${name}`))!;
  assert.ok(sym, `original of ${name} is stored under a symbol`);
  const holder = proto as Record<symbol, unknown>;
  const saved = holder[sym];
  holder[sym] = impl;
  return () => {
    holder[sym] = saved;
  };
}

function getOriginal(proto: object, name: string): unknown {
  const fn = (proto as Record<string, unknown>)[name] as Record<symbol, unknown>;
  return fn[PATCHED];
}

test('a rejection reaches the caller unchanged and is logged as an error', async () => {
  const s = session();
  const page = new FakePage();
  s.attachPage(page);
  const boom = new Error('click: Timeout 5ms exceeded');
  const restore = stubOriginal(Object.getPrototypeOf(page.mainFrame()), 'click', () => Promise.reject(boom));
  try {
    await assert.rejects(page.mainFrame().click('#z'), (e) => e === boom);
  } finally {
    restore();
  }
  const ev = s.events().at(-1);
  assert.equal(ev?.kind === 'action' && ev.status, 'error');
  assert.equal(ev?.kind === 'action' && ev.error?.message, 'click: Timeout 5ms exceeded');
});

test('synchronous throws propagate and the call is recorded as an error', () => {
  const s = session();
  const page = new FakePage();
  s.attachPage(page);
  const err = new TypeError('sync boom');
  const restore = stubOriginal(Object.getPrototypeOf(page.mainFrame()), 'goto', () => {
    throw err;
  });
  try {
    assert.throws(() => page.mainFrame().goto('/'), (e) => e === err);
  } finally {
    restore();
  }
  const ev = s.events().at(-1);
  assert.equal(ev?.kind === 'action' && ev.status, 'error');
});

test('install is idempotent: attaching again never double-wraps', async () => {
  const s = session();
  const page = new FakePage();
  s.attachPage(page);
  const before = FakeLocator.prototype.click;
  const s2 = session();
  s2.attachPage(new FakePage());
  assert.equal(FakeLocator.prototype.click, before);
  assert.ok(isMethodPatched(FakeLocator.prototype, 'click'));
  await page.locator('#q').click();
  assert.equal(actionCalls(s).length, 1);
});

test('methods that do not exist on this Playwright version are skipped', () => {
  const s = session();
  s.attachPage(new FakePage());
  assert.ok(!('pressSequentially' in FakeLocator.prototype));
  assert.equal(isMethodPatched(FakePage.prototype, 'locator'), false); // factories are never patched
});

test('queries and waits follow their switches', async () => {
  const off = session({ queries: false });
  const page = new FakePage();
  off.attachPage(page);
  await page.locator('#q').textContent();
  assert.deepEqual(off.events(), []);

  const on = session({ queries: true });
  const page2 = new FakePage();
  on.attachPage(page2);
  await page2.locator('#q').textContent();
  assert.deepEqual(actionCalls(on), ["locator('#q').textContent()"]);
});

test('attachContext registers the current pages and pages opened later', async () => {
  const s = session();
  const ctx = new FakeContext();
  const first = new FakePage();
  ctx.pagesList.push(first);
  s.attachContext(ctx);
  await first.click('#a');
  const popup = new FakePage();
  ctx.emit('page', popup);
  await popup.click('#b');
  const ev = s.events().filter((e) => e.kind === 'action');
  assert.equal(ev.length, 2);
  assert.equal(ev[1].page, 2);
  s.detach();
  assert.equal(ctx.listenerCount('page'), 0);
  await first.click('#c');
  assert.equal(s.events().filter((e) => e.kind === 'action').length, 2);
});

test('endCapture flushes unresolved actions as pending and later settlement is ignored', async () => {
  const s = session();
  const page = new FakePage();
  s.attachPage(page);
  let release!: () => void;
  const restore = stubOriginal(Object.getPrototypeOf(page.mainFrame()), 'click', () => new Promise<void>((r) => { release = r; }));
  try {
    const pending = page.click('#hang');
    s.endCapture();
    const ev = s.events().at(-1);
    assert.equal(ev?.kind === 'action' && ev.status, 'pending');
    release();
    await pending;
  } finally {
    restore();
  }
  assert.equal(s.events().filter((e) => e.kind === 'action').length, 1);
});

test('two loaded copies of the modules share one registry and never double patch', () => {
  const req = createRequire(__filename);
  const regPath = req.resolve('../src/browser/registry');
  const installPath = req.resolve('../src/browser/install');
  const first = getRegistry();
  delete req.cache[regPath];
  delete req.cache[installPath];
  const copy = req('../src/browser/registry') as typeof import('../src/browser/registry');
  const copyInstall = req('../src/browser/install') as typeof import('../src/browser/install');
  assert.notEqual(copy.getRegistry, getRegistry);
  assert.equal(copy.getRegistry(), first);

  const page = new FakePage();
  const s = session();
  s.attachPage(page);
  const wrapped = FakeLocator.prototype.click;
  copyInstall.installPagePrototypes(page);
  assert.equal(FakeLocator.prototype.click, wrapped);
});
