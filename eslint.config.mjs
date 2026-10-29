// @ts-check
import eslint from '@eslint/js';
import tseslint from 'typescript-eslint';

export default tseslint.config(
  { ignores: ['dist/', 'node_modules/'] },
  eslint.configs.recommended,
  tseslint.configs.recommended,
  {
    // Tests match ANSI/control sequences on purpose.
    files: ['test/**/*.ts'],
    rules: { 'no-control-regex': 'off' },
  },
);
