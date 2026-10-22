// REQ-UI-003 — shell smoke test per locale project: the dashboard renders, <html> carries lang and dir, screenshot saved.
import { fileURLToPath } from 'node:url';
import { expect, test } from '@playwright/test';
import { direction, isLocale, translate } from '@openmap/i18n';

const screenshotsDir = fileURLToPath(new URL('./screenshots/', import.meta.url));

test('dashboard shell renders with the correct direction', async ({ page }, testInfo) => {
  const locale = testInfo.project.name;
  if (!isLocale(locale)) throw new Error('Playwright project must be named after a locale: ' + locale);

  await page.goto('/' + locale + '/dashboard');
  const html = page.locator('html');
  await expect(html).toHaveAttribute('lang', locale);
  await expect(html).toHaveAttribute('dir', direction(locale));
  await expect(page.getByRole('navigation', { name: translate(locale, 'nav.primary') })).toBeVisible();
  await expect(page.getByRole('heading', { level: 1, name: translate(locale, 'nav.dashboard') })).toBeVisible();
  await expect(page.getByRole('link', { name: translate(locale, 'nav.cmdb') })).toHaveAttribute('href', '/' + locale + '/cmdb');

  await page.screenshot({ path: screenshotsDir + 'dashboard-' + locale + '.png', fullPage: true });
});

test('a path without a locale is redirected to the default locale', async ({ page }) => {
  const response = await page.goto('/cmdb');
  expect(response?.url()).toMatch(/\/(en|ar)\/cmdb$/);
});
