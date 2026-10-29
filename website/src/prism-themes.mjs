// Code-block themes: prism-react-renderer's github / vsDark with the token colours that fail
// WCAG AA (4.5:1 against the code background) replaced by the nearest passing shade.
// Verified by `npm run check-prism` (scripts/check-prism-contrast.mjs).
import {themes} from 'prism-react-renderer';

// original colour -> replacement, matched case-insensitively against each token style
const LIGHT_FIX = {
  '#999988': '#717161', // comment
  '#e3116c': '#da1067', // string
  '#36acaa': '#277b7a', // constant, number, property
  '#00a4db': '#0078a0', // keyword, attr-name
  '#d73a49': '#d42d3d', // function, tag
};
const DARK_FIX = {
  'rgb(0, 0, 128)': '#7676ff', // prolog
  'rgb(100, 102, 149)': '#8385ac', // constant
  '#808080': '#888888', // markup punctuation
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
