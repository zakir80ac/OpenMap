// T-211 REQ-CMDB-023 REQ-CMDB-025 — lifecycle on the real stack, per locale project (ADR-039): the dev estate's operating
// systems matched to catalogue releases from the bundled endoflife.date snapshot (Windows Server 2022, RHEL 9, Ubuntu
// 24.04 supported; Nutanix AHV not in the catalogue), a release opened to its CIs; hypervisors and network operating
// systems with Nutanix AOS 6.10 ended; hardware end of support by model; the catalogue's source. Screenshots are the
// evidence (docs/evidence/lifecycle.md).
import { fileURLToPath } from 'node:url';
import { expect, test } from '@playwright/test';
import { isLocale, translate } from '@openmap/i18n';
import { signIn } from './auth';

const screenshotsDir = fileURLToPath(new URL('./screenshots/', import.meta.url));
const PAINT_TIMEOUT_MS = 30_000;

test('the lifecycle screen matches the estate to catalogue releases (REQ-CMDB-023, REQ-CMDB-025)', async ({ page }, testInfo) => {
  const locale = testInfo.project.name;
  if (!isLocale(locale)) throw new Error('project name must be a locale: ' + locale);
  await page.goto('/' + locale + '/lifecycle');
  await signIn(page, locale);
  const releases = page.getByTestId('lifecycle-releases');
  const win = releases.locator('[data-release="windows-server|2022"]');
  await expect(win).toBeVisible({ timeout: PAINT_TIMEOUT_MS });
  await expect(win).toHaveAttribute('data-state', 'supported');
  await expect(releases.locator('[data-release="rhel|9"]')).toBeVisible();
  await expect(releases.locator('[data-release="ubuntu|24.04"]')).toBeVisible();
  await expect(releases.locator('[data-release^="unmatched|os|"]').first()).toContainText(translate(locale, 'lifecycle.notInCatalogue'));
  await expect(page.getByTestId('lifecycle-catalogue')).toContainText('endoflife.date');
  await win.getByRole('button').first().click();
  await expect(win.getByTestId('lifecycle-instances').getByRole('link').first()).toBeVisible({ timeout: PAINT_TIMEOUT_MS });
  await page.screenshot({ path: screenshotsDir + 'lifecycle-os-' + locale + '.png', fullPage: false });

  await page.getByRole('tab', { name: translate(locale, 'lifecycle.tab.platforms') }).click();
  const aos = releases.locator('[data-release="nutanix-aos|6.10"]');
  await expect(aos).toBeVisible({ timeout: PAINT_TIMEOUT_MS });
  await expect(aos).toHaveAttribute('data-state', 'ended');
  await expect(releases.locator('[data-release="cisco-ios-xe|17.12"]')).toBeVisible();
  // Ended releases lead.
  await expect(releases.locator('tr[data-release]').first()).toHaveAttribute('data-state', 'ended');
  await page.screenshot({ path: screenshotsDir + 'lifecycle-platforms-' + locale + '.png', fullPage: false });

  await page.getByRole('tab', { name: translate(locale, 'lifecycle.tab.hardware') }).click();
  const hardware = page.getByTestId('lifecycle-hardware');
  await expect(hardware.locator('tr[data-model]').first()).toBeVisible({ timeout: PAINT_TIMEOUT_MS });
  await page.screenshot({ path: screenshotsDir + 'lifecycle-hardware-' + locale + '.png', fullPage: false });
});
