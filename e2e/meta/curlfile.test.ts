import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import { runMeta } from './run';

const CANARY = 'PLP-CANARY-7f3a';
// eslint-disable-next-line no-control-regex
const ANSI = /\x1b\[|\x1b\]8;/;
const run = runMeta(['curlfile.spec.ts']);

const script = (r: ReturnType<typeof run.find>) => r.attachments.filter((a) => a.name === 'curl.sh');

test('curl.sh is attached, written to the output directory and announced', () => {
  const r = run.find('curl file: default');
  assert.equal(r.status, 'passed');
  const att = script(r);
  assert.equal(att.length, 1);
  assert.equal(att[0].contentType, 'text/plain');
  const body = att[0].body ?? '';
  assert.match(body, /^#!\/bin\/sh\n# curl file: default\n\ncurl /);
  assert.equal(body.match(/^curl /gm)?.length, 2);
  assert.ok(body.includes("'X-Note: it'\\''s $HOME'"), body);
  assert.ok(body.includes('Authorization: ***') && body.includes('token=***'), body);
  assert.ok(body.includes('"pin":"***"'), body);
  assert.ok(!body.includes(CANARY), 'redacted values stay out of curl.sh');
  assert.ok(!ANSI.test(body), 'no ANSI in curl.sh');
  // the file itself, in the test's output directory
  const line = r.stdout.split('\n').find((l) => l.startsWith('curl.sh: '));
  assert.ok(line, r.stdout);
  assert.ok(!ANSI.test(line), 'plain path when stdout is not a TTY');
  assert.ok(line.includes('curl-file-default'), line);
  const file = fs.readdirSync(run.outputDir, { recursive: true, withFileTypes: true })
      .filter((e) => e.isFile() && e.name === 'curl.sh')
      .map((e) => `${e.parentPath}/${e.name}`)
      .find((p) => p.includes('curl-file-default'));
  assert.ok(file, 'curl.sh exists in the output directory');
  assert.equal(fs.readFileSync(file, 'utf8'), body);
  assert.ok(!r.stdout.includes(CANARY));
});

test('a failing test still gets its curl.sh', () => {
  const r = run.find('curl file: failing test still writes it');
  assert.equal(r.status, 'failed');
  assert.equal(script(r).length, 1);
});

test('curlFormat.file: false, curl: false and an on-failure run without failures produce no file', () => {
  for (const title of [
    'curl file: switched off',
    'curl file: curl disabled',
    'curl file: on-failure with only 2xx responses',
  ]) {
    const r = run.find(title);
    assert.deepEqual(script(r), [], title);
    assert.ok(!r.stdout.includes('curl.sh:'), title);
  }
});

test('with a custom sink: no ANSI in any line, the notice goes through the sink', () => {
  const r = run.find('curl file: custom sink gets plain lines');
  const lines = r.stdout.split('\n').filter((l) => l.startsWith('SINK|')).map((l) => JSON.parse(l.slice(5)) as string);
  assert.ok(lines.length > 4);
  assert.ok(lines.every((l) => !ANSI.test(l)), 'plain');
  assert.ok(lines.some((l) => l.startsWith('curl -')) || lines.some((l) => l.startsWith('curl ')));
  assert.ok(lines.some((l) => l.startsWith('curl.sh: ')), 'notice via the sink');
  assert.equal(script(r).length, 1);
});

test('explicit colors: true keeps colours on apiLog lines but the curl stays plain', () => {
  const r = run.find('curl file: custom sink with colors true');
  const lines = r.stdout.split('\n').filter((l) => l.startsWith('SINK|')).map((l) => JSON.parse(l.slice(5)) as string);
  assert.ok(lines.some((l) => l.startsWith('\u001b[') && l.includes('→')), 'request line coloured');
  assert.ok(lines.some((l) => l.startsWith('curl ')), 'curl plain for a custom sink');
  const link = lines.find((l) => l.includes('curl.sh: '));
  assert.ok(link && !link.includes('\u001b]8;'), 'no hyperlink to a custom sink');
});
