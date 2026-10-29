import type { APIResponse } from '@playwright/test';
import type { RedirectHop } from './types';

/**
 * Parse Playwright's per-request fetch log (`→ GET <url>` before each request,
 * `← 302 Found` after each response, indented header lines in between) into
 * the requests that were sent.
 */
export function parseFetchLog(log: readonly string[]): RedirectHop[] {
  const hops: RedirectHop[] = [];
  for (const line of log) {
    const request = /^→ (\S+) (\S+)$/.exec(line);
    if (request) {
      const [, method, url] = request;
      const last = hops[hops.length - 1];
      // A retry (ECONNRESET) logs the same request again without a response.
      if (last && last.status === undefined && last.method === method && last.url === url) continue;
      hops.push({ method, url });
      continue;
    }
    const response = /^← (\d{3})\b/.exec(line);
    const last = hops[hops.length - 1];
    if (response && last && last.status === undefined) last.status = Number(response[1]);
  }
  return hops;
}

/**
 * The requests Playwright sent for `response`, or undefined when its fetch log
 * is not available (it is an internal API; this never throws).
 */
export async function readRedirectChain(response: APIResponse): Promise<RedirectHop[] | undefined> {
  try {
    const fetchLog = (response as unknown as { _fetchLog?: () => Promise<string[]> })._fetchLog;
    if (typeof fetchLog !== 'function') return undefined;
    const hops = parseFetchLog(await fetchLog.call(response));
    return hops.length > 0 ? hops : undefined;
  } catch {
    return undefined;
  }
}
