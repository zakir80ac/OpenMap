// REQ-UI-003 REQ-SEC-001 — shell smoke test per locale project: an anonymous visit shows the sign-in screen, signing in
// through the Keycloak realm (seeded user from deploy/compose/keycloak/realm-openmap.json) lands on the dashboard with
// the correct direction and the account menu, and a screenshot is saved.
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { expect, test, type Page } from '@playwright/test';
import { direction, isLocale, translate, type Locale } from '@openmap/i18n';

const screenshotsDir = fileURLToPath(new URL('./screenshots/', import.meta.url));
const realmFile = fileURLToPath(new URL('../../../deploy/compose/keycloak/realm-openmap.json', import.meta.url));

interface RealmUser {
  username: string;
  credentials?: Array<{ type: string; value: string; temporary?: boolean }>;
}

/** The compose stack imports this realm; its first password user is the one the e2e signs in as. */
function seededUser(): { username: string; password: string } {
  const realm = JSON.parse(readFileSync(realmFile, 'utf8')) as { users?: RealmUser[] };
  for (const user of realm.users ?? []) {
    const credential = user.credentials?.find((c) => c.type === 'password');
    if (credential !== undefined) return { username: user.username, password: credential.value };
  }
  throw new Error('realm export has no user with a password credential');
}

async function signIn(page: Page, locale: Locale): Promise<void> {
  await page.getByRole('button', { name: translate(locale, 'auth.signIn') }).click();
  const user = seededUser();
  await page.locator('#username').fill(user.username);
  await page.locator('#password').fill(user.password);
  await page.locator('#kc-login').click();
  // A seeded temporary password makes Keycloak ask for a new one on first use; keep the seeded value.
  const newPassword = page.locator('#password-new');
  if (await newPassword.isVisible({ timeout: 2_000 }).catch(() => false)) {
    await newPassword.fill(user.password);
    await page.locator('#password-confirm').fill(user.password);
    await page.locator('#kc-form-buttons input[type=submit], #kc-form-buttons button[type=submit]').first().click();
  }
}

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
  await expect(menu.getByText(seededUser().username)).toBeVisible();
  await page.screenshot({ path: screenshotsDir + 'dashboard-' + locale + '.png', fullPage: true });
});

test('a path without a locale is redirected to the default locale', async ({ page }) => {
  const response = await page.goto('/cmdb');
  expect(response?.url()).toMatch(/\/(en|ar)\/cmdb$/);
});
