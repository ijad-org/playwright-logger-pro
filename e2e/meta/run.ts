import { spawnSync } from 'node:child_process';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

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
export function runMeta(args: string[] = [], env: Record<string, string> = {}): MetaRun {
  const root = process.env.PLP_META_ROOT || path.resolve(__dirname, "..", "..");
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'plp-meta-'));
  const out = path.join(dir, 'results.json');
  const outputDir = path.join(dir, 'output');
  const bin = process.env.PLP_PLAYWRIGHT_BIN || path.join(root, 'node_modules', '.bin', 'playwright');
  const childEnv: Record<string, string | undefined> = {
    ...process.env, PLP_META_OUT: out, PLP_META_OUTPUT_DIR: outputDir, FORCE_COLOR: undefined, NO_COLOR: '1', ...env,
  };
  delete childEnv.CI;
  const r = spawnSync(bin, ['test', '-c', path.join(root, 'e2e', 'meta', 'playwright.config.ts'), ...args], {
    cwd: root, env: childEnv as NodeJS.ProcessEnv, encoding: 'utf8', timeout: 180_000,
  });
  const tests: MetaResult[] = fs.existsSync(out) ? JSON.parse(fs.readFileSync(out, 'utf8')) : [];
  return {
    tests,
    stdout: r.stdout ?? '',
    stderr: r.stderr ?? '',
    outputDir,
    find(title: string) {
      const t = tests.find((x) => x.title === title);
      if (!t) throw new Error(`meta test "${title}" not found; got: ${tests.map((x) => x.title).join(', ')}\n${r.stdout}\n${r.stderr}`);
      return t.results[t.results.length - 1];
    },
  };
}
