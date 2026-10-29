import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  renderBrowserEventJsonl,
  renderBrowserEventText,
  renderBrowserHeader,
  renderBrowserTimeline,
} from '../src/browser/render';
import type { BrowserLogEvent } from '../src/browser/types';

const base = { v: 1 as const, ts: '2026-10-29T10:15:02.000Z' };

const events: BrowserLogEvent[] = [
  { ...base, seq: 1, t: 0, kind: 'page', event: 'opened', page: 1 },
  { ...base, seq: 2, t: 10, kind: 'action', category: 'navigation', target: 'page', method: 'goto',
    args: "'https://app.test/login?token=***'", status: 'ok', durationMs: 412 },
  { ...base, seq: 3, t: 422, kind: 'navigation', url: 'https://app.test/login?token=***' },
  { ...base, seq: 4, t: 425, kind: 'step', phase: 'start', title: 'Log in' },
  { ...base, seq: 5, t: 446, kind: 'action', category: 'action', target: 'locator',
    subject: "getByLabel('Password')", method: 'fill', args: '***', redacted: true, status: 'ok',
    durationMs: 15, step: ['Log in'] },
  { ...base, seq: 6, t: 560, kind: 'console', level: 'error', text: 'Failed to load resource: 401',
    location: 'app.js:12', step: ['Log in'] },
  { ...base, seq: 7, t: 561, kind: 'network', method: 'POST', url: 'https://app.test/api/session',
    status: 401, resourceType: 'fetch', durationMs: 83, step: ['Log in'] },
  { ...base, seq: 8, t: 563, kind: 'step', phase: 'end', title: 'Log in', status: 'passed', durationMs: 138 },
  { ...base, seq: 9, t: 570, kind: 'action', category: 'action', target: 'locator',
    subject: "locator('.toast-success')", method: 'click', args: '', status: 'error', durationMs: 5003,
    error: { name: 'TimeoutError', message: 'locator.click: Timeout 5000ms exceeded.\nCall log:\n - waiting' } },
];

test('golden text lines match the documented format', () => {
  const lines = events.map((e) => renderBrowserEventText(e));
  assert.deepEqual(lines, [
    '+0.000s  page#1 opened',
    "+0.010s  ✓ page.goto('https://app.test/login?token=***')  412ms",
    '+0.422s  ↪ https://app.test/login?token=***',
    '+0.425s  ▸ Log in',
    "+0.446s  │ ✓ getByLabel('Password').fill(***)  15ms",
    '+0.560s  │ ⚠ console.error  Failed to load resource: 401  (app.js:12)',
    '+0.561s  │ ✗ network POST https://app.test/api/session 401  83ms',
    '+0.563s  ◂ Log in  passed  138ms',
    "+0.570s  ✗ locator('.toast-success').click()  5003ms  TimeoutError: locator.click: Timeout 5000ms exceeded.",
  ]);
});

test('plain output never contains an ANSI escape, even if event text does', () => {
  const evil: BrowserLogEvent = { ...base, seq: 1, t: 1, kind: 'console', level: 'log',
    text: '\u001b[31mred\u001b[0m and \u001b[2Kclear' };
  const out = renderBrowserEventText(evil);
  assert.doesNotMatch(out, /\u001b/);
  assert.match(out, /red and/);
  for (const e of events) assert.doesNotMatch(renderBrowserEventText(e), /\u001b/);
});

