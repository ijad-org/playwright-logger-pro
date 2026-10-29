import { describeValue, warnOnce } from '../warn';
import type { BrowserLoggerConfig, BrowserRedactConfig } from './types';

/**
 * Validation of the `browserLog` option, like apiLog's: nothing here throws.
 * An unknown key or an invalid value gets one console warning and the option
 * falls back to its default, so a typo cannot fail a run - or, worse, quietly
 * switch the failure block off.
 */

const TOP_KEYS = new Set([
  'enabled', 'colors', 'actions', 'waits', 'queries', 'mouseMoves', 'navigation', 'browserConsole',
  'pageErrors', 'network', 'networkFilter', 'steps', 'includeApiLog', 'logStart', 'slowActionMs',
  'location', 'maxArgLength', 'maxEvents', 'redact', 'print', 'attach', 'attachFormat', 'file',
  'fileFormat', 'fileDir', 'sink',
]);

const REDACT_KEYS = new Set(['mask', 'fillValues', 'selectors', 'values', 'keys', 'headers', 'inspectInputType']);

interface Rule {
  expected: string;
  fallback: string;
  ok(value: unknown): boolean;
}

const oneOf = (...allowed: unknown[]) => (value: unknown): boolean => allowed.includes(value);
const isBool = (value: unknown): boolean => typeof value === 'boolean';
const isFn = (value: unknown): boolean => typeof value === 'function';
const isString = (value: unknown): boolean => typeof value === 'string';

const bool = (fallback: boolean): Rule => ({ expected: 'true or false', fallback: String(fallback), ok: isBool });
const when = (fallback: string): Rule => ({
  expected: "true, false or 'on-failure'", fallback, ok: oneOf(true, false, 'on-failure'),
});

const RULES: Record<string, Rule> = {
  enabled: bool(true),
  colors: { expected: 'true or false', fallback: 'auto-detection', ok: isBool },
  actions: bool(true),
  waits: bool(true),
  queries: bool(false),
  mouseMoves: bool(false),
  navigation: bool(true),
  browserConsole: {
    expected: "false, 'error', 'warning', 'info' or 'all'", fallback: "'warning'",
    ok: oneOf(false, 'error', 'warning', 'info', 'all'),
  },
  pageErrors: bool(true),
  network: {
    expected: "false, 'failed', 'documents' or 'all'", fallback: 'false',
    ok: oneOf(false, 'failed', 'documents', 'all'),
  },
  networkFilter: { expected: 'a function', fallback: 'no filter', ok: isFn },
  steps: { expected: "true, false or 'auto'", fallback: "'auto'", ok: oneOf(true, false, 'auto') },
  includeApiLog: bool(true),
  logStart: bool(false),
  slowActionMs: {
    expected: 'a number >= 0', fallback: '1000',
    ok: (v) => typeof v === 'number' && !Number.isNaN(v) && v >= 0,
  },
  location: bool(false),
  maxArgLength: {
    expected: 'a positive integer', fallback: '200',
    ok: (v) => typeof v === 'number' && ((Number.isInteger(v) && v >= 1) || v === Infinity),
  },
  maxEvents: {
    expected: 'a positive integer', fallback: '5000',
    ok: (v) => typeof v === 'number' && Number.isInteger(v) && v >= 1,
  },
  print: when("'on-failure'"),
  attach: when("'on-failure'"),
  attachFormat: { expected: "'text' or 'jsonl'", fallback: "'text'", ok: oneOf('text', 'jsonl') },
  file: when('false'),
  fileFormat: { expected: "'text' or 'jsonl'", fallback: "'text'", ok: oneOf('text', 'jsonl') },
  fileDir: { expected: 'a string', fallback: "the test's output directory", ok: isString },
  sink: { expected: 'a function', fallback: 'console.log', ok: isFn },
};

const REDACT_RULES: Record<string, Rule> = {
  mask: { expected: 'a string', fallback: "'***'", ok: isString },
  fillValues: { expected: "'auto', 'always' or 'never'", fallback: "'auto'", ok: oneOf('auto', 'always', 'never') },
  inspectInputType: bool(false),
};

const isPlainObject = (value: unknown): value is Record<string, unknown> =>
  value !== null && typeof value === 'object' && !Array.isArray(value);

function invalid(path: string, expected: string, value: unknown, fallback: string): void {
  warnOnce(`browserLog option "${path}" must be ${expected} (got ${describeValue(value)}); using ${fallback}`);
}

/** Copy `input` keeping only valid, known entries. An entry set to `undefined` means "default" and is dropped silently. */
function check(
    input: Record<string, unknown>,
    known: Set<string>,
    rules: Record<string, Rule>,
    prefix: string,
): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const key of Object.keys(input)) {
    const path = `${prefix}${key}`;
    if (!known.has(key)) {
      warnOnce(`browserLog: unknown option "${path}" ignored`);
      continue;
    }
    const value = input[key];
    const rule = rules[key];
    if (value === undefined || !rule) continue; // list / object options are checked separately
    if (rule.ok(value)) out[key] = value;
    else invalid(path, rule.expected, value, rule.fallback);
  }
  return out;
}

/** An array option; entries failing `keep` are dropped with one warning. */
function list<T>(
    path: string,
    value: unknown,
    keep: (entry: unknown) => entry is T,
    entries: string,
    fallback: string,
): T[] | undefined {
  if (!Array.isArray(value)) {
    invalid(path, `an array of ${entries}`, value, fallback);
    return undefined;
  }
  const kept = value.filter(keep);
  if (kept.length !== value.length) {
    warnOnce(`browserLog option "${path}" contains entries that are not ${entries}; they were ignored`);
  }
  return kept;
}

const isStr = (entry: unknown): entry is string => typeof entry === 'string';
const isStrOrRegExp = (entry: unknown): entry is string | RegExp => typeof entry === 'string' || entry instanceof RegExp;

/**
 * The valid part of `config`. Everything else produced one warning and is
 * absent from the result, so the defaults apply to it.
 */
export function validateBrowserConfig(config: unknown): BrowserLoggerConfig {
  if (config === undefined) return {};
  if (!isPlainObject(config)) {
    warnOnce(`the browserLog option must be an object such as { enabled: false } (got ${describeValue(config)}); using the defaults`);
    return {};
  }
  const out = check(config, TOP_KEYS, RULES, '') as BrowserLoggerConfig;

  const rawRedact = config.redact;
  if (rawRedact !== undefined) {
    if (!isPlainObject(rawRedact)) {
      invalid('redact', 'an object', rawRedact, 'the default redaction');
    } else {
      const redact = check(rawRedact, REDACT_KEYS, REDACT_RULES, 'redact.') as BrowserRedactConfig;
      for (const key of ['selectors', 'keys'] as const) {
        if (rawRedact[key] === undefined) continue;
        const kept = list(`redact.${key}`, rawRedact[key], isStrOrRegExp, 'strings or regular expressions', 'the defaults');
        if (kept) redact[key] = kept;
      }
      for (const key of ['values', 'headers'] as const) {
        if (rawRedact[key] === undefined) continue;
        const kept = list(`redact.${key}`, rawRedact[key], isStr, 'strings', key === 'values' ? 'no values' : 'the defaults');
        if (kept) redact[key] = kept;
      }
      out.redact = redact;
    }
  }
  return out;
}
