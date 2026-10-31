import { createColors } from 'picocolors';
import type { ThemeName } from './options';

export type Paint = (s: string) => string;
export type Severity = 4 | 5;

const identity: Paint = (s) => s;
const pc = createColors(true);

/** The palette of the reference screenshots (see the README). */
interface Hex { fg?: string; bg?: string; bold?: boolean }
interface Role {
  ansi: Paint;
  dark: Hex;
  light: Hex;
}

const bold = (paint: Paint): Paint => (s) => pc.bold(paint(s));

const ROLES = {
  get: { ansi: bold(pc.blue), dark: { fg: '#58a6ff', bold: true }, light: { fg: '#0969da', bold: true } },
  post: { ansi: bold(pc.green), dark: { fg: '#3fb950', bold: true }, light: { fg: '#1a7f37', bold: true } },
  put: { ansi: bold(pc.yellow), dark: { fg: '#d29922', bold: true }, light: { fg: '#9a6700', bold: true } },
  patch: { ansi: bold(pc.magenta), dark: { fg: '#bc8cff', bold: true }, light: { fg: '#8250df', bold: true } },
  delete: { ansi: bold(pc.red), dark: { fg: '#ff7b72', bold: true }, light: { fg: '#cf222e', bold: true } },
  otherMethod: { ansi: bold(pc.cyan), dark: { fg: '#39c5cf', bold: true }, light: { fg: '#1b7c83', bold: true } },
  s2xx: { ansi: bold(pc.green), dark: { fg: '#3fb950', bold: true }, light: { fg: '#1a7f37', bold: true } },
  s3xx: { ansi: bold(pc.cyan), dark: { fg: '#39c5cf', bold: true }, light: { fg: '#1b7c83', bold: true } },
  s1xx: { ansi: pc.gray, dark: { fg: '#7d8590' }, light: { fg: '#656d76' } },
  chip4: {
    ansi: (s) => pc.bgYellow(pc.bold(pc.black(s))),
    dark: { fg: '#0d1117', bg: '#d29922', bold: true },
    light: { fg: '#ffffff', bg: '#9a6700', bold: true },
  },
  chip5: {
    ansi: (s) => pc.bgRed(pc.bold(pc.whiteBright(s))),
    dark: { fg: '#0d1117', bg: '#f85149', bold: true },
    light: { fg: '#ffffff', bg: '#cf222e', bold: true },
  },
  host: { ansi: pc.gray, dark: { fg: '#7d8590' }, light: { fg: '#656d76' } },
  path: { ansi: identity, dark: { fg: '#e6edf3' }, light: { fg: '#1f2328' } },
  mask: {
    ansi: (s) => pc.bgBlackBright(pc.whiteBright(s)),
    dark: { fg: '#e6edf3', bg: '#30363d' },
    light: { fg: '#1f2328', bg: '#e1e4e8' },
  },
  timing: { ansi: pc.gray, dark: { fg: '#7d8590' }, light: { fg: '#656d76' } },
  slow: { ansi: bold(pc.yellow), dark: { fg: '#f0883e', bold: true }, light: { fg: '#bc4c00', bold: true } },
  gutter4: { ansi: pc.yellow, dark: { fg: '#d29922' }, light: { fg: '#9a6700' } },
  gutter5: { ansi: pc.red, dark: { fg: '#f85149' }, light: { fg: '#cf222e' } },
  text4: { ansi: bold(pc.yellow), dark: { fg: '#d29922', bold: true }, light: { fg: '#9a6700', bold: true } },
  text5: { ansi: bold(pc.red), dark: { fg: '#f85149', bold: true }, light: { fg: '#cf222e', bold: true } },
  curlString: { ansi: pc.blue, dark: { fg: '#a5d6ff' }, light: { fg: '#0a3069' } },
  gray: { ansi: pc.gray, dark: { fg: '#7d8590' }, light: { fg: '#656d76' } },
  body: { ansi: identity, dark: { fg: '#c9d1d9' }, light: { fg: '#424a53' } },
  // Plain text that must stand out (`curl`, `curl.sh`): bold in the default foreground.
  strong: { ansi: pc.bold, dark: { fg: '#e6edf3', bold: true }, light: { fg: '#1f2328', bold: true } },
} satisfies Record<string, Role>;

type RoleName = keyof typeof ROLES;

const ESC = '\u001b[';

function rgb(hex: string): string {
  const n = parseInt(hex.slice(1), 16);
  return `${(n >> 16) & 255};${(n >> 8) & 255};${n & 255}`;
}

function truecolor({ fg, bg, bold: b }: Hex): Paint {
  const open = `${b ? `${ESC}1m` : ''}${fg ? `${ESC}38;2;${rgb(fg)}m` : ''}${bg ? `${ESC}48;2;${rgb(bg)}m` : ''}`;
  const close = `${bg ? `${ESC}49m` : ''}${fg ? `${ESC}39m` : ''}${b ? `${ESC}22m` : ''}`;
  return (s) => `${open}${s}${close}`;
}

export interface Style {
  method: (method: string) => Paint;
  /** Colour of the status number of a successful response (1xx-3xx). */
  status: (status: number) => Paint;
  /** The chip of a 4xx, 5xx or network error. */
  chip: (severity: Severity) => Paint;
  gutter: (severity: Severity) => Paint;
  /** Bold severity colour of `404 Not Found`. */
  severityText: (severity: Severity) => Paint;
  host: Paint;
  path: Paint;
  mask: Paint;
  timing: Paint;
  slow: Paint;
  curlString: Paint;
  gray: Paint;
  body: Paint;
  strong: Paint;
  /** `2 errors` in the footer. */
  errors: Paint;
}

/** The paints of a theme; with `colors` off every paint returns its text unchanged. */
export function makeStyle(colors: boolean, theme: ThemeName): Style {
  const paint = (name: RoleName): Paint => {
    if (!colors) return identity;
    const role: Role = ROLES[name];
    return theme === 'ansi' ? role.ansi : truecolor(role[theme]);
  };
  const methods: Record<string, Paint> = {
    GET: paint('get'), POST: paint('post'), PUT: paint('put'), PATCH: paint('patch'), DELETE: paint('delete'),
  };
  const other = paint('otherMethod');
  const statuses = [paint('s1xx'), paint('s2xx'), paint('s3xx')];
  return {
    method: (m) => methods[m.toUpperCase()] ?? other,
    status: (status) => statuses[Math.max(1, Math.min(3, Math.floor(status / 100))) - 1] as Paint,
    chip: (severity) => paint(severity === 4 ? 'chip4' : 'chip5'),
    gutter: (severity) => paint(severity === 4 ? 'gutter4' : 'gutter5'),
    severityText: (severity) => paint(severity === 4 ? 'text4' : 'text5'),
    host: paint('host'),
    path: paint('path'),
    mask: paint('mask'),
    timing: paint('timing'),
    slow: paint('slow'),
    curlString: paint('curlString'),
    gray: paint('gray'),
    body: paint('body'),
    strong: paint('strong'),
    errors: paint('text5'),
  };
}