test('colored output uses ANSI even when picocolors would auto-disable it', () => {
  const out = renderBrowserEventText(events[1], { colors: true });
  assert.match(out, /\u001b\[/);
  assert.equal(out.replace(/\u001b\[[0-9;]*m/g, ''), renderBrowserEventText(events[1]));
});

test('multi-line text is collapsed to one line', () => {
  const ev: BrowserLogEvent = { ...base, seq: 1, t: 1, kind: 'console', level: 'log', text: 'a\nb\r\nc' };
  assert.equal(renderBrowserEventText(ev), '+0.001s  • console.log  a ⏎ b ⏎ c');
});

test('pending, slow and page-prefixed actions', () => {
  const pending: BrowserLogEvent = { ...base, seq: 1, t: 1000, kind: 'action', category: 'action', target: 'locator',
    subject: "locator('#go')", method: 'click', args: '', status: 'pending', durationMs: 30012 };
  assert.match(renderBrowserEventText(pending), /⧗ locator\('#go'\)\.click\(\) {2}still pending after 30012ms$/);
  const multi: BrowserLogEvent = { ...base, seq: 2, t: 1, kind: 'action', category: 'action', target: 'locator',
    subject: "locator('#go')", method: 'click', args: '', status: 'ok', durationMs: 5, page: 2 };
  assert.match(renderBrowserEventText(multi), /\[page#2\] locator\('#go'\)\.click\(\)/);
  const onPage: BrowserLogEvent = { ...base, seq: 3, t: 1, kind: 'action', category: 'action', target: 'page',
    method: 'reload', args: '', status: 'ok', durationMs: 5, page: 2 };
  assert.match(renderBrowserEventText(onPage), /✓ page#2\.reload\(\)/);
});

test('pageerror stacks and api blocks keep their indent on every line', () => {
  const pe: BrowserLogEvent = { ...base, seq: 1, t: 1, kind: 'pageerror', message: 'Boom\nmore',
    stack: 'Error: Boom\n    at a (app.js:1:1)\n    at b (app.js:2:2)', step: ['S'] };
  assert.equal(renderBrowserEventText(pe), [
    '+0.001s  │ ✗ pageerror  Boom',
    '         │     Error: Boom',
    '         │     at a (app.js:1:1)',
    '         │     at b (app.js:2:2)',
  ].join('\n'));
  const api: BrowserLogEvent = { ...base, seq: 2, t: 2, kind: 'api', text: '→ GET /x\n  accept: */*' };
  assert.equal(renderBrowserEventText(api), ['+0.002s  api  → GET /x', '                accept: */*'].join('\n'));
});

test('dropped marker, note, dialog and download lines', () => {
  assert.equal(renderBrowserEventText({ ...base, seq: 1, t: 0, kind: 'dropped', count: 3 }),
      '+0.000s  … 3 earlier events dropped (maxEvents)');
  assert.equal(renderBrowserEventText({ ...base, seq: 1, t: 0, kind: 'note', message: 'hello' }), '+0.000s  ✎ hello');
  assert.equal(renderBrowserEventText({ ...base, seq: 1, t: 0, kind: 'dialog', dialogType: 'alert', message: 'hi' }),
      '+0.000s  ◇ dialog alert "hi"');
  assert.match(renderBrowserEventText({ ...base, seq: 1, t: 0, kind: 'download', url: 'http://x/a.pdf', suggestedFilename: 'a.pdf' }),
      /⤓ download "a\.pdf"/);
});

test('JSONL round-trips every event and carries the schema version', () => {
  const lines = events.map(renderBrowserEventJsonl);
  for (const [i, line] of lines.entries()) {
    assert.ok(!line.includes('\n'));
    const parsed = JSON.parse(line);
    assert.equal(parsed.v, 1);
    assert.deepEqual(parsed, events[i]);
  }
});

test('timeline: header, plain and jsonl formats', () => {
  const text = renderBrowserTimeline(events, {
    meta: { title: 'login.spec.ts › rejects wrong password', project: 'chromium', status: 'failed' },
  });
  const [head, first] = text.split('\n');
  assert.equal(head, '── browser log · login.spec.ts › rejects wrong password · chromium · failed ──');
  assert.equal(first, '+0.000s  page#1 opened');
  const jsonl = renderBrowserTimeline(events, { format: 'jsonl' });
  assert.equal(jsonl.trimEnd().split('\n').length, events.length);
  assert.ok(jsonl.endsWith('\n'));
  assert.equal(renderBrowserTimeline([], { format: 'jsonl' }), '');
  assert.equal(renderBrowserHeader({}), '── browser log ──');
});
