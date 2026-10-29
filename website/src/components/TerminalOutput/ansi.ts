/** Minimal ANSI SGR parser for the codes picocolors emits (bold, dim, 8 colours, resets). */

export interface Span {
  text: string;
  className: string;
}

const COLORS = ['black', 'red', 'green', 'yellow', 'blue', 'magenta', 'cyan', 'white'];

interface State {
  bold: boolean;
  dim: boolean;
  italic: boolean;
  underline: boolean;
  fg: string | null;
}

const fresh = (): State => ({bold: false, dim: false, italic: false, underline: false, fg: null});

function classes(s: State): string {
  const out: string[] = [];
  if (s.fg) out.push(`ansi-${s.fg}`);
  if (s.bold) out.push('ansi-bold');
  if (s.dim && !s.fg) out.push('ansi-dim');
  if (s.italic) out.push('ansi-italic');
  if (s.underline) out.push('ansi-underline');
  return out.join(' ');
}

function apply(state: State, codes: number[]): void {
  for (const code of codes) {
    if (code === 0) Object.assign(state, fresh());
    else if (code === 1) state.bold = true;
    else if (code === 2) state.dim = true;
    else if (code === 3) state.italic = true;
    else if (code === 4) state.underline = true;
    else if (code === 22) {
      state.bold = false;
      state.dim = false;
    } else if (code === 23) state.italic = false;
    else if (code === 24) state.underline = false;
    else if (code >= 30 && code <= 37) state.fg = COLORS[code - 30]!;
    else if (code >= 90 && code <= 97) state.fg = code === 90 ? 'gray' : COLORS[code - 90]!;
    else if (code === 39) state.fg = null;
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
    if (text) spans.push({text, className: classes(state)});
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
