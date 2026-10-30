import * as fs from 'node:fs';
import * as path from 'node:path';
import { test } from '../lib';

// Run through `node scripts/perf.mjs` (excluded from the normal run by the @perf tag).
const label = process.env.PLP_PERF_LABEL ?? 'enabled';
test.use({ browserLog: { enabled: label !== 'disabled' } });

test('@perf 500 fill and 500 click calls on a static page', async ({ page }, testInfo) => {
  // ~1000 actions at 10-50 ms each (a click waits for a stable frame) overrun the suite's 20 s default on slow CI runners.
  test.setTimeout(180_000);
  await page.goto('/');
  const input = page.locator('#text');
  const button = page.locator('#go');
  // warm up
  for (let i = 0; i < 20; i++) {
    await input.fill(`w${i}`);
    await button.click();
  }
  const t0 = performance.now();
  for (let i = 0; i < 500; i++) await input.fill(`value ${i}`);
  const t1 = performance.now();
  for (let i = 0; i < 500; i++) await button.click();
  const t2 = performance.now();
  const out = process.env.PLP_PERF_OUT ?? testInfo.outputPath('perf.json');
  fs.mkdirSync(path.dirname(out), { recursive: true });
  fs.writeFileSync(out, JSON.stringify({ label, fillMs: t1 - t0, clickMs: t2 - t1 }));
});
