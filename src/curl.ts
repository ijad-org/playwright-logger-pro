import type { RequestInfo } from './types';
import { redactHeaders } from './format';

function shellQuote(value: string): string {
  // Single-quote for POSIX shells, escaping embedded single quotes.
  return `'${value.replace(/'/g, `'\\''`)}'`;
}

/**
 * Build a copy-pastable curl command equivalent to the given request.
 * Headers in `redact` are masked with *** so secrets never land in logs.
 */
export function buildCurl(info: RequestInfo, redact: string[] = []): string {
  const method = info.method.toUpperCase();
  const head = method === 'GET' ?
    `curl ${shellQuote(info.url)}` :
    `curl -X ${method} ${shellQuote(info.url)}`;
  const parts: string[] = [head];

  const headers = redactHeaders(info.headers ?? {}, redact);
  for (const [key, value] of Object.entries(headers)) {
    parts.push(`-H ${shellQuote(`${key}: ${value}`)}`);
  }

  if (info.form && Object.keys(info.form).length > 0) {
    for (const [key, value] of Object.entries(info.form)) {
      parts.push(`--data-urlencode ${shellQuote(`${key}=${value}`)}`);
    }
  } else if (info.data !== undefined && info.data !== null) {
    const hasContentType = Object.keys(headers)
        .some((h) => h.toLowerCase() === 'content-type');
    if (typeof info.data === 'object' && !Buffer.isBuffer(info.data) && !hasContentType) {
      parts.push(`-H ${shellQuote('Content-Type: application/json')}`);
    }
    const body = Buffer.isBuffer(info.data) ?
      '<binary body omitted>' :
      (typeof info.data === 'string' ? info.data : JSON.stringify(info.data));
    parts.push(`--data-raw ${shellQuote(body)}`);
  }

  return parts.join(' \\\n  ');
}
