import { autoCurlColors, isOff } from './env';
import { describeValue, warnOnce } from './warn';
import { curlModeOf, legacyConsole, resolveDisplay, DEFAULT_DISPLAY } from './compact/options';
import type { CompactDisplayConfig, CurlMode, OutputFormat, ResolvedDisplay } from './compact/options';

export type { CompactDisplayConfig, CurlMode, DetailsMode, OutputFormat, ThemeName } from './compact/options';

/** Extra names to mask, merged with the built-in lists. */
export interface MaskConfig {
  /** Header names (case-insensitive); same as `redactHeaders`. */
  headers?: string[];
  /** Query parameter names; same as `redactQueryParams`. */
  query?: string[];
  /** JSON/form body keys, at any depth; same as `redactBodyKeys`. */
  bodyKeys?: string[];
}

/**
 * Configuration for the API logger. All fields optional; see DEFAULT_CONFIG
 * for the effective defaults.
 */
/** How the curl command is printed and saved; see `ApiLoggerConfig.curlFormat`. */
export interface CurlFormatConfig {
  /**
   * Colour the printed curl command (the `curl.sh` file and attachment are never coloured).
   * - 'auto' (default): coloured only when ALL of these hold: NO_COLOR is not set (it always
   *   wins here), the process is not on CI, the output really reaches a terminal (stdout is a
   *   TTY, or the test runner's own stdout is one, which the runner tells its workers through
   *   PLP_RUNNER_TTY, or PLAYWRIGHT_FORCE_TTY is set), TERM is not dumb, the resolved `colors` is
   *   true and the sink is the default console one. So a local `npx playwright test` in a
   *   terminal needs no setting. `colors: true` alone, FORCE_COLOR and the FORCE_COLOR=1 that
   *   Playwright gives its workers do not colour the curl in CI or when piped.
   *   The 256-colour palette is used when COLORTERM/TERM/the terminal say so, else the 16 basic colours.
   * - true: colours on. An explicit override: it bypasses the CI, NO_COLOR and terminal checks
   *   and the sink check, so ANSI codes can end up in CI logs or a custom sink.
   * - false: colours off.
   */
  colors?: boolean | 'auto';
  /**
   * One option per line with `\` continuations (default true). false prints the command on
   * a single line, options joined by single spaces; `#` notes stay on their own preceding lines.
   */
  multiline?: boolean;
  /**
   * With the `test` fixture: collect the curl commands of a test (plain and redacted) into a
   * `curl.sh` file in the test's output directory, attach it to the report and print a one-line
   * notice (default true). The file starts with `#!/bin/sh` and the spec file and line of the
   * test; it holds no test title. Only applies while `curl` is enabled.
   */
  file?: boolean;
}

/** `CurlFormatConfig` with every default filled in and `colors` resolved to a boolean. */
export type ResolvedCurlFormat = Required<Omit<CurlFormatConfig, 'colors'>> & { colors: boolean };

