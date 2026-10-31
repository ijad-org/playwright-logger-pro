import type { APIRequestContext, APIResponse } from '@playwright/test';
import type { ApiLoggerConfig, RedirectHop } from './types';
import { resolveConfig } from './types';
import { buildCurl } from './curl';
import { cookieHeaderFor, type StoredCookie } from './cookies';
import {
  describeResponseBody,
  escapeControlChars,
  formatBody,
  formatErrorLine,
  formatHeaders,
  formatRequestLine,
  formatResponseLine,
  stringifyBody,
  truncateBody,
} from './format';
import { captureBody, describeError, maskHeaders, renderOptionsOf } from './compact/capture';
import { buildCurlParts } from './compact/curlScript';
import { wantsCurl } from './compact/options';
import { renderCalls } from './compact/render';
import { isErrorCall } from './compact/types';
import type { CallRecord } from './compact/types';
import { warnOnce } from './warn';
import { describeMultipart } from './multipart';
import { detectPlaywrightVersion } from './playwrightVersion';
import { readRedirectChain } from './redirects';
import { redactBodyString, redactBodyValue, redactUrl } from './redact';
import { ensureStackHygiene } from './browser/stackHygiene';

const HTTP_METHODS = ['get', 'post', 'put', 'patch', 'delete', 'head', 'fetch'] as const;
type HttpMethod = (typeof HTTP_METHODS)[number];

interface RequestOptions {
  data?: unknown;
  form?: Record<string, string | number | boolean>;
  multipart?: unknown;
  params?: unknown;
  headers?: Record<string, string>;
  [key: string]: unknown;
}

/**
 * `url` (absolute or relative) with `params` applied the way Playwright
 * applies them: a string or URLSearchParams replaces the query, an object's
 * entries are appended to it.
 */
function withParams(url: string, params: unknown): string {
  if (params === undefined || params === null) return url;
  const hashAt = url.indexOf('#');
  const beforeHash = hashAt === -1 ? url : url.slice(0, hashAt);
  const hash = hashAt === -1 ? '' : url.slice(hashAt);
  const queryAt = beforeHash.indexOf('?');
  const path = queryAt === -1 ? beforeHash : beforeHash.slice(0, queryAt);
  let search: URLSearchParams;
  if (typeof params === 'string' || params instanceof URLSearchParams) {
    search = new URLSearchParams(params);
  } else if (typeof params === 'object') {
    search = new URLSearchParams(queryAt === -1 ? '' : beforeHash.slice(queryAt + 1));
    for (const [name, value] of Object.entries(params)) {
      if (value !== undefined) search.append(name, String(value));
    }
  } else {
    return url;
  }
  const query = search.toString();
  return `${path}${query ? `?${query}` : ''}${hash}`;
}

/**
 * The absolute URL Playwright sent the first request to: `url` resolved
 * against the base URL, with `params` applied the way Playwright applies them.
 * Without a known base URL, relative URLs are resolved against `fallbackBase`.
 */
function resolveRequestedUrl(
    url: string,
    params: unknown,
    baseURL: string | undefined,
    fallbackBase: string | undefined,
): string | undefined {
  try {
    return new URL(withParams(url, params), baseURL || fallbackBase).toString();
  } catch {
    return undefined;
  }
}

/** Per-call headers override context headers case-insensitively, as in Playwright. */
function mergeHeaders(
    contextHeaders: Record<string, string> | undefined,
    callHeaders: Record<string, string> | undefined,
): Record<string, string> {
  const merged: Record<string, string> = { ...contextHeaders };
  for (const [key, value] of Object.entries(callHeaders ?? {})) {
    for (const existing of Object.keys(merged)) {
      if (existing.toLowerCase() === key.toLowerCase()) delete merged[existing];
    }
    merged[key] = value;
  }
  return merged;
}

function headerValue(headers: Record<string, string>, name: string): string | undefined {
  return Object.entries(headers).find(([k]) => k.toLowerCase() === name)?.[1];
}

/** The context's cookie jar, or undefined when it cannot be read. */
async function readCookies(context: APIRequestContext): Promise<StoredCookie[] | undefined> {
  try {
    return (await context.storageState()).cookies;
  } catch {
    return undefined;
  }
}

function normalizeUrl(url: string): string {
  try {
    return new URL(url).toString();
  } catch {
    return url;
  }
}

function isHttpMethod(prop: string | symbol): prop is HttpMethod {
  return typeof prop === 'string' && (HTTP_METHODS as readonly string[]).includes(prop);
}

/** One finished call for the `test` fixture: the record and, when it asks for one, its `curl.sh` content. */
export interface CompactCall {
  record: CallRecord;
  script?: string;
}

