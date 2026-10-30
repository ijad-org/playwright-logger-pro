/* eslint-disable @typescript-eslint/no-require-imports */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { runMeta } from './run';
import { findCanary } from '../../scripts/assert-no-canary';

const CANARY = 'PLP-CANARY-7f3a';
const run = runMeta(['outputs.spec.ts']);
const [major, minor] = String((require('@playwright/test/package.json') as { version: string }).version).split('.').map(Number);
const supportsSteps = major > 1 || minor >= 48;
const SPEC = 'outputs.spec.ts';

function walk(dir: string, out: string[] = []): string[] {
  if (!fs.existsSync(dir)) return out;
  for (const name of fs.readdirSync(dir)) {
    const p = path.join(dir, name);
    if (fs.statSync(p).isDirectory()) walk(p, out);
    else out.push(p);
  }
  return out;
}

// eslint-disable-next-line no-control-regex
const ANSI = /\x1b\[/;
const block = (stdout: string): string => stdout.slice(stdout.indexOf('── browser log'));

test('default: a failing test prints one block and attaches plain text', () => {
  const r = run.find('default: failing test');
  assert.equal(r.status, 'failed');
  const att = r.attachments.filter((a) => a.name === 'browser-log');
  assert.equal(att.length, 1);
  assert.equal(att[0].contentType, 'text/plain');
  const body = att[0].body ?? '';
  assert.match(body, /^── browser log · .*outputs\.spec\.ts › default: failing test · chromium · failed ──/);
  assert.match(body, /\+\d+\.\d{3}s {2}✓ page\.goto\('\/login'\) {2}\d+ms/);
  assert.match(body, /getByLabel\('Email'\)\.fill\('jo@example\.com'\)/);
  assert.match(body, /✗ locator\('#nope'\)\.click\(\{ timeout: 300 \}\) {2}\d+ms {2}TimeoutError: /);
  assert.ok(!ANSI.test(body), 'no ANSI in attachments');
  assert.ok(r.stdout.includes('── browser log'), 'printed on failure');
  assert.ok(block(r.stdout).includes("page.goto('/login')"));
  assert.equal(r.attachments.filter((a) => /browser-log\.(txt|jsonl)$/.test(a.name)).length, 0);
});

test('default: a passing test is silent', () => {
  const r = run.find('default: passing test');
  assert.equal(r.status, 'passed');
  assert.deepEqual(r.attachments.filter((a) => a.name.startsWith('browser-log')), []);
  assert.equal(r.stdout, '');
});

test('test.fail(): the expected failure produces no output, the unexpected pass does', () => {
  const expected = run.find('default: expected failure');
  assert.equal(expected.expectedStatus, 'failed');
  assert.deepEqual(expected.attachments.filter((a) => a.name.startsWith('browser-log')), []);
  assert.equal(expected.stdout, '');
  const unexpected = run.find('default: expected failure that passes unexpectedly');
  assert.equal(unexpected.status, 'passed');
  assert.equal(unexpected.expectedStatus, 'failed');
  assert.equal(unexpected.attachments.filter((a) => a.name === 'browser-log').length, 1);
});

test('a test skipped from its body produces no output', () => {
  const r = run.find('default: skipped in the body');
  assert.equal(r.status, 'skipped');
  assert.deepEqual(r.attachments.filter((a) => a.name.startsWith('browser-log')), []);
  assert.equal(r.stdout, '');
});

test('apiLog lines are kept in the attachment but never printed again by the browser block', () => {
  const r = run.find('default: api and browser together');
  const att = r.attachments.find((a) => a.name === 'browser-log');
  assert.ok(att);
  assert.match(att.body ?? '', /\+\d+\.\d{3}s {2}api {2}.*GET.*\/api\/ok/);
  assert.ok(!/\+\d+\.\d{3}s {2}api /.test(block(r.stdout)), 'api events are not re-printed');
  assert.match(r.stdout, /GET .*\/api\/ok/, 'apiLog itself still printed its own lines');
});

test('a test that times out lists the action that never settled', () => {
  const r = run.find('hangs: action never settles');
  assert.equal(r.status, 'timedOut');
  const body = r.attachments.find((a) => a.name === 'browser-log')?.body ?? '';
  assert.match(body, /⧗ locator\('#never-appears'\)\.click\(\) {2}still pending after \d+ms/);
  assert.match(body, /timedOut ──/);
});

test('print: true streams lines live even for a passing test', () => {
  const r = run.find('live: passing');
  assert.equal(r.status, 'passed');
  assert.match(r.stdout, /\+\d+\.\d{3}s {2}✓ page\.goto\('\/login'\)/);
  assert.ok(!r.stdout.includes('── browser log'), 'no header block when streaming');
  assert.ok(!ANSI.test(r.stdout), 'colors: false');
});

test('attach/file as JSONL: schema v1, one event per line, fileDir naming, nothing deleted', () => {
  const r = run.find('files: passing');
  const att = r.attachments.find((a) => a.name === 'browser-log.jsonl');
  assert.ok(att);
  assert.equal(att.contentType, 'application/x-ndjson');
  const lines = (att.body ?? '').trim().split('\n').map((l) => JSON.parse(l) as { v: number; kind: string });
  assert.ok(lines.length >= 2);
  assert.ok(lines.every((l) => l.v === 1));
  const dir = path.join(run.outputDir, '..', 'plp-files');
  const files = fs.readdirSync(dir);
  assert.equal(files.length, 1);
  assert.match(files[0], /^outputs\.spec\.ts-.*-[0-9a-f]{8}\.jsonl$/);
  const fromFile = fs.readFileSync(path.join(dir, files[0]), 'utf8').trim().split('\n').map((l) => JSON.parse(l) as { kind: string });
  assert.deepEqual(fromFile.map((l) => l.kind), lines.map((l) => l.kind));
});

test('file: true without fileDir writes next to Playwright outputs (outputPath)', () => {
  const found = walk(run.outputDir).filter((p) => path.basename(p) === 'browser-log.txt');
  assert.equal(found.length, 1);
  assert.match(fs.readFileSync(found[0], 'utf8'), /page\.goto\('\/login'\)/);
  const r = run.find('file default location');
  assert.deepEqual(r.attachments.filter((a) => a.name.startsWith('browser-log')), []);
});

test('enabled: false is silent even when the test fails', () => {
  const r = run.find('disabled: failing test');
  assert.equal(r.status, 'failed');
  assert.deepEqual(r.attachments.filter((a) => a.name.startsWith('browser-log')), []);
  assert.equal(r.stdout, '');
});

test('an API-only failing test produces no browser log', () => {
  const r = run.find('no browser used: api-only test');
  assert.equal(r.status, 'failed');
  assert.deepEqual(r.attachments.filter((a) => a.name.startsWith('browser-log')), []);
});

test('steps: markers and indentation (Playwright 1.48+), step locations that point at the spec (all versions)', () => {
  const r = run.find('steps: failing inside a step');
  const body = r.attachments.find((a) => a.name === 'browser-log')?.body ?? '';
  if (supportsSteps) {
    assert.match(body, /▸ Open the login page/);
    assert.match(body, /◂ Open the login page {2}passed {2}\d+ms/);
    assert.match(body, /│ ✓ page\.goto\('\/login'\)/);
    assert.match(body, /◂ Submit {2}failed/);
  } else {
    assert.ok(!body.includes('▸'), 'no step markers below 1.48 (steps stay off under auto)');
  }
  const stepSteps = r.steps.filter((s) => s.category === 'test.step');
  assert.ok(stepSteps.length >= 2, 'test.step steps are reported');
  for (const s of stepSteps) {
    assert.equal(path.basename(s.file ?? ''), SPEC, `step "${s.title}" located at ${s.file}`);
    // PCL-34: a stack frame without parentheses used to leave "at " in the path ("../at /abs/outputs.spec.ts").
    assert.ok(path.isAbsolute(s.file ?? ''), `step "${s.title}" file is not absolute: ${s.file}`);
    assert.ok(!(s.file ?? '').includes('at '), `step "${s.title}" file keeps the stack prefix: ${s.file}`);
    assert.ok(fs.existsSync(s.file ?? ''), `step "${s.title}" file does not exist: ${s.file}`);
    assert.ok(typeof s.line === 'number' && s.line > 0, `step "${s.title}" has no line`);
  }
});

test('canary: a planted secret never reaches stdout, attachments or files', () => {
  const r = run.find('canary: secrets everywhere');
  assert.equal(r.status, 'failed');
  const att = r.attachments.find((a) => a.name === 'browser-log');
  assert.ok(att, 'the log was attached');
  assert.ok((att.body ?? '').length > 200);
  // Playwright's own artifacts (error-context snapshot, traces) are out of scope: they hold raw page state.
  const scanned = [r.stdout, r.stderr, ...r.attachments.filter((a) => a.name.startsWith('browser-log')).map((a) => a.body ?? '')];
  for (const text of scanned) assert.ok(!text.includes(CANARY), `canary in:\n${text.slice(0, 400)}`);
  const hits = findCanary(CANARY, [path.join(run.outputDir, '..', 'plp-canary-files')]);
  assert.deepEqual(hits, []);
  const written = walk(path.join(run.outputDir, '..', 'plp-canary-files'));
  assert.equal(written.length, 1, 'the canary run wrote its file');
  // The planted values were really exercised: the masked forms are present.
  assert.match(att.body ?? '', /fill\(\*\*\*\)/);
  assert.match(att.body ?? '', /console\.error {2}err \*\*\*/);
  assert.match(att.body ?? '', /note \*\*\*/);
});
