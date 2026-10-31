import { describeValue, warnOnce } from '../warn';

/** What the compact output prints for a call that went wrong; see `ApiLoggerConfig.curl`. */
export type CurlMode = '5xx' | '4xx+' | 'always' | 'never';
/** When the `│` detail block is printed under a request line. */
export type DetailsMode = 'failed-tests' | 'always' | 'never';
/** `'ansi'`: the 16 basic colours of the user's terminal theme. `'dark'`/`'light'`: true colour. */
export type ThemeName = 'ansi' | 'dark' | 'light';
/** `'compact'`: one line per call and detail only where something went wrong. `'verbose'`: the 0.3 output. */
export type OutputFormat = 'compact' | 'verbose';

/** The options that decide how the compact output looks; shared by `apiLog` and the reporter. */
export interface CompactDisplayConfig {
  /** A call at least this slow (ms) gets a `▲` and a yellow time, and counts in the footer (default 1000). */
  slowThresholdMs?: number;
  /**
   * Column where the timing ends (default 82). `'auto'` fits the terminal width. A longer line
   * keeps a 2-space gap and, when it exceeds the terminal, loses the middle of its query string.
   */
  timeColumn?: number | 'auto';
  /**
   * When a request with status >= 400 or a network error gets its `│` block:
   * `'failed-tests'` (default) only when its test failed, `'always'`, or `'never'`.
   */
  details?: DetailsMode;
  /** Response body preview length in the detail block, in characters (default 200). */
  bodyPreviewChars?: number;
  /** `'ansi'` (default), `'dark'` or `'light'` (true colour palettes of the documentation screenshots). */
  theme?: ThemeName;
  /** ASCII symbols instead of Unicode. Default: only on legacy Windows consoles. */
  ascii?: boolean;
}

export interface ResolvedDisplay {
  slowThresholdMs: number;
  timeColumn: number | 'auto';
  details: DetailsMode;
  bodyPreviewChars: number;
  theme: ThemeName;
  ascii: boolean;
}

export const CURL_MODES: readonly CurlMode[] = ['5xx', '4xx+', 'always', 'never'];
export const DETAILS_MODES: readonly DetailsMode[] = ['failed-tests', 'always', 'never'];
export const THEMES: readonly ThemeName[] = ['ansi', 'dark', 'light'];

/** Legacy Windows consoles (no Windows Terminal, not VS Code) cannot show the Unicode symbols. */
export function legacyConsole(env: Record<string, string | undefined> = process.env, platform: string = process.platform): boolean {
  return platform === 'win32' && !env.WT_SESSION && env.TERM_PROGRAM !== 'vscode';
}

export const DEFAULT_DISPLAY: ResolvedDisplay = {
  slowThresholdMs: 1000,
  timeColumn: 82,
  details: 'failed-tests',
  bodyPreviewChars: 200,
  theme: 'ansi',
  ascii: false,
};

export type Invalid = (key: string, expected: string, value: unknown, fallback: string) => void;

/** `warnOnce`-based reporter of an invalid option, for callers without their own. */
export const warnInvalid: Invalid = (key, expected, value, fallback) =>
  warnOnce(`option "${key}" must be ${expected} (got ${describeValue(value)}); using ${fallback}`);

/** Validate the display options in `input`, falling back to `base`; never throws. */
export function resolveDisplay(
    input: Record<string, unknown>,
    base: ResolvedDisplay = { ...DEFAULT_DISPLAY, ascii: legacyConsole() },
    invalid: Invalid = warnInvalid,
): ResolvedDisplay {
  const out = { ...base };

  const slow = input.slowThresholdMs;
  if (typeof slow === 'number' && !Number.isNaN(slow) && slow >= 0) out.slowThresholdMs = slow;
  else if (slow !== undefined) invalid('slowThresholdMs', 'a number >= 0', slow, String(base.slowThresholdMs));

  const column = input.timeColumn;
  if (column === 'auto') out.timeColumn = 'auto';
  else if (typeof column === 'number' && Number.isFinite(column) && column >= 0) out.timeColumn = Math.floor(column);
  else if (column !== undefined) invalid('timeColumn', "a number >= 0 or 'auto'", column, String(base.timeColumn));

  const details = input.details;
  if (DETAILS_MODES.includes(details as DetailsMode)) out.details = details as DetailsMode;
  else if (details !== undefined) invalid('details', "'failed-tests', 'always' or 'never'", details, `'${base.details}'`);

  const chars = input.bodyPreviewChars;
  if (typeof chars === 'number' && !Number.isNaN(chars) && chars >= 0) out.bodyPreviewChars = Math.floor(chars);
  else if (chars !== undefined) invalid('bodyPreviewChars', 'a number >= 0', chars, String(base.bodyPreviewChars));

  const theme = input.theme;
  if (THEMES.includes(theme as ThemeName)) out.theme = theme as ThemeName;
  else if (theme !== undefined) invalid('theme', "'ansi', 'dark' or 'light'", theme, `'${base.theme}'`);

  const ascii = input.ascii;
  if (typeof ascii === 'boolean') out.ascii = ascii;
  else if (ascii !== undefined) invalid('ascii', 'true or false', ascii, String(base.ascii));

  return out;
}

/** The `curl` option in compact terms: the legacy `true`/`false`/`'on-failure'` map onto the modes. */
export function curlModeOf(curl: unknown): CurlMode | undefined {
  if (curl === true) return 'always';
  if (curl === false) return 'never';
  if (curl === 'on-failure') return '4xx+';
  return CURL_MODES.includes(curl as CurlMode) ? curl as CurlMode : undefined;
}

/**
 * Whether a call gets a curl. `status` is undefined for a network failure. `'on-failure'`
 * (legacy) means any non-2xx; `true` means every call.
 */
export function wantsCurl(curl: boolean | 'on-failure' | CurlMode, status: number | undefined): boolean {
  if (curl === true || curl === 'always') return true;
  if (curl === false || curl === 'never') return false;
  if (status === undefined) return true;
  if (curl === 'on-failure') return status < 200 || status >= 300;
  return curl === '4xx+' ? status >= 400 : status >= 500;
}
