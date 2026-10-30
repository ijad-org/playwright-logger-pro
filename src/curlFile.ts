import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import { pathToFileURL } from 'node:url';
import type { TestInfoLike } from './browser/output';
import { warnOnce } from './warn';

/** Name of the script written to the test's output directory and attached to the report. */
export const CURL_SCRIPT = 'curl.sh';

/** Contents of `curl.sh`: the plain, redacted commands of a test, ready for `sh curl.sh`. */
export function renderCurlScript(title: string, commands: readonly string[]): string {
  // The title is a comment: a line break in it would start a command.
  const heading = title.replace(/\s*[\r\n\u2028\u2029]+\s*/g, ' ').trim();
  return `#!/bin/sh\n# ${heading}\n\n${commands.join('\n\n')}\n`;
}

/** `text` as a clickable terminal link (OSC 8) to the file at `file`. */
export function terminalLink(file: string, text: string): string {
  return `\u001b]8;;${pathToFileURL(file).href}\u001b\\${text}\u001b]8;;\u001b\\`;
}

/** CI services set CI; "0" and "false" mean off like they do for the colour variables. */
function inCI(env: Record<string, string | undefined>): boolean {
  const value = env.CI;
  return Boolean(value) && value !== '0' && value!.toLowerCase() !== 'false';
}

export interface CurlScriptOptions {
  /** Where the one-line "curl.sh: <path>" notice goes. */
  log: (line: string) => void;
  /** Colours are on for the console (default console sink); the path becomes a link if stdout is a TTY too. */
  consoleColors: boolean;
}

/**
 * Write the commands to `curl.sh` in the test's output directory, attach it
 * and print where it is. Never throws; nothing happens without commands.
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
    await fs.writeFile(file, renderCurlScript(testInfo.title, commands), 'utf8');
    await testInfo.attach(CURL_SCRIPT, { path: file, contentType: 'text/plain' });
    const shown = path.relative(process.cwd(), file) || file;
    const link = options.consoleColors && Boolean(process.stdout.isTTY) && !inCI(process.env);
    options.log(`${CURL_SCRIPT}: ${link ? terminalLink(file, shown) : shown}`);
  } catch (error) {
    warnOnce(`could not write ${CURL_SCRIPT}: ${error instanceof Error ? error.message : String(error)}`);
  }
}
