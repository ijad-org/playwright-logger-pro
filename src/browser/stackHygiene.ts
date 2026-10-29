import * as path from 'node:path';
import { pathToFileURL } from 'node:url';
import { createRequire } from 'node:module';
import { LIB_DIR, LIB_DIRS } from '../libDir';
import { getRegistry } from './registry';

/**
 * Playwright attributes a step / error to the first stack frame outside its
 * own packages. Any wrapper between the test and Playwright (our patched
 * methods, the apiLog Proxy) would become that frame, so we ask Playwright to
 * hide our directory. See docs/adr/0001-browser-capture.md.
 */
export type HygieneMode = 'boxed' | 'ignoreFilter' | 'internalPrefix' | 'fallback';

export interface HygieneDeps {
  /** require() resolved from the user's Playwright install; throws if the module is missing. */
  load(id: string): unknown;
  /** Directory of the `playwright` package (newer versions), used for the boxed-prefix list. */
  playwrightRoot?: string;
}

interface Utils {
  setBoxedStackPrefixes?: (prefixes: string[]) => void;
  addStackIgnoreFilter?: (filter: (frame: { file: string }) => boolean) => void;
  addInternalStackPrefix?: (prefix: string) => void;
}

function tryLoad(deps: HygieneDeps, id: string): Record<string, unknown> | undefined {
  try {
    return deps.load(id) as Record<string, unknown>;
  } catch {
    return undefined;
  }
}

/**
 * Pick and apply the first working adapter. Pure with respect to its
 * arguments, so it is unit-tested with fake module maps.
 *
 * a. 1.6x:        playwright-core/lib/coreBundle -> utils.setBoxedStackPrefixes
 * b. 1.30:        playwright-core/lib/utils      -> addStackIgnoreFilter
 *    1.39-1.48:   playwright-core/lib/utils      -> addInternalStackPrefix
 * c. otherwise:   'fallback' (caller scrubs our frames from error stacks)
 */
export function applyHygiene(deps: HygieneDeps, dirs: readonly string[]): HygieneMode {
  // Frames of ES modules are reported as file:// URLs (and with a loader such as tsx
  // the same is true for TypeScript sources), so hide both spellings.
  const libDirs = dirs.flatMap((d) => [d, `${pathToFileURL(d).href.replace(/\/?$/, '/')}`]);
  const bundle = tryLoad(deps, 'playwright-core/lib/coreBundle');
  const bundleUtils = bundle?.utils as Utils | undefined;
  if (bundleUtils && typeof bundleUtils.setBoxedStackPrefixes === 'function') {
    const prefixes = [...(deps.playwrightRoot ? [deps.playwrightRoot] : []), ...libDirs];
    bundleUtils.setBoxedStackPrefixes(prefixes);
    return 'boxed';
  }

  const utils = tryLoad(deps, 'playwright-core/lib/utils') as Utils | undefined;
  if (utils && typeof utils.addStackIgnoreFilter === 'function') {
    // The filter reads the live registry list so later copies of this module can add directories.
    utils.addStackIgnoreFilter((frame) => {
      const file = frame && frame.file;
      if (typeof file !== 'string') return false;
      const plain = file.startsWith('file://') ? decodeURIComponent(file.slice('file://'.length)) : file;
      return [...getRegistry().libDirs].some((d) => plain.startsWith(d));
    });
    return 'ignoreFilter';
  }
  if (utils && typeof utils.addInternalStackPrefix === 'function') {
    for (const dir of libDirs) utils.addInternalStackPrefix(dir);
    return 'internalPrefix';
  }
  return 'fallback';
}

