#!/usr/bin/env node
// Run the e2e suite (and the meta tests) against a specific @playwright/test version.
//
//   node scripts/e2e-version.mjs 1.30.0
//   node scripts/e2e-version.mjs latest --browsers all
//   PLP_E2E_FROM=dist node scripts/e2e-version.mjs 1.48.0
//
// The repo's own node_modules is left alone: the sources are copied next to an
// isolated install of the requested Playwright in $PLP_E2E_CACHE (default /tmp/plp-e2e).
import { spawnSync } from 'node:child_process';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const argv = process.argv.slice(2);
const version = argv[0] && !argv[0].startsWith('--') ? argv[0] : 'latest';
const flag = (name) => {
  const i = argv.indexOf(`--${name}`);
  return i === -1 ? undefined : argv[i + 1] ?? true;
};
const browsers = flag('browsers') === 'all' ? ['chromium', 'firefox', 'webkit'] : ['chromium'];
const only = flag('only'); // e2e | meta
const grep = flag('grep');

const run = (cmd, args, opts = {}) => {
  const r = spawnSync(cmd, args, { stdio: 'inherit', ...opts });
  if (r.status !== 0) throw new Error(`${cmd} ${args.join(' ')} exited with ${r.status}`);
};

const base = process.env.PLP_E2E_CACHE || '/tmp/plp-e2e';
const dir = path.join(base, `pw-${version}`);
fs.mkdirSync(dir, { recursive: true });
if (!fs.existsSync(path.join(dir, 'package.json'))) fs.writeFileSync(path.join(dir, 'package.json'), '{"name":"plp-e2e","private":true}');
const pwPkg = path.join(dir, 'node_modules', '@playwright', 'test', 'package.json');
if (!fs.existsSync(pwPkg)) {
  run('npm', ['install', '--no-audit', '--no-fund', `@playwright/test@${version}`, 'picocolors'], { cwd: dir });
}
const installed = JSON.parse(fs.readFileSync(pwPkg, 'utf8')).version;
const bin = path.join(dir, 'node_modules', '.bin', 'playwright');
console.log(`\n== @playwright/test ${installed} (${browsers.join(', ')}) ==\n`);
run(bin, ['install', ...browsers], { cwd: dir });

// Fresh copy of the code under test.
const repo = path.join(dir, 'repo');
fs.rmSync(repo, { recursive: true, force: true });
fs.mkdirSync(repo, { recursive: true });
for (const item of ['src', 'e2e', 'dist', 'tsconfig.json']) {
  if (fs.existsSync(path.join(root, item))) fs.cpSync(path.join(root, item), path.join(repo, item), { recursive: true });
}
fs.writeFileSync(path.join(repo, 'package.json'), '{"name":"playwright-logger-pro-e2e","private":true}');

const env = {
  ...process.env,
  PLP_E2E_BROWSERS: browsers.length > 1 ? 'all' : 'chromium',
  PLP_PLAYWRIGHT_BIN: bin,
  PLP_E2E_VERSION: installed,
  PLP_E2E_PORT: process.env.PLP_E2E_PORT || String(4200 + Math.floor(Math.random() * 500)),
};
delete env.NO_COLOR;
let failed = false;
const attempt = (cmd, args, cwd) => {
  const r = spawnSync(cmd, args, { stdio: 'inherit', cwd, env });
  if (r.status !== 0) failed = true;
};
if (only !== 'meta') {
  attempt(bin, ['test', '-c', 'e2e/playwright.config.ts', ...(grep ? ['-g', String(grep)] : [])], repo);
}
if (only !== 'e2e') {
  const tsx = path.join(root, 'node_modules', '.bin', 'tsx');
  attempt(tsx, ['--test', ...fs.readdirSync(path.join(repo, 'e2e', 'meta')).filter((f) => f.endsWith('.test.ts')).map((f) => path.join('e2e', 'meta', f))], repo);
}
process.exit(failed ? 1 : 0);
