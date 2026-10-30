/**
 * Fake Playwright-shaped classes: enough surface for prototype discovery and
 * for the delegation patterns the real library has (page -> frame, locator ->
 * frame, and a delegation that happens after an await).
 */
import { EventEmitter } from 'node:events';

export const calls: string[] = [];

export class FakeKeyboard {
  async press(key: string): Promise<void> {
    calls.push(`keyboard.press(${key})`);
  }
  async type(text: string): Promise<void> {
    calls.push(`keyboard.type(${text})`);
  }
}
export class FakeMouse {
  async click(x: number, y: number): Promise<void> {
    calls.push(`mouse.click(${x},${y})`);
  }
}
export class FakeTouchscreen {
  async tap(): Promise<void> {}
}

export class FakeFrame {
  constructor(readonly owner: FakePage) {}
  page(): FakePage {
    return this.owner;
  }
  name(): string {
    return '';
  }
  url(): string {
    return 'http://x.test/';
  }
  async click(selector: string): Promise<void> {
    calls.push(`frame.click(${selector})`);
  }
  async fill(selector: string, value: string): Promise<void> {
    calls.push(`frame.fill(${selector},${value})`);
  }
  async goto(url: string): Promise<void> {
    calls.push(`frame.goto(${url})`);
  }
}

export class FakeLocator {
  constructor(readonly owner: FakePage, readonly selector: string) {}
  page(): FakePage {
    return this.owner;
  }
  toString(): string {
    return `locator('${this.selector}')`;
  }
  async click(): Promise<void> {
    await this.owner.mainFrame().click(this.selector);
  }
  async fill(value: string): Promise<void> {
    await this.owner.mainFrame().fill(this.selector, value);
  }
  async clear(): Promise<void> {
    await this.fill('');
  }
  /** Delegates to a handle after an await (the real selectText / screenshot do). */
  async selectText(): Promise<void> {
    await Promise.resolve();
    await new FakeHandle(this.owner).selectText();
  }
  async textContent(): Promise<string> {
    return 'text';
  }
  first(): FakeLocator {
    return this;
  }
  /** Set by tests: what the inspectInputType probe finds in the DOM (a promise: answers whenever it settles). */
  static probeResult: Array<string> | Error | Promise<unknown> = ['text', ''];
  async evaluate(): Promise<unknown> {
    if (FakeLocator.probeResult instanceof Error) throw FakeLocator.probeResult;
    return FakeLocator.probeResult;
  }
  async press(_key?: string): Promise<void> {
    void _key;
  }
}

export class FakeHandle {
  constructor(readonly owner: FakePage) {}
  async selectText(): Promise<void> {
    calls.push('handle.selectText');
  }
}

export class FakePage extends EventEmitter {
  url(): string {
    return 'about:blank';
  }
  keyboard = new FakeKeyboard();
  mouse = new FakeMouse();
  touchscreen = new FakeTouchscreen();
  private frame = new FakeFrame(this);
  mainFrame(): FakeFrame {
    return this.frame;
  }
  locator(selector: string): FakeLocator {
    return new FakeLocator(this, selector);
  }
  context(): FakeContext {
    return this.ctx;
  }
  ctx = new FakeContext();
  async goto(url: string): Promise<string> {
    return this.frame.goto(url).then(() => 'response');
  }
  async click(selector: string): Promise<void> {
    return this.frame.click(selector);
  }
  async fill(selector: string, value: string): Promise<void> {
    return this.frame.fill(selector, value);
  }
  async setExtraHTTPHeaders(_headers?: unknown): Promise<void> {
    void _headers;
  }
  async close(): Promise<void> {
    this.emit('close');
  }
  fail(): Promise<void> {
    return Promise.reject(new Error('page.fail: boom'));
  }
  syncThrow(): never {
    throw new TypeError('sync boom');
  }
  /** Not in any method table: never patched. */
  title(): string {
    return 't';
  }
}

export class FakeBrowser {
  async newContext(): Promise<FakeContext> {
    return new FakeContext();
  }
}

export class FakeContext extends EventEmitter {
  pagesList: FakePage[] = [];
  pages(): FakePage[] {
    return this.pagesList;
  }
  browser(): FakeBrowser | null {
    return null;
  }
  async addCookies(_cookies?: unknown): Promise<void> {
    void _cookies;
  }
  async setExtraHTTPHeaders(_headers?: unknown): Promise<void> {
    void _headers;
  }
}

/** A dialog event payload (a class, because the logger patches the prototype of the first dialog it sees). */
export class FakeDialog {
  constructor(private readonly kind: string, private readonly text: string) {}
  type(): string {
    return this.kind;
  }
  message(): string {
    return this.text;
  }
  async accept(_text?: string): Promise<void> {
    void _text;
  }
  async dismiss(): Promise<void> {}
}