export interface ApiLoggerConfig extends CompactDisplayConfig {
  /**
   * `'compact'` (default): one line per call, detail only where something went wrong, rendered by
   * the `playwright-logger-pro/reporter` reporter (or by the fixture when it is not registered).
   * `'verbose'`: the 0.3 output (request, headers, bodies, response, curl) printed live.
   */
  format?: OutputFormat;
  /**
   * Extra names to mask, merged with the built-in lists and with `redactHeaders`,
   * `redactQueryParams` and `redactBodyKeys` (which keep working). The mask is always `***`.
   */
  mask?: MaskConfig;
  /** Master switch. Set false to make the wrapper a transparent pass-through. */
  enabled?: boolean;
  /**
   * ANSI colors in output. `true`/`false` force colors on/off (`true` wins
   * over NO_COLOR). Defaults to auto-detection from NO_COLOR, FORCE_COLOR,
   * DEBUG_COLORS, PLAYWRIGHT_FORCE_TTY and whether stdout/stderr is a TTY;
   * see detectColorSupport(). With a custom `sink` and no explicit `colors`, colours
   * default to off so ANSI codes do not end up in a file; set `colors: true` to keep them.
   */
  colors?: boolean;
  /**
   * Which calls get their equivalent curl command (and a `curl.sh` attachment).
   * - '5xx' (default with `format: 'compact'`): status >= 500 and network errors
   * - '4xx+': status >= 400 and network errors
   * - 'always' (same as true): every call
   * - 'never' (same as false; the default with `format: 'verbose'`)
   * - 'on-failure' (legacy): any status that is not 2xx, and network errors
   * Any other value is ignored with a console warning.
   */
  curl?: boolean | 'on-failure' | CurlMode;
  /**
   * Presentation of the curl command: colours, single-line output and the `curl.sh` file.
   * Only the printed command changes; the redaction is the same everywhere. An invalid
   * value is ignored with a console warning.
   */
  curlFormat?: CurlFormatConfig;
  /** Log request/response headers. */
  logHeaders?: boolean;
  /** Log request/response bodies. */
  logBody?: boolean;
  /**
   * Truncate logged bodies beyond this many characters. A number >= 0
   * (`Infinity` disables truncation); anything else is ignored with a console
   * warning (default: 2000).
   */
  maxBodyLength?: number;
  /**
   * Extra header names (case-insensitive) whose values are masked in logs and
   * curl output. MERGED with DEFAULT_REDACT_HEADERS: the defaults stay
   * redacted unless `replaceDefaultRedaction` is true.
   */
  redactHeaders?: string[];
  /**
   * Extra query parameter names (case-insensitive) whose values are masked in
   * logged URLs and curl output. MERGED with DEFAULT_REDACT_QUERY_PARAMS
   * unless `replaceDefaultRedaction` is true.
   */
  redactQueryParams?: string[];
  /**
   * Extra keys (case-insensitive, at any depth) whose values are masked in
   * JSON and form request/response bodies, in logs and curl output. MERGED
   * with DEFAULT_REDACT_BODY_KEYS unless `replaceDefaultRedaction`
   * is true.
   */
  redactBodyKeys?: string[];
  /**
   * Opt out of the built-in redaction lists. When true, ONLY the lists you
   * pass are used, and a list you leave out redacts nothing. Dangerous: any
   * secret that is not in your lists is printed in clear text. Default false.
   */
  replaceDefaultRedaction?: boolean;
  /** Where log lines go. Defaults to console.log. */
  sink?: (line: string) => void;
  /**
   * Base URL that relative request URLs are resolved against, used to log and
   * curl the URL that was originally requested when a request is redirected.
   * The `test` fixture fills this in from Playwright's `baseURL` automatically.
   */
  baseURL?: string;
  /**
   * Headers the context sends with every request (Playwright's
   * `extraHTTPHeaders`), shown in logged headers and curl output. The `test`
   * fixture fills this in from Playwright's `extraHTTPHeaders` automatically.
   */
  extraHTTPHeaders?: Record<string, string>;
}

type OptionalKeys = 'baseURL' | 'extraHTTPHeaders';
export type ResolvedConfig =
  Required<Omit<ApiLoggerConfig, OptionalKeys | 'curlFormat' | 'mask' | keyof CompactDisplayConfig>> &
  Pick<ApiLoggerConfig, OptionalKeys> &
  ResolvedDisplay &
  { curlFormat: ResolvedCurlFormat };

type ColorEnv = Record<string, string | undefined>;
interface MaybeTTY { isTTY?: boolean }

/**
 * Whether colored output should be used by default. Follows the same rules as
 * Playwright's own reporters, in this order:
 *
 * 1. Off: NO_COLOR set to a non-empty value, FORCE_COLOR=0/false, or
 *    DEBUG_COLORS=0/false.
 * 2. On: any other FORCE_COLOR value (including an empty one) or DEBUG_COLORS.
 *    `playwright test` sets FORCE_COLOR=1 for its workers even though their
 *    stdout is piped, which is what makes colors work in tests.
 * 3. On: PLAYWRIGHT_FORCE_TTY is set (anything but 0/false).
 * 4. On: stdout or stderr is a TTY, unless TERM=dumb.
 *
 * Otherwise off. `colors: true/false` in the options always wins.
 */
