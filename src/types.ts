import { describeValue, warnOnce } from './warn';

/**
 * Configuration for the API logger. All fields optional; see DEFAULT_CONFIG
 * for the effective defaults.
 */
export interface ApiLoggerConfig {
  /** Master switch. Set false to make the wrapper a transparent pass-through. */
  enabled?: boolean;
  /**
   * ANSI colors in output. `true`/`false` force colors on/off (`true` wins
   * over NO_COLOR). Defaults to auto-detection from NO_COLOR, FORCE_COLOR,
   * DEBUG_COLORS, PLAYWRIGHT_FORCE_TTY and whether stdout/stderr is a TTY;
   * see detectColorSupport().
   */
  colors?: boolean;
  /**
   * Print the equivalent curl command for each request.
   * - false: never (default)
   * - true: for every request
   * - 'on-failure': only when the response status is not 2xx
   * Any other value is ignored with a console warning (default: false).
   */
  curl?: boolean | 'on-failure';
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
   * with DEFAULT_REDACT_BODY_KEYS (empty) unless `replaceDefaultRedaction`
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
  Required<Omit<ApiLoggerConfig, OptionalKeys>> & Pick<ApiLoggerConfig, OptionalKeys>;

type ColorEnv = Record<string, string | undefined>;
interface MaybeTTY { isTTY?: boolean }

/** True for the values the colour env vars use to mean "off". */
function isOff(value: string | undefined): boolean {
  return value !== undefined && (value === '0' || value.toLowerCase() === 'false');
}

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
  'authorization', 'cookie', 'set-cookie', 'x-api-key',
]);
/** Query parameter names redacted by default. Custom `redactQueryParams` are added to these. */
export const DEFAULT_REDACT_QUERY_PARAMS: readonly string[] = Object.freeze([
  'api_key', 'apikey', 'token', 'access_token', 'password', 'secret',
]);
/** Body keys redacted by default (none). Custom `redactBodyKeys` are added to these. */
export const DEFAULT_REDACT_BODY_KEYS: readonly string[] = Object.freeze([]);

export const DEFAULT_CONFIG: ResolvedConfig = {
  enabled: true,
  colors: detectColorSupport(),
  curl: false,
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
function mergeNames(...lists: Array<readonly string[]>): string[] {
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

const KNOWN_OPTIONS = new Set([
  'enabled', 'colors', 'curl', 'logHeaders', 'logBody', 'maxBodyLength', 'redactHeaders',
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
  const redactList = (key: keyof ApiLoggerConfig, defaults: readonly string[]): string[] => {
    const value = get(key);
    if (value === undefined) return replace ? [] : [...defaults];
    if (!Array.isArray(value)) {
      invalid(key, 'an array of strings', value, 'the defaults');
      return [...defaults];
    }
    const strings = value.filter((v): v is string => typeof v === 'string');
    if (strings.length !== value.length) {
      warnOnce(`option "${key}" contains entries that are not strings; they were ignored`);
    }
    const names = strings.map((v) => v.trim()).filter((v) => v.length > 0);
    return mergeNames(replace ? [] : defaults, names);
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

  let curl: ResolvedConfig['curl'] = DEFAULT_CONFIG.curl;
  const rawCurl = get('curl');
  if (rawCurl !== undefined) {
    if (rawCurl === true || rawCurl === false || rawCurl === 'on-failure') {
      curl = rawCurl;
    } else {
      invalid('curl', "true, false or 'on-failure'", rawCurl, 'false');
    }
  }

  let sink = DEFAULT_CONFIG.sink;
  const rawSink = get('sink');
  if (rawSink !== undefined) {
    if (typeof rawSink === 'function') {
      sink = guardSink(rawSink as (line: string) => void);
    } else {
      invalid('sink', 'a function', rawSink, 'console.log');
    }
  }

  // Colors are detected per call (not only at module load) so the environment
  // the logger actually runs in is honoured.
  let colors = detectColorSupport();
  const rawColors = get('colors');
  if (rawColors !== undefined) {
    if (typeof rawColors === 'boolean') {
      colors = rawColors;
    } else {
      invalid('colors', 'true or false', rawColors, 'auto-detection');
    }
  }

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
    enabled: bool('enabled', DEFAULT_CONFIG.enabled),
    colors,
    curl,
    logHeaders: bool('logHeaders', DEFAULT_CONFIG.logHeaders),
    logBody: bool('logBody', DEFAULT_CONFIG.logBody),
    maxBodyLength,
    redactHeaders: redactList('redactHeaders', DEFAULT_REDACT_HEADERS),
    redactQueryParams: redactList('redactQueryParams', DEFAULT_REDACT_QUERY_PARAMS),
    redactBodyKeys: redactList('redactBodyKeys', DEFAULT_REDACT_BODY_KEYS),
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
}

/** One request Playwright sent on the way to the final response. */
export interface RedirectHop {
  method: string;
  url: string;
  /** Status of the response to this request, when known. */
  status?: number;
}
