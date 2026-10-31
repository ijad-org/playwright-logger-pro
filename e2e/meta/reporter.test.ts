import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import * as path from 'node:path';
import { CI_VARIABLES } from '../../src/env';
import { renderTerminal } from './terminal';

const root = path.resolve(__dirname, '..', '..');
let ports = 0;

function run(workers: number, env: Record<string, string | undefined>, options: Record<string, unknown> = {}) {
  const port = 21000 + ((process.pid * 3 + ports++ * 17) % 4000);
  const bin = process.env.PLP_PLAYWRIGHT_BIN || path.join(root, 'node_modules', '.bin', 'playwright');
  const r = spawnSync(bin, [
    'test', '-c', path.join(root, 'e2e', 'reporter', 'playwright.config.ts'),
  ], {
    cwd: root,
    encoding: 'utf8',
    timeout: 120_000,
    env: {
      ...process.env,
      ...Object.fromEntries([...CI_VARIABLES, 'PLAYWRIGHT_FORCE_TTY', 'PLP_REPORTER', 'PLP_RUNNER_TTY', 'FORCE_COLOR', 'NO_COLOR'].map((n) => [n, undefined])),
      PLP_E2E_PORT: String(port),
      PLP_WORKERS: String(workers),
      PLP_REPORTER_OPTIONS: JSON.stringify(options),
      ...env,
    } as NodeJS.ProcessEnv,
  });
  // A failed spawn (no such binary, timeout) must not look like empty output.
  if (r.error || typeof r.stdout !== 'string') throw new Error(`could not run ${bin}: ${r.error?.message ?? 'no output'}`);
  return { output: r.stdout, status: r.status };
}

const RESULT = /^\s+(?:✓|✘|ok|x)\s+\d*\s*\[chromium\] › [^›]*› (tag\d) /;
const REQUEST = /^\s+(?:GET|POST)\s+\S+\s+https?:\/\/\S*[?&]t=(tag\d)/;

/**
 * Walks the screen: a request line must sit under a result (or title) line of its own test, and
 * a `│` line under a request line.
 */
function groupingProblems(screen: string[]): string[] {
  const problems: string[] = [];
  let current: string | undefined;
  let sawRequest = false;
  for (const line of screen) {
    const result = RESULT.exec(line);
    const request = REQUEST.exec(line);
    if (result) {
      current = result[1];
      sawRequest = false;
    } else if (request) {
      sawRequest = true;
      if (request[1] !== current) problems.push(`${request[1]} under ${current ?? 'nothing'}: ${line}`);
    } else if (/^\s+│/.test(line) && !sawRequest) {
      problems.push(`detail line without a request above it: ${line}`);
    }
  }
  return problems;
}

const TAGS = ['tag1', 'tag2', 'tag3', 'tag4', 'tag5', 'tag6'];

function assertComplete(screen: string[], rewritten = true): void {
  const text = screen.join('\n');
  for (const tag of TAGS) {
    assert.equal(screen.filter((l) => RESULT.exec(l)?.[1] === tag).length >= 1, true, `a result line for ${tag}\n${text}`);
    assert.equal(screen.filter((l) => REQUEST.exec(l)?.[1] === tag).length, 2, `two request lines for ${tag}\n${text}`);
  }
  // A line the list reporter printed when the test began and never rewrote. (Without colours it
  // strips its own cursor movements, so nothing is rewritten: Playwright's doing, not ours.)
  if (rewritten) assert.equal(screen.filter((l) => /^\s+\d+ \[chromium\] ›/.test(l)).length, 0, `unfinished lines\n${text}`);
  assert.match(text, /12 requests · 2 errors/, text);
  assert.ok(!text.includes('SECRET-123'), 'the secret is masked (it is in the output)');
  assert.ok(screen.some((l) => l.includes('← 500 Internal Server Error')), `the 500 block\n${text}`);
  assert.equal(screen.filter((l) => l.includes('← 404')).length, 0, `no block for the 404 of a passing test\n${text}`);
}

for (const workers of [1, 4]) {
  test(`non-terminal output, ${workers} worker(s): request lines sit under their result line`, () => {
    const { output } = run(workers, {});
    const screen = renderTerminal(output);
    assert.deepEqual(groupingProblems(screen), [], output);
    assertComplete(screen);
    // with the list reporter in place the blocks need no title line of their own
    if (workers === 1) assert.equal(screen.filter((l) => RESULT.exec(l)?.[1] === 'tag1').length, 1, output);
  });

  // With NO_COLOR (or FORCE_COLOR=0) in a terminal Playwright's list reporter strips its own cursor
  // movements and glues its lines together; that is not ours to test, so colours stay on here.
  test(`terminal output, ${workers} worker(s): nothing is garbled`, () => {
    const { output } = run(workers, { PLAYWRIGHT_FORCE_TTY: '160x40', FORCE_COLOR: '1' }, { colors: false });
    const screen = renderTerminal(output);
    assert.deepEqual(groupingProblems(screen), [], screen.join('\n'));
    assertComplete(screen);
    // one worker: each block is right under its own result line, no title lines needed;
    // four workers: the blocks wait for an idle terminal and come with a title line.
    const titled = screen.filter((l) => /^\s+(?:✓|✘)\s+\[chromium\] › ordering\.spec\.ts/.test(l)).length;
    assert.equal(titled, workers === 1 ? 0 : 6, screen.join('\n'));
  });
}