export function detectColorSupport(
    env: ColorEnv = typeof process !== 'undefined' ? process.env : {},
    streams: Array<MaybeTTY | undefined> =
    typeof process !== 'undefined' ? [process.stdout, process.stderr] : [],
): boolean {
  if (env.NO_COLOR) return false;
  if (isOff(env.FORCE_COLOR) || isOff(env.DEBUG_COLORS)) return false;
  if (env.FORCE_COLOR !== undefined || env.DEBUG_COLORS) return true;
  if (env.PLAYWRIGHT_FORCE_TTY && !isOff(env.PLAYWRIGHT_FORCE_TTY)) return true;
  if (env.TERM === 'dumb') return false;
  return streams.some((s) => Boolean(s && s.isTTY));
}

/** Header names redacted by default. Custom `redactHeaders` are added to these. */
export const DEFAULT_REDACT_HEADERS: readonly string[] = Object.freeze([
  'authorization', 'proxy-authorization', 'cookie', 'set-cookie', 'x-api-key', 'x-auth-token',
]);
/** Query parameter names redacted by default. Custom `redactQueryParams` are added to these. */
export const DEFAULT_REDACT_QUERY_PARAMS: readonly string[] = Object.freeze([
  'api_key', 'apikey', 'token', 'access_token', 'refresh_token', 'key', 'password', 'secret', 'signature', 'sig',
]);
/**
 * Body keys redacted by default, at any depth (the snake_case spellings of the camelCase
 * ones included). Custom `redactBodyKeys` are added to these.
 */
export const DEFAULT_REDACT_BODY_KEYS: readonly string[] = Object.freeze([
  'password', 'token', 'accessToken', 'refreshToken', 'secret', 'apiKey', 'cardToken', 'cardNumber', 'cvv', 'pin',
  'access_token', 'refresh_token', 'api_key', 'card_number',
]);

export const DEFAULT_CONFIG: ResolvedConfig = {
  enabled: true,
  colors: detectColorSupport(),
  curl: '5xx',
  format: 'compact',
  ...DEFAULT_DISPLAY,
  ascii: legacyConsole(),
  curlFormat: { colors: detectColorSupport() && autoCurlColors(), multiline: true, file: true },
  logHeaders: true,
  logBody: true,
  maxBodyLength: 2000,
  redactHeaders: [...DEFAULT_REDACT_HEADERS],
  redactQueryParams: [...DEFAULT_REDACT_QUERY_PARAMS],
  redactBodyKeys: [...DEFAULT_REDACT_BODY_KEYS],
  replaceDefaultRedaction: false,
  sink: (line: string) => console.log(line),
};

/** Names from `lists`, case-insensitively deduplicated, first spelling wins. */
export function mergeNames(...lists: Array<readonly string[]>): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const name of lists.flat()) {
    const key = name.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(name);
  }
  return out;
}

const KNOWN_CURL_FORMAT_OPTIONS = new Set(['colors', 'multiline', 'file']);

const KNOWN_OPTIONS = new Set([
  'format', 'slowThresholdMs', 'timeColumn', 'details', 'bodyPreviewChars', 'theme', 'ascii', 'mask',
  'enabled', 'colors', 'curl', 'curlFormat', 'logHeaders', 'logBody', 'maxBodyLength', 'redactHeaders',
  'redactQueryParams', 'redactBodyKeys', 'replaceDefaultRedaction', 'sink', 'baseURL',
  'extraHTTPHeaders',
]);

/** Wrap a user sink so a throwing sink can never fail the request. */
function guardSink(sink: (line: string) => void): (line: string) => void {
  return (line) => {
    try {
      sink(line);
    } catch (error) {
      warnOnce(`the "sink" option threw (${error instanceof Error ? error.message : String(error)}); ` +
        'falling back to console.log for the lines it could not take');
      console.log(line);
    }
  };
}

/** The `curlFormat` option. `autoColors` is what 'auto' resolves to (see `CurlFormatConfig.colors`). */
function resolveCurlFormat(
    raw: unknown,
    autoColors: boolean,
    invalid: (key: string, expected: string, value: unknown, fallback: string) => void,
): ResolvedCurlFormat {
  const out: ResolvedCurlFormat = { colors: autoColors, multiline: true, file: true };
  if (raw === undefined) return out;
  if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) {
    invalid('curlFormat', 'an object', raw, 'the defaults');
    return out;
  }
  const input = raw as Record<string, unknown>;
  for (const key of Object.keys(input)) {
    if (!KNOWN_CURL_FORMAT_OPTIONS.has(key)) warnOnce(`unknown option "curlFormat.${key}" ignored`);
  }
  const colors = input.colors;
  if (colors === true || colors === false) out.colors = colors;
  else if (colors !== undefined && colors !== 'auto') {
    invalid('curlFormat.colors', "true, false or 'auto'", colors, "'auto'");
  }
  for (const key of ['multiline', 'file'] as const) {
    const value = input[key];
    if (typeof value === 'boolean') out[key] = value;
    else if (value !== undefined) invalid(`curlFormat.${key}`, 'true or false', value, 'true');
  }
  return out;
}

