// Fails when a code-block token colour has less than 4.5:1 contrast (WCAG AA) against the
// block's background, in the light or the dark theme.
//
// Checked: the plain text colour and the colour of every token style of src/prism-themes.mjs
// (the themes docusaurus.config.ts uses), each against the theme's plain background. A style
// with an opacity (e.g. `namespace`) is blended over the background first; a style without a
// colour inherits the plain colour.
//
// Highlighted lines (`{1}`, `// highlight-next-line`) get --docusaurus-highlighted-code-line-bg
// painted over the block background. Every colour above is checked a second time against that
// composited background. The rgba values are read from src/css/custom.css (the one place they are
// defined), so the check cannot drift from the stylesheet.
import {readFileSync} from 'node:fs';
import {lightTheme, darkTheme} from '../src/prism-themes.mjs';

const MIN = 4.5;

const css = readFileSync(new URL('../src/css/custom.css', import.meta.url), 'utf8');

/** The --docusaurus-highlighted-code-line-bg declared in the rule whose selector is `selector`. */
function highlightBg(selector) {
  const rule = css.match(new RegExp(`(?:^|\\n)${selector.replace(/[[\]'.]/g, '\\$&')}\\s*\\{([^}]*)\\}`));
  const decl = rule && /--docusaurus-highlighted-code-line-bg:\s*([^;]+);/.exec(rule[1]);
  if (!decl) throw new Error(`--docusaurus-highlighted-code-line-bg not found in custom.css for ${selector}`);
  return decl[1].trim();
}

/** "rgb(21 128 61 / 0.12)" or "rgba(21, 128, 61, 0.12)" -> {rgb: [21, 128, 61], alpha: 0.12} */
function parseRgba(value) {
  const m = /^rgba?\(\s*(\d+)[\s,]+(\d+)[\s,]+(\d+)(?:\s*[,/]\s*([\d.]+))?\s*\)$/i.exec(value);
  if (!m) throw new Error(`unsupported highlight colour: ${value}`);
  return {rgb: [m[1], m[2], m[3]].map(Number), alpha: m[4] === undefined ? 1 : Number(m[4])};
}

const blend = (fg, bg, alpha) => fg.map((v, i) => v * alpha + bg[i] * (1 - alpha));

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
for (const [name, theme, selector] of [
  ['light', lightTheme, ':root'],
  ['dark', darkTheme, "[data-theme='dark']"],
]) {
  const bg = parseColor(theme.plain.backgroundColor);
  const hl = highlightBg(selector);
  const {rgb, alpha} = parseRgba(hl);
  const entries = [
    {label: 'plain', style: theme.plain},
    ...theme.styles.map((e) => ({
      label: e.types.join(',') + (e.languages ? ` [${e.languages.join(',')}]` : ''),
      style: e.style,
    })),
  ];
  for (const [where, ground] of [
    ['background', bg],
    [`highlighted line ${hl}`, blend(rgb, bg, alpha).map(Math.round)],
  ]) {
    console.log(`${name} on ${where} (${theme.plain.backgroundColor})`);
    for (const {label, style} of entries) {
      if (!style.color && style.opacity === undefined) continue;
      let fg = parseColor(style.color ?? theme.plain.color);
      if (style.opacity !== undefined) fg = blend(fg, ground, style.opacity);
      const ratio = contrast(fg, ground);
      const ok = ratio >= MIN;
      if (!ok) failures++;
      console.log(`  ${ok ? 'ok  ' : 'FAIL'} ${ratio.toFixed(2).padStart(5)}  ${style.color ?? '(plain)'}  ${label}`);
    }
  }
}
if (failures) {
  console.error(`check-prism-contrast: ${failures} token colour(s) below ${MIN}:1`);
  process.exit(1);
}
console.log(`check-prism-contrast: all token colours >= ${MIN}:1`);