/** Hooks for the `test` fixture; not part of the public API. */
export interface WrapInternals {
  /**
   * `format: 'verbose'`: called with each curl command in its plain form (no colours, same
   * redaction), for the `curl.sh` file. Not called with `curlFormat.file: false`.
   */
  onCurl?: (plain: string) => void;
  /**
   * `format: 'compact'`: called with every finished call instead of printing it. Without it the
   * wrapper prints the call itself (request line, and the detail block of a failed call).
   */
  onCall?: (call: CompactCall) => void;
}

/**
 * Wrap a Playwright APIRequestContext so every request logs a compact summary line (or, with
 * `format: 'verbose'`, a colorful request/response summary) and optionally the equivalent curl
 * command before delegating to the real context. Non-HTTP members (dispose,
 * storageState, ...) pass through untouched.
 */
export function wrapRequestContext(
    context: APIRequestContext,
    config: ApiLoggerConfig = {},
    internals: WrapInternals = {},
): APIRequestContext {
  const cfg = resolveConfig(config);
  if (!cfg.enabled) return context;
  ensureStackHygiene();

  const log = cfg.sink;
  const verbose = cfg.format === 'verbose';
  const curlOff = cfg.curl === false || cfg.curl === 'never';

  async function loggedCall(
      method: HttpMethod,
      url: string,
      options: RequestOptions | undefined,
      args: unknown[],
  ): Promise<APIResponse> {
    const httpVerb = method === 'fetch' ?
      String(options?.method ?? 'get') :
      method;
    const headers = mergeHeaders(cfg.extraHTTPHeaders, options?.headers);
    const contentType = headerValue(headers, 'content-type');
    const redactedUrl = (u: string) => redactUrl(u, cfg.redactQueryParams);

    if (verbose) {
      log(formatRequestLine(httpVerb, redactedUrl(withParams(url, options?.params)), cfg));
      if (cfg.logHeaders && Object.keys(headers).length > 0) {
        log(formatHeaders(headers, cfg));
      }
    }
    const maskedData = typeof options?.data === 'string' ?
      redactBodyString(options.data, cfg.redactBodyKeys, contentType) :
      redactBodyValue(options?.data, cfg.redactBodyKeys);
    const maskedBody = maskedData ?? redactBodyValue(options?.form, cfg.redactBodyKeys) ??
      describeMultipart(options?.multipart, cfg.redactBodyKeys);
    if (verbose && cfg.logBody) {
      const body = formatBody(maskedBody, cfg);
      if (body !== undefined) log(body);
    }

    // Cookies the context sends implicitly, for the curl. Always read before
    // the request: afterwards the jar also holds the cookies the response set,
    // which the request never sent.
    const cookiesBefore = !curlOff ? await readCookies(context) : undefined;
    const requestInfo = (
        requestedUrl: string,
        followRedirects: boolean,
        redirects?: RedirectHop[],
    ) => {
      const cookie = headerValue(headers, 'cookie') === undefined && cookiesBefore ?
        cookieHeaderFor(requestedUrl, cookiesBefore) :
        undefined;
      return {
        method: httpVerb,
        url: requestedUrl,
        headers: cookie ? { ...headers, Cookie: cookie } : headers,
        data: options?.data,
        form: options?.form,
        multipart: options?.multipart,
        followRedirects,
        redirects,
        cookieFromJar: cookie !== undefined,
        playwrightVersion: redirects ? detectPlaywrightVersion() : undefined,
      };
    };
    const printCurl = async (
        requestedUrl: string,
        followRedirects: boolean,
        redirects?: RedirectHop[],
    ) => {
      const info = requestInfo(requestedUrl, followRedirects, redirects);
      const curlOptions = {
        redactQueryParams: cfg.redactQueryParams,
        redactBodyKeys: cfg.redactBodyKeys,
        maxBodyLength: cfg.maxBodyLength,
        multiline: cfg.curlFormat.multiline,
      };
      const colored = cfg.curlFormat.colors;
      const shown = buildCurl(info, cfg.redactHeaders, { ...curlOptions, colors: colored });
      log(shown);
      // Same builder and redaction lists, never coloured.
      if (internals.onCurl && cfg.curlFormat.file) {
        internals.onCurl(colored ? buildCurl(info, cfg.redactHeaders, curlOptions) : shown);
      }
    };

    /** Compact: the record of a finished call, with its curl when the options ask for one. */
    const finish = async (
        base: Pick<CallRecord, 'status' | 'statusText' | 'durationMs' | 'error' | 'redirectedTo'>,
        requestedUrl: string,
        followRedirects: boolean,
        response?: APIResponse,
    ): Promise<void> => {
      try {
        const record: CallRecord = {
          method: httpVerb.toUpperCase(),
          url: redactedUrl(requestedUrl),
          ...base,
        };
        if (cfg.logHeaders) {
          record.requestHeaders = maskHeaders(headers, cfg);
          if (response) record.responseHeaders = maskHeaders(response.headers(), cfg);
        }
        if (cfg.logBody) {
          const text = stringifyBody(maskedBody);
          if (text !== undefined) record.requestBody = truncateBody(escapeControlChars(text), cfg.maxBodyLength);
          if (response) {
            try {
              record.responseBody = captureBody(await response.body(), response.headers()['content-type'], cfg.redactBodyKeys);
            } catch {
              // body may not be readable (e.g. disposed context) — never fail the test for logging
            }
          }
        }
        let script: string | undefined;
        if (!curlOff && (isErrorCall(record) || wantsCurl(cfg.curl, record.status))) {
          const chain = followRedirects && response ? await readRedirectChain(response) : undefined;
          const parts = buildCurlParts(requestInfo(requestedUrl, followRedirects, chain), {
            redactHeaders: cfg.redactHeaders,
            redactQueryParams: cfg.redactQueryParams,
            redactBodyKeys: cfg.redactBodyKeys,
            multiline: cfg.curlFormat.multiline,
          });
          record.curl = parts.terminal;
          if (wantsCurl(cfg.curl, record.status) && cfg.curlFormat.file) script = parts.script;
        }
        if (internals.onCall) {
          internals.onCall({ record, script });
        } else {
          // No test to ask whether it failed: show the detail of every failed call.
          const width = process.stdout.columns || 120;
          log(renderCalls([record], renderOptionsOf(cfg, cfg.curlFormat.colors, width), true).join('\n'));
        }
      } catch (error) {
        warnOnce(`could not record an API call: ${error instanceof Error ? error.message : String(error)}`);
      }
    };

    const started = Date.now();
    let response: APIResponse;
    try {
      // Called as a method, not through apply/call: Playwright 1.30-1.48 derive
      // the step title (`apiRequestContext.get(...)`) from this frame's name.
      response = await (context as unknown as Record<HttpMethod, (...a: unknown[]) => Promise<APIResponse>>)[method](...args);
    } catch (error) {
      const requestedUrl = resolveRequestedUrl(url, options?.params, cfg.baseURL, undefined) ??
        withParams(url, options?.params);
      if (verbose) {
        log(formatErrorLine(httpVerb, redactedUrl(requestedUrl), error, Date.now() - started, cfg));
        if (wantsCurl(cfg.curl, undefined)) await printCurl(requestedUrl, false);
      } else {
        await finish({
          durationMs: Date.now() - started,
          error: describeError(error, cfg.redactQueryParams),
        }, requestedUrl, false);
      }
      throw error;
    }
    const durationMs = Date.now() - started;

    // response.url() is the URL after redirects. Log and curl the URL that was
    // actually requested, noting the final URL when they differ.
    const finalUrl = response.url();
    const requestedUrl =
      resolveRequestedUrl(url, options?.params, cfg.baseURL, finalUrl) ?? finalUrl;
    const redirected = normalizeUrl(requestedUrl) !== normalizeUrl(finalUrl);

    if (!verbose) {
      await finish({
        status: response.status(),
        statusText: response.statusText(),
        durationMs,
        redirectedTo: redirected ? redactedUrl(finalUrl) : undefined,
      }, requestedUrl, redirected, response);
      return response;
    }

    log(formatResponseLine(
        httpVerb, redactedUrl(requestedUrl), response.status(), response.statusText(), durationMs,
        cfg, redirected ? redactedUrl(finalUrl) : undefined,
    ));
    const responseHeaders = response.headers();
    if (cfg.logHeaders && Object.keys(responseHeaders).length > 0) {
      log(formatHeaders(responseHeaders, cfg));
    }
    if (cfg.logBody) {
      try {
        const responseType = responseHeaders['content-type'];
        const text = describeResponseBody(await response.body(), responseType);
        const body = formatBody(redactBodyString(text, cfg.redactBodyKeys, responseType), cfg);
        if (body !== undefined) log(body);
      } catch {
        // body may not be readable (e.g. disposed context) — never fail the test for logging
      }
    }

    if (wantsCurl(cfg.curl, response.status())) {
      const chain = redirected ? await readRedirectChain(response) : undefined;
      await printCurl(requestedUrl, redirected, chain);
    }

    return response;
  }

  return new Proxy(context, {
    get(target, prop) {
      if (isHttpMethod(prop)) {
        return (url: string, options?: RequestOptions, ...rest: unknown[]) =>
          loggedCall(prop, String(url), options, [url, options, ...rest]);
      }
      // Read off the target directly (not the proxy receiver) so any
      // internal/private state in Playwright's implementation keeps working.
      const value = Reflect.get(target, prop, target);
      return typeof value === 'function' ? value.bind(target) : value;
    },
  });
}