/**
 * Validate `config` and fill in defaults. Never throws: an invalid value gets
 * a one-time console warning and falls back to its default, so a typo in the
 * options cannot fail a test run.
 */
export function resolveConfig(config: ApiLoggerConfig = {}): ResolvedConfig {
  let input: Record<string, unknown> = {};
  if (config !== null && typeof config === 'object' && !Array.isArray(config)) {
    input = config as Record<string, unknown>;
  } else {
    warnOnce(`the options must be an object (got ${describeValue(config)}); using the defaults`);
  }
  for (const key of Object.keys(input)) {
    if (!KNOWN_OPTIONS.has(key)) warnOnce(`unknown option "${key}" ignored`);
  }
  // An option explicitly set to undefined falls back to its default.
  const get = (key: string): unknown => input[key];
  const invalid = (key: string, expected: string, value: unknown, fallback: string): void =>
    warnOnce(`option "${key}" must be ${expected} (got ${describeValue(value)}); using ${fallback}`);

  const bool = (key: keyof ApiLoggerConfig, fallback: boolean): boolean => {
    const value = get(key);
    if (value === undefined) return fallback;
    if (typeof value === 'boolean') return value;
    invalid(key, 'true or false', value, String(fallback));
    return fallback;
  };

  const replace = bool('replaceDefaultRedaction', false);
  let maskInput: Record<string, unknown> = {};
  const rawMask = get('mask');
  if (rawMask !== undefined) {
    if (rawMask !== null && typeof rawMask === 'object' && !Array.isArray(rawMask)) {
      maskInput = rawMask as Record<string, unknown>;
      for (const key of Object.keys(maskInput)) {
        if (!['headers', 'query', 'bodyKeys'].includes(key)) warnOnce(`unknown option "mask.${key}" ignored`);
      }
    } else {
      invalid('mask', 'an object', rawMask, 'the defaults');
    }
  }
  const names = (key: string, value: unknown): string[] | undefined => {
    if (value === undefined) return undefined;
    if (!Array.isArray(value)) {
      invalid(key, 'an array of strings', value, 'the defaults');
      return undefined;
    }
    const strings = value.filter((v): v is string => typeof v === 'string');
    if (strings.length !== value.length) {
      warnOnce(`option "${key}" contains entries that are not strings; they were ignored`);
    }
    return strings.map((v) => v.trim()).filter((v) => v.length > 0);
  };
  const redactList = (key: keyof ApiLoggerConfig, alias: string, defaults: readonly string[]): string[] => {
    const own = names(key, get(key)) ?? [];
    const viaMask = names(`mask.${alias}`, maskInput[alias]) ?? [];
    return mergeNames(replace ? [] : defaults, own, viaMask);
  };

  let maxBodyLength = DEFAULT_CONFIG.maxBodyLength;
  const rawMax = get('maxBodyLength');
  if (rawMax !== undefined) {
    if (typeof rawMax === 'number' && !Number.isNaN(rawMax) && rawMax >= 0) {
      maxBodyLength = Math.floor(rawMax);
    } else {
      invalid('maxBodyLength', 'a number >= 0', rawMax, String(maxBodyLength));
    }
  }

  let format: OutputFormat = DEFAULT_CONFIG.format;
  const rawFormat = get('format');
  if (rawFormat === 'compact' || rawFormat === 'verbose') format = rawFormat;
  else if (rawFormat !== undefined) invalid('format', "'compact' or 'verbose'", rawFormat, "'compact'");

  // The default depends on the format: compact prints a curl for 5xx, verbose none (as in 0.3).
  let curl: ResolvedConfig['curl'] = format === 'verbose' ? false : DEFAULT_CONFIG.curl;
  const rawCurl = get('curl');
  if (rawCurl !== undefined) {
    if (rawCurl === 'on-failure' || curlModeOf(rawCurl) !== undefined) {
      curl = rawCurl as ResolvedConfig['curl'];
    } else {
      invalid('curl', "true, false, 'on-failure', '5xx', '4xx+', 'always' or 'never'", rawCurl, String(curl));
    }
  }

  let sink = DEFAULT_CONFIG.sink;
  let customSink = false;
  const rawSink = get('sink');
  if (rawSink !== undefined) {
    if (typeof rawSink === 'function') {
      sink = guardSink(rawSink as (line: string) => void);
      customSink = true;
    } else {
      invalid('sink', 'a function', rawSink, 'console.log');
    }
  }

  // Colors are detected per call (not only at module load) so the environment
  // the logger actually runs in is honoured. A custom sink may write to a file:
  // unless colors were asked for explicitly, keep ANSI codes out of it.
  let colors = detectColorSupport() && !customSink;
  const rawColors = get('colors');
  if (rawColors !== undefined) {
    if (typeof rawColors === 'boolean') {
      colors = rawColors;
    } else {
      invalid('colors', 'true or false', rawColors, 'auto-detection');
    }
  }

  // 'auto' also needs a terminal and no CI/NO_COLOR, which `colors` alone does not check
  // (FORCE_COLOR makes it true for Playwright workers whose stdout is a pipe).
  const curlFormat = resolveCurlFormat(get('curlFormat'), colors && !customSink && autoCurlColors(), invalid);

  let baseURL: string | undefined;
  const rawBase = get('baseURL');
  if (typeof rawBase === 'string') baseURL = rawBase;
  else if (rawBase !== undefined) invalid('baseURL', 'a string', rawBase, 'no base URL');

  let extraHTTPHeaders: Record<string, string> | undefined;
  const rawExtra = get('extraHTTPHeaders');
  if (rawExtra !== undefined) {
    if (rawExtra !== null && typeof rawExtra === 'object' && !Array.isArray(rawExtra)) {
      extraHTTPHeaders = rawExtra as Record<string, string>;
    } else {
      invalid('extraHTTPHeaders', 'an object', rawExtra, 'no extra headers');
    }
  }

  return {
    ...resolveDisplay(input, undefined, invalid),
    format,
    enabled: bool('enabled', DEFAULT_CONFIG.enabled),
    colors,
    curl,
    curlFormat,
    logHeaders: bool('logHeaders', DEFAULT_CONFIG.logHeaders),
    logBody: bool('logBody', DEFAULT_CONFIG.logBody),
    maxBodyLength,
    redactHeaders: redactList('redactHeaders', 'headers', DEFAULT_REDACT_HEADERS),
    redactQueryParams: redactList('redactQueryParams', 'query', DEFAULT_REDACT_QUERY_PARAMS),
    redactBodyKeys: redactList('redactBodyKeys', 'bodyKeys', DEFAULT_REDACT_BODY_KEYS),
    replaceDefaultRedaction: replace,
    sink,
    baseURL,
    extraHTTPHeaders,
  };
}

