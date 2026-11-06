// T-201 REQ-CMDB-021 — per-device layer visibility across the estate-wide screens on the real stack, per locale project:
// switching the Applications layer off on Layers makes CMDB, Assets, Impact and the Dashboard name it as hidden and leave
// its CIs out (the CMDB list holds no application-layer row), and Show all brings everything back. Screenshots are the
// evidence (docs/evidence/layer-visibility.md).
import { fileURLToPath } from 'node:url';
import { expect, test } from '@playwright/test';
import { isLocale, translate } from '@openmap/i18n';
import { signIn } from './auth';

const screenshotsDir = fileURLToPath(new URL('./screenshots/', import.meta.url));
const PAINT_TIMEOUT_MS = 30_000;

test('a layer hidden on this device is left out of every estate-wide list until shown again (REQ-CMDB-021)', async ({ page }, testInfo) => {
  const locale = testInfo.project.name;
  if (!isLocale(locale)) throw new Error('project name must be a locale: ' + locale);
  const applications = translate(locale, 'layer.applications');
  await page.goto('/' + locale + '/layers');
  await signIn(page, locale);
  const toggle = page.getByRole('switch', { name: translate(locale, 'layers.toggle', { layer: applications }) });
  await expect(toggle).toHaveAttribute('aria-checked', 'true', { timeout: PAINT_TIMEOUT_MS });
  await toggle.click();
  await expect(toggle).toHaveAttribute('aria-checked', 'false');

  for (const route of ['/cmdb', '/assets', '/impact', '/dashboard']) {
    await page.goto('/' + locale + route);
    const notice = page.getByTestId('hidden-layers').first();
    await expect(notice, route).toBeVisible({ timeout: PAINT_TIMEOUT_MS });
    await expect(notice).toContainText(applications);
    if (route === '/cmdb') {
      // No row of the hidden layer in the list (rows carry their layer badge).
      const list = page.getByTestId('ci-list');
      await expect(list.locator('[data-layer]').first()).toBeVisible({ timeout: PAINT_TIMEOUT_MS });
      await expect(list.locator('[data-layer="applications"]')).toHaveCount(0);
      await page.screenshot({ path: screenshotsDir + 'layer-visibility-cmdb-' + locale + '.png', fullPage: false });
    }
    if (route === '/assets') await page.screenshot({ path: screenshotsDir + 'layer-visibility-assets-' + locale + '.png', fullPage: false });
  }

  await page.getByTestId('hidden-layers').first().getByRole('button', { name: translate(locale, 'layers.hidden.showAll') }).click();
  await expect(page.getByTestId('hidden-layers')).toHaveCount(0);
  await page.goto('/' + locale + '/layers');
  await expect(page.getByRole('switch', { name: translate(locale, 'layers.toggle', { layer: applications }) })).toHaveAttribute('aria-checked', 'true', { timeout: PAINT_TIMEOUT_MS });
});
