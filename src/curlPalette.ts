import type { Colorizer } from './format';

/**
 * Colours of the printed curl command, as indexes into the xterm palette.
 *
 * Every colour has to read on a black and on a white terminal background, so each one sits in the
 * narrow luminance band where both contrasts stay high (WCAG ratio >= 3:1, and >= 4.5:1 wherever
 * the palette has such a colour). `npm run contrast` prints the ratios; test/curl-palette.test.ts
 * fails when one drops below 3:1.
 *
 * - `c256`: index 16-255 of the xterm 256-colour palette (6x6x6 cube and the greys). All of them
 *   reach 4.5:1 on both backgrounds.
 * - `c16`: index 0-15 of the 16-colour palette, for terminals without 256 colours. The palette is
 *   small: its best colours reach about 4.5:1 on both backgrounds, none of its greens gets 3:1 on
 *   white (so POST and strings are not green here), and every colour used here holds at least 3:1.
 *
 * Elements without an entry (the `curl` word, other methods) are bold in the default colour;
 * a mask is bold + inverse. Both are the terminal's own foreground/background pair.
 */
export interface CurlColor { c256: number; c16: number }

export const CURL_COLORS = {
  /** `-X GET` (only spelled out when the request has a body). */
  methodGet: { c256: 63, c16: 12 },
  methodPost: { c256: 29, c16: 5 },
  /** PUT and PATCH. */
  methodWrite: { c256: 98, c16: 13 },
  methodDelete: { c256: 131, c16: 1 },
  url: { c256: 63, c16: 12 },
  /** Query parameter name and header name. */
  name: { c256: 163, c16: 5 },
  /** JSON key. */
  key: { c256: 63, c16: 12 },
  /** JSON string. */
  string: { c256: 29, c16: 9 },
  /** `#` notes. */
  comment: { c256: 243, c16: 8 },
} as const satisfies Record<string, CurlColor>;

export type CurlElement = keyof typeof CURL_COLORS;

/** How many colours the terminal shows: 8 = 256 colours (8 bit), 4 = the 16 basic ones. */
export type CurlColorDepth = 4 | 8;

const ESC = '\u001b';
const CLOSE_FOREGROUND = `${ESC}[39m`;

/** SGR parameters that select a basic-palette index (0-15) as the foreground. */
function sgr16(index: number): string {
  return String(index < 8 ? 30 + index : 90 + index - 8);
}

/** The colouring function of `element` for the given colour depth. */
export function curlColorizer(element: CurlElement, depth: CurlColorDepth): Colorizer {
  const color = CURL_COLORS[element];
  const open = `${ESC}[${depth >= 8 ? `38;5;${color.c256}` : sgr16(color.c16)}m`;
  return (s) => `${open}${s}${CLOSE_FOREGROUND}`;
}
