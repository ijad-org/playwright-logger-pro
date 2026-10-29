/**
 * Fail if a planted canary secret shows up anywhere it must not: stdout, the
 * test-results directory (attachments, files) or a JSON report.
 *
 *   tsx scripts/assert-no-canary.ts <canary> <file-or-dir>...
 */
import * as fs from 'node:fs';
import * as path from 'node:path';

/** Paths (files, recursively under dirs) whose bytes contain `canary`. */
export function findCanary(canary: string, roots: readonly string[]): string[] {
  const hits: string[] = [];
  const needle = Buffer.from(canary);
  const visit = (p: string): void => {
    let stat: fs.Stats;
    try {
      stat = fs.statSync(p);
    } catch {
      return;
    }
    if (stat.isDirectory()) {
      for (const name of fs.readdirSync(p)) visit(path.join(p, name));
    } else if (stat.isFile() && stat.size < 64 * 1024 * 1024 && fs.readFileSync(p).includes(needle)) {
      hits.push(p);
    }
  };
  roots.forEach(visit);
  return hits;
}

if (require.main === module) {
  const [canary, ...roots] = process.argv.slice(2);
  if (!canary || roots.length === 0) {
    console.error('usage: assert-no-canary <canary> <file-or-dir>...');
    process.exit(2);
  }
  const hits = findCanary(canary, roots);
  if (hits.length > 0) {
    console.error(`canary found in:\n${hits.map((h) => `  ${h}`).join('\n')}`);
    process.exit(1);
  }
  console.log('no canary found');
}