/** The subset of request information the logger cares about. */
export interface RequestInfo {
  method: string;
  url: string;
  headers?: Record<string, string>;
  /** Raw body: string, object (JSON), or Buffer. */
  data?: unknown;
  /** application/x-www-form-urlencoded parameters. */
  form?: Record<string, string | number | boolean>;
  /** multipart/form-data fields, as accepted by Playwright's `multipart` option. */
  multipart?: unknown;
  /** The request was redirected: emit `-L` so curl follows redirects too. */
  followRedirects?: boolean;
  /**
   * The requests Playwright sent while following redirects, first one
   * included. With it, redirected requests are replayed one curl per step.
   */
  redirects?: RedirectHop[];
  /**
   * `headers.Cookie` was added from the context's cookie jar rather than set
   * by the caller. Playwright re-reads the jar for every redirect step, so
   * the step curls never carry it over.
   */
  cookieFromJar?: boolean;
  /**
   * Version of the running Playwright ("1.45.0"). It decides which headers a
   * redirect forwards (see `redirectRulesFor`); without it the rules of the
   * newest Playwright are used.
   */
  playwrightVersion?: string;
}

/** One request Playwright sent on the way to the final response. */
export interface RedirectHop {
  method: string;
  url: string;
  /** Status of the response to this request, when known. */
  status?: number;
}
