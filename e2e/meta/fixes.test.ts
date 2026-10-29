import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { runMeta } from './run';
import { findCanary } from '../../scripts/assert-no-canary';

const run = runMeta(['fixes.spec.ts']);
const TYPED = ['typed', 'secret', '9c1e', 'x y'].join('-');
const SPEC = path.join(__dirname, 'specs', 'fixes.spec.ts');

test('PCL-30: a typed secret is masked in stdout, the attachment and the JSONL file', () => {
  const r = run.find('typed-only: the value is never registered as redact.values');
  assert.equal(r.status, 'failed');
  const att = r.attachments.find((a) => a.name === 'browser-log');
  assert.ok(att, 'the log was attached');
  const body = att.body ?? '';
  // The page really echoed the value, in several forms.
  assert.match(body, /console\.log {2}debug password=\*\*\*/);
  assert.match(body, /network GET \S+\/api\/ok\?token=\*\*\*&n= /);
  assert.match(body, /↪ \S+\/echo\?session=\*\*\*/);
  assert.match(body, /pageerror {2}boom \*\*\*/);
  for (const text of [r.stdout, r.stderr, body]) {
    assert.ok(!text.includes(TYPED), `typed value in:\n${text.slice(0, 600)}`);
    assert.ok(!text.includes(encodeURIComponent(TYPED)), 'URL-encoded typed value');
    assert.ok(!text.includes(encodeURIComponent(TYPED).replace(/%20/g, '+')), '+-encoded typed value');
  }
  assert.deepEqual(findCanary(TYPED, [path.join(run.outputDir, '..', 'plp-typed-files')]), []);
  const files = fs.readdirSync(path.join(run.outputDir, '..', 'plp-typed-files'));
  assert.equal(files.length, 1, 'the JSONL file was written');
  const jsonl = fs.readFileSync(path.join(run.outputDir, '..', 'plp-typed-files', files[0]), 'utf8');
  assert.ok(!jsonl.includes(encodeURIComponent(TYPED)));
  assert.ok(jsonl.split('\n').filter(Boolean).every((l) => JSON.parse(l).v === 1));
});

test('PCL-35: location: true points at the spec file and line, not at the library', () => {
  const r = run.find('location: true');
  const body = r.attachments.find((a) => a.name === 'browser-log')?.body ?? '';
  const lines = fs.readFileSync(SPEC, 'utf8').split('\n');
  const marked = lines.flatMap((l, i) => (l.includes('// LOC-MARK') ? [i + 1] : []));
  assert.equal(marked.length, 2);
  assert.ok(body.includes(`page.goto('/')`), body);
  assert.match(body, new RegExp(`page\\.goto\\('/'\\) {2}\\d+ms {2}\\(fixes\\.spec\\.ts:${marked[0]}\\)`));
  assert.match(body, new RegExp(`click\\(\\{ timeout: 300 \\}\\) {2}\\d+ms {2}TimeoutError: .* {2}\\(fixes\\.spec\\.ts:${marked[1]}\\)`));
  assert.ok(!/fixtures\.(js|mjs|ts)|dist|\bsrc[\\/]/.test(body.replace(/spec/g, '')), 'no library file in the log');
});

test('PCL-37: a completed fill is reported as completed, still masked, when the probe has not answered', () => {
  const r = run.find('probe still running at test end');
  const body = r.attachments.find((a) => a.name === 'browser-log')?.body ?? '';
  assert.match(body, /✓ locator\('#gone'\)\.fill\(\*\*\*\) {2}\d+ms/, body);
  assert.ok(!body.includes('still pending'), body);
  assert.ok(!body.includes('plain-value'), 'unknown sensitivity stays masked');
});

test('PCL-38: lines are in chronological order, live and in the attachment', () => {
  const r = run.find('order: dialog and close');
  const body = r.attachments.find((a) => a.name === 'browser-log')?.body ?? '';
  for (const text of [body, r.stdout]) {
    const at = (needle: string): number => {
      const i = text.indexOf(needle);
      assert.ok(i >= 0, `${needle} missing in:\n${text}`);
      return i;
    };
    assert.ok(at("page.click('#alert')") < at('◇ dialog alert'), text);
    assert.ok(at("page.close()") < at('page#1 closed'), text);
    assert.ok(at('page#1 opened') < at("page.goto('/dialog')"), text);
    const times = [...text.matchAll(/^\+(\d+\.\d{3})s/gm)].map((m) => Number(m[1]));
    assert.deepEqual(times, [...times].sort((a, b) => a - b), `timestamps not ascending:\n${text}`);
  }
});

test('PCL-36: invalid options warn once each and the failure block is still produced', () => {
  const r = run.find('invalid options');
  assert.equal(r.status, 'failed');
  for (const option of ['maxEvents', 'print', 'bogus']) {
    assert.ok(r.stderr.includes(`"${option}"`), `warning for ${option}:\n${r.stderr}`);
  }
  assert.equal((r.stderr.match(/"maxEvents"/g) ?? []).length, 1, 'warned once');
  assert.ok(r.stderr.includes('[playwright-logger-pro] '));
  const body = r.attachments.find((a) => a.name === 'browser-log')?.body ?? '';
  assert.match(body, /✗ locator\('#nope'\)\.click/);
  assert.ok(r.stdout.includes('── browser log'), 'the block was printed (print fell back to on-failure)');
});
