import { DEFAULT_REDACT_HEADERS, detectColorSupport, mergeNames, resolveConfig } from '../types';
import type { ApiLoggerConfig } from '../types';
import { REDACTED, headerSecretValues, normalizeSecretValues } from '../redact';
import { validateBrowserConfig } from './validate';
import { DEFAULT_SENSITIVE_KEY_PATTERNS, DEFAULT_SENSITIVE_SELECTORS } from './sensitive';

export type ConsoleLevel = false | 'error' | 'warning' | 'info' | 'all';
export type NetworkMode = false | 'failed' | 'documents' | 'all';
export type OutputFormat = 'text' | 'jsonl';
export type WhenToWrite = boolean | 'on-failure';

export interface BrowserRedactConfig {
  /** Replacement for masked values. Default '***'. */
  mask?: string;
  /** Masking of text-entry values (fill/type/press/...). Default 'auto'. */
  fillValues?: 'auto' | 'always' | 'never';
  /** Matched against a target's description; strings are case-insensitive substrings. */
  selectors?: (string | RegExp)[];
  /** Literal secrets masked everywhere (args, URLs, console text, errors, notes). */
  values?: string[];
  /** Object keys masked inside arguments. */
  keys?: (string | RegExp)[];
  /** Extra header names masked, on top of apiLog's resolved `redactHeaders` (which include DEFAULT_REDACT_HEADERS). */
  headers?: string[];
  /** Opt-in DOM probe for type=password on fill-like calls. Default false. */
  inspectInputType?: boolean;
}

export interface BrowserLoggerConfig {
  /** Master switch. false = nothing is installed, attached or recorded. Default true. */
  enabled?: boolean;
  /** ANSI colors for `print`. Files and attachments are always plain. Default: auto-detect. */
  colors?: boolean;
  /** Interactions and navigations (click, fill, goto, ...). Default true. */
  actions?: boolean;
  /** waitFor*, locator.waitFor, waitForTimeout. Default true. */
  waits?: boolean;
  /** Read-only async calls (textContent, isVisible, count, ...). Results are never logged. Default false. */
  queries?: boolean;
  /** mouse.move (noisy). Default false. */
  mouseMoves?: boolean;
  /** Main-frame navigations, page open/close/popup/crash, dialogs, downloads. Default true. */
  navigation?: boolean;
  /** Minimum console level to record. Default 'warning'. */
  browserConsole?: ConsoleLevel;
  /** Uncaught page exceptions. Default true. */
  pageErrors?: boolean;
  /** Network capture. Default false. */
  network?: NetworkMode;
  /** Extra filter applied after `network`. */
  networkFilter?: (r: { url: string; method: string; resourceType: string }) => boolean;
  /** test.step integration. 'auto' = on for Playwright >= 1.48. Default 'auto'. */
  steps?: boolean | 'auto';
  /** Copy apiLog lines into this test's file/attachment (never re-printed). Default true. */
  includeApiLog?: boolean;
  /** Also print a line when each action starts. Default false. */
  logStart?: boolean;
  /** Highlight actions slower than this many ms. Default 1000. */
  slowActionMs?: number;
  /** Append the call site (login.spec.ts:14). Costs one stack capture per action. Default false. */
  location?: boolean;
  /** Truncate each rendered argument. Default 200. */
  maxArgLength?: number;
  /** Ring buffer size per test. Default 5000. */
  maxEvents?: number;
  redact?: BrowserRedactConfig;
  /** Print to `sink`. 'on-failure' prints one block if the test failed. Default 'on-failure'. */
  print?: WhenToWrite;
  /** testInfo.attach('browser-log', ...). Default 'on-failure'. */
  attach?: WhenToWrite;
  attachFormat?: OutputFormat;
  /** Write a per-test file. Default false. */
  file?: WhenToWrite;
  fileFormat?: OutputFormat;
  /** Directory for per-test files. Default: testInfo.outputPath(). Never cleaned by us. */
  fileDir?: string;
  /** Where printed lines go. Defaults to console.log. */
  sink?: (line: string) => void;
}

export interface ResolvedRedactConfig {
  mask: string;
  fillValues: 'auto' | 'always' | 'never';
  selectors: (string | RegExp)[];
  /** Normalized (deduplicated, longest first) and including auto-collected secrets. */
  values: string[];
  keys: (string | RegExp)[];
  headers: string[];
  inspectInputType: boolean;
}

export interface ResolvedBrowserConfig {
  enabled: boolean;
  colors: boolean;
  actions: boolean;
  waits: boolean;
  queries: boolean;
  mouseMoves: boolean;
  navigation: boolean;
  browserConsole: ConsoleLevel;
  pageErrors: boolean;
  network: NetworkMode;
  networkFilter?: BrowserLoggerConfig['networkFilter'];
  steps: boolean | 'auto';
  includeApiLog: boolean;
  logStart: boolean;
  slowActionMs: number;
  location: boolean;
  maxArgLength: number;
  maxEvents: number;
  redact: ResolvedRedactConfig;
  print: WhenToWrite;
  attach: WhenToWrite;
  attachFormat: OutputFormat;
  file: WhenToWrite;
  fileFormat: OutputFormat;
  fileDir?: string;
  sink: (line: string) => void;
}

