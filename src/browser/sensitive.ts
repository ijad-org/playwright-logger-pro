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
  /type=["']?password/i,
  /current-password|new-password|one-time-code/i,
  // Card numbers and codes, by id / name / autocomplete / label text:
  // `#cardnumber`, `[name=card_no]`, `[autocomplete=cc-number]`, `getByLabel('Credit card')`.
  /card[-_ ]?number/i,
  /(?:^|[^a-z])card[-_ .]?(?:num|no)(?![a-z])/i,
  /\bcc[-_ ]?(?:number|num|csc|cvc|cvv)(?![a-z])/i,
  // Expiry: `autocomplete=cc-exp` / `cc-exp-month` / `cc-exp-year`, `#cardExpiry`, labels
  // "Expiry date", "Expiration", "Exp date". Whole words only: `expires`, `express` stay clear.
  /\bcc[-_ ]?exp(?:[-_ ]?(?:month|year|date|mm|yy|yyyy))?(?![a-z])/i,
  /card[-_ ]?exp(?:iry|iration)?(?![a-z])/i,
  /(?:^|[^a-z])(?:expir(?:y|ation)|exp)[-_ .]{0,2}(?:date|month|year|mm|yy|yyyy)(?![a-z])/i,
  /(?:^|[^a-z])expir(?:y|ation)(?![a-z])/i,
  // Primary account number as a whole word: `#pan`, `getByLabel('PAN')`; not `company`, `panel`, `span`.
  /(?:^|[^a-z])pan(?![a-z])/i,
  /(?:credit|debit)[-_ ]?card/i,
  /security[-_ ]?code|verification[-_ ]?code|social[-_ ]?security/i,
  /\b(?:2fa|mfa|totp)\b/i,
  // A field that is just "card": `#card`, `[name="card"]`, `getByLabel('Card')`, a textbox named "Card".
  // Not `.card` (a CSS class), `getByText('Card')` or a button.
  /(?:#|\[\s*(?:id|name)\s*[~|^$*]?=\s*["']?)card(?![\w-])/i,
  /get(?:ByLabel|ByPlaceholder)\(\s*'\s*card\s*'/i,
  /getByRole\('(?:textbox|spinbutton)',\s*\{[^}]*name:\s*'\s*card\s*'/i,
];

/** Object keys masked inside arguments (`evaluate` args, cookies, option bags). */
export const DEFAULT_SENSITIVE_KEY_PATTERNS: readonly (string | RegExp)[] =
  compileKeyPatterns(DEFAULT_SENSITIVE_KEYS);
