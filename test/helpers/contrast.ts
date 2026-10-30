import { CURL_COLORS } from '../../src/curlPalette';
import type { CurlElement } from '../../src/curlPalette';

/** The default xterm 16-colour palette (xterm's own, not a terminal theme). */
export const XTERM_16 = [
  '#000000', '#cd0000', '#00cd00', '#cdcd00', '#0000ee', '#cd00cd', '#00cdcd', '#e5e5e5',
  '#7f7f7f', '#ff0000', '#00ff00', '#ffff00', '#5c5cff', '#ff00ff', '#00ffff', '#ffffff',
] as const;

/** Levels of the 6x6x6 colour cube (indexes 16-231). */
const CUBE_LEVELS = [0, 95, 135, 175, 215, 255];

/** The `#rrggbb` colour of an index of the xterm 256-colour palette. */
export function xterm256Hex(index: number): string {
  if (!Number.isInteger(index) || index < 0 || index > 255) throw new RangeError(`not a palette index: ${index}`);
  if (index < 16) return XTERM_16[index];
  const channels = index < 232 ?
    [Math.floor((index - 16) / 36), Math.floor((index - 16) / 6) % 6, (index - 16) % 6].map((n) => CUBE_LEVELS[n]) :
    Array<number>(3).fill(8 + 10 * (index - 232));
  return `#${channels.map((c) => c.toString(16).padStart(2, '0')).join('')}`;
}

/** WCAG 2.x relative luminance of `#rrggbb`. */
export function luminance(hex: string): number {
  const [r, g, b] = [1, 3, 5].map((i) => {
    const c = parseInt(hex.slice(i, i + 2), 16) / 255;
    return c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
  });
  return 0.2126 * r + 0.7152 * g + 0.0722 * b;
}

/** WCAG contrast ratio of two `#rrggbb` colours (1 to 21). */
export function contrast(a: string, b: string): number {
  const [hi, lo] = [luminance(a), luminance(b)].sort((x, y) => y - x);
  return (hi + 0.05) / (lo + 0.05);
}

export const BLACK = '#000000';
export const WHITE = '#ffffff';

export interface ContrastRow {
  element: string;
  palette: '256' | '16';
  /** Palette index. */
  index: number;
  hex: string;
  onBlack: number;
  onWhite: number;
  min: number;
}

/** Contrast of every coloured curl element on the default xterm black and white, for both palettes. */
export function curlContrastRows(): ContrastRow[] {
  const rows: ContrastRow[] = [];
  for (const [element, color] of Object.entries(CURL_COLORS) as Array<[CurlElement, typeof CURL_COLORS[CurlElement]]>) {
    for (const [palette, index] of [['256', color.c256], ['16', color.c16]] as const) {
      const hex = xterm256Hex(index);
      const onBlack = contrast(hex, BLACK);
      const onWhite = contrast(hex, WHITE);
      rows.push({ element, palette, index, hex, onBlack, onWhite, min: Math.min(onBlack, onWhite) });
    }
  }
  return rows;
}
