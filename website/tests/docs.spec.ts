import { test, expect, type Page } from '@playwright/test';

/** Wait until the page is hydrated: the shortcuts only work after that. */
const ready = (page: Page) => page.locator('button[data-ready="true"]').waitFor();
const dialog = (page: Page) => page.getByRole('dialog', { name: 'Search the documentation' });

test('home page renders', async ({ page }) => {
  await page.goto('./');
  await expect(page.getByRole('heading', { level: 1 })).toContainText('Playwright tests you can read');
  await expect(page.getByRole('link', { name: 'Get started' })).toBeVisible();
  await expect(page.getByRole('link', { name: 'View on GitHub' })).toBeVisible();
  await expect(page.getByRole('link', { name: 'GitHub repository' })).toBeVisible();
  await expect(page.getByRole('link', { name: 'npm package' })).toBeVisible();
});

test.describe('terminal sample', () => {
  const rgb = (hex: string) => {
    const n = parseInt(hex.slice(1), 16);
    return `rgb(${n >> 16}, ${(n >> 8) & 255}, ${n & 255})`;
  };

  for (const theme of ['light', 'dark']) {
    test(`home hero shows the compact output with its 500 detail block on a dark panel (${theme} theme)`, async ({ page }) => {
      await page.addInitScript((t) => localStorage.setItem('theme', t), theme);
      await page.goto('./');
      const terminal = page.locator('figure', { hasText: 'curl -X POST' });
      await expect(terminal).toBeVisible();
      await expect(terminal).toHaveCSS('background-color', rgb('#000000'));

      const code = terminal.locator('code');
      await expect(code).not.toContainText('\u001b');
      await expect(code).toContainText('← 500 Internal Server Error  {"error":"payment gateway timeout"}');
      await expect(code).toContainText('↳ replay: curl.sh attached to the HTML report');
      await expect(code).toContainText('8 requests · 2 errors · 1 slow ≥1s');
      const span = (text: string) => code.locator('span', { hasText: new RegExp(`^${text}$`) });
      // chips: black text on yellow for the 404, white on red for the 500, no extra characters
      await expect(span('404').first()).toHaveCSS('background-color', rgb('#facc15'));
      await expect(span('404').first()).toHaveCSS('color', rgb('#000000'));
      await expect(span('500').first()).toHaveCSS('background-color', rgb('#f87171'));
      await expect(span('500').first()).toHaveCSS('color', rgb('#ffffff'));
      // the masked values
      await expect(span('\\*\\*\\*').first()).toHaveCSS('background-color', rgb('#7f7f7f'));
    });
  }
});

test.describe('hero terminal is not clipped', () => {
  for (const width of [1280, 1400, 1920]) {
    test(`at ${width}px the whole compact output fits in the hero panel`, async ({ page }) => {
      await page.setViewportSize({ width, height: 900 });
      await page.goto('./');
      const terminal = page.locator('figure', { hasText: 'curl -X POST' });
      const pre = terminal.locator('pre');
      await expect(pre).toBeVisible();
      await expect(pre).toHaveCSS('overflow-x', 'auto');
      await expect(pre).toHaveCSS('white-space', 'pre');
      const code = terminal.locator('code');
      await expect(code).toContainText("│ curl -X POST 'https://api.shop.test/v1/checkout?token=***&currency=EUR' \\");
      await expect(code).toContainText('POST   500  https://api.shop.test/v1/checkout?token=***&currency=EUR   ▲ 1.83s');
      const m = await pre.evaluate((el) => ({ scroll: el.scrollWidth, client: el.clientWidth }));
      expect(m.scroll, `scrollWidth ${m.scroll} > clientWidth ${m.client}`).toBeLessThanOrEqual(m.client);
      // the panel itself is inside the viewport
      const box = (await terminal.boundingBox())!;
      expect(box.x).toBeGreaterThanOrEqual(0);
      expect(box.x + box.width).toBeLessThanOrEqual(width);
    });
  }

  test('on a narrow screen lines never wrap and the panel scrolls horizontally', async ({ page }) => {
    await page.setViewportSize({ width: 390, height: 800 });
    await page.goto('./');
    const pre = page.locator('figure', { hasText: 'curl -X POST' }).locator('pre');
    await expect(pre).toHaveCSS('overflow-x', 'auto');
    await expect(pre).toHaveCSS('white-space', 'pre');
    const m = await pre.evaluate((el) => ({ scroll: el.scrollWidth, client: el.clientWidth }));
    expect(m.scroll).toBeGreaterThan(m.client);
  });
});

