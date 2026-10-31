import { markRunnerTty } from './env';

// See fixtures.ts: lets Playwright workers know the runner's stdout is a terminal.
markRunnerTty();

export { wrapRequestContext } from './wrapRequestContext';
export { buildCurl } from './curl';
export type { CurlOptions } from './curl';
export {
  formatRequestLine,
  formatResponseLine,
  formatErrorLine,
  formatHeaders,
  describeResponseBody,
  escapeControlChars,
  formatBody,
  redactHeaders,
  truncateBody,
  stringifyBody,
} from './format';
export {
  renderCalls,
  renderCallLine,
  renderDetail,
  renderFooter,
  summarize,
  formatDuration,
  shortenQuery,
  bodyPreview,
} from './compact/render';
export type { RenderOptions, CallStats } from './compact/render';
export { buildCurlParts, envName } from './compact/curlScript';
export type { CurlParts } from './compact/curlScript';
export type { BodyRecord, CallRecord, CallsAttachment } from './compact/types';
export type { ReporterOptions } from './reporter';
export type {
  ApiLoggerConfig,
  CompactDisplayConfig,
  CurlMode,
  DetailsMode,
  MaskConfig,
  OutputFormat,
  ThemeName,
  CurlFormatConfig,
  RedirectHop,
  RequestInfo,
  ResolvedConfig,
  ResolvedCurlFormat,
} from './types';
export {
  DEFAULT_CONFIG,
  DEFAULT_REDACT_BODY_KEYS,
  DEFAULT_REDACT_HEADERS,
  DEFAULT_REDACT_QUERY_PARAMS,
  detectColorSupport,
  resolveConfig,
} from './types';
export { describeMultipart } from './multipart';
export { redactUrl, redactQueryString, redactBodyValue, redactBodyString } from './redact';
export {
  attachBrowserLogger,
  DEFAULT_BROWSER_CONFIG,
  DEFAULT_SENSITIVE_KEYS,
  DEFAULT_SENSITIVE_SELECTORS,
  renderBrowserEventJsonl,
  renderBrowserEventText,
  resolveBrowserConfig,
} from './browser';
export type {
  BrowserLogEvent,
  BrowserLogHandle,
  BrowserLoggerConfig,
  BrowserRedactConfig,
  ResolvedBrowserConfig,
} from './browser';
