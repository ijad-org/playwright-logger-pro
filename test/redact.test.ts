import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  DEFAULT_SENSITIVE_KEYS,
  matchesAny,
  maskUrl,
  normalizeSecretValues,
  redactText,
  sanitizeDeep as redactDeep,
} from '../src/redact';
import { compileKeyPatterns } from '../src/browser/sensitive';
import { DEFAULT_REDACT_BODY_KEYS as typesBodyKeys } from '../src/types';

test('D7: one shared sensitive-key list; apiLog body redaction stays opt-in', () => {
  assert.deepEqual([...typesBodyKeys], []);
  for (const k of ['password', 'token', 'secret', 'pin', 'cvv']) assert.ok(DEFAULT_SENSITIVE_KEYS.includes(k), k);
});

test('compileKeyPatterns: short names stand alone, long names match inside', () => {
  const p = compileKeyPatterns(DEFAULT_SENSITIVE_KEYS);
  assert.ok(matchesAny('getByPlaceholder("Enter PIN")', p));
  assert.ok(matchesAny('userPassword', p));
  assert.ok(matchesAny('x_api_key', p));
  assert.ok(matchesAny('X-Api-Key', p));
  assert.ok(!matchesAny('shipping address', p));
  assert.ok(!matchesAny('compass', p));
  assert.ok(!matchesAny('getByLabel("Email")', p));
});

test('maskUrl always masks the userinfo password and literal values, nothing else', () => {
  assert.equal(maskUrl('https://jo:hunter2@host.test/p'), 'https://jo:***@host.test/p');
  assert.equal(maskUrl('https://jo@host.test/p'), 'https://jo@host.test/p');
  assert.equal(maskUrl('/api?token=abc&b=1'), '/api?token=abc&b=1');
  assert.equal(maskUrl('not a url'), 'not a url');
  assert.equal(maskUrl(''), '');
  assert.equal(maskUrl('https://x.test/PLP-CANARY-7f3a/y', ['PLP-CANARY-7f3a']), 'https://x.test/***/y');
});

test('redactText replaces longest values first and ignores short ones', () => {
  assert.equal(redactText('pass-word-123 and pass-word', ['pass-word', 'pass-word-123']), '*** and ***');
  assert.equal(redactText('abc abc', ['abc']), 'abc abc');
  assert.equal(redactText('a.b*c secret(1)', ['secret(1)']), 'a.b*c ***');
  assert.equal(redactText('x', []), 'x');
});

test('normalizeSecretValues drops junk, dedupes, sorts longest first and warns once', () => {
  const warns: unknown[][] = [];
  const original = console.warn;
  console.warn = (...a: unknown[]) => { warns.push(a); };
  try {
    const out = normalizeSecretValues(['', undefined, 5, 'ab', 'longer-secret', 'sec1', 'sec1']);
    assert.deepEqual(out, ['longer-secret', 'sec1']);
    normalizeSecretValues(['xy']);
    assert.equal(warns.length, 1);
    assert.match(String(warns[0][0]), /shorter than 4/);
  } finally {
    console.warn = original;
  }
});

test('matchesAny: strings are case-insensitive substrings, regexes are tested (even /g)', () => {
  assert.ok(matchesAny('getByLabel("PassWord")', ['password']));
  assert.ok(!matchesAny('getByLabel("Email")', ['password']));
  const g = /pass/g;
  assert.ok(matchesAny('pass', [g]));
  assert.ok(matchesAny('pass', [g]));
  assert.ok(!matchesAny('x', undefined));
  assert.ok(!matchesAny('x', ['']));
});

test('redactDeep masks by key, redacts string values and summarises odd types', () => {
  const out = redactDeep({
    user: 'jo',
    password: 'hunter2hunter2',
    nested: { Api_Key: 'k', note: 'my secret is PLP-CANARY-7f3a ok' },
    big: 10n,
    sym: Symbol('s'),
    fn: function named() {},
    buf: Buffer.from('abc'),
    re: /x/g,
    list: [1, { token: 't' }],
  }, { keys: [/pass/i, /api[-_]?key/i, /token/i], values: ['PLP-CANARY-7f3a'] });
  assert.deepEqual(out, {
    user: 'jo',
    password: '***',
    nested: { Api_Key: '***', note: 'my secret is *** ok' },
    big: '10n',
    sym: 'Symbol(s)',
    fn: '[Function named]',
    buf: '<Buffer 3 bytes>',
    re: '/x/g',
    list: [1, { token: '***' }],
  });
});

test('redactDeep handles cycles, shared references and depth limits', () => {
  const a: Record<string, unknown> = { n: 1 };
  a.self = a;
  assert.deepEqual(redactDeep(a), { n: 1, self: '[Circular]' });
  const shared = { v: 1 };
  assert.deepEqual(redactDeep({ x: shared, y: shared }), { x: { v: 1 }, y: { v: 1 } });
  assert.deepEqual(redactDeep({ a: { b: { c: { d: { e: 1 } } } } }, { maxDepth: 2 }), { a: { b: '[Object]' } });
});

test('redactDeep never throws on hostile objects', () => {
  const hostile = { get boom(): string { throw new Error('nope'); }, ok: 1 };
  assert.doesNotThrow(() => redactDeep(hostile));
  const out = redactDeep(hostile) as Record<string, unknown>;
  assert.equal(out.boom, '[Unreadable]');
  assert.equal(out.ok, 1);
});

test('redactDeep summarises errors without leaking secrets in the message', () => {
  const out = redactDeep(new Error('bad PLP-CANARY-7f3a'), { values: ['PLP-CANARY-7f3a'] });
  assert.deepEqual(out, { name: 'Error', message: 'bad ***' });
});
