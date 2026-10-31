// Runs `npm run demo` (demo/) and returns what the terminal would show, for the screenshots in the
// README (scripts/render-screenshots.mjs) and the documentation site (website/scripts/gen-doc-samples.mjs).
//
// The output is real: the list reporter and this package's reporter, against the mock shop API.
// Three things are normalised, all of them cosmetic:
//  - the mock hosts (127.0.0.1:4310 / :4311, the same width) are shown as api.shop.test / cdn.shop.test;
//  - Playwright's failure report (the stack of the deliberately failing test) is left out, as in the
//    reference design: it is Playwright's output, not this package's;
//  - the rule Playwright draws after a title in its summary (a line of ─) is cut off;
//  - the run starts in demo/specs, so the list reporter prints cart.spec.ts, not demo/specs/cart.spec.ts.
import { spawnSync } from 'node:child_process';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(here, '..');
const API_PORT = 4310;
const CDN_PORT = 4311;

/**
 * @param {{ theme?: 'dark' | 'light' }} [options] with a theme, this package's own colours are true
 *   colour in that palette; without one, the 16 basic colours (what a terminal shows by default).
 * @returns {string} the output, with ANSI escape sequences
 */
export function runDemo({ theme } = {}) {
  const env = {
    ...process.env,
    FORCE_COLOR: '1',
    NO_COLOR: undefined,
    PLP_DEMO_COLORS: '1',
    PLP_DEMO_THEME: theme,
    PLP_DEMO_API_PORT: String(API_PORT),
    PLP_DEMO_CDN_PORT: String(CDN_PORT),
    PLAYWRIGHT_FORCE_TTY: '0',
    CI: undefined,
  };
  const run = spawnSync(path.join(root, 'node_modules', '.bin', 'playwright'), [
    'test', '-c', path.join(root, 'demo', 'playwright.config.ts'),
  ], { cwd: path.join(root, 'demo', 'specs'), env, encoding: 'utf8' });
  if (run.error) throw run.error;
  const text = run.stdout;
  if (!text.includes('requests')) throw new Error(`the demo printed no totals line:\n${text}\n${run.stderr}`);
  const lines = text.split('\n');
  // Playwright's failure report runs from "  1) ..." up to the "  1 failed" line.
  const start = lines.findIndex((l) => /^\s+1\) /.test(plain(l)));
  const end = lines.findIndex((l) => /^\s+1 failed/.test(plain(l)));
  const kept = start !== -1 && end > start ? [...lines.slice(0, start - 1), ...lines.slice(end)] : lines;
  return kept.join('\n')
    .replaceAll(`http://127.0.0.1:${API_PORT}`, 'https://api.shop.test')
    .replaceAll(`http://127.0.0.1:${CDN_PORT}`, 'https://cdn.shop.test')
    // eslint-disable-next-line no-control-regex
    .replace(/ (?:\u001b\[[0-9;]*m)*─{3,}/g, '')
    .replace(/\n+$/, '\n');
}

// eslint-disable-next-line no-control-regex
const plain = (line) => line.replace(/\u001b\[[0-9;]*m/g, '');
