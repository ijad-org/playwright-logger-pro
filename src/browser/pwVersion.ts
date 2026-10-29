import * as path from 'node:path';
import { createRequire } from 'node:module';
import { LIB_DIR } from '../libDir';

let cached: string | undefined | null = null;

/** Version of the user's `@playwright/test` (e.g. "1.48.2"), or undefined if it cannot be read. */
export function playwrightVersion(): string | undefined {
  if (cached !== null) return cached;
  try {
    const req = createRequire(path.join(LIB_DIR, 'noop.js'));
    cached = (req('@playwright/test/package.json') as { version?: string }).version;
  } catch {
    cached = undefined;
  }
  return cached;
}

/** True when `version` is at least `major.minor`. Unknown versions are never "at least". */
export function atLeast(version: string | undefined, major: number, minor: number): boolean {
  const m = /^(\d+)\.(\d+)/.exec(version ?? '');
  if (!m) return false;
  const [maj, min] = [Number(m[1]), Number(m[2])];
  return maj > major || (maj === major && min >= minor);
}

/** `test.step(title, body, { location })` is honoured from Playwright 1.48. */
export function honoursStepLocation(): boolean {
  return atLeast(playwrightVersion(), 1, 48);
}
