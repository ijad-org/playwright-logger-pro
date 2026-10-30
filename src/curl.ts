import type { RedirectHop, RequestInfo } from './types';
import { palette, redactHeaders, splitChars } from './format';
import type { Colorizer, Palette } from './format';
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
  /**
   * Colour the command with ANSI codes (default false). Stripping the codes
   * gives exactly the uncoloured command, which stays safe to paste.
   */
  colors?: boolean;
  /**
   * One option per line, joined with ` \` continuations (default true). With
   * false the command is a single line; notes stay on their own `#` lines.
   */
  multiline?: boolean;
}

/** A piece of the command and how to colour it; the text is what a shell sees. */
type Paint = (p: Palette) => Colorizer;
interface Token { text: string; paint?: Paint }

const tok = (text: string, paint?: Paint): Token => ({ text, paint });
const MASK: Paint = (p) => p.mask;
const COMMENT: Paint = (p) => p.comment;
const URL_PAINT: Paint = (p) => p.url;
const NAME: Paint = (p) => p.name;
const KEY: Paint = (p) => p.key;
const STRING: Paint = (p) => p.string;
const SPACE = tok(' ');

function render(tokens: readonly Token[], p: Palette): string {
  return tokens.map((t) => (t.text && t.paint ? t.paint(p)(t.text) : t.text)).join('');
}

function joinTokens(groups: readonly Token[][], separator: readonly Token[]): Token[] {
  return groups.flatMap((group, i) => (i === 0 ? group : [...separator, ...group]));
}

/** `text` with every mask (`***`) highlighted, the rest in `paint`. */
function withMasks(text: string, paint?: Paint): Token[] {
  const out: Token[] = [];
  text.split(REDACTED).forEach((part, i) => {
    if (i > 0) out.push(tok(REDACTED, MASK));
    if (part) out.push(tok(part, paint));
  });
  return out;
}

/** File a binary request body is read from when the curl is replayed. */
const BINARY_BODY_FILE = 'request-body.bin';

/**
 * Single-quote for POSIX shells, escaping embedded single quotes. Escaping
 * is per token, so the quoted text is the same however it is split into tokens.
 */
