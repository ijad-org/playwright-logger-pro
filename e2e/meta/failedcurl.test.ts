import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { CI_VARIABLES } from '../../src/env';
import { freshPort } from './run';

// Real runs of e2e/failed-curl: the server answers 201, the test asserts 200 (the repro), the list
// reporter and this package's reporter print, a JSON report holds the attachments.
const root = path.resolve(__dirname, '..', '..');
const ESC = '\u001b';
const SECRET = ['SECRET', '123'].join('-');
// Built from ESC so the patterns hold no control character.
const SGR = new RegExp(`${ESC}\\[[0-9;]*m`, 'g');
const strip = (text: string): string => text.replace(SGR, '');

interface Attachment { name: string; body: string }
interface Run {
  output: string;
  /** The API lines and their `│` blocks, as printed (colours included). */
  api: string[];
  attachments(title: string): Attachment[];
}

let counter = 0;
function run(
    apiLog: Record<string, unknown>,
    { env = {}, reporter = {}, withReporter = true }: {
      env?: Record<string, string | undefined>;
      reporter?: Record<string, unknown>;
      withReporter?: boolean;
    } = {},
): Run {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'plp-failed-curl-'));
  const jsonOut = path.join(dir, 'report.json');
  const bin = process.env.PLP_PLAYWRIGHT_BIN || path.join(root, 'node_modules', '.bin', 'playwright');
  const r = spawnSync(bin, ['test', '-c', path.join(root, 'e2e', 'failed-curl', 'playwright.config.ts')], {
    cwd: root,
    encoding: 'utf8',
    timeout: 120_000,
    env: {
      ...process.env,
      ...Object.fromEntries([...CI_VARIABLES, 'PLAYWRIGHT_FORCE_TTY', 'PLP_REPORTER', 'PLP_RUNNER_TTY', 'FORCE_COLOR', 'NO_COLOR'].map((n) => [n, undefined])),
      PLP_E2E_PORT: String(freshPort(1000 + counter++)),
      PLP_JSON_OUT: jsonOut,
      PLP_OUTPUT_DIR: path.join(dir, 'output'),
      PLP_API_LOG: JSON.stringify(apiLog),
      PLP_REPORTER_OPTIONS: JSON.stringify(reporter),
      PLP_NO_PLP_REPORTER: withReporter ? undefined : '1',
      ...env,
    } as NodeJS.ProcessEnv,
  });
  if (r.error || typeof r.stdout !== 'string' || !fs.existsSync(jsonOut)) {
    throw new Error(`could not run ${bin}: ${r.error?.message ?? 'no report'}\n${r.stdout}\n${r.stderr}`);
  }
  interface Suite {
    specs?: Array<{ title: string; tests: Array<{ results: Array<{ attachments?: Array<{ name: string; body?: string }> }> }> }>;
    suites?: Suite[];
  }
  const report = JSON.parse(fs.readFileSync(jsonOut, 'utf8')) as { suites: Suite[] };
  const found = new Map<string, Attachment[]>();
  const walk = (suite: Suite): void => {
    for (const spec of suite.specs ?? []) {
      for (const t of spec.tests) {
        for (const res of t.results) {
          found.set(spec.title, (res.attachments ?? []).flatMap((a) =>
            a.body === undefined ? [] : [{ name: a.name, body: Buffer.from(a.body, 'base64').toString('utf8') }]));
        }
      }
    }
    for (const child of suite.suites ?? []) walk(child);
  };
  report.suites.forEach(walk);
  return {
    output: r.stdout,
    api: r.stdout.split('\n').filter((l) => /^ {4}(?:GET|POST|DELETE|│)/.test(strip(l))),
    attachments: (title) => found.get(title) ?? [],
  };
}

const CREATE = 'creates an order';
const SOFT = 'a call after a soft failure';
const scripts = (r: Run, title: string) => r.attachments(title).filter((a) => a.name.endsWith('.sh'));

test('without the option the failed test is unchanged: the 201 is a single line, no curl, no curl.sh', () => {
  const r = run({});
  const lines = strip(r.api.join('\n')).split('\n');
  assert.ok(lines.some((l) => /POST +201 +http.*step=create&token=\*\*\*/.test(l)), r.output);
  assert.equal(lines.filter((l) => l.startsWith('    │')).length, 0, r.output);
  assert.ok(!r.output.includes('curl '), r.output);
  for (const title of [CREATE, SOFT, 'a passing test']) assert.deepEqual(scripts(r, title), [], title);
});

test("curlOnFailedTest: 'last': the failed test's last call shows its curl and attaches curl.sh, masked", () => {
  const r = run({ curlOnFailedTest: 'last' });
  const text = strip(r.output);
  assert.match(text, /POST +201 +http:\/\/127\.0\.0\.1:\d+\/status\/201\?step=create&token=\*\*\* +\d+ms\n/);
  assert.match(text, /\n {4}│ ← 201 Created {2}\{"path":"\/status\/201","status":201\}\n {4}│\n {4}│ curl -X POST 'http:\/\/127\.0\.0\.1:\d+\/status\/201\?step=create&token=\*\*\*' \\\n/);
  assert.ok(text.includes("    │   -H 'Authorization: ***' \\\n"), text);
  assert.ok(text.includes('    │ ↳ replay: curl.sh attached to the HTML report'), text);
  assert.doesNotMatch(text, /GET +200 [^\n]*\n {4}│/, 'the call before it has no block');
  const [script, ...others] = scripts(r, CREATE);
  assert.equal(script?.name, 'curl.sh');
  assert.deepEqual(others, []);
  assert.ok(script?.body.includes('"${AUTHORIZATION}"') && script.body.includes('"${TOKEN}"') && script.body.includes('"${PASSWORD}"'), script?.body);
  assert.ok(!r.output.includes(SECRET) && !JSON.stringify([...r.attachments(CREATE)]).includes(SECRET), 'the secret is nowhere');
  // The chip is the green success one in the reporter's own colour-free output too (plain mode shows ` 201 `).
  assert.doesNotMatch(text, /\[201\]/);
});

