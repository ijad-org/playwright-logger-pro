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
