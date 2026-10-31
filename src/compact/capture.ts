import { decodeBody, escapeControlChars, redactHeaders } from '../format';
import { redactBodyString, redactUrl, redactUrlsInText } from '../redact';
import type { ResolvedConfig } from '../types';
import { curlModeOf } from './options';
import type { RenderOptions } from './render';
import type { BodyRecord } from './types';

/** Stored response text is cut here; previews are far shorter. */
const MAX_STORED_TEXT = 16 * 1024;

/** The display options of a resolved config, for the pure renderer. */
export function renderOptionsOf(cfg: ResolvedConfig, colors: boolean, width: number): RenderOptions {
  return {
    slowThresholdMs: cfg.slowThresholdMs,
    timeColumn: cfg.timeColumn,
    details: cfg.details,
    bodyPreviewChars: cfg.bodyPreviewChars,
    theme: cfg.theme,
    ascii: cfg.ascii,
    curl: curlModeOf(cfg.curl) ?? 'never',
    colors,
    width,
  };
}

/** The display options that travel with the JSON attachment. */
export function displayOptionsOf(cfg: ResolvedConfig): Record<string, unknown> {
  return {
    slowThresholdMs: cfg.slowThresholdMs,
    timeColumn: cfg.timeColumn,
    details: cfg.details,
    bodyPreviewChars: cfg.bodyPreviewChars,
    theme: cfg.theme,
    ascii: cfg.ascii,
    curl: curlModeOf(cfg.curl) ?? 'never',
  };
}

/** A failure without a response, as a short code and message (URLs masked, one line). */
export function describeError(error: unknown, redactQueryParams: readonly string[]): { code: string; message: string } {
  const raw = error instanceof Error ? error.message : String(error);
  const first = raw.split('\n')[0] ?? '';
  // Playwright prefixes its messages with the API call: "apiRequestContext.get: ..."
  const message = first.replace(/^[A-Za-z]+\.[A-Za-z]+: /, '');
  const own = (error as { code?: unknown } | null)?.code;
  let code = typeof own === 'string' && own !== '' ? own : /\b(E[A-Z]{3,}[A-Z0-9_]*|ERR_[A-Z0-9_]+)\b/.exec(message)?.[1];
  if (!code) {
    if (/timeout/i.test(message)) code = 'TIMEOUT';
    else if (/abort|disposed|closed/i.test(message)) code = 'ABORTED';
    else code = 'ERROR';
  }
  return { code, message: escapeControlChars(redactUrlsInText(message, redactQueryParams)) };
}

/** The response body as the record stores it: masked text, a binary summary or nothing. */
export function captureBody(
    body: Buffer,
    contentType: string | undefined,
    redactBodyKeys: readonly string[],
): BodyRecord {
  if (body.length === 0) return { kind: 'empty' };
  const text = decodeBody(body, contentType);
  if (text === undefined) return { kind: 'binary', bytes: body.length, type: contentType?.split(';')[0]?.trim() || undefined };
  const masked = redactBodyString(text, redactBodyKeys, contentType);
  return masked.length > MAX_STORED_TEXT ?
    { kind: 'text', text: masked.slice(0, MAX_STORED_TEXT), truncated: true } :
    { kind: 'text', text: masked };
}

const URL_HEADERS = ['location', 'content-location'];

/** Headers with the secret ones masked; redirect targets lose their secret query values too. */
export function maskHeaders(
    headers: Record<string, string>,
    cfg: Pick<ResolvedConfig, 'redactHeaders' | 'redactQueryParams'>,
): Record<string, string> {
  const safe = redactHeaders(headers, cfg.redactHeaders);
  for (const [key, value] of Object.entries(safe)) {
    if (URL_HEADERS.includes(key.toLowerCase())) safe[key] = redactUrl(String(value), cfg.redactQueryParams);
  }
  return safe;
}
