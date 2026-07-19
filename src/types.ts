/**
 * Configuration for the API logger. All fields optional; see DEFAULT_CONFIG
 * for the effective defaults.
 */
export interface ApiLoggerConfig {
  /** Master switch. Set false to make the wrapper a transparent pass-through. */
  enabled?: boolean;
  /** ANSI colors in output. Defaults to auto-detection of a TTY. */
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
  /** Where log lines go. Defaults to console.log. */
  sink?: (line: string) => void;
}

export type ResolvedConfig = Required<ApiLoggerConfig>;

export const DEFAULT_CONFIG: ResolvedConfig = {
  enabled: true,
  colors: typeof process !== 'undefined' ? Boolean(process.stdout && process.stdout.isTTY) : false,
  curl: false,
  logHeaders: true,
  logBody: true,
  maxBodyLength: 2000,
  redactHeaders: ['authorization', 'cookie', 'set-cookie', 'x-api-key'],
  // eslint-disable-next-line no-console
  sink: (line: string) => console.log(line),
};

export function resolveConfig(config: ApiLoggerConfig = {}): ResolvedConfig {
  return { ...DEFAULT_CONFIG, ...config };
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
}
