import type { RequestInfo } from './types';
import { redactHeaders, splitChars } from './format';
import { multipartParts } from './multipart';
import { REDACTED, redactBodyString, redactBodyValue, redactUrl } from './redact';

export interface CurlOptions {
  /** Query parameter names whose values are masked in the URL. */
  redactQueryParams?: readonly string[];
  /** JSON/form body keys and multipart field names whose values are masked. */
  redactBodyKeys?: readonly string[];
  /** Truncate the request body (and each form/field value) beyond this many characters. */
  maxBodyLength?: number;
}

/** File a binary request body is read from when the curl is replayed. */
const BINARY_BODY_FILE = 'request-body.bin';

function shellQuote(value: string): string {
  // Single-quote for POSIX shells, escaping embedded single quotes.
  return `'${value.replace(/'/g, `'\\''`)}'`;
}

/** Value for a curl -F `@file` / `type=` attribute, double-quoted if needed. */
function formValue(value: string): string {
  return /[;,"\\\s]/.test(value) ? `"${value.replace(/[\\"]/g, '\\$&')}"` : value;
}

/**
 * Build a copy-pastable curl command equivalent to the given request.
 * Headers in `redact` (and query parameters / body keys per `options`) are
 * masked with *** so secrets never land in logs.
 */
export function buildCurl(
    info: RequestInfo,
    redact: string[] = [],
    options: CurlOptions = {},
): string {
  const { redactQueryParams = [], redactBodyKeys = [], maxBodyLength } = options;
  const method = info.method.toUpperCase();
  const parts = multipartParts(info.multipart, redactBodyKeys);
  const hasBody = (parts !== undefined && parts.length > 0) ||
    (info.form !== undefined && Object.keys(info.form).length > 0) ||
    (info.data !== undefined && info.data !== null);
  // When following redirects, let a body imply POST instead of forcing it
  // with -X: curl then switches to GET on 301/302/303 like Playwright does,
  // rather than re-POSTing the body to the redirect target.
  // A body alone would make curl send POST, so GET with a body needs -X GET.
  const impliedMethod = (method === 'GET' && !hasBody) ||
    (info.followRedirects && method === 'POST' && hasBody);
  const methodFlag = method === 'HEAD' ?
    // -X HEAD makes curl wait for a response body that never comes.
    '--head' :
    (impliedMethod ? undefined : `-X ${method}`);
  const head = [
    'curl',
    ...(methodFlag ? [methodFlag] : []),
    ...(info.followRedirects ? ['-L'] : []),
    shellQuote(redactUrl(info.url, redactQueryParams)),
  ].join(' ');
  const lines: string[] = [head];

  const notes: string[] = [];
  const truncated: number[] = [];
  const limit = (value: string): string => {
    if (maxBodyLength === undefined) return value;
    const { head, rest } = splitChars(value, maxBodyLength);
    if (rest === 0) return value;
    truncated.push(maxBodyLength + rest);
    return head;
  };
  const redactedKeys = new Set(redactBodyKeys.map((k) => k.toLowerCase()));

  const headers = redactHeaders(info.headers ?? {}, redact);
  for (const [key, value] of Object.entries(headers)) {
    lines.push(`-H ${shellQuote(`${key}: ${value}`)}`);
  }

  // Files whose content only existed in memory are referenced by filename;
  // they must exist in the current directory for the command to replay.
  const localFiles: string[] = [];
  if (parts && parts.length > 0) {
    for (const part of parts) {
      if (part.kind === 'field') {
        // --form-string: no @file / <file / ;type= interpretation of the value.
        lines.push(`--form-string ${shellQuote(`${part.name}=${limit(part.value)}`)}`);
        continue;
      }
      const source = part.path ?? part.filename;
      if (!part.path) localFiles.push(part.filename);
      let spec = `${part.name}=@${formValue(source)}`;
      if (part.mimeType) spec += `;type=${formValue(part.mimeType)}`;
      lines.push(`-F ${shellQuote(spec)}`);
    }
  } else if (info.form && Object.keys(info.form).length > 0) {
    for (const [key, value] of Object.entries(info.form)) {
      const safe = redactedKeys.has(key.toLowerCase()) ? REDACTED : limit(String(value));
      lines.push(`--data-urlencode ${shellQuote(`${key}=${safe}`)}`);
    }
  } else if (info.data !== undefined && info.data !== null) {
    const contentType = Object.entries(headers)
        .find(([h]) => h.toLowerCase() === 'content-type')?.[1];
    if (typeof info.data === 'object' && !Buffer.isBuffer(info.data) && contentType === undefined) {
      lines.push(`-H ${shellQuote('Content-Type: application/json')}`);
    }
    if (Buffer.isBuffer(info.data)) {
      // The bytes cannot be pasted into a shell; read them from a file
      // instead of sending a placeholder as the body.
      if (contentType === undefined) {
        lines.push(`-H ${shellQuote('Content-Type: application/octet-stream')}`);
      }
      lines.push(`--data-binary ${shellQuote(`@${BINARY_BODY_FILE}`)}`);
      notes.push(`# binary request body (${info.data.length} bytes) is not included; ` +
        `save it as ${BINARY_BODY_FILE} before replaying`);
    } else {
      const body = typeof info.data === 'string' ?
        redactBodyString(info.data, redactBodyKeys, contentType) :
        JSON.stringify(redactBodyValue(info.data, redactBodyKeys));
      lines.push(`--data-raw ${shellQuote(limit(body))}`);
    }
  }

  if (localFiles.length > 0) {
    notes.push(`# multipart file content is read from local file(s): ${localFiles.join(', ')}`);
  }
  if (truncated.length > 0) {
    notes.push(`# request body truncated to maxBodyLength (${maxBodyLength} of ` +
      `${Math.max(...truncated)} chars); the replayed body is incomplete`);
  }
  return [...notes, lines.join(' \\\n  ')].join('\n');
}
