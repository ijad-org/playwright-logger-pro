import { test } from 'node:test';
import assert from 'node:assert/strict';
import { buildCurl } from '../src/curl';

test('GET without body has no -X and no data', () => {
  const cmd = buildCurl({ method: 'get', url: 'http://localhost:3000/vegetables' });
  assert.match(cmd, /^curl 'http:\/\/localhost:3000\/vegetables'$/);
  assert.doesNotMatch(cmd, /-X/);
  assert.doesNotMatch(cmd, /--data/);
});

test('POST with JSON object body adds -X, content-type and --data-raw', () => {
  const cmd = buildCurl({
    method: 'post',
    url: 'http://localhost:3000/vegetables',
    data: { name: 'Orange', price: 1 },
  });
  assert.match(cmd, /-X POST/);
  assert.match(cmd, /-H 'Content-Type: application\/json'/);
  assert.match(cmd, /--data-raw '\{"name":"Orange","price":1\}'/);
});

test('string body is passed through as-is', () => {
  const cmd = buildCurl({ method: 'post', url: 'http://x/y', data: 'raw-payload' });
  assert.match(cmd, /--data-raw 'raw-payload'/);
});

test('explicit content-type is not duplicated', () => {
  const cmd = buildCurl({
    method: 'post',
    url: 'http://x/y',
    headers: { 'content-type': 'application/vnd.custom+json' },
    data: { a: 1 },
  });
  const matches = cmd.match(/content-type/gi) ?? [];
  assert.equal(matches.length, 1);
});

test('headers are emitted and redacted per the redact list', () => {
  const cmd = buildCurl(
      {
        method: 'get',
        url: 'http://x/y',
        headers: { Authorization: 'Bearer secret-token', Accept: 'application/json' },
      },
      ['authorization'],
  );
  assert.match(cmd, /-H 'Authorization: \*\*\*'/);
  assert.match(cmd, /-H 'Accept: application\/json'/);
  assert.doesNotMatch(cmd, /secret-token/);
});

test('form parameters become --data-urlencode pairs', () => {
  const cmd = buildCurl({
    method: 'post',
    url: 'http://x/login',
    form: { user: 'jo', active: true },
  });
  assert.match(cmd, /--data-urlencode 'user=jo'/);
  assert.match(cmd, /--data-urlencode 'active=true'/);
  assert.doesNotMatch(cmd, /--data-raw/);
});

test('single quotes in values are shell-escaped', () => {
  const cmd = buildCurl({ method: 'post', url: 'http://x/y', data: "it's" });
  assert.ok(cmd.includes(`--data-raw 'it'\\''s'`));
});

test('buffer bodies are not dumped raw', () => {
  const cmd = buildCurl({ method: 'post', url: 'http://x/y', data: Buffer.from([1, 2, 3]) });
  assert.match(cmd, /--data-raw '<binary body omitted>'/);
});
