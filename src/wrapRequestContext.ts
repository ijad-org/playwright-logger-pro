import type { APIRequestContext, APIResponse } from '@playwright/test';
import type { ApiLoggerConfig } from './types';
import { resolveConfig } from './types';
import { buildCurl } from './curl';
import {
  formatBody,
  formatHeaders,
  formatRequestLine,
  formatResponseLine,
} from './format';

const HTTP_METHODS = ['get', 'post', 'put', 'patch', 'delete', 'head', 'fetch'] as const;
type HttpMethod = (typeof HTTP_METHODS)[number];

interface RequestOptions {
  data?: unknown;
  form?: Record<string, string | number | boolean>;
  headers?: Record<string, string>;
  [key: string]: unknown;
}

function isHttpMethod(prop: string | symbol): prop is HttpMethod {
  return typeof prop === 'string' && (HTTP_METHODS as readonly string[]).includes(prop);
}

/**
 * Wrap a Playwright APIRequestContext so every request logs a colorful
 * request/response summary (and optionally the equivalent curl command)
 * before delegating to the real context. Non-HTTP members (dispose,
 * storageState, ...) pass through untouched.
 */
export function wrapRequestContext(
    context: APIRequestContext,
    config: ApiLoggerConfig = {},
): APIRequestContext {
  const cfg = resolveConfig(config);
  if (!cfg.enabled) return context;

  const log = cfg.sink;

  async function loggedCall(
      method: HttpMethod,
      url: string,
      options: RequestOptions | undefined,
      args: unknown[],
  ): Promise<APIResponse> {
    const httpVerb = method === 'fetch' ?
      String(options?.method ?? 'get') :
      method;

    log(formatRequestLine(httpVerb, url, cfg));
    if (cfg.logHeaders && options?.headers && Object.keys(options.headers).length > 0) {
      log(formatHeaders(options.headers, cfg));
    }
    if (cfg.logBody) {
      const body = formatBody(options?.data ?? options?.form, cfg);
      if (body !== undefined) log(body);
    }

    const started = Date.now();
    const target = context[method] as (...a: unknown[]) => Promise<APIResponse>;
    const response = await target.apply(context, args);
    const durationMs = Date.now() - started;

    log(formatResponseLine(
        httpVerb, response.url(), response.status(), response.statusText(), durationMs, cfg,
    ));
    if (cfg.logHeaders) {
      const responseHeaders = response.headers();
      if (Object.keys(responseHeaders).length > 0) {
        log(formatHeaders(responseHeaders, cfg));
      }
    }
    if (cfg.logBody) {
      try {
        const text = await response.text();
        const body = formatBody(text, cfg);
        if (body !== undefined) log(body);
      } catch {
        // body may not be readable (e.g. disposed context) — never fail the test for logging
      }
    }

    if (cfg.curl === true || (cfg.curl === 'on-failure' && !response.ok())) {
      log(buildCurl({
        method: httpVerb,
        url: response.url(),
        headers: options?.headers,
        data: options?.data,
        form: options?.form,
      }, cfg.redactHeaders));
    }

    return response;
  }

  return new Proxy(context, {
    get(target, prop, receiver) {
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
