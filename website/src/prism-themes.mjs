// Code-block themes: prism-react-renderer's github / vsDark with the token colours that fail
// WCAG AA (4.5:1 against the code background) replaced by the nearest passing shade.
// Verified by `npm run check-prism` (scripts/check-prism-contrast.mjs), on the plain block
// background and on a highlighted line (--docusaurus-highlighted-code-line-bg in custom.css).
import {themes} from 'prism-react-renderer';

// original colour -> replacement, matched case-insensitively against each token style
const LIGHT_FIX = {
  '#999988': '#5c6773', // comment (same as the !important rule in custom.css)
  '#e3116c': '#c70c5d', // string
  '#36acaa': '#226f6e', // constant, number, property
  '#00a4db': '#006c92', // keyword, attr-name
  '#d73a49': '#c22737', // function, tag
};
const DARK_FIX = {
  'rgb(0, 0, 128)': '#8888ff', // prolog
  'rgb(106, 153, 85)': '#7fb069', // comment (same as the !important rule in custom.css)
  'rgb(100, 102, 149)': '#8f91b4', // constant
  'rgb(209, 105, 105)': '#da7d7d', // char
  '#808080': '#949494', // markup punctuation
};

function recolor(theme, fix) {
  const swap = (style) => {
    // github dims `namespace` tokens to 70% opacity, which puts them just under 4.5:1.
    const {opacity, ...rest} = style;
    const to = rest.color && fix[rest.color.toLowerCase()];
    return to ? {...rest, color: to} : rest;
  };
  return {
    ...theme,
    plain: swap(theme.plain),
    styles: theme.styles.map((entry) => ({...entry, style: swap(entry.style)})),
  };
}

export const lightTheme = recolor(themes.github, LIGHT_FIX);
export const darkTheme = recolor(themes.vsDark, DARK_FIX);
