import { buildCurl } from '../curl';
import type { CurlOptions } from '../curl';
import type { RequestInfo } from '../types';

/** Headers curl sets itself, or that only add noise to a replay. */
export const NOISE_HEADERS: readonly string[] = ['host', 'content-length', 'connection', 'accept-encoding'];

/** Bodies longer than this are cut with `…` in the terminal; `curl.sh` keeps them whole. */
export const TERMINAL_BODY_LIMIT = 2048;

/** `cardToken` / `x-api-key` / `access_token` -> `CARD_TOKEN` / `X_API_KEY` / `ACCESS_TOKEN`. */
export function envName(key: string): string {
  const name = key
      .replace(/([a-z0-9])([A-Z])/g, '$1_$2')
      .replace(/[^A-Za-z0-9]+/g, '_')
      .replace(/^_+|_+$/g, '')
      .toUpperCase();
  if (name === '') return 'SECRET';
  return /^[0-9]/.test(name) ? `_${name}` : name;
}

// Private-use characters survive JSON.stringify and shell quoting, so a masked value can be
// found again after the command is built.
const OPEN = '';
const CLOSE = '';
const SENTINEL = new RegExp(`${OPEN}([A-Z0-9_]+)${CLOSE}`, 'g');

export interface CurlParts {
  /** The command as printed in the terminal (`***`, bodies cut at 2 KB with `…`). */
  terminal: string;
  /** The content of `curl.sh`: the whole body, `${VAR}` for every masked value. */
  script: string;
  /** Environment variables the script needs. */
  variables: string[];
}

export interface CurlBuildOptions {
  redactHeaders: readonly string[];
  redactQueryParams: readonly string[];
  redactBodyKeys: readonly string[];
  multiline: boolean;
  /** Spec file and line, written as a comment in the script. */
  location?: string;
}

/** Strips characters that cannot appear in a one-line `#` comment. */
function commentSafe(text: string): string {
  // eslint-disable-next-line no-control-regex
  return text.replace(/[\u0000-\u001f\u007f-\u009f\u2028\u2029]/g, '');
}

/**
 * Turns the masked spots of a command into `"${NAME}"` placeholders. They only ever sit inside
 * single quotes, so the quote is closed around them: `'Authorization: '"${AUTHORIZATION}"`.
 */
function placeholders(command: string, variables: Set<string>): string {
  return command
      .replace(SENTINEL, (_m, name: string) => {
        variables.add(name);
        return `'"\${${name}}"'`;
      })
      // A placeholder at the edge of a string leaves an empty '' pair: drop it.
      .replace(/(\$\{[A-Z0-9_]+\}")''/g, '$1')
      .replace(/''("\$\{)/g, '$1');
}

/** The terminal and the script form of one call's curl command. */
export function buildCurlParts(info: RequestInfo, options: CurlBuildOptions): CurlParts {
  const shared: CurlOptions = {
    redactQueryParams: options.redactQueryParams,
    redactBodyKeys: options.redactBodyKeys,
    multiline: options.multiline,
    skipHeaders: NOISE_HEADERS,
  };
  const terminal = buildCurl(info, options.redactHeaders, {
    ...shared,
    maxBodyLength: TERMINAL_BODY_LIMIT,
    truncationMarker: '…',
    truncationNote: (limit, total) => `# request body cut at ${limit} of ${total} characters; the attached script has all of it`,
  });
  const variables = new Set<string>();
  const body = placeholders(
      buildCurl(info, options.redactHeaders, { ...shared, mask: (key) => `${OPEN}${envName(key)}${CLOSE}` }),
      variables,
  );
  const names = [...variables];
  const script = [
    '#!/usr/bin/env bash',
    'set -euo pipefail',
    ...(options.location ? [`# ${commentSafe(options.location)}`] : []),
    ...names.map((name) => `: "\${${name}:?export ${name} first}"`),
    '',
    body,
    '',
  ].join('\n');
  return { terminal, script, variables: names };
}

/** `curl.sh` for a test's only curl, `curl-{n}-{METHOD}-{lastPathSegment}.sh` among several. */
export function curlFileName(index: number, count: number, method: string, url: string): string {
  if (count === 1) return 'curl.sh';
  const lastSegment = (path: string): string => path.split('/').filter(Boolean).pop() ?? '';
  let segment: string;
  try {
    segment = lastSegment(new URL(url).pathname);
  } catch {
    segment = lastSegment(url.split('?')[0] ?? '');
  }
  const safe = segment.replace(/[^A-Za-z0-9._-]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 40) || 'root';
  return `curl-${index}-${method.toUpperCase()}-${safe}.sh`;
}
