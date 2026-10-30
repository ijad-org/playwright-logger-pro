// Regenerates website/src/data/samples/*.ansi from real runs of the library (coloured output).
// Manual: node website/scripts/gen-doc-samples.mjs   (needs the repository dependencies and Chromium)
// The host and the Date header are normalised; durations are whatever the run produced.
import { spawnSync } from 'node:child_process';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(here, '..', '..');
const out = path.join(here, '..', 'src', 'data', 'samples');
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'plp-samples-'));

const bin = path.join(root, 'node_modules', '.bin', 'playwright');
const run = spawnSync(bin, ['test', '-c', path.join(here, 'gen-samples', 'playwright.config.mjs')], {
  cwd: root,
  env: { ...process.env, PLP_SAMPLES_OUT: tmp, FORCE_COLOR: '1', NO_COLOR: undefined },
  encoding: 'utf8',
});
// The browser-failure test fails on purpose, so the exit code is not checked.
if (run.error) throw run.error;

fs.mkdirSync(out, { recursive: true });
for (const file of fs.readdirSync(tmp)) {
  const text = fs.readFileSync(path.join(tmp, file), 'utf8')
    .replaceAll('127.0.0.1:4399', 'localhost:3000')
    .replaceAll('samples.spec.ts \u203a browser-failure \u203a', 'login.spec.ts \u203a')
    .replace(/(date:(?:\u001b\[22m)?) [A-Z][a-z]{2}, \d{2} [A-Z][a-z]{2} \d{4} [\d:]{8} GMT/g, '$1 Thu, 29 Oct 2026 09:12:25 GMT');
  fs.writeFileSync(path.join(out, file), text);
  console.log('wrote', path.relative(root, path.join(out, file)));
}
