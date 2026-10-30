import { createColors } from 'picocolors';
import type { ResolvedConfig } from './types';
import { redactUrl } from './redact';

export type Colorizer = (s: string) => string;

export interface Palette {
  method: (method: string) => Colorizer;
  status: (status: number) => Colorizer;
  dim: Colorizer;
  bold: Colorizer;
  arrowOut: Colorizer;
  arrowIn: Colorizer;
  /** The `curl` word of a curl command. */
  curl: Colorizer;
  /** URL of a curl command. */
  url: Colorizer;
  /** Query parameter name and JSON key. */
  name: Colorizer;
  /** Header name. */
  header: Colorizer;
  /** JSON string. */
  string: Colorizer;
  /** A masked value (`***`). */
  warn: Colorizer;
}

const identity: Colorizer = (s) => s;

// Always-on colorizers: once `colors` has been resolved to true it must win
// over picocolors' own env detection (NO_COLOR, non-TTY, ...).
const pc = createColors(true);

export function palette(colors: boolean): Palette {
  if (!colors) {
    return {
      method: () => identity,
      status: () => identity,
      dim: identity,
      bold: identity,
      arrowOut: identity,
      arrowIn: identity,
      curl: identity,
      url: identity,
      name: identity,
      header: identity,
      string: identity,
      warn: identity,
    };
  }
  return {
    method: (method: string) => {
      switch (method.toUpperCase()) {
        case 'GET': return pc.cyan;
        case 'POST': return pc.green;
        case 'PUT': return pc.yellow;
        case 'PATCH': return pc.magenta;
        case 'DELETE': return pc.red;
        default: return pc.white;
      }
    },
    status: (status: number) => {
      if (status >= 500) return pc.red;
      if (status >= 400) return pc.yellow;
      if (status >= 300) return pc.cyan;
      return pc.green;
    },
    dim: pc.dim,
    bold: pc.bold,
    arrowOut: pc.blue,
    arrowIn: pc.blue,
    curl: pc.bold,
    url: pc.cyan,
    name: pc.blue,
    header: pc.magenta,
    string: pc.yellow,
    warn: (s: string) => pc.bold(pc.yellow(s)),
  };
}

export function redactHeaders(
    headers: Record<string, string>,
    redactList: readonly string[],
    mask: string = '***',
): Record<string, string> {
  const lowered = redactList.map((h) => h.toLowerCase());
  const out: Record<string, string> = {};
  for (const [key, value] of Object.entries(headers)) {
    out[key] = lowered.includes(key.toLowerCase()) ? mask : value;
  }
  return out;
}

/**
 * Split `text` after `max` characters, counting code points so a surrogate
 * pair (emoji, ...) is never cut in half. `rest` is the number of
 * characters dropped, or 0 when nothing was cut.
 */
export function splitChars(text: string, max: number): { head: string; rest: number } {
  // A string never has more code points than UTF-16 units.
  if (text.length <= max) return { head: text, rest: 0 };
  let count = 0;
  let cut = text.length;
  for (let i = 0; i < text.length; i++) {
    if (count === max) cut = i;
    const code = text.charCodeAt(i);
    if (code >= 0xd800 && code <= 0xdbff && i + 1 < text.length) {
      const next = text.charCodeAt(i + 1);
      if (next >= 0xdc00 && next <= 0xdfff) i++;
    }
    count++;
  }
  if (count <= max) return { head: text, rest: 0 };
  return { head: text.slice(0, cut), rest: count - max };
}

export function truncateBody(body: string, maxLength: number): string {
  const { head, rest } = splitChars(body, maxLength);
  return rest === 0 ? body : `${head}... (${rest} more chars)`;
}

/**
 * Escape control characters (ESC, BEL, CR, ...) so a body cannot inject
 * terminal escape sequences into the log. Newlines and tabs are kept.
 */
