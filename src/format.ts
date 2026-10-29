import { createColors } from 'picocolors';
import type { ResolvedConfig } from './types';
import { redactUrl } from './redact';

type Colorizer = (s: string) => string;

interface Palette {
  method: (method: string) => Colorizer;
  status: (status: number) => Colorizer;
  dim: Colorizer;
  bold: Colorizer;
  arrowOut: Colorizer;
  arrowIn: Colorizer;
}

const identity: Colorizer = (s) => s;

// Always-on colorizers: once `colors` has been resolved to true it must win
// over picocolors' own env detection (NO_COLOR, non-TTY, ...).
const pc = createColors(true);

function palette(colors: boolean): Palette {
  if (!colors) {
    return {
      method: () => identity,
      status: () => identity,
      dim: identity,
      bold: identity,
      arrowOut: identity,
      arrowIn: identity,
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
  };
}

export function redactHeaders(
    headers: Record<string, string>,
    redactList: string[],
): Record<string, string> {
  const lowered = redactList.map((h) => h.toLowerCase());
  const out: Record<string, string> = {};
  for (const [key, value] of Object.entries(headers)) {
    out[key] = lowered.includes(key.toLowerCase()) ? '***' : value;
  }
  return out;
}

export function truncateBody(body: string, maxLength: number): string {
  if (body.length <= maxLength) return body;
  const extra = body.length - maxLength;
  return `${body.slice(0, maxLength)}... (${extra} more chars)`;
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
      .map(([k, v]) => {
        const value = URL_HEADERS.includes(k.toLowerCase()) ?
          redactUrl(v, config.redactQueryParams) :
          v;
        return `  ${p.dim(`${k}:`)} ${value}`;
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
