import { escapeControlChars } from '../format';
import { REDACTED } from '../redact';
import { wantsCurl } from './options';
import type { CurlMode, ResolvedDisplay } from './options';
import { makeStyle } from './style';
import type { Paint, Severity, Style } from './style';
import { isErrorCall } from './types';
import type { BodyRecord, CallRecord } from './types';

/** Everything the renderer needs besides the records. */
export interface RenderOptions extends ResolvedDisplay {
  /** Which calls get a curl in their block. */
  curl: CurlMode;
  /** ANSI colours on or off; off also widens the status column to 5 (` 200 `, `[404]`). */
  colors: boolean;
  /** Terminal width in columns (120 when unknown). */
  width: number;
}

export interface Symbols {
  gutter: string;
  arrow: string;
  slow: string;
  replay: string;
  pass: string;
  fail: string;
}

const UNICODE: Symbols = { gutter: '│', arrow: '←', slow: '▲', replay: '↳', pass: '✓', fail: '✘' };
const ASCII: Symbols = { gutter: '|', arrow: '<-', slow: '^', replay: '->', pass: 'ok', fail: 'x' };

export function symbolsFor(ascii: boolean): Symbols {
  return ascii ? ASCII : UNICODE;
}

const INDENT = '    ';
const METHOD_WIDTH = 7;

/** `142ms`, `1.83s`, `1m 02s`. */
export function formatDuration(ms: number): string {
  const value = Math.max(0, ms);
  if (Math.round(value) < 1000) return `${Math.round(value)}ms`;
  if (Math.round(value / 10) < 6000) return `${(Math.round(value / 10) / 100).toFixed(2)}s`;
  const seconds = Math.round(value / 1000);
  return `${Math.floor(seconds / 60)}m ${String(seconds % 60).padStart(2, '0')}s`;
}

/** The threshold as the footer shows it: `1s`, `1.5s`, `500ms`. */
export function formatThreshold(ms: number): string {
  if (ms < 1000) return `${ms}ms`;
  return `${Number((ms / 1000).toFixed(2))}s`;
}

function severityOf(call: CallRecord): Severity | undefined {
  if (call.status === undefined || call.status >= 500) return 5;
  return call.status >= 400 ? 4 : undefined;
}

/** A call at or over the threshold. */
export function isSlow(call: CallRecord, opts: Pick<RenderOptions, 'slowThresholdMs'>): boolean {
  return call.durationMs >= opts.slowThresholdMs;
}

/** `text` with every `***` painted as a mask, the rest with `paint`. */
function paintMasks(text: string, paint: Paint, style: Style): string {
  return text.split(REDACTED).map((part) => (part ? paint(part) : '')).join(style.mask(REDACTED));
}

const ORIGIN = /^[a-z][a-z0-9+.-]*:\/\/[^/?#]*/i;

/** Scheme, host and port in the host colour, the rest in the default one. */
function paintUrl(url: string, style: Style): string {
  const origin = ORIGIN.exec(url)?.[0] ?? '';
  return paintMasks(origin, style.host, style) + paintMasks(url.slice(origin.length), style.path, style);
}

/**
 * `url` cut to at most `max` characters by replacing the middle of its query string with `…`.
 * The scheme, host and path are never touched, so a URL without a query comes back as it is.
 */
export function shortenQuery(url: string, max: number): string {
  if (url.length <= max) return url;
  const hashAt = url.indexOf('#');
  const beforeHash = hashAt === -1 ? url : url.slice(0, hashAt);
  const queryAt = beforeHash.indexOf('?');
  if (queryAt === -1) return url;
  const head = url.slice(0, queryAt);
  const query = url.slice(queryAt + 1);
  const room = max - head.length - 1; // characters left for the query after the `?`
  if (room >= query.length) return url;
  if (room < 1) return `${head}?…`;
  const keep = room - 1; // one character is the ellipsis
  const front = Math.ceil(keep / 2);
  const back = keep - front;
  return `${head}?${query.slice(0, front)}…${back > 0 ? query.slice(query.length - back) : ''}`;
}

function statusCell(call: CallRecord, opts: RenderOptions, style: Style): { text: string; width: number } {
  const label = call.status === undefined ? 'ERR' : String(call.status);
  const severity = severityOf(call);
  if (!opts.colors) {
    const text = severity ? `[${label}]` : ` ${label} `;
    return { text, width: 5 };
  }
  const paint = severity ? style.chip(severity) : style.status(call.status as number);
  return { text: paint(label), width: 3 };
}

/** The request line of one call, without a trailing newline. */
export function renderCallLine(call: CallRecord, opts: RenderOptions, style: Style = makeStyle(opts.colors, opts.theme)): string {
  const sym = symbolsFor(opts.ascii);
  const method = call.method.toUpperCase();
  const gap = method.length >= METHOD_WIDTH ? ' ' : ' '.repeat(METHOD_WIDTH - method.length);
  const cell = statusCell(call, opts, style);
  const prefixWidth = INDENT.length + METHOD_WIDTH + cell.width + 2;
  const slow = isSlow(call, opts);
  const time = `${slow ? `${sym.slow} ` : ''}${formatDuration(call.durationMs)}`;
  const column = opts.timeColumn === 'auto' ? opts.width : opts.timeColumn;

  let url = escapeControlChars(call.url);
  // Over the terminal width: shorten the query, never the host or the path.
  const room = opts.width - prefixWidth - 2 - time.length;
  if (url.length > room) url = shortenQuery(url, room);
  const pad = Math.max(2, column - prefixWidth - url.length - time.length);

  const paintTime = slow ? style.slow : style.timing;
  return INDENT +
    style.method(method)(method) + gap +
    cell.text + '  ' +
    paintUrl(url, style) +
    ' '.repeat(pad) +
    paintTime(time);
}

function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
}

