/**
 * Minimal ANSI SGR parser for the output of the library: bold, dim, italic, underline, inverse,
 * the 8/16 basic colours, the xterm 256-colour palette (38;5;N / 48;5;N) and true colour
 * (38;2;r;g;b / 48;2;r;g;b). Everything else is dropped.
 */

export interface Span {
  text: string;
  className: string;
  /** Inline colours (CSS values). Palette colours are the exact xterm hex, not a theme approximation. */
  style?: {color?: string; background?: string};
}

/** The default xterm 16-colour palette (xterm's own, not a terminal theme); matches the library's tests. */
const XTERM_16 = [
  '#000000', '#cd0000', '#00cd00', '#cdcd00', '#0000ee', '#cd00cd', '#00cdcd', '#e5e5e5',
  '#7f7f7f', '#ff0000', '#00ff00', '#ffff00', '#5c5cff', '#ff00ff', '#00ffff', '#ffffff',
];

/** Levels of the 6x6x6 colour cube (indexes 16-231). */
const CUBE_LEVELS = [0, 95, 135, 175, 215, 255];

/** The theme colours of the eight basic colours (30-37), tuned for the terminal panel's background. */
const BASIC = ['gray', 'red', 'green', 'yellow', 'blue', 'magenta', 'cyan', 'fg'].map((name) => `var(--ansi-${name})`);

const hex = (r: number, g: number, b: number): string =>
  `#${[r, g, b].map((c) => Math.max(0, Math.min(255, c)).toString(16).padStart(2, '0')).join('')}`;

/** The `#rrggbb` colour of an index of the xterm 256-colour palette; undefined when out of range. */
export function xterm256Hex(index: number): string | undefined {
  if (!Number.isInteger(index) || index < 0 || index > 255) return undefined;
  if (index < 16) return XTERM_16[index];
  if (index < 232) {
    const n = index - 16;
    return hex(CUBE_LEVELS[Math.floor(n / 36)]!, CUBE_LEVELS[Math.floor(n / 6) % 6]!, CUBE_LEVELS[n % 6]!);
  }
  const gray = 8 + 10 * (index - 232);
  return hex(gray, gray, gray);
}

interface State {
  bold: boolean;
  dim: boolean;
  italic: boolean;
  underline: boolean;
  inverse: boolean;
  fg: string | null;
  bg: string | null;
}

const fresh = (): State => ({bold: false, dim: false, italic: false, underline: false, inverse: false, fg: null, bg: null});

function classes(s: State): string {
  const out: string[] = [];
  if (s.bold) out.push('ansi-bold');
  if (s.dim && !s.fg && !s.inverse) out.push('ansi-dim');
  if (s.italic) out.push('ansi-italic');
  if (s.underline) out.push('ansi-underline');
  return out.join(' ');
}

/** Inverse swaps the foreground and background, with the terminal's own colours for the default ones. */
function style(s: State): Span['style'] {
  const color = s.inverse ? (s.bg ?? 'var(--ansi-bg)') : s.fg;
  const background = s.inverse ? (s.fg ?? 'var(--ansi-fg)') : s.bg;
  if (!color && !background) return undefined;
  return {...(color && {color}), ...(background && {background})};
}

/** Reads the colour after 38/48 (`5;N` or `2;r;g;b`); returns it and how many codes it used. */
function extended(codes: number[], at: number): [string | null, number] {
  if (codes[at] === 5) return [xterm256Hex(codes[at + 1] ?? -1) ?? null, 2];
  if (codes[at] === 2) {
    const [r, g, b] = [codes[at + 1], codes[at + 2], codes[at + 3]];
    const ok = [r, g, b].every((c) => c !== undefined && c >= 0 && c <= 255);
    return [ok ? hex(r!, g!, b!) : null, 4];
  }
  return [null, 0];
}

function apply(state: State, codes: number[]): void {
  for (let i = 0; i < codes.length; i++) {
    const code = codes[i]!;
    if (code === 0) Object.assign(state, fresh());
    else if (code === 1) state.bold = true;
    else if (code === 2) state.dim = true;
    else if (code === 3) state.italic = true;
    else if (code === 4) state.underline = true;
    else if (code === 7) state.inverse = true;
    else if (code === 22) {
      state.bold = false;
      state.dim = false;
    } else if (code === 23) state.italic = false;
    else if (code === 24) state.underline = false;
    else if (code === 27) state.inverse = false;
    else if (code >= 30 && code <= 37) state.fg = BASIC[code - 30]!;
    else if (code === 38 || code === 48) {
      const [color, used] = extended(codes, i + 1);
      i += used;
      if (code === 38) state.fg = color ?? state.fg;
      else state.bg = color ?? state.bg;
    } else if (code === 39) state.fg = null;
    else if (code >= 40 && code <= 47) state.bg = BASIC[code - 40]!;
    else if (code === 49) state.bg = null;
    else if (code >= 90 && code <= 97) state.fg = XTERM_16[code - 90 + 8]!;
    else if (code >= 100 && code <= 107) state.bg = XTERM_16[code - 100 + 8]!;
  }
}

// eslint-disable-next-line no-control-regex
const SGR = /\u001b\[([0-9;]*)m/g;

/** Splits `input` into styled spans. Unknown escape sequences are dropped. */
export function parseAnsi(input: string): Span[] {
  const spans: Span[] = [];
  const state = fresh();
  let last = 0;
  const push = (text: string) => {
    if (!text) return;
    const span: Span = {text, className: classes(state)};
    const css = style(state);
    if (css) span.style = css;
    spans.push(span);
  };
  for (const match of input.matchAll(SGR)) {
    push(input.slice(last, match.index));
    apply(state, match[1] === '' ? [0] : match[1]!.split(';').map(Number));
    last = match.index! + match[0].length;
  }
  push(input.slice(last));
  return spans;
}

/** The same text without escape sequences (used for the copy button and the accessible label). */
export function stripAnsi(input: string): string {
  return input.replace(SGR, '');
}