export const DEFAULT_BROWSER_CONFIG: Omit<ResolvedBrowserConfig, 'colors' | 'networkFilter' | 'fileDir'> = {
  enabled: true,
  actions: true,
  waits: true,
  queries: false,
  mouseMoves: false,
  navigation: true,
  browserConsole: 'warning',
  pageErrors: true,
  network: false,
  steps: 'auto',
  includeApiLog: true,
  logStart: false,
  slowActionMs: 1000,
  location: false,
  maxArgLength: 200,
  maxEvents: 5000,
  redact: {
    mask: REDACTED,
    fillValues: 'auto',
    selectors: [...DEFAULT_SENSITIVE_SELECTORS],
    values: [],
    keys: [...DEFAULT_SENSITIVE_KEY_PATTERNS],
    headers: [...DEFAULT_REDACT_HEADERS],
    inspectInputType: false,
  },
  print: 'on-failure',
  attach: 'on-failure',
  attachFormat: 'text',
  file: false,
  fileFormat: 'text',
  sink: (line: string) => console.log(line),
};

/** Secrets Playwright's own option fixtures may already hold. */
export interface ResolveContext {
  /** The raw user `apiLog` option; its header redaction list is inherited. */
  apiLog?: ApiLoggerConfig;
  httpCredentials?: { username?: string; password?: string } | undefined;
  extraHTTPHeaders?: Record<string, string> | undefined;
}

/** Copy of `obj` without keys whose value is `undefined`, so they never override defaults. */
function defined<T extends object>(obj: T | undefined): Partial<T> {
  const out: Partial<T> = {};
  if (!obj) return out;
  for (const key of Object.keys(obj) as (keyof T)[]) {
    if (obj[key] !== undefined) out[key] = obj[key];
  }
  return out;
}

export function resolveBrowserConfig(
    input: BrowserLoggerConfig = {},
    context: ResolveContext = {},
): ResolvedBrowserConfig {
  // Invalid options warn once and fall back to the defaults (nothing here throws).
  const config = validateBrowserConfig(input);
  const userRedact = defined(config.redact);
  // One header list for both loggers: apiLog's resolved list (defaults + its
  // extras, honouring replaceDefaultRedaction) plus browserLog's own extras.
  const headers = mergeNames(
      resolveConfig(context.apiLog ?? {}).redactHeaders,
      userRedact.headers ?? [],
  );

  const auto: unknown[] = [];
  const password = context.httpCredentials?.password;
  if (typeof password === 'string') auto.push(password);
  if (context.extraHTTPHeaders) {
    const lowered = new Set(headers.map((h) => h.toLowerCase()));
    for (const [name, value] of Object.entries(context.extraHTTPHeaders)) {
      // `Bearer X` is learned whole and as the bare token X.
      if (lowered.has(name.toLowerCase())) auto.push(...headerSecretValues(name, value));
    }
  }

  const rest = defined(config);
  const resolved: ResolvedBrowserConfig = {
    ...DEFAULT_BROWSER_CONFIG,
    ...rest,
    colors: config.colors ?? detectColorSupport(),
    redact: {
      ...DEFAULT_BROWSER_CONFIG.redact,
      ...userRedact,
      selectors: [...(userRedact.selectors ?? DEFAULT_BROWSER_CONFIG.redact.selectors)],
      keys: [...(userRedact.keys ?? DEFAULT_BROWSER_CONFIG.redact.keys)],
      headers: [...headers],
      values: normalizeSecretValues([...(userRedact.values ?? []), ...auto]),
    },
  };
  return resolved;
}

// ---------------------------------------------------------------------------
// Events. Everything stored here is already redacted.
// ---------------------------------------------------------------------------

export type ActionCategory = 'action' | 'wait' | 'query' | 'navigation';
export type ActionTarget =
  | 'page' | 'frame' | 'locator' | 'elementHandle' | 'keyboard' | 'mouse' | 'touchscreen'
  | 'clock' | 'context' | 'browser' | 'dialog' | 'download';

interface BaseEvent {
  /** Schema version of the JSONL format. */
  v: 1;
  /** Monotonic sequence number within the session. */
  seq: number;
  /** Milliseconds since the session started (monotonic clock). */
  t: number;
  /** Wall-clock ISO timestamp. */
  ts: string;
  /** Page id (page#N). Only set when the session has more than one page. */
  page?: number;
  /**
   * Enclosing test.step titles, outermost first. For `step` events this is the
   * path of the *parent* steps (it excludes the step itself).
   */
  step?: string[];
}

export type BrowserLogEvent = BaseEvent & (
  | {
    kind: 'action';
    category: ActionCategory;
    target: ActionTarget;
    subject?: string;
    method: string;
    args: string;
    redacted?: boolean;
    status: 'ok' | 'error' | 'pending';
    durationMs?: number;
    slow?: boolean;
    error?: { name: string; message: string };
    location?: { file: string; line: number; column: number };
  }
  | { kind: 'navigation'; url: string }
  | { kind: 'page'; event: 'opened' | 'popup' | 'closed' | 'crashed'; url?: string; opener?: number }
  | { kind: 'console'; level: string; text: string; location?: string }
  | { kind: 'pageerror'; message: string; stack?: string }
  | {
    kind: 'network';
    method: string;
    url: string;
    resourceType: string;
    status?: number;
    durationMs?: number;
    failure?: string;
  }
  | { kind: 'dialog'; dialogType: string; message: string }
  | { kind: 'download'; url: string; suggestedFilename: string }
  | {
    kind: 'step';
    phase: 'start' | 'end';
    title: string;
    status?: 'passed' | 'failed' | 'skipped';
    durationMs?: number;
  }
  | { kind: 'note'; message: string }
  | { kind: 'api'; text: string }
  | { kind: 'dropped'; count: number }
);

export type BrowserLogEventKind = BrowserLogEvent['kind'];
