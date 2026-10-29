#!/usr/bin/env node
// Overhead benchmark: 500 fill + 500 click calls on a static page, with browserLog
// enabled (defaults) versus disabled (nothing installed). Budget: <= 5 %.
//
//   node scripts/perf.mjs [--rounds 5] [--strict]
//
// Uses the Playwright in node_modules; results go to stdout and, in CI, to the job summary.
import { spawnSync } from 'node:child_process';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const args = process.argv.slice(2);
const rounds = Number(args[args.indexOf('--rounds') + 1]) || 5;
const strict = args.includes('--strict');
const BUDGET = 5;

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'plp-perf-'));
const results = { disabled: [], enabled: [] };
const bin = path.join(root, 'node_modules', '.bin', 'playwright');

for (let round = 0; round < rounds; round++) {
  for (const label of round % 2 === 0 ? ['disabled', 'enabled'] : ['enabled', 'disabled']) {
    const out = path.join(tmp, `${label}-${round}.json`);
    const r = spawnSync(bin, ['test', '-c', 'e2e/playwright.config.ts', '--project=chromium', '--workers=1'], {
      cwd: root,
      encoding: 'utf8',
      env: { ...process.env, PLP_E2E_PERF: '1', PLP_PERF_LABEL: label, PLP_PERF_OUT: out, PLP_E2E_PORT: String(4900 + round) },
    });
    if (r.status !== 0 || !fs.existsSync(out)) {
      console.error(r.stdout, r.stderr);
      process.exit(2);
    }
    results[label].push(JSON.parse(fs.readFileSync(out, 'utf8')));
  }
}

const median = (xs) => [...xs].sort((a, b) => a - b)[Math.floor(xs.length / 2)];
const stat = (label, key) => median(results[label].map((r) => r[key]));
const rows = ['fillMs', 'clickMs'].map((key) => {
  const off = stat('disabled', key);
  const on = stat('enabled', key);
  return { op: key.replace('Ms', ''), off, on, overhead: ((on - off) / off) * 100 };
});
const lines = [
  `### browserLog overhead (median of ${rounds} rounds, 500 calls each)`,
  '',
  '| call | disabled | enabled | overhead | budget |',
  '| --- | --- | --- | --- | --- |',
  ...rows.map((r) => `| ${r.op} | ${r.off.toFixed(0)} ms | ${r.on.toFixed(0)} ms | ${r.overhead.toFixed(1)} % | ${r.overhead <= BUDGET ? 'ok' : `over ${BUDGET} %`} |`),
];
console.log(lines.join('\n'));
if (process.env.GITHUB_STEP_SUMMARY) fs.appendFileSync(process.env.GITHUB_STEP_SUMMARY, `${lines.join('\n')}\n`);
if (strict && rows.some((r) => r.overhead > BUDGET)) process.exit(1);
