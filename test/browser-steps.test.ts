import { test, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { wrapTestType } from '../src/browser/steps';
import { BrowserLogSession } from '../src/browser/session';
import { getRegistry } from '../src/browser/registry';
import { resolveBrowserConfig } from '../src/browser/types';
import type { BrowserLoggerConfig } from '../src/browser/types';

interface Call { title: string; options?: { location?: { file: string } }; ran?: boolean }

/** A TestType-shaped function: `step`, a static `step.skip`, and an `extend` that returns another one. */
function fakeTestType(calls: Call[] = []): Record<string, unknown> & (() => void) {
  const t = (() => {}) as Record<string, unknown> & (() => void);
  const step = async (title: string, body: () => unknown, options?: Call['options']): Promise<unknown> => {
    calls.push({ title, options, ran: true });
    return body();
  };
  (step as unknown as Record<string, unknown>).skip = () => 'skipped';
  t.step = step;
  t.extend = () => fakeTestType(calls);
  return t;
}

function activate(config: BrowserLoggerConfig = {}): BrowserLogSession {
  const s = new BrowserLogSession(resolveBrowserConfig({ colors: false, print: false, ...config }), {}, false);
  getRegistry().activeSession = s;
  return s;
}

beforeEach(() => {
  getRegistry().activeSession = null;
});

test('the caller location is passed to Playwright; an explicit one is kept', async () => {
  const calls: Call[] = [];
  const t = wrapTestType(fakeTestType(calls));
  await (t.step as (...a: unknown[]) => Promise<unknown>)('one', async () => 1);
  assert.match(calls[0].options?.location?.file ?? '', /browser-steps\.test\.ts$/);
  await (t.step as (...a: unknown[]) => Promise<unknown>)('two', async () => 1, { location: { file: '/x.ts', line: 1, column: 1 } });
  assert.equal(calls[1].options?.location?.file, '/x.ts');
});

test('static members of step survive and wrapping is idempotent', () => {
  const t = fakeTestType();
  const wrapped = wrapTestType(t);
  assert.equal(wrapped, t);
  assert.equal(typeof (t.step as unknown as { skip: () => string }).skip, 'function');
  const step = t.step;
  assert.equal(wrapTestType(t).step, step);
});

test('extend stays wrapped all the way down', async () => {
  const calls: Call[] = [];
  const t = wrapTestType(fakeTestType(calls));
  const child = (t.extend as () => Record<string, unknown>)();
  const grandChild = (child.extend as () => Record<string, unknown>)();
  await (grandChild.step as (...a: unknown[]) => Promise<unknown>)('deep', async () => 1);
  assert.match(calls[0].options?.location?.file ?? '', /browser-steps\.test\.ts$/);
});

test('without a session the step runs untouched', async () => {
  const t = wrapTestType(fakeTestType());
  assert.equal(await (t.step as (...a: unknown[]) => Promise<unknown>)('plain', async () => 'value'), 'value');
});

test('with a session: start/end events, step path in ALS, return value and errors pass through', async () => {
  const s = activate();
  const t = wrapTestType(fakeTestType());
  const step = t.step as (...a: unknown[]) => Promise<unknown>;
  const inner: Array<string[] | undefined> = [];
  const value = await step('outer', async () => {
    inner.push(getRegistry().als.getStore()?.step);
    await step('inner', async () => {
      inner.push(getRegistry().als.getStore()?.step);
    });
    return 7;
  });
  assert.equal(value, 7);
  assert.deepEqual(inner, [['outer'], ['outer', 'inner']]);
  const summary = s.events().filter((e) => e.kind === 'step').map((e) => (e.kind === 'step' ? `${e.phase}:${e.title}:${(e.step ?? []).join('>')}:${e.status ?? ''}` : ''));
  assert.deepEqual(summary, ['start:outer::', 'start:inner:outer:', 'end:inner:outer:passed', 'end:outer::passed']);

  const boom = new Error('step failed');
  await assert.rejects(step('bad', async () => { throw boom; }), (e) => e === boom);
  assert.equal(s.events().at(-1)?.kind === 'step' && s.events().at(-1)?.kind === 'step' && (s.events().at(-1) as { status?: string }).status, 'failed');
  await assert.rejects(step('sync', () => { throw boom; }), (e) => e === boom);
});

test('steps: false records nothing and does not touch the body', async () => {
  const s = activate({ steps: false });
  const t = wrapTestType(fakeTestType());
  await (t.step as (...a: unknown[]) => Promise<unknown>)('quiet', async () => 1);
  assert.deepEqual(s.events(), []);
});

test('secrets in step titles are scrubbed', async () => {
  const s = activate({ redact: { values: ['PLP-CANARY-7f3a'] } });
  const t = wrapTestType(fakeTestType());
  await (t.step as (...a: unknown[]) => Promise<unknown>)('login as PLP-CANARY-7f3a', async () => 1);
  assert.ok(!JSON.stringify(s.events()).includes('PLP-CANARY-7f3a'));
});
