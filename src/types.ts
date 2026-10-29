/**
 * Configuration for the API logger. All fields optional; see DEFAULT_CONFIG
 * for the effective defaults.
 */
export interface ApiLoggerConfig {
  /** Master switch. Set false to make the wrapper a transparent pass-through. */
  enabled?: boolean;
  /**
   * ANSI colors in output. `true`/`false` force colors on/off (`true` wins
   * over NO_COLOR). Defaults to auto-detection: on when the terminal is a TTY
   * or FORCE_COLOR is set (as Playwright does for its workers), unless
   * NO_COLOR is set. See detectColorSupport().
   */
  colors?: boolean;
  /**
   * Print the equivalent curl command for each request.
   * - false: never (default)
   * - true: for every request
   * - 'on-failure': only when the response status is not 2xx
   */
  curl?: boolean | 'on-failure';
  /** Log request/response headers. */
  logHeaders?: boolean;
  /** Log request/response bodies. */
  logBody?: boolean;
  /** Truncate logged bodies beyond this many characters. */
  maxBodyLength?: number;
  /** Header names (case-insensitive) whose values are masked in logs and curl output. */
  redactHeaders?: string[];
  /**
   * Query parameter names (case-insensitive) whose values are masked in
   * logged URLs and curl output.
   */
  redactQueryParams?: string[];
  /**
   * Keys (case-insensitive, at any depth) whose values are masked in JSON and
   * form request/response bodies, in logs and curl output. Empty by default.
   */
  redactBodyKeys?: string[];
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

/**
 * Whether colored output should be used by default.
 *
 * Playwright pipes worker stdout/stderr to the runner (so `isTTY` is false in
 * tests) but sets FORCE_COLOR=1 for workers, so FORCE_COLOR counts as a
 * signal alongside a TTY on stdout or stderr. NO_COLOR, FORCE_COLOR=0/false
 * and TERM=dumb (for the TTY case) turn colors off.
 */
export function detectColorSupport(
    env: ColorEnv = typeof process !== 'undefined' ? process.env : {},
    streams: Array<MaybeTTY | undefined> =
    typeof process !== 'undefined' ? [process.stdout, process.stderr] : [],
): boolean {
  if (env.NO_COLOR) return false;
  const force = env.FORCE_COLOR;
  if (force !== undefined) {
    if (force === '0' || force.toLowerCase() === 'false') return false;
    return true;
  }
  if (env.TERM === 'dumb') return false;
  return streams.some((s) => Boolean(s && s.isTTY));
}

export const DEFAULT_CONFIG: ResolvedConfig = {
  enabled: true,
  colors: detectColorSupport(),
  curl: false,
  logHeaders: true,
  logBody: true,
  maxBodyLength: 2000,
  redactHeaders: ['authorization', 'cookie', 'set-cookie', 'x-api-key'],
  redactQueryParams: ['api_key', 'apikey', 'token', 'access_token', 'password', 'secret'],
  redactBodyKeys: [],
  // eslint-disable-next-line no-console
  sink: (line: string) => console.log(line),
};

export function resolveConfig(config: ApiLoggerConfig = {}): ResolvedConfig {
  // An option explicitly set to undefined falls back to its default.
  const defined = Object.fromEntries(
      Object.entries(config).filter(([, value]) => value !== undefined),
  ) as ApiLoggerConfig;
  // Colors are detected per call (not only at module load) so the environment
  // the logger actually runs in is honoured.
  return { ...DEFAULT_CONFIG, ...defined, colors: config.colors ?? detectColorSupport() };
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
}
