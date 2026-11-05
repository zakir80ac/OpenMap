// T-168 REQ-CMDB-015 — custom fields against the live stack, per locale project: an administrator defines a choice
// field for hosts in Settings, sets it on a host from its detail page, finds the host again through the CMDB custom
// field filter, and removes the field, which clears its value. Screenshots are the evidence
// (docs/evidence/custom-fields.md).
import { fileURLToPath } from 'node:url';
import { expect, test } from '@playwright/test';
import { isLocale, translate, type Locale } from '@openmap/i18n';
import { signIn } from './auth';

const PAINT_TIMEOUT_MS = 60_000;
const screenshotsDir = fileURLToPath(new URL('./screenshots/', import.meta.url));

function localeOf(name: string): Locale {
  if (!isLocale(name)) throw new Error('project name must be a locale: ' + name);
  return name;
}

test('Custom fields: defined in Settings, set on a CI, found by the CMDB filter, removed (REQ-CMDB-015)', async ({ page }, testInfo) => {
  const locale = localeOf(testInfo.project.name);
  test.setTimeout(PAINT_TIMEOUT_MS * 4);
  const key = 'e2eTier' + locale.toUpperCase() + String(Date.now()).slice(-6);
  const labelEn = 'E2E tier ' + key;
  const labelAr = 'فئة الاختبار ' + key;
  const label = locale === 'ar' ? labelAr : labelEn;

  await page.goto('/' + locale + '/settings');
  await signIn(page, locale);
  await page.getByRole('button', { name: translate(locale, 'customFields.add') }).click();
  const form = page.getByRole('form', { name: translate(locale, 'customFields.form') });
  await form.getByLabel(translate(locale, 'customFields.field.key'), { exact: true }).fill(key);
  await form.getByLabel(translate(locale, 'customFields.field.type'), { exact: true }).selectOption('select');
  await form.getByLabel(translate(locale, 'customFields.field.labelEn'), { exact: true }).fill(labelEn);
  await form.getByLabel(translate(locale, 'customFields.field.labelAr'), { exact: true }).fill(labelAr);
  await form.getByLabel(translate(locale, 'customFields.field.options'), { exact: true }).fill('gold, silver');
  await form.getByLabel(translate(locale, 'customFields.field.appliesTo'), { exact: true }).selectOption(['host']);
  await form.getByRole('button', { name: translate(locale, 'customFields.save') }).click();
  const row = page.getByTestId('custom-field-row').filter({ hasText: key });
  await expect(row).toBeVisible({ timeout: PAINT_TIMEOUT_MS });
  await page.screenshot({ path: screenshotsDir + 'custom-fields-settings-' + locale + '.png', fullPage: false });

  await page.goto('/' + locale + '/cmdb');
  const more = page.getByRole('group', { name: translate(locale, 'cmdb.filter.more') });
  await more.getByRole('combobox', { name: translate(locale, 'cmdb.filter.type') }).selectOption('host');
  const first = page.getByRole('table').getByRole('link').first();
  await expect(first).toBeVisible({ timeout: PAINT_TIMEOUT_MS });
  const name = (await first.textContent()) ?? '';
  await first.click();
  await expect(page).toHaveURL(/\/cmdb\/[0-9a-f-]{36}/, { timeout: PAINT_TIMEOUT_MS });
  await page.getByRole('button', { name: translate(locale, 'customFields.editValues') }).click();
  const values = page.getByRole('form', { name: translate(locale, 'customFields.valuesForm') });
  await values.getByLabel(label).selectOption('gold');
  await values.getByRole('button', { name: translate(locale, 'customFields.save') }).click();
  const shown = page.getByTestId('custom-field-values');
  await expect(shown).toContainText(label, { timeout: PAINT_TIMEOUT_MS });
  await expect(shown).toContainText('gold');
  await page.screenshot({ path: screenshotsDir + 'custom-fields-ci-' + locale + '.png', fullPage: false });

  await page.goto('/' + locale + '/cmdb');
  const filters = page.getByRole('group', { name: translate(locale, 'cmdb.filter.more') });
  await filters.getByRole('combobox', { name: translate(locale, 'cmdb.filter.customField') }).selectOption({ label });
  await filters.getByRole('combobox', { name: translate(locale, 'cmdb.filter.customValue') }).selectOption('gold');
  await expect(page.getByRole('table').getByRole('link')).toHaveCount(1, { timeout: PAINT_TIMEOUT_MS });
  await expect(page.getByRole('table').getByRole('link').first()).toHaveText(name);

  await page.goto('/' + locale + '/settings');
  const again = page.getByTestId('custom-field-row').filter({ hasText: key });
  await again.getByRole('button', { name: translate(locale, 'customFields.delete', { key }) }).click();
  await again.getByRole('button', { name: translate(locale, 'customFields.confirmDelete', { count: '1' }) }).click();
  await expect(page.getByTestId('custom-field-row').filter({ hasText: key })).toHaveCount(0, { timeout: PAINT_TIMEOUT_MS });
});
