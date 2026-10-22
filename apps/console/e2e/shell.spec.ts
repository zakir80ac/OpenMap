// REQ-UI-003 REQ-SEC-001 — shell smoke test per locale project: an anonymous visit shows the sign-in screen, signing in
// through the Keycloak realm (seeded user from deploy/compose/keycloak/realm-openmap.json) lands on the dashboard with
// the correct direction and the account menu, and a screenshot is saved.
import { fileURLToPath } from 'node:url';
import { expect, test } from '@playwright/test';
import { direction, isLocale, translate } from '@openmap/i18n';
import { seededUser, signIn } from './auth';

const screenshotsDir = fileURLToPath(new URL('./screenshots/', import.meta.url));

test('anonymous visitors see the sign-in screen, signing in renders the dashboard shell', async ({ page }, testInfo) => {
  const locale = testInfo.project.name;
  if (!isLocale(locale)) throw new Error('Playwright project must be named after a locale: ' + locale);

  await page.goto('/' + locale + '/dashboard');
  const html = page.locator('html');
  await expect(html).toHaveAttribute('lang', locale);
  await expect(html).toHaveAttribute('dir', direction(locale));
  await expect(page.getByRole('heading', { level: 1, name: translate(locale, 'auth.signInTitle') })).toBeVisible();
  await page.screenshot({ path: screenshotsDir + 'sign-in-' + locale + '.png', fullPage: true });

  await signIn(page, locale);
  await expect(page).toHaveURL(new RegExp('/' + locale + '/dashboard$'));
  await expect(html).toHaveAttribute('dir', direction(locale));
  await expect(page.getByRole('navigation', { name: translate(locale, 'nav.primary') })).toBeVisible();
  await expect(page.getByRole('heading', { level: 1, name: translate(locale, 'nav.dashboard') })).toBeVisible();
  await expect(page.getByRole('link', { name: translate(locale, 'nav.cmdb') })).toHaveAttribute('href', '/' + locale + '/cmdb');

  await page.getByRole('button', { name: translate(locale, 'auth.menu') }).click();
  const menu = page.getByRole('dialog', { name: translate(locale, 'auth.menu') });
  await expect(menu).toBeVisible();
  await expect(menu.getByText(seededUser().username, { exact: true })).toBeVisible();
  await page.screenshot({ path: screenshotsDir + 'dashboard-' + locale + '.png', fullPage: true });
});

test('a path without a locale is redirected to the default locale', async ({ page }) => {
  const response = await page.goto('/cmdb');
  expect(response?.url()).toMatch(/\/(en|ar)\/cmdb$/);
});
