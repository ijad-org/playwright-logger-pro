export { attachBrowserLogger } from './attach';
export type { BrowserLogHandle } from './session';
export { DEFAULT_BROWSER_CONFIG, resolveBrowserConfig } from './types';
export type {
  BrowserLogEvent,
  BrowserLoggerConfig,
  BrowserRedactConfig,
  ResolvedBrowserConfig,
} from './types';
export {
  DEFAULT_SENSITIVE_KEYS,
  DEFAULT_SENSITIVE_KEY_PATTERNS,
  DEFAULT_SENSITIVE_SELECTORS,
} from './sensitive';
export { renderBrowserEventJsonl, renderBrowserEventText } from './render';
