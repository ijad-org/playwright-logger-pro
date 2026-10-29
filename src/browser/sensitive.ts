import { DEFAULT_SENSITIVE_KEYS } from '../redact';

/**
 * What counts as sensitive for browserLog. The names come from the list shared
 * with apiLog (DEFAULT_SENSITIVE_KEYS); this file compiles them into patterns
 * and adds the selector-only extras. The matching logic that uses them
 * (selector heuristics, keyboard-focus tracking) lives alongside.
 */
export { DEFAULT_SENSITIVE_KEYS };

const escapeRegExp = (s: string): string => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

/**
 * Compile key names into case-insensitive patterns. Names of up to four
 * letters (`pin`, `otp`, `pass`) must stand alone as a word, so `shipping` or
 * `compass` do not match; longer names match anywhere (`userPassword`,
 * `x-api-key-v2`). `_` and `-` are interchangeable inside a name.
 */
export function compileKeyPatterns(names: readonly string[]): RegExp[] {
  return names.filter((n) => n.length > 0).map((name) => {
    const body = escapeRegExp(name).replace(/\\?[-_]/g, '[-_ ]?');
    return name.length <= 4 ?
      new RegExp(`(?:^|[^a-z])${body}(?:[^a-z]|$)`, 'i') :
      new RegExp(body, 'i');
  });
}

/**
 * Matched against a target's description (locator text, or the selector for
 * page/frame calls). `#password`, `getByLabel('Password')`, `input[type=password]`
 * and `getByPlaceholder('Enter PIN')` all match.
 */
export const DEFAULT_SENSITIVE_SELECTORS: readonly (string | RegExp)[] = [
  ...compileKeyPatterns(DEFAULT_SENSITIVE_KEYS),
  /one[-_ ]?time/i,
  /card[-_ ]?number|cc-number/i,
  /type=["']?password/i,
  /current-password|new-password|one-time-code/i,
];

/** Object keys masked inside arguments (`evaluate` args, cookies, option bags). */
export const DEFAULT_SENSITIVE_KEY_PATTERNS: readonly (string | RegExp)[] =
  compileKeyPatterns(DEFAULT_SENSITIVE_KEYS);
