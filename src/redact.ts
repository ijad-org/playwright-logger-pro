import { warnOnce } from './warn';

/** Placeholder that replaces every redacted value. */
export const REDACTED = '***';

function lowerSet(keys: readonly string[]): Set<string> {
  return new Set(keys.map((k) => k.toLowerCase()));
}

function decodeFormComponent(value: string): string {
  try {
    return decodeURIComponent(value.replace(/\+/g, ' '));
  } catch {
    return value;
  }
}

/**
 * Mask the values of `keys` (case-insensitive) in an
 * application/x-www-form-urlencoded string such as a URL query. Everything
 * else is kept byte for byte.
 */
export function redactQueryString(query: string, keys: readonly string[]): string {
  if (keys.length === 0 || query.length === 0) return query;
  const names = lowerSet(keys);
  return query
      .split('&')
      .map((pair) => {
        const eq = pair.indexOf('=');
        const rawName = eq === -1 ? pair : pair.slice(0, eq);
        if (!names.has(decodeFormComponent(rawName).toLowerCase())) return pair;
        return `${rawName}=${REDACTED}`;
      })
      .join('&');
}

/** Mask the values of the query parameters in `keys` (case-insensitive) in a URL. */
export function redactUrl(url: string, keys: readonly string[]): string {
  if (keys.length === 0) return url;
  const hashAt = url.indexOf('#');
  const beforeHash = hashAt === -1 ? url : url.slice(0, hashAt);
  const hash = hashAt === -1 ? '' : url.slice(hashAt);
  const queryAt = beforeHash.indexOf('?');
  if (queryAt === -1) return url;
  return `${beforeHash.slice(0, queryAt + 1)}${redactQueryString(beforeHash.slice(queryAt + 1), keys)}${hash}`;
}

function redactDeep(value: unknown, names: Set<string>): { value: unknown; changed: boolean } {
  if (Array.isArray(value)) {
    let changed = false;
    const out = value.map((item) => {
      const r = redactDeep(item, names);
      changed ||= r.changed;
      return r.value;
    });
    return changed ? { value: out, changed } : { value, changed };
  }
  if (value === null || typeof value !== 'object' || Buffer.isBuffer(value) ||
    value instanceof Date || value instanceof URLSearchParams) {
    return { value, changed: false };
  }
  let changed = false;
  const out: Record<string, unknown> = {};
  for (const [key, item] of Object.entries(value as Record<string, unknown>)) {
    if (names.has(key.toLowerCase())) {
      out[key] = REDACTED;
      changed = true;
      continue;
    }
    const r = redactDeep(item, names);
    changed ||= r.changed;
    out[key] = r.value;
  }
  return changed ? { value: out, changed } : { value, changed };
}

/**
 * Mask the values of `keys` (case-insensitive, at any depth) in a JSON-like
 * object or array. Returns the input unchanged when nothing matched.
 */
export function redactBodyValue<T>(data: T, keys: readonly string[]): T {
  if (keys.length === 0) return data;
  return redactDeep(data, lowerSet(keys)).value as T;
}

/**
 * Mask the values of `keys` in a string body: JSON (any content type, when it
 * parses) or application/x-www-form-urlencoded. Returns the input unchanged
 * when nothing matched or the body is in another format.
 */
export function redactBodyString(
    body: string,
    keys: readonly string[],
    contentType?: string,
): string {
  if (keys.length === 0) return body;
  const trimmed = body.trimStart();
  if (trimmed.startsWith('{') || trimmed.startsWith('[')) {
    try {
      const { value, changed } = redactDeep(JSON.parse(body), lowerSet(keys));
      return changed ? JSON.stringify(value) : body;
    } catch {
      // not JSON — fall through
    }
  }
  if (contentType && /application\/x-www-form-urlencoded/i.test(contentType)) {
    return redactQueryString(body, keys);
  }
  return body;
}

// ---------------------------------------------------------------------------
// Shared with browserLog: literal-secret masking, key matching, deep sanitising.
// ---------------------------------------------------------------------------

/** Secrets shorter than this are ignored: masking them would shred ordinary text. */
export const MIN_SECRET_LENGTH = 4;

/**
 * Key / field names that usually hold secrets, shared by both loggers
 * (lower case). browserLog uses it to mask object keys inside arguments and to
 * recognise password-like selectors and labels (so `fill()` values are
 * masked). apiLog does NOT apply it by default (DEFAULT_REDACT_BODY_KEYS stays
 * empty); opt in with `redactBodyKeys: [...DEFAULT_SENSITIVE_KEYS]`.
 * apiLog compares whole key names; browserLog also matches them inside longer
 * names (`userPassword`) and inside selectors.
 */
export const DEFAULT_SENSITIVE_KEYS: readonly string[] = Object.freeze([
  'password', 'passwd', 'pwd', 'pass', 'passphrase', 'passcode',
  'secret', 'client_secret', 'token', 'access_token', 'refresh_token', 'id_token',
  'api_key', 'apikey', 'api-key', 'authorization', 'cookie', 'credentials',
  'private_key', 'otp', 'pin', 'cvv', 'cvc', 'csc', 'ssn', 'card_number', 'cardnumber',
]);

