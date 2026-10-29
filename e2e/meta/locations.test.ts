import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as path from 'node:path';
import { runMeta } from './run';

const SPEC = 'locations.spec.ts';
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
      assert.ok(!/playwright-logger-pro|[\\/]src[\\/](browser|fixtures|wrapRequestContext)/.test(e.stack ?? ''),
          'no library frames in the error stack');
    }
  });
}

test('step titles keep the method name (not "apply")', () => {
  const r = run.find('request fails');
  const titles = r.steps.map((s) => s.title).join('\n');
  assert.ok(!/\.apply\(|\.call\(/.test(titles), titles);
});
