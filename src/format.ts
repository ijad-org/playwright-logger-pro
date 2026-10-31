import { createColors } from 'picocolors';
import type { ResolvedConfig } from './types';
import { maskFor, redactUrl } from './redact';
import type { Mask } from './redact';
import { curlColorizer } from './curlPalette';
import type { CurlColorDepth } from './curlPalette';
import { curlColorDepth } from './env';

export type Colorizer = (s: string) => string;

export interface Palette {
  method: (method: string) => Colorizer;
  status: (status: number) => Colorizer;
  dim: Colorizer;
  bold: Colorizer;
  arrowOut: Colorizer;
  arrowIn: Colorizer;
  // The curl command uses the colours below (see curlPalette.ts). They are chosen to read on
  // the default black and white xterm backgrounds: no white, yellow or cyan text, and no dim,
  // which vanishes on some terminals. Flags, quotes and punctuation stay uncoloured.
  /** The `curl` word. */
  curl: Colorizer;
  /** HTTP method after `-X`. */
  curlMethod: (method: string) => Colorizer;
  /** URL. */
  url: Colorizer;
  /** Query parameter name and header name. */
  name: Colorizer;
  /** JSON key. */
  key: Colorizer;
  /** JSON string. */
  string: Colorizer;
  /** A masked value (`***`): bold and reversed, so it stands out on any background. */
  mask: Colorizer;
  /** `#` notes. */
  comment: Colorizer;
}

const identity: Colorizer = (s) => s;

// Always-on colorizers: once `colors` has been resolved to true it must win
// over picocolors' own env detection (NO_COLOR, non-TTY, ...).
const pc = createColors(true);

/**
 * The colours for the log lines and the curl command. The curl colours depend on how many colours
 * the terminal shows (`depth`, detected when omitted); the log lines use the 16 basic ones.
 */
export function palette(colors: boolean, depth?: CurlColorDepth): Palette {
  if (!colors) {
    return {
      method: () => identity,
      status: () => identity,
      dim: identity,
      bold: identity,
      arrowOut: identity,
      arrowIn: identity,
      curl: identity,
      curlMethod: () => identity,
      url: identity,
      name: identity,
      key: identity,
      string: identity,
      mask: identity,
      comment: identity,
    };
  }
  const d = depth ?? curlColorDepth();
  const curl = (element: Parameters<typeof curlColorizer>[0]): Colorizer => curlColorizer(element, d);
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
    curlMethod: (method: string) => {
      switch (method.toUpperCase()) {
        case 'GET': return curl('methodGet');
        case 'POST': return curl('methodPost');
        case 'PUT':
        case 'PATCH': return curl('methodWrite');
        case 'DELETE': return curl('methodDelete');
        default: return pc.bold;
      }
    },
    url: curl('url'),
    name: curl('name'),
    key: curl('key'),
    string: curl('string'),
    mask: (s: string) => pc.bold(pc.inverse(s)),
    comment: curl('comment'),
  };
}

export function redactHeaders(
    headers: Record<string, string>,
    redactList: readonly string[],
    mask: Mask = '***',
): Record<string, string> {
  const lowered = redactList.map((h) => h.toLowerCase());
  const out: Record<string, string> = {};
  for (const [key, value] of Object.entries(headers)) {
    out[key] = lowered.includes(key.toLowerCase()) ? maskFor(mask, key) : value;
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
 * The decoded text of a response body, or undefined when it is binary: a non-textual content
 * type, or without a content type bytes that are not valid UTF-8 or contain NUL.
 */
export function decodeBody(body: Buffer, contentType?: string): string | undefined {
  const type = contentType?.split(';')[0].trim();
  if (type) return TEXT_CONTENT_TYPE.test(type) ? body.toString('utf8') : undefined;
  try {
    const text = new TextDecoder('utf-8', { fatal: true }).decode(body);
    return text.includes('\u0000') ? undefined : text;
  } catch {
    return undefined;
  }
}

/**
 * Text to log for a response body: the decoded text for textual content
 * types, a `<binary N bytes (type)>` placeholder otherwise. Without a
 * content type, bytes that are not valid UTF-8 or contain NUL count as binary.
 */
export function describeResponseBody(body: Buffer, contentType?: string): string {
  if (body.length === 0) return '';
  const type = contentType?.split(';')[0].trim();
  return decodeBody(body, contentType) ?? `<binary ${body.length} bytes${type ? ` (${type})` : ''}>`;
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