function resolvePlaywright(): { deps: HygieneDeps; pwDirs: string[] } | undefined {
  try {
    const own = createRequire(path.join(LIB_DIR, 'noop.js'));
    const testMain = own.resolve('@playwright/test');
    const fromTest = createRequire(testMain);
    let fromPlaywright = fromTest;
    let playwrightRoot: string | undefined;
    const versionOf = (req: NodeRequire, id: string): string | undefined => {
      try {
        return (req(`${id}/package.json`) as { version?: string }).version;
      } catch {
        return undefined;
      }
    };
    const testVersion = versionOf(fromTest, '@playwright/test');
    try {
      // Only trust a `playwright` package that belongs to this install (NODE_PATH
      // or a hoisted copy of another version must not be picked up).
      if (versionOf(fromTest, 'playwright') === testVersion) {
        playwrightRoot = path.dirname(fromTest.resolve('playwright/package.json'));
        fromPlaywright = createRequire(fromTest.resolve('playwright'));
      }
    } catch {
      // 1.30: @playwright/test depends on playwright-core directly
    }
    const pwDirs: string[] = [];
    const add = (resolve: () => string): void => {
      try {
        pwDirs.push(path.dirname(resolve()) + path.sep);
      } catch {
        // ignore
      }
    };
    add(() => fromTest.resolve('@playwright/test/package.json'));
    if (playwrightRoot) pwDirs.push(playwrightRoot + path.sep);
    add(() => fromPlaywright.resolve('playwright-core/package.json'));
    return { deps: { load: (id) => fromPlaywright(id), playwrightRoot }, pwDirs };
  } catch {
    return undefined;
  }
}

/**
 * Idempotent. Registers LIB_DIR with the user's Playwright. Returns the mode
 * used ('fallback' also when Playwright cannot be located).
 */
export function ensureStackHygiene(): HygieneMode {
  const reg = getRegistry();
  const known = reg.libDirs.has(LIB_DIR);
  for (const dir of LIB_DIRS) reg.libDirs.add(dir);
  if (known && reg.hygiene) return reg.hygiene.mode as HygieneMode;

  const pw = resolvePlaywright();
  let mode: HygieneMode = 'fallback';
  if (pw) {
    for (const dir of pw.pwDirs) if (!reg.pwDirs.includes(dir)) reg.pwDirs.push(dir);
    try {
      mode = applyHygiene(pw.deps, [...reg.libDirs]);
    } catch {
      mode = 'fallback';
    }
  }
  reg.hygiene = { mode };
  if (mode === 'fallback' && process.env.DEBUG && /plp/.test(process.env.DEBUG)) {
    console.warn('[playwright-logger-pro] could not hide library frames from Playwright; ' +
      'step locations may point into the library.');
  }
  return mode;
}

/** Fallback for mode 'fallback': drop our frames from an error's stack. */
export function scrubOwnFrames(err: unknown, libDirs: Iterable<string> = getRegistry().libDirs): void {
  if (!err || typeof err !== 'object') return;
  const dirs = [...libDirs];
  try {
    const e = err as { stack?: unknown };
    if (typeof e.stack !== 'string') return;
    const kept = e.stack.split('\n').filter((line) => !dirs.some((d) => line.includes(d)));
    e.stack = kept.join('\n');
  } catch {
    // stack may be read-only; nothing to do
  }
}

/**
 * True if the first non-library frame of the current stack is inside a
 * Playwright package, i.e. the call comes from Playwright's own fixtures
 * (browser.newContext / context.newPage during fixture setup, page.screenshot
 * from the artifacts fixture) rather than from user code.
 */
export function calledFromRunner(): boolean {
  const reg = getRegistry();
  if (reg.pwDirs.length === 0) return false;
  const limit = Error.stackTraceLimit;
  Error.stackTraceLimit = 15;
  const stack = new Error().stack ?? '';
  Error.stackTraceLimit = limit;
  const dirs = [...reg.libDirs];
  for (const line of stack.split('\n').slice(1)) {
    if (line.includes('node:internal') || line.includes('(native)')) continue;
    if (dirs.some((d) => line.includes(d))) continue;
    return reg.pwDirs.some((d) => line.includes(d));
  }
  return false;
}
