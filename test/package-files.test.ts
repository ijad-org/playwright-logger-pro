import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as path from 'node:path';

const pkg = JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'package.json'), 'utf8')) as {
  files: string[];
  exports: Record<string, unknown>;
};

test('the npm tarball is a whitelist: docs/assets (screenshots), demo and scripts are not in it', () => {
  assert.deepEqual(pkg.files, ['dist', 'README.md', 'LICENSE', 'CHANGELOG.md']);
});

test('the reporter is an export of the package', () => {
  assert.ok('./reporter' in pkg.exports);
});
