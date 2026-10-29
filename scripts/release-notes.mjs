// Prints the GitHub Release notes for a tag: a generated header, the version's section of
// CHANGELOG.md, install and upgrade instructions and a footer.
//
//   node scripts/release-notes.mjs v0.2.0 > release-notes.md
//
// The CHANGELOG heading may be "## 0.2.0" or "## [0.2.0] - 2026-01-12". A stable tag needs its
// section (exit 1 without it); a pre-release tag (version contains "-") falls back to the
// "Unreleased" section, or to a short note.
import * as fs from 'node:fs';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const pkg = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8'));

const tag = process.argv[2];
if (!tag || !/^v\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/.test(tag)) {
  console.error('usage: node scripts/release-notes.mjs v<version>   (for example v0.2.0 or v0.2.0-rc.1)');
  process.exit(2);
}
const version = tag.slice(1);
const prerelease = version.includes('-');

const repoUrl = String(pkg.repository?.url ?? '')
  .replace(/^git\+/, '')
  .replace(/\.git$/, '');
const docsUrl = String(pkg.homepage ?? '').replace(/\/?$/, '/');

/** Body of the level-2 section whose heading names `name`, or undefined. */
function section(markdown, name) {
  const lines = markdown.split(/\r?\n/);
  const escaped = name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const heading = new RegExp(`^##\\s+(?:\\[${escaped}\\]|${escaped})(?:\\s+-\\s+.*)?\\s*$`, 'i');
  const start = lines.findIndex((line) => heading.test(line));
  if (start === -1) return undefined;
  let end = lines.findIndex((line, i) => i > start && /^##\s/.test(line));
  if (end === -1) end = lines.length;
  return lines.slice(start + 1, end).join('\n').trim();
}

const changelog = fs.readFileSync(path.join(root, 'CHANGELOG.md'), 'utf8');
let changes = section(changelog, version);
if (!changes) {
  if (!prerelease) {
    console.error(`CHANGELOG.md has no section for ${version} ("## ${version}" or "## [${version}] - YYYY-MM-DD")`);
    process.exit(1);
  }
  changes = section(changelog, 'Unreleased') || 'Pre-release build for testing. See CHANGELOG.md for the changes so far.';
}

const install = prerelease ?
  [
    '## Install',
    '',
    `This is a pre-release and is **not published to npm**. Install the attached tarball:`,
    '',
    '```sh',
    `npm i -D ./playwright-logger-pro-${version}.tgz`,
    '```',
  ] :
  [
    '## Install',
    '',
    '```sh',
    `npm i -D playwright-logger-pro@${version}   # @playwright/test >= 1.30, Node.js >= 18`,
    '```',
  ];

const supply = prerelease ?
  [] :
  [
    '## Supply chain',
    '',
    `Published from GitHub Actions with npm provenance: https://www.npmjs.com/package/${pkg.name}/v/${version} (see "Provenance").`,
    '',
  ];

// A release's own "Known limitations" section (in the CHANGELOG) replaces the standing list.
const limitations = /^#{2,4}\s+Known limitations\s*$/im.test(changes) ?
  [] :
  [
    '## Known limitations',
    '',
    '- curl output targets POSIX shells (bash, zsh, Git Bash, WSL).',
    "- Playwright's own traces, HTML-report step titles and `error-context.md` record raw action parameters; this library only redacts its own output.",
    '- `page.request` / `context.request` traffic is not logged by the browser log.',
    '',
  ];

const notes = [
  `# Playwright Logger Pro ${version}${prerelease ? ' (pre-release)' : ''}`,
  '',
  `Colourful API and browser-action logging for Playwright tests. Documentation: ${docsUrl}`,
  '',
  '## What changed',
  '',
  changes,
  '',
  ...install,
  '',
  '## Upgrading from playwright-colorful-logger',
  '',
  '1. `npm uninstall playwright-colorful-logger && npm i -D playwright-logger-pro`',
  '2. Replace `playwright-colorful-logger` with `playwright-logger-pro` in your imports (including `/fixtures`).',
  `3. Read the behaviour changes above and the migration guide: ${docsUrl}docs/migration`,
  '',
  ...limitations,
  ...supply,
  `**Full changelog:** ${repoUrl}/blob/${tag}/CHANGELOG.md`,
  '',
];
process.stdout.write(notes.join('\n'));
