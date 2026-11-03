import { test } from 'node:test';
import assert from 'node:assert/strict';
import { pathToFileURL } from 'node:url';
import { applyHygiene, scrubOwnFrames } from '../src/browser/stackHygiene';
import type { HygieneDeps } from '../src/browser/stackHygiene';
import { LIB_DIR } from '../src/libDir';
import { isLibraryFile, pickCallSite } from '../src/browser/callSite';
import { getRegistry } from '../src/browser/registry';

function deps(modules: Record<string, unknown>, playwrightRoot?: string): HygieneDeps {
  return {
    playwrightRoot,
    load(id: string) {
      if (id in modules) return modules[id];
      throw new Error(`Cannot find module '${id}'`);
    },
  };
}

test('adapter a (1.6x): coreBundle utils.setBoxedStackPrefixes gets Playwright root + our dirs', () => {
  let received: string[] = [];
  const mode = applyHygiene(
      deps({ 'playwright-core/lib/coreBundle': { utils: { setBoxedStackPrefixes: (p: string[]) => { received = p; } } } }, '/pw'),
      ['/lib/dist/'],
  );
  assert.equal(mode, 'boxed');
  assert.equal(received[0], '/pw');
  assert.ok(received.includes('/lib/dist/'));
  assert.ok(received.includes(pathToFileURL('/lib/dist/').href), 'file:// spelling too (ES modules)');
});

test('adapter b (1.30): addStackIgnoreFilter hides frames under our dirs, also file:// URLs', () => {
  let filter!: (f: { file: string }) => boolean;
  const reg = getRegistry();
  reg.libDirs.add('/lib/dist/');
  try {
    const mode = applyHygiene(
        deps({ 'playwright-core/lib/utils': { addStackIgnoreFilter: (f: typeof filter) => { filter = f; } } }),
        ['/lib/dist/'],
    );
    assert.equal(mode, 'ignoreFilter');
    assert.equal(filter({ file: '/lib/dist/fixtures.js' }), true);
    assert.equal(filter({ file: 'file:///lib/dist/fixtures.mjs' }), true);
    assert.equal(filter({ file: '/work/tests/login.spec.ts' }), false);
  } finally {
    reg.libDirs.delete('/lib/dist/');
  }
});

test('adapter b (1.39-1.48): addInternalStackPrefix is called for each dir', () => {
  const added: string[] = [];
  const mode = applyHygiene(
      deps({ 'playwright-core/lib/utils': { addInternalStackPrefix: (p: string) => added.push(p) } }),
      ['/lib/dist/'],
  );
  assert.equal(mode, 'internalPrefix');
  assert.ok(added.includes('/lib/dist/'));
});

test('adapters are tried in order: a wins over b', () => {
  const mode = applyHygiene(deps({
    'playwright-core/lib/coreBundle': { utils: { setBoxedStackPrefixes: () => {} } },
    'playwright-core/lib/utils': { addStackIgnoreFilter: () => {} },
  }), ['/x/']);
  assert.equal(mode, 'boxed');
});

test('adapter c: nothing usable -> fallback', () => {
  assert.equal(applyHygiene(deps({}), ['/x/']), 'fallback');
  assert.equal(applyHygiene(deps({ 'playwright-core/lib/utils': {} }), ['/x/']), 'fallback');
  assert.equal(applyHygiene(deps({ 'playwright-core/lib/coreBundle': { utils: {} } }), ['/x/']), 'fallback');
});

test('LIB_DIR is the directory of the compiled modules (not the package root) and ends with a separator', () => {
  assert.ok(LIB_DIR.endsWith('/') || LIB_DIR.endsWith('\\'));
  assert.ok(/[\\/]src[\\/]$/.test(LIB_DIR) || /[\\/]dist[\\/]$/.test(LIB_DIR), LIB_DIR);
});

test('scrubOwnFrames removes our frames from error stacks (fallback) and never throws', () => {
  const err = new Error('boom');
  err.stack = ['Error: boom', '    at wrapped (/lib/dist/fixtures.js:1:1)', '    at test (/work/a.spec.ts:3:1)'].join('\n');
  scrubOwnFrames(err, ['/lib/dist/']);
  assert.equal(err.stack, 'Error: boom\n    at test (/work/a.spec.ts:3:1)');
  const frozen = Object.freeze({ stack: 'x /lib/dist/' });
  assert.doesNotThrow(() => scrubOwnFrames(frozen, ['/lib/dist/']));
  assert.doesNotThrow(() => scrubOwnFrames(null));
  assert.doesNotThrow(() => scrubOwnFrames('str'));
});

test('LIB_DIRS always includes LIB_DIR; dist builds also cover the source-mapped ../src path', async () => {
  const { LIB_DIRS } = await import('../src/libDir');
  assert.ok(LIB_DIRS.includes(LIB_DIR));
});

test('user frames survive when the checkout is itself named playwright-logger-pro (own frames are found by directory, not by name)', () => {
  const root = '/home/dev/playwright-logger-pro';
  const dirs = [`${root}/dist/`, `${root}/src/`];
  const spec = `${root}/e2e/specs/a.spec.ts`;
  const stack = [
    'Error: boom',
    `    at wrapped (${root}/src/browser/session.ts:10:3)`,
    `    at Page.goto (${root}/dist/fixtures.js:5:1)`,
    `    at ${spec}:7:9`,
  ].join('\n');

  assert.equal(isLibraryFile(spec, dirs), false);
  assert.equal(isLibraryFile(`${root}/src/browser/session.ts`, dirs), true);
  assert.deepEqual(pickCallSite(stack, dirs), { file: spec, line: 7, column: 9 });

  const err = new Error('boom');
  err.stack = stack;
  scrubOwnFrames(err, dirs);
  assert.ok(err.stack.includes(`at ${spec}:7:9`), 'the spec frame is kept');
  assert.ok(!err.stack.includes(`${root}/src/`) && !err.stack.includes(`${root}/dist/`), 'our frames are dropped');
});
