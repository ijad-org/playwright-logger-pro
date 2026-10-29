import type { RedirectHop, RequestInfo } from './types';
import { redactHeaders, splitChars } from './format';
import { multipartParts } from './multipart';
import { REDACTED, redactBodyString, redactBodyValue, redactUrl } from './redact';
import { redirectRulesFor } from './playwrightVersion';

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

function isValidUrl(url: string): boolean {
  try {
    new URL(url);
    return true;
  } catch {
    return false;
  }
}

/** Header names Playwright drops when a redirect turns the request into a GET. */
const BODY_HEADERS = [
  'content-encoding', 'content-language', 'content-length', 'content-location', 'content-type',
];

/**
 * `headers` without `names` (lower-case). With `exactCase` only a header
 * spelled exactly like the name is removed, as older Playwrights do.
 */
function withoutHeaders(
    headers: Record<string, string> | undefined,
    names: readonly string[],
    exactCase = false,
): Record<string, string> {
  return Object.fromEntries(
      Object.entries(headers ?? {})
          .filter(([k]) => !names.includes(exactCase ? k : k.toLowerCase())),
  );
}

function originOf(url: string): string | undefined {
  try {
    return new URL(url).origin;
  } catch {
    return undefined;
  }
}

/**
 * One curl per request Playwright sent while following redirects. A single
 * `curl -L` cannot reproduce Playwright's redirect rules (a 303 turns any
 * method into a GET, a 301/302 turns a POST into a GET, while PUT/PATCH/DELETE
 * keep method and body on 301/302/307/308), so each step is spelled out. The
 * method of each step is the one Playwright actually used; each step starts
 * from the request of the step before it, so a body dropped by one redirect
 * does not come back on a later 307/308. Which headers a redirect forwards
 * depends on the Playwright version (see `redirectRulesFor`).
 */
function buildRedirectSteps(
    info: RequestInfo,
    hops: readonly RedirectHop[],
    redact: readonly string[],
    options: CurlOptions,
): string {
  const out = [
    `# the request was redirected ${hops.length - 1} time(s). Playwright's redirect rules ` +
    'cannot be replayed by a single curl, so there is one command per step',
    '# (cookies for the later steps come from the cookie jar and are not included)',
  ];
  const rules = redirectRulesFor(info.playwrightVersion);
  let headers = info.headers;
  let body = { data: info.data, form: info.form, multipart: info.multipart };
  let previous = { method: info.method.toUpperCase(), url: info.url };
  hops.forEach((hop, index) => {
    const method = index === 0 ? previous.method : hop.method.toUpperCase();
    const url = index === 0 ? info.url : hop.url;
    if (index > 0) {
      // The cookie jar's cookie is a lower-case `cookie` header inside Playwright.
      if (info.cookieFromJar) headers = withoutHeaders(headers, ['Cookie'], true);
      headers = withoutHeaders(headers, ['cookie'], rules.exactCaseRemoval);
      if (method !== previous.method) {
        headers = withoutHeaders(headers, BODY_HEADERS, rules.exactCaseRemoval);
        body = { data: undefined, form: undefined, multipart: undefined };
      }
      if (rules.dropAuthorizationCrossOrigin && originOf(url) !== originOf(previous.url)) {
        headers = withoutHeaders(headers, ['authorization']);
      }
    }
    const status = hop.status === undefined ? '' : ` (response: ${hop.status})`;
    out.push(`# step ${index + 1} of ${hops.length}${status}`);
    out.push(buildCurl({
      method, url, headers, ...body, followRedirects: false,
    }, redact, options));
    previous = { method, url };
  });
  return out.join('\n');
}

/**
 * Build a copy-pastable curl command equivalent to the given request.
 * Headers in `redact` (and query parameters / body keys per `options`) are
 * masked with *** so secrets never land in logs. This is the low-level
 * builder: the lists are used exactly as given (the defaults are merged in
 * by resolveConfig(), not here).
 *
 * A request that followed redirects is replayed with `-L` when curl follows
 * them like Playwright does (GET/HEAD, or a POST with a body). Otherwise, when
 * `info.redirects` lists the hops Playwright took, one command per hop is
 * returned; without it no `-L` is added and a comment says so.
 */
export function buildCurl(
    info: RequestInfo,
    redact: readonly string[] = [],
    options: CurlOptions = {},
): string {
  if (!isValidUrl(info.url)) return '# could not build curl: invalid URL';
  const { redactQueryParams = [], redactBodyKeys = [], maxBodyLength } = options;
  const method = info.method.toUpperCase();
  const parts = multipartParts(info.multipart, redactBodyKeys);
  const hasBody = (parts !== undefined && parts.length > 0) ||
    (info.form !== undefined && Object.keys(info.form).length > 0) ||
    (info.data !== undefined && info.data !== null);
  const plainRead = (method === 'GET' || method === 'HEAD') && !hasBody;
  if (info.followRedirects && info.redirects && info.redirects.length > 1 && !plainRead) {
    return buildRedirectSteps(info, info.redirects, redact, options);
  }
  // Without the hops, `-L` is only right where curl follows redirects the way
  // Playwright does: a bodiless GET/HEAD, or a POST with a body (-d implies
  // POST, which curl turns into a GET on 301/302/303 and keeps on 307/308).
  const follow = Boolean(info.followRedirects) && (plainRead || (method === 'POST' && hasBody));
  // When following redirects, let a body imply POST instead of forcing it
  // with -X: curl then switches to GET on 301/302/303 like Playwright does,
  // rather than re-POSTing the body to the redirect target.
  // A body alone would make curl send POST, so GET with a body needs -X GET.
  const impliedMethod = (method === 'GET' && !hasBody) ||
    (follow && method === 'POST' && hasBody);
  const methodFlag = method === 'HEAD' ?
    // -X HEAD makes curl wait for a response body that never comes.
    '--head' :
    (impliedMethod ? undefined : `-X ${method}`);
  const head = [
    'curl',
    ...(methodFlag ? [methodFlag] : []),
    ...(follow ? ['-L'] : []),
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

  if (info.followRedirects && !follow) {
    notes.push(`# the request was redirected; ${method} is not followed with -L because curl would ` +
      "not apply Playwright's redirect rules. Send the redirect target yourself");
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