function quoted(inner: readonly Token[]): Token[] {
  return [
    tok("'"),
    ...inner.map((t) => ({ ...t, text: t.text.replace(/'/g, `'\\''`) })),
    tok("'"),
  ];
}

/** `flag 'value'` */
function option(flag: string, value: readonly Token[]): Token[] {
  return [tok(flag), SPACE, ...quoted(value)];
}

/** `name=value` with the name and `=` coloured. */
function pair(name: string, value: string, namePaint: Paint = NAME): Token[] {
  return [tok(name, namePaint), tok('='), ...withMasks(value)];
}

/** An (already redacted) URL: query parameter names and the separators get their own colour. */
function urlTokens(url: string): Token[] {
  const hashAt = url.indexOf('#');
  const beforeHash = hashAt === -1 ? url : url.slice(0, hashAt);
  const queryAt = beforeHash.indexOf('?');
  const out = [tok(queryAt === -1 ? beforeHash : beforeHash.slice(0, queryAt), URL_PAINT)];
  if (queryAt !== -1) {
    out.push(tok('?'));
    beforeHash.slice(queryAt + 1).split('&').forEach((param, i) => {
      if (i > 0) out.push(tok('&'));
      const eq = param.indexOf('=');
      if (eq === -1) out.push(tok(param, NAME));
      else out.push(...pair(param.slice(0, eq), param.slice(eq + 1)));
    });
  }
  if (hashAt !== -1) out.push(tok(url.slice(hashAt), URL_PAINT));
  return out;
}

function isJson(text: string): boolean {
  try {
    JSON.parse(text);
    return true;
  } catch {
    return false;
  }
}

const JSON_PIECE = /"(?:[^"\\]|\\[\s\S])*"|[{}[\],:]|[^"{}[\],:]+/g;
const COLON_AHEAD = /\s*:/y;

/** A request body; valid JSON is coloured piece by piece, anything else is left as is. */
function bodyTokens(text: string, colors: boolean): Token[] {
  if (!colors || !isJson(text)) return withMasks(text);
  const out: Token[] = [];
  for (const match of text.matchAll(JSON_PIECE)) {
    const piece = match[0];
    if (piece[0] === '"') {
      COLON_AHEAD.lastIndex = match.index + piece.length;
      out.push(...withMasks(piece, COLON_AHEAD.test(text) ? KEY : STRING));
    } else if (piece.length === 1 && '{}[],:'.includes(piece)) {
      out.push(tok(piece));
    } else {
      out.push(tok(piece));
    }
  }
  return out;
}

/** Value for a curl -F `@file` / `type=` attribute, double-quoted if needed. */
function formValue(value: string): string {
  return /[;,"\\\s]/.test(value) ? `"${value.replace(/[\\"]/g, '\\$&')}"` : value;
}

function contentTypeHeader(value: string): Token[] {
  return [tok('Content-Type', NAME), tok(':'), tok(` ${value}`)];
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
  const p = palette(Boolean(options.colors));
  const comment = (text: string): string => render([tok(text, COMMENT)], p);
  const out = [
    comment(`# the request was redirected ${hops.length - 1} time(s). Playwright's redirect rules ` +
    'cannot be replayed by a single curl, so there is one command per step'),
    comment('# (cookies for the later steps come from the cookie jar and are not included)'),
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
    out.push(comment(`# step ${index + 1} of ${hops.length}${status}`));
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
  const {
    redactQueryParams = [], redactBodyKeys = [], maxBodyLength, colors = false, multiline = true,
  } = options;
  const p = palette(colors);
  if (!isValidUrl(info.url)) return render([tok('# could not build curl: invalid URL', COMMENT)], p);
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
  const methodTokens: Token[][] = method === 'HEAD' ?
    // -X HEAD makes curl wait for a response body that never comes.
    [[tok('--head')]] :
    (impliedMethod ? [] : [[tok('-X'), SPACE, tok(method, (pal) => pal.curlMethod(method))]]);
  const head: Token[][] = [
    [tok('curl', (pal) => pal.curl)],
    ...methodTokens,
    ...(follow ? [[tok('-L')]] : []),
    quoted(urlTokens(redactUrl(info.url, redactQueryParams))),
  ];
  const lines: Token[][] = [joinTokens(head, [SPACE])];

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
    lines.push(option('-H', [tok(key, NAME), tok(':'), tok(' '), ...withMasks(value)]));
  }

  // Files whose content only existed in memory are referenced by filename;
  // they must exist in the current directory for the command to replay.
  const localFiles: string[] = [];
  if (parts && parts.length > 0) {
    for (const part of parts) {
      if (part.kind === 'field') {
        // --form-string: no @file / <file / ;type= interpretation of the value.
        lines.push(option('--form-string', pair(part.name, limit(part.value))));
        continue;
      }
      const source = part.path ?? part.filename;
      if (!part.path) localFiles.push(part.filename);
      let spec = `@${formValue(source)}`;
      if (part.mimeType) spec += `;type=${formValue(part.mimeType)}`;
      lines.push(option('-F', pair(part.name, spec)));
    }
  } else if (info.form && Object.keys(info.form).length > 0) {
    for (const [key, value] of Object.entries(info.form)) {
      const safe = redactedKeys.has(key.toLowerCase()) ? REDACTED : limit(String(value));
      lines.push(option('--data-urlencode', pair(key, safe)));
    }
  } else if (info.data !== undefined && info.data !== null) {
    const contentType = Object.entries(headers)
        .find(([h]) => h.toLowerCase() === 'content-type')?.[1];
    if (typeof info.data === 'object' && !Buffer.isBuffer(info.data) && contentType === undefined) {
      lines.push(option('-H', contentTypeHeader('application/json')));
    }
    if (Buffer.isBuffer(info.data)) {
      // The bytes cannot be pasted into a shell; read them from a file
      // instead of sending a placeholder as the body.
      if (contentType === undefined) {
        lines.push(option('-H', contentTypeHeader('application/octet-stream')));
      }
      lines.push(option('--data-binary', [tok(`@${BINARY_BODY_FILE}`)]));
      notes.push(`# binary request body (${info.data.length} bytes) is not included; ` +
        `save it as ${BINARY_BODY_FILE} before replaying`);
    } else {
      const body = typeof info.data === 'string' ?
        redactBodyString(info.data, redactBodyKeys, contentType) :
        JSON.stringify(redactBodyValue(info.data, redactBodyKeys));
      lines.push(option('--data-raw', bodyTokens(limit(body), colors)));
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
  const separator = multiline ? [SPACE, tok('\\'), tok('\n  ')] : [SPACE];
  return [
    ...notes.map((note) => render([tok(note, COMMENT)], p)),
    render(joinTokens(lines, separator), p),
  ].join('\n');
}