test('a passing test is untouched, and a call after a soft failure is not "the last call before the failure"', () => {
  const r = run({ curlOnFailedTest: 'last' });
  assert.deepEqual(scripts(r, 'a passing test'), []);
  const softScripts = scripts(r, SOFT);
  assert.equal(softScripts.length, 1);
  assert.ok(softScripts[0]?.body.includes('step=create-2'), softScripts[0]?.body);
  assert.ok(!softScripts[0]?.body.includes('after-soft'));
  const text = strip(r.output);
  assert.match(text, /DELETE +204 +http[^\n]*step=after-soft[^\n]*\n(?! {4}│)/, 'no block under the cleanup call');
  assert.match(text, /step=passing +\d+ms\n(?! {4}│)/, 'no block in the passing test');
});

test("curlOnFailedTest: 'all' blocks every call of the failed test, with numbered scripts", () => {
  const r = run({ curlOnFailedTest: 'all' });
  assert.deepEqual(scripts(r, CREATE).map((s) => s.name), ['curl-1-GET-200.sh', 'curl-2-POST-201.sh']);
  assert.equal(strip(r.output).split('\n').filter((l) => l.startsWith('    │ ← ')).length, 3, 'two + the soft-failure test\'s call');
});

test('colours: apiLog colors: true colours the reporter output although it is piped', () => {
  const r = run({ colors: true, curlOnFailedTest: 'last' });
  const post = r.api.find((l) => strip(l).includes('POST'));
  assert.ok(post?.includes(`${ESC}[`), `coloured: ${JSON.stringify(post)}`);
  assert.ok(r.api.filter((l) => strip(l).startsWith('    │')).every((l) => l.includes(`${ESC}[`)), 'the block too');
  assert.ok(post?.includes(`${ESC}[32m201`), `201 in the success colour: ${JSON.stringify(post)}`);
  assert.ok(!r.api.join('\n').includes(`${ESC}[41m`) && !r.api.join('\n').includes(`${ESC}[43m`), 'no error chip');
  assert.ok(!r.api.join('\n').includes(`${ESC}[31m│`) && !r.api.join('\n').includes(`${ESC}[33m│`), 'no red or yellow gutter on a 2xx');
});

test('colours: colors: true alone is enough (curlOnFailedTest not needed)', () => {
  const r = run({ colors: true });
  assert.ok(r.api.some((l) => l.includes(`${ESC}[`)), r.output);
});

// Without the reporter the worker prints and Playwright's list reporter relays it: it strips the
// colours of a worker's output when the runner itself does not colour (a pipe, no FORCE_COLOR). So
// the fixture's own output can only show them when the runner colours too.
test('colours: with no reporter registered, colors: true colours what the fixture prints once the runner colours', () => {
  const on = run({ colors: true }, { withReporter: false, env: { FORCE_COLOR: '1' } });
  assert.ok(on.api.length > 0 && on.api.some((l) => l.includes(`${ESC}[`)), on.output);
  const unset = run({}, { withReporter: false, env: { FORCE_COLOR: '1' } });
  assert.ok(unset.api.length > 0 && unset.api.every((l) => !l.includes(`${ESC}[`)), 'unchanged: FORCE_COLOR alone does not colour it\n' + unset.output);
});

test('colours stay plain without an explicit true: nothing set, FORCE_COLOR, NO_COLOR, colors: false', () => {
  const cases: Array<[string, Run]> = [
    ['nothing set', run({})],
    ['FORCE_COLOR=1 (what Playwright gives its workers), piped', run({}, { env: { FORCE_COLOR: '1' } })],
    ['NO_COLOR', run({}, { env: { NO_COLOR: '1' } })],
    ['colors: false', run({ colors: false })],
    ['colors: false and FORCE_COLOR=1', run({ colors: false }, { env: { FORCE_COLOR: '1' } })],
    ['colors: false and NO_COLOR', run({ colors: false }, { env: { NO_COLOR: '1' } })],
    ['no reporter, nothing set', run({}, { withReporter: false })],
  ];
  for (const [name, r] of cases) {
    assert.ok(r.api.length > 0, `${name}: API lines found\n${r.output}`);
    assert.ok(r.api.every((l) => !l.includes(`${ESC}[`)), `${name}: plain\n${r.api.join('\n')}`);
  }
});

test("the reporter option is the workaround and wins: ['playwright-logger-pro/reporter', { colors }]", () => {
  const on = run({}, { reporter: { colors: true } });
  assert.ok(on.api.some((l) => l.includes(`${ESC}[`)), on.output);
  const off = run({ colors: true }, { reporter: { colors: false } });
  assert.ok(off.api.length > 0 && off.api.every((l) => !l.includes(`${ESC}[`)), off.output);
});
