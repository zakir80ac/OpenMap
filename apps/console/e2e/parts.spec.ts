// T-199 REQ-CMDB-014 — parts on the real stack, per locale project (ADR-037): the Parts register lists the components the
// synthetic estate's collectors reported (hypervisors carry two FC HBAs each), the kind filter keeps HBAs only, and a
// holding CI's Parts tab shows its processors, memory, drives, adapters, HBAs and power supplies. Screenshots are the
// evidence (docs/evidence/parts.md).
import { fileURLToPath } from 'node:url';
import { expect, test } from '@playwright/test';
import { isLocale, translate } from '@openmap/i18n';
import { signIn } from './auth';

const screenshotsDir = fileURLToPath(new URL('./screenshots/', import.meta.url));
const PAINT_TIMEOUT_MS = 30_000;

test('the parts register filters by kind and a CI shows its parts (REQ-CMDB-014)', async ({ page }, testInfo) => {
  const locale = testInfo.project.name;
  if (!isLocale(locale)) throw new Error('project name must be a locale: ' + locale);
  await page.goto('/' + locale + '/parts');
  await signIn(page, locale);
  const register = page.getByTestId('part-register');
  await expect(register.locator('tr[data-part]').first()).toBeVisible({ timeout: PAINT_TIMEOUT_MS });
  await expect(page.getByTestId('part-models')).toBeVisible();
  await page.screenshot({ path: screenshotsDir + 'parts-' + locale + '.png', fullPage: false });

  await page.getByLabel(translate(locale, 'parts.filter.kind')).selectOption('hba');
  const hba = translate(locale, 'parts.kind.hba');
  await expect(register.locator('tr[data-part]').first()).toContainText(hba, { timeout: PAINT_TIMEOUT_MS });
  const kinds = await register.locator('tr[data-part] td:first-child').allInnerTexts();
  expect(kinds.every((k) => k.includes(hba))).toBe(true);
  await expect(register.locator('tr[data-part]').first()).toContainText(/WWPN/);

  await register.locator('tr[data-part]').first().getByRole('link').click();
  await page.getByRole('tab', { name: translate(locale, 'cmdb.detail.tab.parts') }).click();
  const parts = page.getByTestId('ci-parts');
  for (const kind of ['cpu', 'memory', 'disk', 'nic', 'hba', 'psu'] as const)
    await expect(parts.locator('tr[data-part^="' + kind + ':"]').first()).toBeVisible({ timeout: PAINT_TIMEOUT_MS });
  await page.screenshot({ path: screenshotsDir + 'parts-ci-' + locale + '.png', fullPage: false });
});
