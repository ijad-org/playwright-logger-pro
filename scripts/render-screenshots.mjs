// Renders the real output of `npm run demo` to docs/assets/compact-dark.png and compact-light.png,
// the screenshots of the README. Needs the repository's dependencies and Chromium
// (`npx playwright install chromium`).
//
//   node scripts/render-screenshots.mjs
//
// The demo is run twice, once per palette (`theme: 'dark'` / `'light'`, true colour); Playwright's own
// lines use the 16 basic colours, which the page maps to the same palette, as a terminal theme would.
// docs/assets is not part of the npm package (package.json "files" lists dist and the docs files only).
import * as fs from 'node:fs';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium } from '@playwright/test';
import { runDemo } from './demo-output.mjs';

const here = path.dirname(fileURLToPath(import.meta.url));
const outDir = path.resolve(here, '..', 'docs', 'assets');

const THEMES = {
  dark: {
    page: '#0a0c10', window: '#0d1117', bar: '#161b22', fg: '#e6edf3', title: '#7d8590', shadow: 'rgba(0,0,0,.5)',
    // the 16 basic colours as the theme maps them: SGR 30-37 and 90-97
    ansi: ['#484f58', '#f85149', '#3fb950', '#d29922', '#58a6ff', '#bc8cff', '#39c5cf', '#c9d1d9',
      '#7d8590', '#ff7b72', '#56d364', '#e3b341', '#79c0ff', '#d2a8ff', '#56d4dd', '#f0f6fc'],
    dim: '#7d8590',
  },
  light: {
    page: '#d8dde3', window: '#ffffff', bar: '#eaeef2', fg: '#1f2328', title: '#656d76', shadow: 'rgba(31,35,40,.25)',
    ansi: ['#24292f', '#cf222e', '#1a7f37', '#9a6700', '#0969da', '#8250df', '#1b7c83', '#6e7781',
      '#656d76', '#a40e26', '#2da44e', '#bf8700', '#218bff', '#a475f9', '#3192aa', '#8c959f'],
    dim: '#656d76',
  },
};

const escapeHtml = (text) => text.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

/** ANSI text to HTML spans: bold, dim, inverse, the 16 basic colours (themed) and true colour. */
export function ansiToHtml(text, theme) {
  const palette = THEMES[theme].ansi;
  const state = { bold: false, dim: false, inverse: false, fg: null, bg: null };
  const reset = () => Object.assign(state, { bold: false, dim: false, inverse: false, fg: null, bg: null });
  let html = '';
  const push = (chunk) => {
    if (!chunk) return;
    let color = state.fg ?? (state.dim ? THEMES[theme].dim : null);
    let background = state.bg;
    if (state.inverse) [color, background] = [background ?? THEMES[theme].window, color ?? THEMES[theme].fg];
    const style = [
      color && `color:${color}`, background && `background:${background}`, state.bold && 'font-weight:700',
    ].filter(Boolean).join(';');
    html += style ? `<span style="${style}">${escapeHtml(chunk)}</span>` : escapeHtml(chunk);
  };
  let last = 0;
  // eslint-disable-next-line no-control-regex
  for (const match of text.matchAll(/\u001b\[([0-9;]*)m/g)) {
    push(text.slice(last, match.index));
    last = match.index + match[0].length;
    const codes = (match[1] || '0').split(';').map(Number);
    for (let i = 0; i < codes.length; i++) {
      const code = codes[i];
      if (code === 0) reset();
      else if (code === 1) state.bold = true;
      else if (code === 2) state.dim = true;
      else if (code === 7) state.inverse = true;
      else if (code === 22) { state.bold = false; state.dim = false; }
      else if (code === 27) state.inverse = false;
      else if (code >= 30 && code <= 37) state.fg = palette[code - 30];
      else if (code >= 90 && code <= 97) state.fg = palette[code - 90 + 8];
      else if (code >= 40 && code <= 47) state.bg = palette[code - 40];
      else if (code >= 100 && code <= 107) state.bg = palette[code - 100 + 8];
      else if (code === 39) state.fg = null;
      else if (code === 49) state.bg = null;
      else if ((code === 38 || code === 48) && codes[i + 1] === 2) {
        const [r, g, b] = codes.slice(i + 2, i + 5);
        state[code === 38 ? 'fg' : 'bg'] = `rgb(${r},${g},${b})`;
        i += 4;
      } else if ((code === 38 || code === 48) && codes[i + 1] === 5) i += 2;
    }
  }
  push(text.slice(last));
  return html;
}

function page(theme, body) {
  const t = THEMES[theme];
  return `<!doctype html><meta charset="utf-8"><style>
    body { margin: 0; padding: 44px; background: ${t.page}; width: max-content; }
    .window { background: ${t.window}; border-radius: 14px; overflow: hidden; box-shadow: 0 18px 50px ${t.shadow}; width: max-content; }
    .bar { background: ${t.bar}; height: 44px; display: flex; align-items: center; padding: 0 16px; gap: 9px; color: ${t.title};
      font: 13px -apple-system, "Segoe UI", Helvetica, Arial, sans-serif; }
    .dot { width: 13px; height: 13px; border-radius: 50%; }
    .bar span { margin-left: 12px; }
    pre { margin: 0; padding: 26px 28px 30px; color: ${t.fg}; font: 14px/1.5 "JetBrains Mono", "DejaVu Sans Mono", Menlo, Consolas, monospace; }
  </style>
  <div class="window"><div class="bar"><i class="dot" style="background:#ff5f56"></i><i class="dot" style="background:#ffbd2e"></i><i class="dot" style="background:#27c93f"></i><span>playwright-logger-pro · compact output — ${theme}</span></div>
  <pre>${body}</pre></div>`;
}

async function main() {
  fs.mkdirSync(outDir, { recursive: true });
  const browser = await chromium.launch();
  try {
    for (const theme of ['dark', 'light']) {
      const output = runDemo({ theme });
      const command = `<span style="color:${THEMES[theme].title}">$</span> npx playwright test\n`;
      const context = await browser.newContext({ deviceScaleFactor: 2, viewport: { width: 1400, height: 900 } });
      const tab = await context.newPage();
      await tab.setContent(page(theme, `${command}${ansiToHtml(output, theme)}`));
      const file = path.join(outDir, `compact-${theme}.png`);
      await tab.locator('body').screenshot({ path: file });
      await context.close();
      console.log('wrote', path.relative(process.cwd(), file));
    }
  } finally {
    await browser.close();
  }
}

if (process.argv[1] === fileURLToPath(import.meta.url)) await main();
