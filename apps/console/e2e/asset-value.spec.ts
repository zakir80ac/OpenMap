// T-175 REQ-CMDB-017 REQ-CMDB-019 — asset value and spare stock on the real stack, per locale project: a spare PSU
// shelf recorded by hand with its purchase, a straight-line schedule and stock below its reorder point shows its book
// value with the cost beneath and the low-stock mark in the register; the low-stock filter keeps it; the details panel
// states today's book value. Each run leaves one `PSU e2e *` asset in the dev estate, as the asset spec leaves its PDU.
// Screenshots are the evidence (docs/evidence/asset-value.md).
import { fileURLToPath } from 'node:url';
import { expect, test } from '@playwright/test';
import { isLocale, translate } from '@openmap/i18n';
import { signIn } from './auth';

const screenshotsDir = fileURLToPath(new URL('./screenshots/', import.meta.url));
const PAINT_TIMEOUT_MS = 30_000;

test('a spare is valued under its schedule and flagged below its reorder point (REQ-CMDB-017, REQ-CMDB-019)', async ({ page }, testInfo) => {
  const locale = testInfo.project.name;
  if (!isLocale(locale)) throw new Error('project name must be a locale: ' + locale);
  test.setTimeout(PAINT_TIMEOUT_MS * 4);
  const now = new Date();
  const purchasedAt = new Date(Date.UTC(now.getUTCFullYear() - 1, now.getUTCMonth(), 1)).toISOString().slice(0, 'YYYY-MM-DD'.length);
  const name = 'PSU e2e ' + locale + ' ' + String(Date.now());

  await page.goto('/' + locale + '/assets');
  await signIn(page, locale);
  await expect(page.getByTestId('asset-register')).toBeVisible({ timeout: PAINT_TIMEOUT_MS });
  const manual = page.getByRole('form', { name: translate(locale, 'assets.manual.title') });
  await manual.getByLabel(translate(locale, 'assets.manual.name')).fill(name);
  await manual.getByLabel(translate(locale, 'assets.details.manufacturer')).fill('Delta');
  await manual.getByLabel(translate(locale, 'assets.details.purchasedAt'), { exact: true }).fill(purchasedAt);
  await manual.getByLabel(translate(locale, 'assets.details.purchaseCost'), { exact: true }).fill('4800');
  await manual.getByLabel(translate(locale, 'assets.details.currency'), { exact: true }).fill('SAR');
  await manual.getByLabel(translate(locale, 'assets.details.depreciation.method'), { exact: true }).selectOption('straight_line');
  await manual.getByLabel(translate(locale, 'assets.details.depreciation.usefulLife'), { exact: true }).fill('48');
  await manual.getByLabel(translate(locale, 'assets.details.stock.onHand'), { exact: true }).fill('1');
  await manual.getByLabel(translate(locale, 'assets.details.stock.reorderPoint'), { exact: true }).fill('2');
  await manual.getByRole('button', { name: translate(locale, 'assets.manual.create') }).click();
  await expect(manual.getByRole('status')).toBeVisible({ timeout: PAINT_TIMEOUT_MS });

  const register = page.getByTestId('asset-register');
  await page.getByLabel(translate(locale, 'assets.filter.text')).fill(name);
  const row = register.getByRole('row').filter({ hasText: name });
  await expect(row).toBeVisible({ timeout: PAINT_TIMEOUT_MS });
  const value = row.getByTestId('asset-book-value-cell');
  await expect(value).toContainText('SAR');
  await expect(value).toContainText(translate(locale, 'assets.table.ofCost', { cost: '' }).trim());
  await expect(row.getByTestId('asset-low-stock')).toBeVisible();

  const lowStock = page.getByTestId('asset-low-stock-filter').getByRole('button');
  await expect(lowStock).toContainText(/[1-9١-٩]/);
  await lowStock.click();
  await expect(row).toBeVisible({ timeout: PAINT_TIMEOUT_MS });
  await page.screenshot({ path: screenshotsDir + 'asset-value-register-' + locale + '.png', fullPage: false });

  const tag = await row.getAttribute('data-asset-tag');
  if (tag === null) throw new Error('register rows carry their tag');
  await row.getByRole('button', { name: translate(locale, 'assets.table.edit', { tag }), exact: true }).click();
  const panel = page.getByTestId('asset-details-panel');
  await expect(panel.getByTestId('asset-book-value')).toContainText('SAR');
  await panel.getByTestId('asset-book-value').scrollIntoViewIfNeeded();
  await page.screenshot({ path: screenshotsDir + 'asset-value-details-' + locale + '.png', fullPage: false });
  await lowStock.click();
});
