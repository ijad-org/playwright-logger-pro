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
    test(`home hero shows the curl command coloured on a dark panel (${theme} theme)`, async ({ page }) => {
      await page.addInitScript((t) => localStorage.setItem('theme', t), theme);
      await page.goto('./');
      const terminal = page.locator('figure', { hasText: 'curl -X POST' });
      await expect(terminal).toBeVisible();
      await expect(terminal).toHaveCSS('background-color', rgb('#000000'));

      const code = terminal.locator('code');
      await expect(code).not.toContainText('\u001b');
      await expect(code).not.toContainText('[38;5;');
      const colour = (text: string) => code.locator('span', { hasText: new RegExp(`^${text}$`) });
      await expect(colour('POST').last()).toHaveCSS('color', rgb('#00875f'));
      await expect(colour('http://localhost:3000/vegetables').last()).toHaveCSS('color', rgb('#5f5fff'));
      await expect(colour('Content-Type').last()).toHaveCSS('color', rgb('#d700af'));
    });
  }
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
