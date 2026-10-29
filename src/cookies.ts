/** A cookie as returned by APIRequestContext.storageState(). */
export interface StoredCookie {
  name: string;
  value: string;
  domain: string;
  path: string;
  /** Unix time in seconds; -1 for session cookies. */
  expires: number;
  secure: boolean;
}

function isLocalhost(hostname: string): boolean {
  return hostname === 'localhost' || hostname === '127.0.0.1' || hostname === '[::1]' ||
    hostname.endsWith('.localhost');
}

function domainMatches(hostname: string, domain: string): boolean {
  const d = domain.toLowerCase();
  if (d.startsWith('.')) return hostname === d.slice(1) || hostname.endsWith(d);
  return hostname === d;
}

function pathMatches(pathname: string, cookiePath: string): boolean {
  const p = cookiePath || '/';
  if (pathname === p) return true;
  return pathname.startsWith(p.endsWith('/') ? p : `${p}/`);
}

/**
 * The Cookie header value a cookie jar would send to `url`, or undefined when
 * no cookie applies (or the URL is not absolute).
 */
export function cookieHeaderFor(
    url: string,
    cookies: readonly StoredCookie[],
    now: number = Date.now(),
): string | undefined {
  let u: URL;
  try {
    u = new URL(url);
  } catch {
    return undefined;
  }
  const hostname = u.hostname.toLowerCase();
  const pairs = cookies
      .filter((c) => domainMatches(hostname, c.domain) &&
        pathMatches(u.pathname, c.path) &&
        (!c.secure || u.protocol === 'https:' || isLocalhost(hostname)) &&
        !(c.expires > 0 && c.expires * 1000 <= now))
      .map((c) => `${c.name}=${c.value}`);
  return pairs.length > 0 ? pairs.join('; ') : undefined;
}
