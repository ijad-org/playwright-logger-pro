import { test } from 'node:test';
import assert from 'node:assert/strict';
import { ptyUnavailable, runMeta } from './run';

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

// A local `npx playwright test`: the runner's stdout is a terminal (a pseudo-terminal made by
// `script`), no CI, no NO_COLOR, no FORCE_COLOR and no PLAYWRIGHT_FORCE_TTY. The workers' stdout
// is still a pipe (on 1.30-1.39 made to look like a terminal), so only the runner can tell them.
const LOCAL = { NO_COLOR: undefined, FORCE_COLOR: undefined, DEBUG_COLORS: undefined, COLORTERM: undefined, TERM: 'xterm-256color' };
const noPty = ptyUnavailable();
const pty = (env: Record<string, string | undefined>) => runMeta(['curlcolor.spec.ts'], { ...LOCAL, ...env }, { pty: true });
const ptyRuns = noPty ? undefined : {
  local: pty({}),
  local16: pty({ TERM: 'xterm' }),
  truecolor: pty({ TERM: 'xterm', COLORTERM: 'truecolor' }),
  ci: pty({ CI: '1' }),
  githubActions: pty({ GITHUB_ACTIONS: 'true' }),
  noColor: pty({ NO_COLOR: '1' }),
  dumb: pty({ TERM: 'dumb' }),
  forceColor0: pty({ FORCE_COLOR: '0' }),
};
// Piped runner (no terminal) with the variable set by hand or left over from another process.
const handmade = {
  one: runMeta(['curlcolor.spec.ts'], { ...FORCE, PLP_RUNNER_TTY: '1' }),
  withDepth: runMeta(['curlcolor.spec.ts'], { ...FORCE, PLP_RUNNER_TTY: `${process.pid}:8` }),
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

const ptyTest = (name: string, fn: (runs: NonNullable<typeof ptyRuns>) => void): void => {
  test(name, { skip: noPty }, () => fn(ptyRuns!));
};
const SGR_256 = `${ESC}[38;5;`;

/** The runner's own terminal is enough: a local run colours the curl without any opt-in. */
ptyTest('a local run on a terminal colours the curl by default, in 256 colours', ({ local }) => {
  for (const title of [AUTO, TOP, EXPLICIT]) {
    colouredCurl(local, title);
    assert.ok(curlLines(local.find(title).stdout).some((l) => l.includes(SGR_256)), `${title}: 256-colour codes`);
  }
});

ptyTest('a local run on a 16-colour terminal uses the basic colours; truecolor gets 256', ({ local16, truecolor }) => {
  for (const title of [AUTO, TOP]) {
    colouredCurl(local16, title);
    const lines = curlLines(local16.find(title).stdout);
    assert.ok(lines.every((l) => !l.includes(SGR_256)), `no 256-colour codes:\n${JSON.stringify(lines)}`);
    assert.ok(lines.some((l) => l.includes(`${ESC}[94m`)), 'bright blue URL');
    assert.ok(curlLines(truecolor.find(title).stdout).some((l) => l.includes(SGR_256)));
  }
});

ptyTest('a local run: the coloured curl strips to the same command as the plain one, curl.sh is plain', ({ local, ci }) => {
  for (const title of [AUTO, TOP]) {
    // every run has its own server port
    const sameCommand = (stdout: string): string[] => curlLines(stdout).map((l) => stripAnsi(l).replace(/127\.0\.0\.1:\d+/, 'host'));
    const coloured = sameCommand(local.find(title).stdout);
    const plain = sameCommand(ci.find(title).stdout);
    assert.deepEqual(coloured, plain, title);
    const files = local.find(title).attachments.filter((a) => a.name === 'curl.sh');
    assert.equal(files.length, 1);
    assert.ok(!(files[0].body ?? '').includes(ESC));
  }
});

ptyTest('a terminal does not beat CI, NO_COLOR, TERM=dumb or FORCE_COLOR=0', ({ ci, githubActions, noColor, dumb, forceColor0 }) => {
  for (const run of [ci, githubActions, noColor, dumb, forceColor0]) for (const title of [AUTO, TOP]) plainCurl(run, title);
});

ptyTest('explicit curlFormat.colors: true still colours the curl in CI, under NO_COLOR and on TERM=dumb', ({ ci, noColor, dumb }) => {
  for (const run of [ci, noColor, dumb]) colouredCurl(run, EXPLICIT);
});

test('a PLP_RUNNER_TTY set by hand does not colour a piped run: it names no parent', () => {
  for (const run of Object.values(handmade)) for (const title of [AUTO, TOP]) plainCurl(run, title);
  for (const run of Object.values(handmade)) colouredCurl(run, EXPLICIT);
});
