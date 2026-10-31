// @ts-check
import eslint from '@eslint/js';
import tseslint from 'typescript-eslint';

export default tseslint.config(
  // website/ is a separate project (its own package.json and tooling); build outputs are generated.
  { ignores: ['dist/', 'node_modules/', 'website/', 'test-results/', 'playwright-report/', 'blob-report/'] },
  eslint.configs.recommended,
  tseslint.configs.recommended,
  {
    // Plain Node scripts, the e2e server and the meta reporter (no TypeScript, no bundler).
    files: ['scripts/**/*.mjs', 'scripts/**/*.cjs', 'e2e/**/*.mjs', 'e2e/**/*.cjs', 'demo/**/*.mjs'],
    languageOptions: {
      globals: {
        process: 'readonly', console: 'readonly', URL: 'readonly', require: 'readonly', setTimeout: 'readonly',
        module: 'writable', __dirname: 'readonly',
      },
    },
    rules: { '@typescript-eslint/no-require-imports': 'off' },
  },
  {
    // Tests match ANSI/control sequences on purpose.
    files: ['test/**/*.ts'],
    rules: { 'no-control-regex': 'off' },
  },
);
