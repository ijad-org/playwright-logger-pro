import pc from 'picocolors';

type Colorizer = (s: string) => string;

export interface BrowserPalette {
  ok: Colorizer;
  fail: Colorizer;
  warn: Colorizer;
  subject: Colorizer;
  method: Colorizer;
  nav: Colorizer;
  step: Colorizer;
  pageError: Colorizer;
  dim: Colorizer;
  bold: Colorizer;
  status: (status: number) => Colorizer;
}

const identity: Colorizer = (s) => s;

const PLAIN: BrowserPalette = {
  ok: identity,
  fail: identity,
  warn: identity,
  subject: identity,
  method: identity,
  nav: identity,
  step: identity,
  pageError: identity,
  dim: identity,
  bold: identity,
  status: () => identity,
};

/**
 * `colors: true` always yields real ANSI (picocolors' own TTY detection is
 * bypassed on purpose: the caller already decided). `colors: false` is the
 * identity palette used for files and attachments.
 */
export function browserPalette(colors: boolean): BrowserPalette {
  if (!colors) return PLAIN;
  const c = pc.createColors(true);
  return {
    ok: c.green,
    fail: c.red,
    warn: c.yellow,
    subject: c.cyan,
    method: c.bold,
    nav: c.blue,
    step: c.magenta,
    pageError: (s) => c.bold(c.red(s)),
    dim: c.dim,
    bold: c.bold,
    status: (status: number) => {
      if (status >= 500) return c.red;
      if (status >= 400) return c.yellow;
      if (status >= 300) return c.cyan;
      return c.green;
    },
  };
}

// eslint-disable-next-line no-control-regex
const ANSI = /\x1b\[[0-9;]*m/g;

export function stripAnsi(s: string): string {
  return s.replace(ANSI, '');
}
