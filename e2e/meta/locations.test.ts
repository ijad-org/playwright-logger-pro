import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as path from 'node:path';
import { runMeta } from './run';

const SPEC = 'locations.spec.ts';
const PACKAGE_ROOT = path.resolve(__dirname, '..', '..');
const slashed = (p: string): string => p.replace(/\\/g, '/');
/**
 * Our own frames, by location: this checkout's `src/` and `dist/`, or an installed copy under
 * `node_modules/`. Never by the package name alone, which is also the checkout's folder name.
 */
const OWN_FRAME_DIRS = [path.join(PACKAGE_ROOT, 'src'), path.join(PACKAGE_ROOT, 'dist')].map((d) => slashed(d) + '/');
const isOwnFrame = (line: string): boolean => {
  const l = slashed(line);
  return OWN_FRAME_DIRS.some((d) => l.includes(d)) || l.includes('/node_modules/playwright-logger-pro/');
};
const isSpec = (file?: string): boolean => typeof file === 'string' && path.basename(file) === SPEC;

const run = runMeta(['--grep', 'browser action fails|request fails|request network error']);

for (const name of ['browser action fails', 'request fails', 'request network error']) {
  test(`step and error locations point at the spec file: ${name}`, () => {
    const r = run.find(name);
    assert.equal(r.status, 'failed', `${name} should fail`);
    const apiSteps = r.steps.filter((s) => s.category === 'pw:api' && s.file !== undefined);
    assert.ok(apiSteps.length > 0, 'expected pw:api steps with locations');
    for (const s of apiSteps) assert.ok(isSpec(s.file), `step "${s.title}" located at ${s.file}`);
    for (const e of r.errors) {
      if (e.file !== undefined) assert.ok(isSpec(e.file), `error located at ${e.file}`);
      const firstFrame = (e.stack ?? '').split('\n').find((l) => /^\s+at /.test(l)) ?? '';
      assert.ok(firstFrame.includes(SPEC), `first stack frame should be the spec, got: ${firstFrame}`);
      assert.ok(!(e.stack ?? '').split('\n').some(isOwnFrame), 'no library frames in the error stack');
    }
  });
}

test('step titles keep the method name (not "apply")', () => {
  const r = run.find('request fails');
  const titles = r.steps.map((s) => s.title).join('\n');
  assert.ok(!/\.apply\(|\.call\(/.test(titles), titles);
});
