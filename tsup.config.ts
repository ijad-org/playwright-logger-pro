import { defineConfig } from 'tsup';

export default defineConfig({
  entry: ['src/index.ts', 'src/fixtures.ts', 'src/reporter.ts'],
  format: ['cjs', 'esm'],
  dts: true,
  // No source maps: Playwright maps every frame of every API call's stack through them, which
  // costs ~2 points of overhead on the fastest calls (see docs/adr/0001-browser-capture.md).
  sourcemap: false,
  clean: true,
  // __dirname / import.meta.url for the library directory (src/libDir.ts)
  shims: true,
  target: 'node16',
  external: ['@playwright/test', 'playwright-core'],
});