export function escapeControlChars(text: string): string {
  return text
      .replace(/\r\n/g, '\n')
      // eslint-disable-next-line no-control-regex
      .replace(/[\u0000-\u0008\u000b-\u001f\u007f-\u009f]/g,
          (c) => `\\x${c.charCodeAt(0).toString(16).padStart(2, '0')}`);
}

const TEXT_CONTENT_TYPE =
  /^text\/|[/+](json|xml|javascript|ecmascript|x-www-form-urlencoded|graphql|yaml|x-yaml|csv)\b/i;

/**
 * Text to log for a response body: the decoded text for textual content
 * types, a `<binary N bytes (type)>` placeholder otherwise. Without a
 * content type, bytes that are not valid UTF-8 or contain NUL count as binary.
 */
export function describeResponseBody(body: Buffer, contentType?: string): string {
  if (body.length === 0) return '';
  const type = contentType?.split(';')[0].trim();
  const placeholder = `<binary ${body.length} bytes${type ? ` (${type})` : ''}>`;
  if (type) return TEXT_CONTENT_TYPE.test(type) ? body.toString('utf8') : placeholder;
  try {
    const text = new TextDecoder('utf-8', { fatal: true }).decode(body);
    return text.includes('\u0000') ? placeholder : text;
  } catch {
    return placeholder;
  }
}

export function stringifyBody(data: unknown): string | undefined {
  if (data === undefined || data === null) return undefined;
  if (typeof data === 'string') return data;
  if (Buffer.isBuffer(data)) return `<Buffer ${data.length} bytes>`;
  try {
    return JSON.stringify(data, null, 2);
  } catch {
    return String(data);
  }
}

export function formatRequestLine(
    method: string,
    url: string,
    config: ResolvedConfig,
): string {
  const p = palette(config.colors);
  const m = method.toUpperCase();
  return `${p.arrowOut('→')} ${p.bold(p.method(m)(m))} ${url}`;
}

export function formatResponseLine(
    method: string,
    url: string,
    status: number,
    statusText: string,
    durationMs: number,
    config: ResolvedConfig,
    redirectedTo?: string,
): string {
  const p = palette(config.colors);
  const m = method.toUpperCase();
  const statusStr = p.bold(p.status(status)(`${status} ${statusText}`.trim()));
  const line = `${p.arrowIn('←')} ${p.method(m)(m)} ${url} ${statusStr} ${p.dim(`(${durationMs}ms)`)}`;
  return redirectedTo ? `${line} ${p.dim(`(redirected to ${redirectedTo})`)}` : line;
}

export function formatErrorLine(
    method: string,
    url: string,
    error: unknown,
    durationMs: number,
    config: ResolvedConfig,
): string {
  const p = palette(config.colors);
  const m = method.toUpperCase();
  const message = escapeControlChars(
      (error instanceof Error ? error.message : String(error)).split('\n')[0],
  );
  return `${p.status(500)('✖')} ${p.method(m)(m)} ${url} ${p.bold(p.status(500)('failed'))} ` +
    `${p.dim(`(${durationMs}ms)`)} ${message}`;
}

const URL_HEADERS = ['location', 'content-location'];

export function formatHeaders(
    headers: Record<string, string>,
    config: ResolvedConfig,
): string {
  const p = palette(config.colors);
  const safe = redactHeaders(headers, config.redactHeaders);
  return Object.entries(safe)
      .flatMap(([k, v]) => {
        const isUrl = URL_HEADERS.includes(k.toLowerCase());
        // Playwright joins repeated headers (Set-Cookie, ...) with newlines:
        // print one indented `name: value` line per value.
        return String(v).split('\n').map((value) =>
          `  ${p.dim(`${k}:`)} ${isUrl ? redactUrl(value, config.redactQueryParams) : value}`);
      })
      .join('\n');
}

export function formatBody(data: unknown, config: ResolvedConfig): string | undefined {
  const body = stringifyBody(data);
  if (body === undefined || body.length === 0) return undefined;
  return truncateBody(escapeControlChars(body), config.maxBodyLength)
      .split('\n')
      .map((line) => `  ${line}`)
      .join('\n');
}
