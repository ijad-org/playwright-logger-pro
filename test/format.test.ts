import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  formatBody,
  formatRequestLine,
  formatResponseLine,
  redactHeaders,
  stringifyBody,
  truncateBody,
} from '../src/format';
import { resolveConfig } from '../src/types';

const plain = resolveConfig({ colors: false });
const colored = resolveConfig({ colors: true });

test('request line shows arrow, method and url', () => {
  const line = formatRequestLine('post', '/vegetables', plain);
  assert.equal(line, '→ POST /vegetables');
});

test('response line shows status and duration', () => {
  const line = formatResponseLine('get', 'http://x/vegetables', 200, 'OK', 42, plain);
  assert.equal(line, '← GET http://x/vegetables 200 OK (42ms)');
});

test('colored output contains ANSI escapes, plain output does not', () => {
  assert.doesNotMatch(formatRequestLine('get', '/x', plain), /\[/);
  assert.match(formatRequestLine('get', '/x', colored), /\[/);
});

test('redactHeaders masks case-insensitively and keeps others', () => {
  const out = redactHeaders(
      { "Authorization": 'Bearer tok', 'X-Trace': 'abc' },
      ['authorization'],
  );
  assert.deepEqual(out, { "Authorization": '***', 'X-Trace': 'abc' });
});

test('truncateBody appends remaining char count', () => {
  assert.equal(truncateBody('abcdef', 4), 'abcd... (2 more chars)');
  assert.equal(truncateBody('abc', 10), 'abc');
});

test('stringifyBody handles objects, strings, buffers and empties', () => {
  assert.equal(stringifyBody(undefined), undefined);
  assert.equal(stringifyBody(null), undefined);
  assert.equal(stringifyBody('x'), 'x');
  assert.equal(stringifyBody({ a: 1 }), JSON.stringify({ a: 1 }, null, 2));
  assert.match(stringifyBody(Buffer.alloc(5))!, /<Buffer 5 bytes>/);
});

test('formatBody indents and honors maxBodyLength', () => {
  const cfg = resolveConfig({ colors: false, maxBodyLength: 5 });
  const out = formatBody('123456789', cfg);
  assert.equal(out, '  12345... (4 more chars)');
  assert.equal(formatBody('', plain), undefined);
  assert.equal(formatBody(undefined, plain), undefined);
});
