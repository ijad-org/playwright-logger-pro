import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import type { TestInfoLike } from './browser/output';
import { warnOnce } from './warn';

/** Name of the script written to the test's output directory and attached to the report. */
export const CURL_SCRIPT = 'curl.sh';

/**
 * The one line printed when the script is ready. It names no path: Playwright derives the
 * output folder from the test title, so a path could carry (a normalised form of) a secret.
 */
export const CURL_SCRIPT_NOTICE =
  `${CURL_SCRIPT}: attached to the test report (see "${CURL_SCRIPT}" in the HTML report; ` +
  "also saved in this test's output folder)";

const GENERIC_COMMENT = '# redacted curl commands of this test; run with: sh curl.sh';

/** Escape sequences (CSI, OSC and other string sequences, two-character ones), then every control character. */
const TERMINAL_CODES = new RegExp([
  '(?:\\u001b\\]|\\u009d)[^\\u0007\\u001b\\u009c]*(?:\\u0007|\\u001b\\\\|\\u009c)?', // OSC, terminated or not
  '(?:\\u001b\\[|\\u009b)[0-?]*[ -/]*[@-~]?', // CSI
  '\\u001b[PX^_][^\\u001b]*(?:\\u001b\\\\)?', // DCS, SOS, PM, APC
  '\\u001b[ -/]*[0-~]?', // other escapes
  '[\\u0000-\\u001f\\u007f-\\u009f\\u2028\\u2029\\u200b-\\u200f\\u202a-\\u202e\\u2066-\\u2069\\ufeff]',
].join('|'), 'g');

/** `text` without escape sequences and control (or bidi) characters: safe on a `#` comment line. */
export function stripControl(text: string): string {
  return text.replace(TERMINAL_CODES, '');
}

/** Whether `rel` (from path.relative) stays inside its base directory. */
const inside = (rel: string): boolean => rel !== '' && !rel.startsWith('..') && !path.isAbsolute(rel);

/**
 * `spec/file.ts:line` of the test: the spec file relative to the config's rootDir (or the
 * project's testDir), the bare file name when it is in neither. Undefined without a file.
 */
export function specLocation(testInfo: TestInfoLike): string | undefined {
  const file = testInfo.file;
  if (typeof file !== 'string' || file === '') return undefined;
  let shown = path.basename(file);
  for (const base of [testInfo.config?.rootDir, testInfo.project?.testDir]) {
    if (typeof base !== 'string') continue;
    const rel = path.relative(base, file);
    if (inside(rel)) {
      shown = rel.split(path.sep).join('/');
      break;
    }
  }
  const line = Number.isInteger(testInfo.line) && Number(testInfo.line) > 0 ? `:${testInfo.line}` : '';
  const text = stripControl(`${shown}${line}`).trim();
  return text === '' ? undefined : text;
}

/**
 * Contents of `curl.sh`: the plain, redacted commands of a test, ready for `sh curl.sh`.
 * The header holds the spec location (control characters stripped) and a generic comment,
 * never the test title, which may hold secrets or terminal escape sequences.
 */
export function renderCurlScript(location: string | undefined, commands: readonly string[]): string {
  const where = location === undefined ? [] : [`# ${stripControl(location)}`];
  return `${['#!/bin/sh', ...where, GENERIC_COMMENT].join('\n')}\n\n${commands.join('\n\n')}\n`;
}

export interface CurlScriptOptions {
  /** Where the one-line notice goes. */
  log: (line: string) => void;
}

/**
 * Write the commands to `curl.sh` in the test's output directory, attach it
 * and print a notice. Never throws; nothing happens without commands.
 */
export async function writeCurlScript(
    commands: readonly string[],
    testInfo: TestInfoLike,
    options: CurlScriptOptions,
): Promise<void> {
  if (commands.length === 0) return;
  try {
    const file = testInfo.outputPath(CURL_SCRIPT);
    await fs.mkdir(path.dirname(file), { recursive: true });
    await fs.writeFile(file, renderCurlScript(specLocation(testInfo), commands), 'utf8');
    await testInfo.attach(CURL_SCRIPT, { path: file, contentType: 'text/plain' });
    options.log(CURL_SCRIPT_NOTICE);
  } catch (error) {
    warnOnce(`could not write ${CURL_SCRIPT}: ${error instanceof Error ? error.message : String(error)}`);
  }
}