test.describe('search', () => {
  test('Ctrl+K opens the dialog with topics, typing finds pages and headings, Enter navigates', async ({ page }) => {
    await page.goto('docs/intro');
    await ready(page);
    await page.keyboard.press('Control+k');
    await expect(dialog(page)).toBeVisible();
    await expect(page.getByRole('combobox')).toBeFocused();

    // Empty query: topics from the sidebar.
    const topics = page.getByRole('listbox', { name: 'Topics' });
    await expect(topics.getByRole('option', { name: 'Redaction & security' })).toBeVisible();
    await expect(topics.getByRole('option', { name: 'Configuration' })).toBeVisible();
    await expect(dialog(page).getByRole('status')).toContainText('topics');

    await page.getByRole('combobox').fill('redact');
    const results = page.getByRole('listbox', { name: 'Search results' });
    await expect(results.getByRole('option').first()).toBeVisible();
    await expect(dialog(page).getByRole('status')).toContainText(/\d+ results?/);
    const labels = await results.getByRole('option').evaluateAll((els) => els.map((e) => e.getAttribute('aria-label')));
    expect(labels.some((l) => l && l.includes('Redaction & security') && !l.includes('›'))).toBeTruthy(); // a page
    expect(labels.some((l) => l && l.includes('›'))).toBeTruthy(); // "Page › Heading"

    await page.keyboard.press('ArrowDown');
    await expect(page.getByRole('combobox')).toHaveAttribute('aria-activedescendant', /.+/);
    await page.keyboard.press('Enter');
    await expect(dialog(page)).toBeHidden();
    await expect(page).not.toHaveURL(/docs\/intro/);
    expect(page.url()).toContain('_highlight=');
  });

  test('Esc closes and returns focus; slash opens when not typing; Tab is trapped', async ({ page }) => {
    await page.goto('docs/intro');
    await ready(page);
    const trigger = page.getByRole('button', { name: 'Search', exact: true });
    await trigger.focus();
    await page.keyboard.press('Enter');
    await expect(dialog(page)).toBeVisible();
    for (let i = 0; i < 6; i++) {
      await page.keyboard.press('Tab');
      await expect(dialog(page).locator(':focus')).toHaveCount(1);
    }
    await page.keyboard.press('Escape');
    await expect(dialog(page)).toBeHidden();
    await expect(trigger).toBeFocused();

    await page.locator('body').click({ position: { x: 5, y: 300 } });
    await page.keyboard.press('/');
    await expect(dialog(page)).toBeVisible();
    // A slash typed in the search field is text, not a shortcut.
    await page.getByRole('combobox').fill('a/b');
    await expect(page.getByRole('combobox')).toHaveValue('a/b');
  });

  test('no requests to other hosts', async ({ page, baseURL }) => {
    const origin = new URL(baseURL!).origin;
    const foreign: string[] = [];
    page.on('request', (r) => { if (!r.url().startsWith(origin) && !r.url().startsWith('data:')) foreign.push(r.url()); });
    await page.goto('docs/intro');
    await ready(page);
    await page.keyboard.press('Control+k');
    await page.getByRole('combobox').fill('curl');
    await expect(page.getByRole('listbox', { name: 'Search results' }).getByRole('option').first()).toBeVisible();
    expect(foreign).toEqual([]);
  });

  test('full-screen on mobile', async ({ page }) => {
    await page.emulateMedia({ reducedMotion: 'reduce' });
    await page.setViewportSize({ width: 360, height: 800 });
    await page.goto('docs/intro');
    await ready(page);
    await page.getByRole('button', { name: 'Search', exact: true }).click();
    const box = await dialog(page).boundingBox();
    expect(box).toMatchObject({ x: 0, y: 0, width: 360, height: 800 });
  });
});

test.describe('theme toggle', () => {
  test('cycles light, dark, system and persists', async ({ page }) => {
    await page.emulateMedia({ colorScheme: 'light' });
    await page.goto('docs/intro');
    const html = page.locator('html');
    const toggle = page.getByRole('button', { name: /Switch between dark and light mode/ });
    // respectPrefersColorScheme: starts in system mode (follows the OS)
    await expect(toggle).toHaveAttribute('aria-label', /system mode/);
    await expect(html).toHaveAttribute('data-theme', 'light');

    await toggle.click(); // -> light
    await expect(toggle).toHaveAttribute('aria-label', /light mode/);
    await toggle.click(); // -> dark
    await expect(toggle).toHaveAttribute('aria-label', /dark mode/);
    await expect(html).toHaveAttribute('data-theme', 'dark');

    await page.reload(); // choice persists
    await expect(html).toHaveAttribute('data-theme', 'dark');
    await expect(page.getByRole('button', { name: /currently dark mode/ })).toBeVisible();

    await page.getByRole('button', { name: /Switch between/ }).click(); // -> system
    await expect(page.getByRole('button', { name: /currently system mode/ })).toBeVisible();
    await expect(html).toHaveAttribute('data-theme', 'light'); // follows OS (light)
    await expect(page.evaluate(() => localStorage.getItem('theme'))).resolves.toBeNull();

    // live OS change
    await page.emulateMedia({ colorScheme: 'dark' });
    await expect(html).toHaveAttribute('data-theme', 'dark');
    await page.reload();
    await expect(html).toHaveAttribute('data-theme', 'dark');
  });
});

test('API reference and changelog pages exist', async ({ page }) => {
  await page.goto('docs/api');
  await expect(page.getByRole('heading', { level: 1, name: 'API reference' })).toBeVisible();
  await page.goto('changelog');
  await expect(page.getByRole('heading', { level: 1, name: 'Changelog' })).toBeVisible();
});
