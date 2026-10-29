import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { didFail, writeOutputs } from '../src/browser/output';
import type { TestInfoLike } from '../src/browser/output';
import { BrowserLogSession } from '../src/browser/session';
import { resolveBrowserConfig } from '../src/browser/types';
import type { BrowserLoggerConfig } from '../src/browser/types';

function fakeTestInfo(over: Partial<TestInfoLike> = {}): TestInfoLike & { attached: Array<{ name: string; body?: string | Buffer; contentType?: string }>; dir: string } {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'plp-out-'));
  const attached: Array<{ name: string; body?: string | Buffer; contentType?: string }> = [];
  return {
    title: 'does things',
    titlePath: ['login.spec.ts', 'login', 'does things'],
    status: 'failed',
    expectedStatus: 'passed',
    project: { name: 'chromium' },
    retry: 0,
    repeatEachIndex: 0,
    testId: 'abcdef0123456789',
    outputPath: (...segments: string[]) => path.join(dir, ...segments),
    async attach(name, options) {
      attached.push({ name, ...options });
    },
    attached,
    dir,
    ...over,
  };
}

function sessionWith(config: BrowserLoggerConfig, sink: string[] = []): BrowserLogSession {
  const cfg = resolveBrowserConfig({ colors: false, sink: (l) => { sink.push(l); }, ...config });
  const s = new BrowserLogSession(cfg, { title: 'login.spec.ts › does things', project: 'chromium' }, cfg.print === true);
  s.note('hello');
  return s;
}

test('didFail: outcome differs from expectation (test.fail, timedOut, interrupted)', () => {
  assert.equal(didFail({ status: 'passed', expectedStatus: 'passed' }), false);
  assert.equal(didFail({ status: 'failed', expectedStatus: 'failed' }), false);
  assert.equal(didFail({ status: 'failed', expectedStatus: 'passed' }), true);
  assert.equal(didFail({ status: 'timedOut', expectedStatus: 'passed' }), true);
  assert.equal(didFail({ status: 'interrupted', expectedStatus: 'passed' }), true);
  assert.equal(didFail({ status: 'passed', expectedStatus: 'failed' }), true);
  assert.equal(didFail({ status: 'skipped', expectedStatus: 'skipped' }), false);
});

test('defaults: print and attach on failure, no file', async () => {
  const sink: string[] = [];
  const info = fakeTestInfo();
  await writeOutputs(sessionWith({}, sink), info);
  assert.equal(sink.length, 1, 'a single sink call');
  assert.match(sink[0], /^── browser log · login\.spec\.ts › does things · chromium · failed ──\n\+\d+\.\d{3}s {2}✎ hello$/);
  assert.equal(info.attached.length, 1);
  assert.equal(info.attached[0].name, 'browser-log');
  assert.equal(info.attached[0].contentType, 'text/plain');
  assert.deepEqual(fs.readdirSync(info.dir), []);
});

test('passing test: nothing printed, attached or written', async () => {
  const sink: string[] = [];
  const info = fakeTestInfo({ status: 'passed' });
  await writeOutputs(sessionWith({}, sink), info);
  assert.deepEqual(sink, []);
  assert.deepEqual(info.attached, []);
  assert.deepEqual(fs.readdirSync(info.dir), []);
});

test('sessions without browser events write nothing, api lines alone do not count', async () => {
  const sink: string[] = [];
  const info = fakeTestInfo();
  const s = new BrowserLogSession(resolveBrowserConfig({ colors: false, sink: (l) => { sink.push(l); }, file: true }), {}, false);
  await writeOutputs(s, info);
  s.addApi('GET http://x');
  await writeOutputs(s, info);
  assert.deepEqual(sink, []);
  assert.deepEqual(info.attached, []);
  assert.deepEqual(fs.readdirSync(info.dir), []);
});

test('file: true writes plain text to outputPath; jsonl variant; fileDir naming with retry/repeat', async () => {
  const info = fakeTestInfo({ status: 'passed' });
  await writeOutputs(sessionWith({ file: true, print: false, attach: false }), info);
  assert.match(fs.readFileSync(path.join(info.dir, 'browser-log.txt'), 'utf8'), /✎ hello/);

  const info2 = fakeTestInfo({ status: 'passed', retry: 2, repeatEachIndex: 1 });
  const fileDir = path.join(info2.dir, 'nested', 'logs');
  await writeOutputs(sessionWith({ file: true, fileFormat: 'jsonl', fileDir, print: false, attach: false }), info2);
  const names = fs.readdirSync(fileDir);
  assert.equal(names.length, 1);
  assert.match(names[0], /^login\.spec\.ts-login-does-things-abcdef01-retry2-repeat1\.jsonl$/);
  const line = JSON.parse(fs.readFileSync(path.join(fileDir, names[0]), 'utf8').trim()) as { v: number; kind: string };
  assert.deepEqual([line.v, line.kind], [1, 'note']);
});

test('attachFormat jsonl uses browser-log.jsonl / application/x-ndjson; ANSI never reaches attachments', async () => {
  const sink: string[] = [];
  const info = fakeTestInfo();
  const s = sessionWith({ attachFormat: 'jsonl', colors: true }, sink);
  s.note('\u001b[31mred\u001b[0m');
  await writeOutputs(s, info);
  assert.equal(info.attached[0].name, 'browser-log.jsonl');
  assert.equal(info.attached[0].contentType, 'application/x-ndjson');
  assert.ok(!/\u001b\[/.test(String(info.attached[0].body)) || String(info.attached[0].body).includes('\\u001b'));
  assert.ok(/\u001b\[/.test(sink[0]), 'print uses the palette when colors are on');
});

test('a failing sink or attach never throws out of writeOutputs', async () => {
  const info = fakeTestInfo({
    async attach() {
      throw new Error('attach failed');
    },
  });
  const cfg = resolveBrowserConfig({ colors: false, sink: () => { throw new Error('sink failed'); } });
  const s = new BrowserLogSession(cfg, {}, false);
  s.note('x');
  const warn = console.warn;
  console.warn = () => {};
  try {
    await assert.doesNotReject(writeOutputs(s, info));
  } finally {
    console.warn = warn;
  }
});
