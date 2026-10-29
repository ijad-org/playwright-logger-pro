// Fails when a code-block token colour has less than 4.5:1 contrast (WCAG AA) against the
// block's background, in the light or the dark theme.
//
// Checked: the plain text colour and the colour of every token style of src/prism-themes.mjs
// (the themes docusaurus.config.ts uses), each against the theme's plain background. A style
// with an opacity (e.g. `namespace`) is blended over the background first; a style without a
// colour inherits the plain colour.
import {lightTheme, darkTheme} from '../src/prism-themes.mjs';

const MIN = 4.5;

function parseColor(value) {
  const hex = /^#([0-9a-f]{3}|[0-9a-f]{6})$/i.exec(value.trim());
  if (hex) {
    const h = hex[1].length === 3 ? [...hex[1]].map((c) => c + c).join('') : hex[1];
    return [0, 2, 4].map((i) => parseInt(h.slice(i, i + 2), 16));
  }
  const rgb = /^rgb\(\s*(\d+)\s*,\s*(\d+)\s*,\s*(\d+)\s*\)$/i.exec(value.trim());
  if (rgb) return rgb.slice(1).map(Number);
  throw new Error(`unsupported colour: ${value}`);
}

function luminance(rgb) {
  const [r, g, b] = rgb.map((v) => {
    const c = v / 255;
    return c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
  });
  return 0.2126 * r + 0.7152 * g + 0.0722 * b;
}

function contrast(fg, bg) {
  const [hi, lo] = [luminance(fg), luminance(bg)].sort((a, b) => b - a);
  return (hi + 0.05) / (lo + 0.05);
}

let failures = 0;
for (const [name, theme] of [['light', lightTheme], ['dark', darkTheme]]) {
  const bg = parseColor(theme.plain.backgroundColor);
  const entries = [
    {label: 'plain', style: theme.plain},
    ...theme.styles.map((e) => ({
      label: e.types.join(',') + (e.languages ? ` [${e.languages.join(',')}]` : ''),
      style: e.style,
    })),
  ];
  console.log(`${name} (background ${theme.plain.backgroundColor})`);
  for (const {label, style} of entries) {
    if (!style.color && style.opacity === undefined) continue;
    let fg = parseColor(style.color ?? theme.plain.color);
    if (style.opacity !== undefined) fg = fg.map((v, i) => v * style.opacity + bg[i] * (1 - style.opacity));
    const ratio = contrast(fg, bg);
    const ok = ratio >= MIN;
    if (!ok) failures++;
    console.log(`  ${ok ? 'ok  ' : 'FAIL'} ${ratio.toFixed(2).padStart(5)}  ${style.color ?? '(plain)'}  ${label}`);
  }
}
if (failures) {
  console.error(`check-prism-contrast: ${failures} token colour(s) below ${MIN}:1`);
  process.exit(1);
}
console.log(`check-prism-contrast: all token colours >= ${MIN}:1`);
