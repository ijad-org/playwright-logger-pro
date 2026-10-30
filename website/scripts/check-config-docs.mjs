// Fails when docs/configuration.mdx and the library disagree.
//
// Source of truth: the option interfaces in ../src (read with the TypeScript compiler, so optional
// options such as baseURL/fileDir are included) and the exported defaults of the built library
// (../dist, run `npx tsup` in the repository root first).
//
// The docs mark each table with a comment: {/* config-table: apiLog */}. Checked per table:
//   - every option of the interface is documented, and nothing else is (missing / extra)
//   - the documented default contains the literal default for booleans, numbers and strings,
//     and mentions every element of a string-array default
// Tables marked {/* config-table: exports-index */} or exports-fixtures list exported names; each
// must exist in src/index.ts / src/fixtures.ts.
import * as fs from 'node:fs';
import * as path from 'node:path';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import ts from 'typescript';

const here = path.dirname(fileURLToPath(import.meta.url));
const site = path.resolve(here, '..');
const root = path.resolve(site, '..');
const require = createRequire(import.meta.url);

const docFile = path.join(site, 'docs', 'configuration.mdx');
const dist = path.join(root, 'dist', 'index.js');
if (!fs.existsSync(dist)) {
  console.error(`check-config-docs: ${path.relative(process.cwd(), dist)} not found. Build the library first (npx tsup in the repository root).`);
  process.exit(2);
}
const lib = require(dist);

// ---- TypeScript: option names per interface, and exported names per entry point ----
const program = ts.createProgram([path.join(root, 'src/index.ts'), path.join(root, 'src/fixtures.ts')], {
  target: ts.ScriptTarget.ES2022,
  module: ts.ModuleKind.ESNext,
  moduleResolution: ts.ModuleResolutionKind.Bundler,
  strict: true,
  skipLibCheck: true,
  noEmit: true,
  types: [],
});
const checker = program.getTypeChecker();
function exportsOf(file) {
  const sf = program.getSourceFile(path.join(root, file));
  const sym = checker.getSymbolAtLocation(sf);
  return new Map(checker.getExportsOfModule(sym).map((s) => [s.name, s]));
}
const indexExports = exportsOf('src/index.ts');
const fixturesExports = exportsOf('src/fixtures.ts');

function members(name) {
  let sym = indexExports.get(name);
  if (!sym) throw new Error(`interface ${name} is not exported from src/index.ts`);
  if (sym.flags & ts.SymbolFlags.Alias) sym = checker.getAliasedSymbol(sym);
  return checker.getDeclaredTypeOfSymbol(sym).getProperties().map((p) => p.name);
}

const TABLES = {
  apiLog: { keys: members('ApiLoggerConfig'), defaults: lib.DEFAULT_CONFIG, skipDefault: ['colors', 'sink'] },
  browserLog: {
    keys: members('BrowserLoggerConfig'),
    defaults: lib.DEFAULT_BROWSER_CONFIG,
    skipDefault: ['colors', 'sink', 'redact'],
  },
  'browserLog.redact': { keys: members('BrowserRedactConfig'), defaults: lib.DEFAULT_BROWSER_CONFIG.redact, skipDefault: ['selectors', 'keys'] },
  'curl-options': { keys: members('CurlOptions'), defaults: {}, skipDefault: [] },
};

// ---- Parse the docs ----
const text = fs.readFileSync(docFile, 'utf8');
const lines = text.split('\n');
const documented = new Map(); // table id -> Map(option -> default cell)
for (let i = 0; i < lines.length; i++) {
  const marker = lines[i].match(/^\{\/\*\s*config-table:\s*([\w.-]+)\s*\*\/\}\s*$/);
  if (!marker) continue;
  const rows = new Map();
  for (let j = i + 1; j < lines.length; j++) {
    const line = lines[j];
    if (line.trim() === '') { if (rows.size > 0) break; continue; }
    if (!line.startsWith('|')) break;
    const cells = line.replace(/^\||\|$/g, '').split(/(?<!\\)\|/).map((c) => c.trim());
    const name = cells[0].match(/^`([^`]+)`$/)?.[1];
    if (name) rows.set(name, cells[2] ?? '');
  }
  if (documented.has(marker[1])) throw new Error(`duplicate config-table: ${marker[1]}`);
  documented.set(marker[1], rows);
}

const problems = [];
const literal = (v) => (typeof v === 'string' ? `'${v}'` : String(v));

for (const [id, spec] of Object.entries(TABLES)) {
  const rows = documented.get(id);
  if (!rows) { problems.push(`table "${id}" is missing from configuration.mdx (marker {/* config-table: ${id} */})`); continue; }
  for (const key of spec.keys) if (!rows.has(key)) problems.push(`[${id}] option "${key}" exists in the library but is not documented`);
  for (const key of rows.keys()) if (!spec.keys.includes(key)) problems.push(`[${id}] "${key}" is documented but is not an option of the library`);
  for (const key of spec.keys) {
    if (!rows.has(key) || spec.skipDefault.includes(key) || !(key in spec.defaults)) continue;
    const value = spec.defaults[key];
    const cell = rows.get(key);
    if (['boolean', 'number', 'string'].includes(typeof value)) {
      if (!cell.includes(`\`${literal(value)}\``)) problems.push(`[${id}] default of "${key}" should show \`${literal(value)}\`, docs say: ${cell || '(empty)'}`);
    } else if (Array.isArray(value)) {
      for (const el of value) if (typeof el === 'string' && !cell.includes(el)) problems.push(`[${id}] default of "${key}" should mention "${el}", docs say: ${cell || '(empty)'}`);
      if (value.length === 0 && !cell.includes('[]')) problems.push(`[${id}] default of "${key}" should show \`[]\`, docs say: ${cell || '(empty)'}`);
    }
  }
  documented.delete(id);
}

for (const [id, rows] of documented) {
  const exportsMap = id === 'exports-index' ? indexExports : id === 'exports-fixtures' ? fixturesExports : null;
  if (!exportsMap) { problems.push(`unknown config-table id "${id}"`); continue; }
  for (const name of rows.keys()) if (!exportsMap.has(name)) problems.push(`[${id}] "${name}" is documented but not exported`);
}

if (problems.length) {
  console.error(`check-config-docs: ${problems.length} problem(s) in docs/configuration.mdx\n  - ${problems.join('\n  - ')}`);
  process.exit(1);
}
console.log(`check-config-docs: ok (${Object.keys(TABLES).length} option tables, ${documented.size} export tables)`);
