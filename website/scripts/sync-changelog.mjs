// Copies the root CHANGELOG.md to src/pages/changelog.md (git-ignored) with front matter.
// Runs before `start` and `build` (see package.json).
import * as fs from 'node:fs';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const source = path.resolve(here, '..', '..', 'CHANGELOG.md');
const target = path.resolve(here, '..', 'src', 'pages', 'changelog.md');

const body = fs.readFileSync(source, 'utf8').replace(/^﻿/, '');
const frontMatter = [
  '---',
  'title: Changelog',
  'description: Release notes of playwright-logger-pro.',
  'wrapperClassName: plp-changelog',
  '---',
  '',
  '<!-- Generated from CHANGELOG.md by website/scripts/sync-changelog.mjs. Do not edit. -->',
  '',
].join('\n');

fs.mkdirSync(path.dirname(target), { recursive: true });
fs.writeFileSync(target, frontMatter + body);
console.log(`changelog: ${path.relative(process.cwd(), target)} <- ${path.relative(process.cwd(), source)}`);
