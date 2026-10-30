#!/usr/bin/env node
// Contrast of every coloured element of the printed curl command on the default xterm black
// (#000000) and white (#ffffff) backgrounds, for the 256-colour palette and the 16-colour fallback.
//
//   pnpm contrast          (tsx scripts/curl-contrast.mjs)
//
// Exits 1 when a 256-colour element drops below 3:1 on either background, or a 16-colour one does.
// The colours are defined in src/curlPalette.ts; the xterm palette and the WCAG maths live in
// test/helpers/contrast.ts, which test/curl-palette.test.ts uses to enforce the same limits.
import { curlContrastRows } from '../test/helpers/contrast.ts';

const rows = curlContrastRows();
const pad = (text, width) => String(text).padEnd(width);
const ratio = (n) => `${n.toFixed(2)}:1`;
const grade = (min) => (min >= 4.5 ? 'AA' : min >= 3 ? '>=3' : 'FAIL');

for (const palette of ['256', '16']) {
  console.log(`\n${palette}-colour palette`);
  console.log(`${pad('element', 14)}${pad('index', 7)}${pad('colour', 9)}${pad('on black', 11)}${pad('on white', 11)}worst`);
  for (const row of rows.filter((r) => r.palette === palette)) {
    console.log(
        `${pad(row.element, 14)}${pad(row.index, 7)}${pad(row.hex, 9)}${pad(ratio(row.onBlack), 11)}${pad(ratio(row.onWhite), 11)}${ratio(row.min)} ${grade(row.min)}`,
    );
  }
}
console.log('\ncurl and other methods: bold, default foreground; masks: bold + inverse (the terminal\'s own pair, 21:1)');

const failing = rows.filter((r) => r.min < 3);
if (failing.length > 0) {
  console.error(`\n${failing.length} element(s) below 3:1: ${failing.map((r) => `${r.element} (${r.palette})`).join(', ')}`);
  process.exit(1);
}
