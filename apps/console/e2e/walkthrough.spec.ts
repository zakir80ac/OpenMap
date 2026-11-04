// T-087 REQ-UI-003 REQ-SEC-001 — signed-in walkthrough per locale project: every primary screen renders behind the
// sign-in gate with the correct direction and a level-1 heading, the CMDB list opens its first CI detail, and a
// full-page screenshot of each screen is saved as review evidence (en and ar, RTL included).
import { fileURLToPath } from 'node:url';
import { expect, test } from '@playwright/test';
import { direction, isLocale, translate } from '@openmap/i18n';
import { signIn } from './auth';

const screenshotsDir = fileURLToPath(new URL('./screenshots/', import.meta.url));

const SCREENS = ['twin', 'setup', 'layers', 'discovery', 'dependencies', 'cmdb', 'assets', 'software', 'services', 'impact', 'integrations', 'ipam', 'dcim', 'vulnerabilities', 'analytics', 'assistant', 'settings'] as const;
const SHELL_TIMEOUT_MS = 30_000;

test('every primary screen renders for a signed-in user and is captured in both locales', async ({ page }, testInfo) => {
  const locale = testInfo.project.name;
  if (!isLocale(locale)) throw new Error('Playwright project must be named after a locale: ' + locale);
  // Seven full page loads, each allowed the shell timeout: the whole walk needs more than the default test budget.
  test.setTimeout((SCREENS.length + 1) * SHELL_TIMEOUT_MS);

  await page.goto('/' + locale + '/dashboard');
  await signIn(page, locale);
  const html = page.locator('html');

  for (const screen of SCREENS) {
    await page.goto('/' + locale + '/' + screen);
    await expect(html).toHaveAttribute('dir', direction(locale));
    // A full page load restores the session from the stored refresh token first, and a dev server compiles the
    // route on its first visit, so the shell is allowed longer than the default expectation timeout to appear.
    await expect(page.getByRole('navigation', { name: translate(locale, 'nav.primary') })).toBeVisible({ timeout: SHELL_TIMEOUT_MS });
    await expect(page.getByRole('heading', { level: 1 })).toBeVisible();
    await expect(page.getByRole('heading', { level: 1, name: translate(locale, 'auth.signInTitle') })).toHaveCount(0);
    await page.waitForLoadState('networkidle');
    await page.screenshot({ path: screenshotsDir + screen + '-' + locale + '.png', fullPage: true });
  }

  // CI detail: the first row link in the CMDB list. Every row carries its layer's headline metric (REQ-CMDB-038).
  await page.goto('/' + locale + '/cmdb');
  const firstCi = page.locator('main a[href*="/cmdb/"]').first();
  await expect(firstCi).toBeVisible();
  await expect(page.getByRole('columnheader', { name: translate(locale, 'cmdb.column.metric') })).toBeVisible();
  await expect(page.locator('main [role="row"] [data-metric]').first()).toBeVisible();
  await firstCi.click();
  await expect(page).toHaveURL(new RegExp('/' + locale + '/cmdb/[^/]+$'));
  await expect(page.getByRole('heading', { level: 1 })).toBeVisible({ timeout: SHELL_TIMEOUT_MS });
  await page.waitForLoadState('networkidle');
  await page.screenshot({ path: screenshotsDir + 'ci-detail-' + locale + '.png', fullPage: true });
});
