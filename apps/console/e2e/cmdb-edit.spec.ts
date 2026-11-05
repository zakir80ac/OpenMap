// T-163 REQ-CMDB-013 REQ-CMDB-016 REQ-CMDB-018 — editing the CMDB and the register against the live stack, per locale
// project: an operator narrows the CMDB to hosts, opens one, moves it to "managed" and tags it, finds it again through
// the lifecycle and tag filters, then removes the tag and returns the lifecycle; on the Assets screen an asset's stage
// changes and the change appears in its audit trail with the new value, then the stage goes back. Screenshots are the
// evidence (docs/evidence/cmdb-editing.md).
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

test('CMDB: lifecycle and tags edited by hand, found again by the filters (REQ-CMDB-013, REQ-CMDB-016)', async ({ page }, testInfo) => {
  const locale = localeOf(testInfo.project.name);
  test.setTimeout(PAINT_TIMEOUT_MS * 4);
  const tag = 'e2e-' + locale + '-' + String(Date.now());
  await page.goto('/' + locale + '/cmdb');
  await signIn(page, locale);
  const more = page.getByRole('group', { name: translate(locale, 'cmdb.filter.more') });
  await more.getByRole('combobox', { name: translate(locale, 'cmdb.filter.type') }).selectOption('host');
  const table = page.getByRole('table');
  const firstLink = table.getByRole('link').first();
  await expect(firstLink).toBeVisible({ timeout: PAINT_TIMEOUT_MS });
  const name = (await firstLink.textContent()) ?? '';
  await firstLink.click();
  await expect(page).toHaveURL(/\/cmdb\/[0-9a-f-]{36}/, { timeout: PAINT_TIMEOUT_MS });
  const ciUrl = page.url();

  const lifecycle = page.getByRole('combobox', { name: translate(locale, 'cmdb.detail.lifecycle') });
  await expect(lifecycle).toBeVisible({ timeout: PAINT_TIMEOUT_MS });
  const before = await lifecycle.inputValue();
  await lifecycle.selectOption('managed');
  await expect(lifecycle).toHaveValue('managed', { timeout: PAINT_TIMEOUT_MS });
  await page.getByRole('combobox', { name: translate(locale, 'cmdb.detail.tagAdd') }).fill(tag);
  await page.getByRole('button', { name: translate(locale, 'cmdb.detail.tagAddButton') }).click();
  await expect(page.getByRole('button', { name: translate(locale, 'cmdb.detail.tagRemove', { tag }) })).toBeVisible({ timeout: PAINT_TIMEOUT_MS });
  await page.screenshot({ path: screenshotsDir + 'cmdb-edit-' + locale + '.png', fullPage: false });

  await page.goto('/' + locale + '/cmdb');
  const filters = page.getByRole('group', { name: translate(locale, 'cmdb.filter.more') });
  await filters.getByRole('combobox', { name: translate(locale, 'cmdb.filter.lifecycle') }).selectOption('managed');
  await filters.getByRole('combobox', { name: translate(locale, 'cmdb.filter.tag') }).selectOption({ label: tag + ' (1)' });
  await expect(page.getByRole('table').getByRole('link')).toHaveCount(1, { timeout: PAINT_TIMEOUT_MS });
  await expect(page.getByRole('table').getByRole('link').first()).toHaveText(name);

  await page.goto(ciUrl);
  await page.getByRole('button', { name: translate(locale, 'cmdb.detail.tagRemove', { tag }) }).click();
  await expect(page.getByRole('button', { name: translate(locale, 'cmdb.detail.tagRemove', { tag }) })).toHaveCount(0, { timeout: PAINT_TIMEOUT_MS });
  await page.getByRole('combobox', { name: translate(locale, 'cmdb.detail.lifecycle') }).selectOption(before);
  await expect(page.getByRole('combobox', { name: translate(locale, 'cmdb.detail.lifecycle') })).toHaveValue(before, { timeout: PAINT_TIMEOUT_MS });
});

test('Assets: a stage change is audited with its new value (REQ-CMDB-018)', async ({ page }, testInfo) => {
  const locale = localeOf(testInfo.project.name);
  test.setTimeout(PAINT_TIMEOUT_MS * 3);
  await page.goto('/' + locale + '/assets');
  await signIn(page, locale);
  const register = page.getByTestId('asset-register');
  const row = register.getByRole('row').nth(1);
  await expect(row).toBeVisible({ timeout: PAINT_TIMEOUT_MS });
  const assetTag = await row.getAttribute('data-asset-tag');
  if (assetTag === null) throw new Error('register rows carry their tag');
  const stage = row.getByRole('combobox', { name: translate(locale, 'assets.setStage', { tag: assetTag }) });
  const before = await stage.inputValue();
  const next = before === 'spare' ? 'deployed' : 'spare';
  await stage.selectOption(next);
  await expect(stage).toHaveValue(next, { timeout: PAINT_TIMEOUT_MS });
  await row.getByRole('button', { name: translate(locale, 'assets.table.edit', { tag: assetTag }) }).click();
  const panel = page.getByTestId('asset-details-panel');
  await expect(panel).toBeVisible();
  const entry = panel.locator('li').filter({ hasText: translate(locale, 'assets.details.audits.entry', { actor: 'admin', field: 'stage' }) }).first();
  await expect(entry).toBeVisible({ timeout: PAINT_TIMEOUT_MS });
  await expect(entry).toContainText(next);
  await page.screenshot({ path: screenshotsDir + 'assets-stage-audit-' + locale + '.png', fullPage: false });
  await stage.selectOption(before);
  await expect(stage).toHaveValue(before, { timeout: PAINT_TIMEOUT_MS });
});
