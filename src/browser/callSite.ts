import { getRegistry } from './registry';

export interface CallSite {
  file: string;
  line: number;
  column: number;
}

/** `file:///C:/x/a.ts` -> `C:/x/a.ts`, `file:///home/u/my%20dir/a.ts` -> `/home/u/my dir/a.ts`. */
function fromFileUrl(url: string): string {
  let path = url.replace(/^file:\/\//, '');
  try {
    path = decodeURIComponent(path);
  } catch {
    // keep the raw spelling
  }
  return /^\/[A-Za-z]:[\\/]/.test(path) ? path.slice(1) : path;
}

/**
 * Parse one V8 stack frame line into its location. Both shapes are handled:
 * `at fn (/abs/file.ts:11:5)` and, for anonymous functions, `at /abs/file.ts:11:5`
 * (also `at async /abs/file.ts:11:5`). The `at ` prefix never ends up in `file`.
 * Node internals (`node:internal/...`), `<anonymous>` and eval frames give undefined.
 */
export function parseStackFrame(raw: string): CallSite | undefined {
  let s = raw.trim();
  if (!s.startsWith('at ')) return undefined;
  s = s.slice(3).trim();
  let location: string;
  const open = s.indexOf(' (');
  if (s.endsWith(')') && open !== -1) location = s.slice(open + 2, -1);
  else location = s.replace(/^async\s+/, '');
  if (/^eval at /.test(location)) return undefined;
  const m = /^(.+):(\d+):(\d+)$/.exec(location);
  if (!m) return undefined;
  const file = m[1].startsWith('file://') ? fromFileUrl(m[1]) : m[1];
  if (file.startsWith('node:') || file.startsWith('<') || file === 'native') return undefined;
  return { file, line: Number(m[2]), column: Number(m[3]) };
}

const norm = (p: string): string => {
  const slashed = p.replace(/\\/g, '/');
  // Windows paths compare case-insensitively.
  return /^[A-Za-z]:\//.test(slashed) ? slashed.toLowerCase() : slashed;
};

/** Playwright's own packages, wherever they are installed. */
const PLAYWRIGHT_PACKAGE = /\/node_modules\/(?:@playwright\/|playwright(?:-core|-test)?\/)/;

/** True for frames inside this library or Playwright (never the user's code). */
export function isLibraryFile(file: string, libDirs: readonly string[], pwDirs: readonly string[] = []): boolean {
  const f = norm(file);
  if (PLAYWRIGHT_PACKAGE.test(f)) return true;
  return [...libDirs, ...pwDirs].some((d) => d.length > 0 && f.startsWith(norm(d)));
}

/** First frame of `stack` that is neither ours, Playwright's, nor a node internal. */
export function pickCallSite(
    stack: string,
    libDirs: readonly string[],
    pwDirs: readonly string[] = [],
): CallSite | undefined {
  for (const raw of stack.split('\n')) {
    const frame = parseStackFrame(raw);
    if (!frame || isLibraryFile(frame.file, libDirs, pwDirs)) continue;
    return frame;
  }
  return undefined;
}

/** The user's call site (spec file:line) for the call being made right now. */
export function callSite(
    libDirs: Iterable<string>,
    pwDirs: readonly string[] = getRegistry().pwDirs,
): CallSite | undefined {
  const limit = Error.stackTraceLimit;
  Error.stackTraceLimit = 40;
  const stack = new Error().stack ?? '';
  Error.stackTraceLimit = limit;
  return pickCallSite(stack, [...libDirs], pwDirs);
}
