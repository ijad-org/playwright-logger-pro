import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import { runMeta } from './run';
import { TITLE_ESCAPES, TITLE_QUERY, TITLE_VALUE, VALUE_CANARY } from './specs/curlfile-titles';

const CANARY = 'PLP-CANARY-7f3a';
// eslint-disable-next-line no-control-regex
const ANSI = /\x1b|\x07|\x9b|\x9d/;
const NOTICE = 'curl.sh: attached to the test report (see "curl.sh" in the HTML report; also saved in this test\'s output folder)';
const run = runMeta(['curlfile.spec.ts']);

const script = (r: ReturnType<typeof run.find>) => r.attachments.filter((a) => a.name === 'curl.sh');

test('curl.sh is attached, written to the output directory and announced', () => {
  const r = run.find('curl file: default');
  assert.equal(r.status, 'passed');
  const att = script(r);
  assert.equal(att.length, 1);
  assert.equal(att[0].contentType, 'text/plain');
  const body = att[0].body ?? '';
  assert.match(body, /^#!\/bin\/sh\n# curlfile\.spec\.ts:\d+\n# [^\n]*\n\ncurl /);
  assert.ok(!body.includes('curl file: default'), 'the title is not in the file');
  assert.equal(body.match(/^curl /gm)?.length, 2);
  assert.ok(body.includes("'X-Note: it'\\''s $HOME'"), body);
  assert.ok(body.includes('Authorization: ***') && body.includes('token=***'), body);
  assert.ok(body.includes('"pin":"***"'), body);
  assert.ok(!body.includes(CANARY), 'redacted values stay out of curl.sh');
  assert.ok(!ANSI.test(body), 'no ANSI in curl.sh');
  // the file itself, in the test's output directory
  const line = r.stdout.split('\n').find((l) => l.startsWith('curl.sh: '));
  assert.equal(line, NOTICE, r.stdout);
  const file = att[0].path;
  assert.ok(file && file.includes('curl-file-default'), file);
  assert.ok(fs.existsSync(file) && file.startsWith(run.outputDir), 'curl.sh exists in the output directory');
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

test('the test title never reaches the file, the attachment or the notice', () => {
  const cases: Array<[string, string[]]> = [
    [TITLE_QUERY, ['CANARY1', 'token=CANARY', 'echo?token', 'title with']],
    [TITLE_VALUE, [VALUE_CANARY, 'title with']],
    [TITLE_ESCAPES, ['CANARY-OSC8', 'evil.test', 'Q0FOQVJZ', 'title', 'line2']],
  ];
  for (const [title, forbidden] of cases) {
    const r = run.find(title);
    assert.equal(r.status, 'passed', `${JSON.stringify(title)}\n${r.stdout}`);
    const att = script(r);
    assert.equal(att.length, 1, JSON.stringify(title));
    const body = att[0].body ?? '';
    const onDisk = fs.readFileSync(att[0].path!, 'utf8');
    const notice = r.stdout.split('\n').filter((l) => l.includes('curl.sh'));
    assert.deepEqual(notice, [NOTICE], 'one plain notice');
    // the header: shebang, the spec location, the generic comment
    assert.match(body, /^#!\/bin\/sh\n# curlfile\.spec\.ts:\d+\n# redacted curl commands of this test; run with: sh curl\.sh\n\ncurl /);
    assert.equal(onDisk, body, 'file and attachment are the same');
    for (const [where, text] of [['file', onDisk], ['attachment', body], ['notice', notice.join('\n')]] as const) {
      assert.ok(!ANSI.test(text), `${where} has a control character: ${JSON.stringify(text.slice(0, 200))}`);
      for (const needle of forbidden) {
        assert.ok(!text.includes(needle), `${where} of ${JSON.stringify(title)} contains ${needle}: ${JSON.stringify(text.slice(0, 300))}`);
      }
    }
    // no line before the first command other than the header comments
    assert.ok(body.split('\n\n')[0].split('\n').every((l, i) => (i === 0 ? l === '#!/bin/sh' : l.startsWith('# '))));
    // eslint-disable-next-line no-control-regex
    assert.ok(!/[\u0000-\u0008\u000b-\u001f\u007f-\u009f\u2028\u2029]/.test(body.split('\n\n')[0]));
  }
});