/** Match `url` userinfo passwords (`https://u:pw@host`) and literal secret values. */
const USERINFO_PASSWORD = /^([a-z][a-z0-9+.-]*:\/\/[^/?#@\s:]*):([^/?#@\s]*)@/i;

/**
 * Mask what is always a secret in a URL: the userinfo password
 * (`https://u:***@host`) and literal secret values. Query parameters are
 * left alone (see `redactUrl` for those). Works on relative and invalid URLs.
 */
export function maskUrl(url: string, values?: readonly string[], mask: string = REDACTED): string {
  if (typeof url !== 'string' || url.length === 0) return url;
  return redactText(url.replace(USERINFO_PASSWORD, (_m, head: string) => `${head}:${mask}@`), values, mask);
}

/**
 * Clean a list of literal secrets: drops non-strings, empties and values
 * shorter than MIN_SECRET_LENGTH (one warning), removes duplicates and sorts
 * longest first so a secret that contains another is masked as a whole.
 */
export function normalizeSecretValues(values: readonly unknown[] | undefined): string[] {
  if (!values || values.length === 0) return [];
  const out = new Set<string>();
  let short = 0;
  for (const v of values) {
    if (typeof v !== 'string' || v.length === 0) continue;
    if (v.length < MIN_SECRET_LENGTH) {
      short++;
      continue;
    }
    out.add(v);
  }
  if (short > 0) {
    warnOnce(
        `ignoring ${short} redact value(s) shorter than ${MIN_SECRET_LENGTH} characters; ` +
        'masking them would hide ordinary text.',
    );
  }
  return [...out].sort((a, b) => b.length - a.length);
}

/**
 * Typed values (fill/type/... into a field detected as sensitive) shorter than
 * this are not learned as secrets: masking a 1-3 character string in every
 * console message, URL and error would shred ordinary text. Same floor as
 * `redact.values`.
 */
export const MIN_LEARNED_SECRET_LENGTH = MIN_SECRET_LENGTH;

const lowerHex = (s: string): string => s.replace(/%[0-9A-F]{2}/g, (m) => m.toLowerCase());

/**
 * The value itself plus the spellings it takes when a page puts it in a URL
 * or a JSON string: percent-encoded (`encodeURIComponent`, `encodeURI`, the
 * RFC 3986 form that also encodes `!'()*`, which is how browsers serialise a
 * query), with `+` for spaces, lower-case hex, and the JSON-escaped form.
 * Variants shorter than MIN_SECRET_LENGTH are dropped.
 */
export function secretVariants(value: string): string[] {
  const out = new Set<string>();
  const add = (s: string): void => {
    if (s.length >= MIN_SECRET_LENGTH) out.add(s);
  };
  const trimmed = value.trim();
  for (const base of trimmed === value ? [value] : [value, trimmed]) {
    add(base);
    try {
      const component = encodeURIComponent(base);
      const strict = component.replace(/[!'()*]/g, (c) => `%${c.charCodeAt(0).toString(16).toUpperCase()}`);
      for (const c of [component, strict]) {
        for (const form of [c, lowerHex(c)]) {
          add(form);
          add(form.replace(/%20/g, '+'));
        }
      }
      add(encodeURI(base));
    } catch {
      // a lone surrogate cannot be encoded; the plain value is still masked
    }
    const json = JSON.stringify(base).slice(1, -1);
    if (json !== base) add(json);
  }
  return [...out];
}

const AUTH_SCHEME = /^([A-Za-z][\w.~+-]*)\s+(\S.*)$/;

/**
 * The secrets a header value carries. `Authorization: Bearer X` also yields
 * the bare token `X` (pages echo the token, not the scheme); `Basic base64`
 * also yields the decoded `user:password` and the password; a `Cookie`
 * header yields each cookie value. The whole value is always first.
 */
export function headerSecretValues(name: string, value: unknown): string[] {
  if (typeof value !== 'string' || value.length === 0) return [];
  const out: string[] = [value];
  const derived = (s: string): void => {
    if (s.length >= MIN_SECRET_LENGTH && !out.includes(s)) out.push(s);
  };
  const trimmed = value.trim();
  derived(trimmed);
  const scheme = AUTH_SCHEME.exec(trimmed);
  if (scheme) {
    const token = scheme[2].trim();
    derived(token);
    if (/^basic$/i.test(scheme[1]) && /^[A-Za-z0-9+/_-]+={0,2}$/.test(token)) {
      const decoded = Buffer.from(token, 'base64').toString('utf8');
      // eslint-disable-next-line no-control-regex
      if (decoded.includes(':') && !/[\u0000-\u001f\u007f�]/.test(decoded)) {
        derived(decoded);
        derived(decoded.slice(decoded.indexOf(':') + 1));
      }
    }
  }
  if (/^(?:set-)?cookie$/i.test(name)) {
    for (const part of trimmed.split(';')) {
      const eq = part.indexOf('=');
      if (eq > 0) derived(part.slice(eq + 1).trim());
    }
  }
  return out;
}

/** Literal replacement (no regex), longest value first. */
export function redactText(
    text: string,
    values: readonly string[] | undefined,
    mask: string = REDACTED,
): string {
  if (!values || values.length === 0 || text.length === 0) return text;
  let out = text;
  // Lists built by normalizeSecretValues are already longest first: only sort when they are not.
  let sorted = true;
  for (let i = 1; i < values.length; i++) {
    if ((values[i - 1]?.length ?? 0) < (values[i]?.length ?? 0)) {
      sorted = false;
      break;
    }
  }
  const ordered = sorted ? values : [...values].sort((a, b) => b.length - a.length);
  for (const value of ordered) {
    if (typeof value !== 'string' || value.length < MIN_SECRET_LENGTH) continue;
    if (out.includes(value)) out = out.split(value).join(mask);
  }
  return out;
}

/** Case-insensitive substring for strings, `.test()` for regular expressions. */
export function matchesAny(text: string, patterns: readonly (string | RegExp)[] | undefined): boolean {
  if (!patterns || patterns.length === 0) return false;
  const lower = text.toLowerCase();
  for (const p of patterns) {
    if (typeof p === 'string') {
      if (p.length > 0 && lower.includes(p.toLowerCase())) return true;
    } else {
      p.lastIndex = 0;
      if (p.test(text)) return true;
    }
  }
  return false;
}

export interface SanitizeDeepOptions {
  /** Object keys whose values are masked. */
  keys?: readonly (string | RegExp)[];
  values?: readonly string[];
  mask?: string;
  /** Containers nested deeper than this are replaced by a placeholder. Default 4. */
  maxDepth?: number;
  /** Return a replacement (used as-is, not walked) for values the caller wants to render itself. */
  custom?: (value: unknown) => unknown;
}

/**
 * Convert any value to a plain, JSON-safe structure with secrets masked:
 * strings go through `redactText`, values under sensitive keys are masked,
 * cycles become '[Circular]', and BigInt / Symbol / function / Buffer / Error
 * / Map / Set values are summarised. Never throws.
 */
export function sanitizeDeep(value: unknown, options: SanitizeDeepOptions = {}): unknown {
  const mask = options.mask ?? REDACTED;
  const maxDepth = options.maxDepth ?? 4;
  const seen = new WeakSet<object>();

  const walk = (v: unknown, depth: number): unknown => {
    if (options.custom && v !== null && (typeof v === 'object' || typeof v === 'function')) {
      const replaced = options.custom(v);
      if (replaced !== undefined) return replaced;
    }
    switch (typeof v) {
      case 'string': return redactText(v, options.values, mask);
      case 'number':
      case 'boolean':
      case 'undefined': return v;
      case 'bigint': return `${v}n`;
      case 'symbol': return v.toString();
      case 'function': return `[Function${v.name ? ` ${v.name}` : ''}]`;
      default: break;
    }
    if (v === null) return null;
    const obj = v as object;
    if (obj instanceof RegExp) return String(obj);
    if (obj instanceof Date) return Number.isNaN(obj.getTime()) ? 'Invalid Date' : obj.toISOString();
    if (typeof Buffer !== 'undefined' && Buffer.isBuffer(obj)) return `<Buffer ${obj.length} bytes>`;
    if (obj instanceof ArrayBuffer || ArrayBuffer.isView(obj)) {
      return `<binary ${(obj as ArrayBufferLike & { byteLength: number }).byteLength} bytes>`;
    }
    if (seen.has(obj)) return '[Circular]';
    if (obj instanceof Error) {
      return { name: obj.name, message: redactText(String(obj.message), options.values, mask) };
    }
    if (depth >= maxDepth) return Array.isArray(obj) ? '[Array]' : '[Object]';
    seen.add(obj);
    try {
      if (Array.isArray(obj)) return obj.map((item) => walk(item, depth + 1));
      if (obj instanceof Map) return `[Map(${obj.size})]`;
      if (obj instanceof Set) return `[Set(${obj.size})]`;
      const out: Record<string, unknown> = {};
      for (const key of Object.keys(obj)) {
        if (matchesAny(key, options.keys)) {
          out[key] = mask;
          continue;
        }
        let child: unknown;
        try {
          child = (obj as Record<string, unknown>)[key];
        } catch {
          child = '[Unreadable]';
        }
        out[key] = walk(child, depth + 1);
      }
      return out;
    } finally {
      // Siblings may legitimately share a reference; only true ancestors are cycles.
      seen.delete(obj);
    }
  };

  try {
    return walk(value, 0);
  } catch {
    return '[Unserializable]';
  }
}
