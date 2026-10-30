import { spawnSync } from 'node:child_process';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { CI_VARIABLES } from '../../src/env';

export interface MetaResult {
  title: string;
  titlePath: string[];
  results: Array<{
    status: string;
    expectedStatus: string;
    steps: Array<{ title: string; category: string; file?: string; line?: number }>;
    errors: Array<{ message: string; stack?: string; file?: string; line?: number }>;
    attachments: Array<{ name: string; contentType: string; body?: string; path?: string }>;
    stdout: string;
    stderr: string;
  }>;
}

export interface MetaRun {
  tests: MetaResult[];
  stdout: string;
  stderr: string;
  outputDir: string;
  find(title: string): MetaResult['results'][number];
}

/** Run the meta Playwright project (e2e/meta/specs) in a child process and collect results. */
let counter = 0;

/** Why a run under a pseudo-terminal is not possible here, or undefined when it is. */
export function ptyUnavailable(): string | undefined {
  if (process.platform !== 'linux') return `a pseudo-terminal run needs Linux (this is ${process.platform})`;
  const r = spawnSync('script', ['--version'], { encoding: 'utf8' });
  if (r.error || r.status !== 0) return 'a pseudo-terminal run needs `script` (util-linux), which is not installed';
  return undefined;
}

/** Whether nothing listens on `port` (the meta web server binds 127.0.0.1). */
function portIsFree(port: number): boolean {
  const probe = "require('net').createServer().once('error', () => process.exit(1)).listen(Number(process.argv[1]), '127.0.0.1', function () { this.close(); });";
  return spawnSync(process.execPath, ['-e', probe, String(port)]).status === 0;
}

/**
 * A port of its own for this run. Runs of different test files are concurrent, hence the per-process
 * and per-run offset; the probe skips a port something else already listens on, which would make
 * Playwright's web server fail and the run end with exit 1, no output and no results.
 */
function freshPort(run: number): number {
  let port = 20000 + ((process.pid * 7 + run * 131) % 20000);
  while (!portIsFree(port)) port = 20000 + ((port - 20000 + 1) % 20000);
  return port;
}

const shellQuote = (arg: string): string => `'${arg.replace(/'/g, `'\\''`)}'`;

/**
 * `env` is applied on top of a clean environment (no CI variables, no PLAYWRIGHT_FORCE_TTY,
 * NO_COLOR=1); a value of undefined removes the variable. With `pty` the runner is started under a
 * pseudo-terminal (`script`), so its stdout is a real terminal as in a local `npx playwright test`.
 */
export function runMeta(
    args: string[] = [],
    env: Record<string, string | undefined> = {},
    { pty = false }: { pty?: boolean } = {},
): MetaRun {
  const root = process.env.PLP_META_ROOT || path.resolve(__dirname, "..", "..");
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'plp-meta-'));
  const out = path.join(dir, 'results.json');
  const outputDir = path.join(dir, 'output');
  const bin = process.env.PLP_PLAYWRIGHT_BIN || path.join(root, 'node_modules', '.bin', 'playwright');
  const childEnv: Record<string, string | undefined> = {
    ...process.env,
    ...Object.fromEntries([...CI_VARIABLES, 'PLAYWRIGHT_FORCE_TTY', 'PLP_RUNNER_TTY'].map((name) => [name, undefined])),
    // Meta files run concurrently: every run gets its own, free, web server port.
    PLP_E2E_PORT: String(freshPort(counter++)),
    PLP_META_OUT: out, PLP_META_OUTPUT_DIR: outputDir, FORCE_COLOR: undefined, NO_COLOR: '1', ...env,
  };
  const command = [bin, 'test', '-c', path.join(root, 'e2e', 'meta', 'playwright.config.ts'), ...args];
  const [file, fileArgs] = pty ?
    ['script', ['-qefc', command.map(shellQuote).join(' '), '/dev/null']] as const :
    [command[0], command.slice(1)] as const;
  const r = spawnSync(file, fileArgs, {
    cwd: root, env: childEnv as NodeJS.ProcessEnv, encoding: 'utf8', timeout: 180_000,
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  const tests: MetaResult[] = fs.existsSync(out) ? JSON.parse(fs.readFileSync(out, 'utf8')) : [];
  return {
    tests,
    stdout: r.stdout ?? '',
    stderr: r.stderr ?? '',
    outputDir,
    find(title: string) {
      const t = tests.find((x) => x.title === title);
      if (!t) throw new Error(`meta test "${title}" not found; got: ${tests.map((x) => x.title).join(', ')}\n` +
        `(exit ${r.status}, signal ${r.signal}, ${r.error ?? 'no spawn error'})\n${r.stdout}\n${r.stderr}`);
      return t.results[t.results.length - 1];
    },
  };
}
