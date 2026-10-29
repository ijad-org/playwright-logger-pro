const PREFIX = '[playwright-logger-pro]';
const seen = new Set<string>();

/**
 * Print `message` to the console once per process. The logger never throws
 * for a bad option or a failing sink, so this is how the user finds out.
 */
export function warnOnce(message: string): void {
  if (seen.has(message)) return;
  seen.add(message);
  try {
    console.warn(`${PREFIX} ${message}`);
  } catch {
    // a broken console must not fail the request either
  }
}

/** Forget which warnings were printed. For tests. */
export function resetWarnings(): void {
  seen.clear();
}

/** A short, single-line description of a bad value for a warning. */
export function describeValue(value: unknown): string {
  if (value === null) return 'null';
  if (Array.isArray(value)) return 'an array';
  if (typeof value === 'string') {
    return `the string ${JSON.stringify(value.length > 40 ? `${value.slice(0, 40)}…` : value)}`;
  }
  if (typeof value === 'number' || typeof value === 'boolean' || typeof value === 'undefined') {
    return `${typeof value} ${String(value)}`;
  }
  return `a ${typeof value}`;
}