/** One line of text for the body: minified JSON, or the first line of anything else; cut at `max`. */
export function bodyPreview(body: BodyRecord | undefined, max: number): string {
  if (!body) return '';
  if (body.kind === 'empty') return '<empty body>';
  if (body.kind === 'binary') return `<binary ${formatBytes(body.bytes)}${body.type ? ` ${body.type}` : ''}>`;
  const trimmed = body.text.trim();
  if (trimmed === '') return '<empty body>';
  let line: string;
  if (trimmed.startsWith('{') || trimmed.startsWith('[')) {
    try {
      line = JSON.stringify(JSON.parse(trimmed));
    } catch {
      // Cut or not JSON after all: join the lines.
      line = trimmed.split('\n').map((l) => l.trim()).join('');
    }
  } else {
    line = trimmed.split('\n')[0]?.trim() ?? '';
  }
  line = escapeControlChars(line);
  return line.length > max ? `${line.slice(0, max)}…` : line;
}

const CURL_TOKEN = /('(?:[^']|'\\'')*')|(\\$)|(--?[A-Za-z][\w-]*)|(\s+)|(\S+)/g;

/** One line of the curl command painted: quoted strings, flags and continuations get their own colours. */
function paintCurlLine(line: string, style: Style): string {
  if (line.trimStart().startsWith('#')) return style.gray(line);
  let out = '';
  let previous = '';
  let first = true;
  for (const match of line.matchAll(CURL_TOKEN)) {
    const [text, quoted, backslash, flag, space] = match;
    if (space) {
      out += text;
      continue;
    }
    if (quoted) out += paintMasks(text, style.curlString, style);
    else if (backslash || flag) out += style.gray(text);
    else if (first && text === 'curl') out += style.strong(text);
    else if (previous === '-X') out += style.method(text)(text);
    else out += text;
    previous = text;
    first = false;
  }
  return out;
}

/** Name used in the replay line. */
function replayLine(call: CallRecord, style: Style, sym: Symbols): string {
  return style.gray(`${sym.replay} replay: `) + style.strong(call.curlFile as string) + style.gray(' attached to the HTML report');
}

/** The `│` block that explains a failed call, one string per line. */
export function renderDetail(call: CallRecord, opts: RenderOptions, style: Style = makeStyle(opts.colors, opts.theme)): string[] {
  const severity = severityOf(call);
  if (!severity) return [];
  const sym = symbolsFor(opts.ascii);
  const bar = style.gutter(severity)(sym.gutter);
  const lead = `${INDENT}${bar} `;
  const lines: string[] = [];

  const headline = call.error ?
    style.severityText(severity)(escapeControlChars(call.error.code)) :
    style.severityText(severity)(escapeControlChars(`${call.status} ${call.statusText ?? ''}`.trim()));
  const detail = call.error ?
    paintMasks(escapeControlChars(call.error.message), style.body, style) :
    paintMasks(bodyPreview(call.responseBody, opts.bodyPreviewChars), style.body, style);
  lines.push(`${lead}${style.gray(sym.arrow)} ${headline}${detail ? `  ${detail}` : ''}`);

  if (call.curl && wantsCurl(opts.curl, call.status)) {
    lines.push(`${INDENT}${bar}`);
    for (const row of call.curl.split('\n')) lines.push(`${lead}${paintCurlLine(row, style)}`);
    if (call.curlFile) {
      lines.push(`${INDENT}${bar}`);
      lines.push(`${lead}${replayLine(call, style, sym)}`);
    }
  }
  return lines;
}

/** Whether the detail block of `call` is printed. */
export function showsDetail(call: CallRecord, opts: Pick<RenderOptions, 'details'>, testFailed: boolean): boolean {
  if (!isErrorCall(call) || opts.details === 'never') return false;
  return opts.details === 'always' || testFailed;
}

/**
 * The request lines of one test, each followed by its detail block where one is due.
 * `testFailed` drives `details: 'failed-tests'`.
 */
export function renderCalls(calls: readonly CallRecord[], opts: RenderOptions, testFailed: boolean): string[] {
  const style = makeStyle(opts.colors, opts.theme);
  const out: string[] = [];
  for (const call of calls) {
    out.push(renderCallLine(call, opts, style));
    if (showsDetail(call, opts, testFailed)) out.push(...renderDetail(call, opts, style));
  }
  return out;
}

export interface CallStats {
  requests: number;
  errors: number;
  slow: number;
}

export function summarize(calls: readonly CallRecord[], opts: Pick<RenderOptions, 'slowThresholdMs'>): CallStats {
  return {
    requests: calls.length,
    errors: calls.filter(isErrorCall).length,
    slow: calls.filter((c) => isSlow(c, opts)).length,
  };
}

/** `8 requests · 2 errors · 1 slow ≥1s`, segments with a zero count left out; undefined without requests. */
export function renderFooter(stats: CallStats, opts: RenderOptions): string | undefined {
  if (stats.requests === 0) return undefined;
  const style = makeStyle(opts.colors, opts.theme);
  const plural = (n: number, word: string): string => `${n} ${word}${n === 1 ? '' : 's'}`;
  const parts = [style.gray(plural(stats.requests, 'request'))];
  if (stats.errors > 0) parts.push(style.errors(plural(stats.errors, 'error')));
  if (stats.slow > 0) parts.push(style.slow(`${stats.slow} slow ≥${formatThreshold(opts.slowThresholdMs)}`));
  return `  ${parts.join(style.gray(' · '))}`;
}
