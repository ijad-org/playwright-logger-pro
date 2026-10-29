import type { RequestInfo } from './types';
import { redactHeaders } from './format';
import { multipartParts } from './multipart';

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
 * Headers in `redact` are masked with *** so secrets never land in logs.
 */
export function buildCurl(info: RequestInfo, redact: string[] = []): string {
  const method = info.method.toUpperCase();
  const parts = multipartParts(info.multipart);
  const hasBody = (parts !== undefined && parts.length > 0) ||
    (info.form !== undefined && Object.keys(info.form).length > 0) ||
    (info.data !== undefined && info.data !== null);
  // When following redirects, let a body imply POST instead of forcing it
  // with -X: curl then switches to GET on 301/302/303 like Playwright does,
  // rather than re-POSTing the body to the redirect target.
  const impliedMethod = method === 'GET' || (info.followRedirects && method === 'POST' && hasBody);
  const head = [
    'curl',
    ...(impliedMethod ? [] : [`-X ${method}`]),
    ...(info.followRedirects ? ['-L'] : []),
    shellQuote(info.url),
  ].join(' ');
  const lines: string[] = [head];

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
        lines.push(`--form-string ${shellQuote(`${part.name}=${part.value}`)}`);
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
      lines.push(`--data-urlencode ${shellQuote(`${key}=${value}`)}`);
    }
  } else if (info.data !== undefined && info.data !== null) {
    const hasContentType = Object.keys(headers)
        .some((h) => h.toLowerCase() === 'content-type');
    if (typeof info.data === 'object' && !Buffer.isBuffer(info.data) && !hasContentType) {
      lines.push(`-H ${shellQuote('Content-Type: application/json')}`);
    }
    const body = Buffer.isBuffer(info.data) ?
      '<binary body omitted>' :
      (typeof info.data === 'string' ? info.data : JSON.stringify(info.data));
    lines.push(`--data-raw ${shellQuote(body)}`);
  }

  const command = lines.join(' \\\n  ');
  if (localFiles.length === 0) return command;
  return `# multipart file content is read from local file(s): ${localFiles.join(', ')}\n${command}`;
}
