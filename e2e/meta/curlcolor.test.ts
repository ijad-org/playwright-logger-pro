import { test } from 'node:test';
import assert from 'node:assert/strict';
import { runMeta } from './run';

const ESC = '\u001b';
// eslint-disable-next-line no-control-regex
const stripAnsi = (text: string): string => text.replace(/\x1b\[[0-9;]*m/g, '');

/** The lines of the printed curl commands (a command continues while a line ends with `\`). */
function curlLines(stdout: string): string[] {
  const lines = stdout.split('\n');
  const out: string[] = [];
  for (let i = 0; i < lines.length; i++) {
    if (!stripAnsi(lines[i]).startsWith('curl ')) continue;
    out.push(lines[i]);
    while (stripAnsi(lines[i]).endsWith('\\') && i + 1 < lines.length) out.push(lines[++i]);
  }
  return out;
}

// Real Playwright workers: FORCE_COLOR=1 and DEBUG_COLORS=1 are set by `playwright test` for
// them and their stdout is a pipe. NO_COLOR=1 is the default of runMeta, so each run starts
// by removing it. TERM is pinned: with TERM=dumb nothing is coloured.
const FORCE = { NO_COLOR: undefined, FORCE_COLOR: '1', TERM: 'xterm-256color' };
const runs = {
  ci: runMeta(['curlcolor.spec.ts'], { ...FORCE, CI: '1' }),
  githubActions: runMeta(['curlcolor.spec.ts'], { ...FORCE, GITHUB_ACTIONS: 'true' }),
  piped: runMeta(['curlcolor.spec.ts'], FORCE),
  forceTty: runMeta(['curlcolor.spec.ts'], { ...FORCE, PLAYWRIGHT_FORCE_TTY: '1' }),
  forceTtyInCi: runMeta(['curlcolor.spec.ts'], { ...FORCE, PLAYWRIGHT_FORCE_TTY: '1', CI: '1' }),
  noColor: runMeta(['curlcolor.spec.ts'], { ...FORCE, NO_COLOR: '1', PLAYWRIGHT_FORCE_TTY: '1' }),
};

const AUTO = 'curl color: auto';
const TOP = 'curl color: top-level colors true';
const EXPLICIT = 'curl color: explicit curlFormat true';

function plainCurl(run: ReturnType<typeof runMeta>, title: string): void {
  const r = run.find(title);
  assert.equal(r.status, 'passed', `${title}\n${r.stdout}`);
  const lines = curlLines(r.stdout);
  assert.ok(lines.length >= 4, `curl was printed: ${JSON.stringify(r.stdout)}`);
  assert.ok(lines.every((l) => !l.includes(ESC)), `no ESC byte in the curl:\n${JSON.stringify(lines)}`);
}

function colouredCurl(run: ReturnType<typeof runMeta>, title: string): void {
  const r = run.find(title);
  assert.equal(r.status, 'passed', `${title}\n${r.stdout}`);
  const lines = curlLines(r.stdout);
  assert.ok(lines.length >= 4, `curl was printed: ${JSON.stringify(r.stdout)}`);
  assert.ok(lines.some((l) => l.includes(`${ESC}[`)), `coloured curl expected:\n${JSON.stringify(lines)}`);
}

test('a worker under CI=1 and FORCE_COLOR=1 prints a curl without ESC bytes', () => {
  for (const title of [AUTO, TOP]) plainCurl(runs.ci, title);
  // the same worker does colour the other log lines: it is FORCE_COLOR that is being ignored for the curl
  const request = runs.ci.find(TOP).stdout.split('\n').find((l) => stripAnsi(l).includes('GET'));
  assert.ok(request?.includes(`${ESC}[`), `request line coloured: ${JSON.stringify(request)}`);
});

test('another CI service variable counts as CI as well', () => {
  for (const title of [AUTO, TOP]) plainCurl(runs.githubActions, title);
});

test('a piped worker (no CI) with FORCE_COLOR=1 prints a plain curl, with top-level colors: true too', () => {
  for (const title of [AUTO, TOP]) plainCurl(runs.piped, title);
});

test('PLAYWRIGHT_FORCE_TTY=1 outside CI: the worker prints a coloured curl', () => {
  for (const title of [AUTO, TOP]) colouredCurl(runs.forceTty, title);
});

test('PLAYWRIGHT_FORCE_TTY=1 does not override CI', () => {
  for (const title of [AUTO, TOP]) plainCurl(runs.forceTtyInCi, title);
});

test('NO_COLOR always wins under auto, even with FORCE_COLOR and PLAYWRIGHT_FORCE_TTY', () => {
  for (const title of [AUTO, TOP]) plainCurl(runs.noColor, title);
});

test('explicit curlFormat.colors: true colours the curl in CI, piped and under NO_COLOR', () => {
  for (const run of [runs.ci, runs.piped, runs.noColor, runs.forceTtyInCi]) colouredCurl(run, EXPLICIT);
});

test('the curl.sh attachment is never coloured, whatever the console shows', () => {
  for (const run of Object.values(runs)) {
    for (const title of [AUTO, TOP, EXPLICIT]) {
      const files = run.find(title).attachments.filter((a) => a.name === 'curl.sh');
      assert.equal(files.length, 1, title);
      assert.ok(!(files[0].body ?? '').includes(ESC), `${title}: no ESC in curl.sh`);
      assert.ok((files[0].body ?? '').includes('Authorization: ***'), title);
    }
  }
});
