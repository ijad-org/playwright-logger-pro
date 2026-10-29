import { defineConfig } from 'tsup';

export default defineConfig({
  entry: ['src/index.ts', 'src/fixtures.ts'],
  format: ['cjs', 'esm'],
  dts: true,
  sourcemap: true,
  clean: true,
  // __dirname / import.meta.url for the library directory (src/libDir.ts)
  shims: true,
  target: 'node16',
  external: ['@playwright/test', 'playwright-core'],
});
