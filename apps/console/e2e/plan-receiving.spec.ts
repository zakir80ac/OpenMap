// T-180 REQ-CMDB-020 — receiving against a plan on the real stack, per locale project (ADR-034): an operator creates a
// plan with one line of two units, approves it, receives one unit with its serial, a tag and an ERP reference; the
// line counts it, the plan moves to building and lists the receipt, and the register shows the unit in stock under
// its new tag. Each run leaves one `Edge e2e *` plan in the dev estate. Screenshots are the evidence
// (docs/evidence/plan-receiving.md).
import { fileURLToPath } from 'node:url';
import { expect, test } from '@playwright/test';
import { isLocale, translate } from '@openmap/i18n';
import { signIn } from './auth';

const screenshotsDir = fileURLToPath(new URL('./screenshots/', import.meta.url));
const PAINT_TIMEOUT_MS = 30_000;

test('an approved plan line is received into stock and listed as a receipt (REQ-CMDB-020)', async ({ page }, testInfo) => {
  const locale = testInfo.project.name;
  if (!isLocale(locale)) throw new Error('project name must be a locale: ' + locale);
  test.setTimeout(PAINT_TIMEOUT_MS * 4);
  const stamp = locale + '-' + String(Date.now());
  const name = 'Edge e2e ' + stamp;
  const item = 'Edge host ' + stamp;
  const serial = 'SN-E2E-' + stamp;
  const tag = 'EDGE-' + stamp;
  const reference = 'PO-' + stamp;

  await page.goto('/' + locale + '/assets');
  await signIn(page, locale);
  await expect(page.getByTestId('asset-register')).toBeVisible({ timeout: PAINT_TIMEOUT_MS });
  const newPlan = page.getByRole('form', { name: translate(locale, 'assets.plans.new') });
  await newPlan.getByLabel(translate(locale, 'assets.plans.name')).fill(name);
  await newPlan.getByLabel(translate(locale, 'assets.plans.description')).fill('Edge pod expansion');
  await newPlan.getByLabel(translate(locale, 'assets.plans.bom.description')).fill(item);
  await newPlan.getByLabel(translate(locale, 'assets.plans.bom.quantity')).fill('2');
  await newPlan.getByRole('button', { name: translate(locale, 'assets.plans.create') }).click();

  const card = page.getByRole('article').filter({ hasText: name });
  await expect(card).toBeVisible({ timeout: PAINT_TIMEOUT_MS });
  const receiveLine = card.getByRole('button', { name: translate(locale, 'assets.receive.open', { line: item }) });
  await expect(receiveLine).toHaveCount(0);
  await card.getByRole('button', { name: translate(locale, 'assets.plans.to.approved') }).click();
  await expect(receiveLine).toBeVisible({ timeout: PAINT_TIMEOUT_MS });
  await receiveLine.click();

  const form = card.getByRole('form', { name: translate(locale, 'assets.receive.title', { line: item }) });
  await form.getByLabel(translate(locale, 'assets.receive.units')).fill(serial + ', ' + tag);
  await form.getByLabel(translate(locale, 'assets.receive.reference')).fill(reference);
  await card.scrollIntoViewIfNeeded();
  await card.screenshot({ path: screenshotsDir + 'plan-receive-form-' + locale + '.png' });
  await form.getByRole('button', { name: translate(locale, 'assets.receive.submit', { count: '1' }) }).click();

  await expect(card.getByText(translate(locale, 'assets.receive.done', { count: '1', line: item }))).toBeVisible({ timeout: PAINT_TIMEOUT_MS });
  const receipts = card.getByTestId('plan-receipts');
  await expect(receipts).toContainText(reference, { timeout: PAINT_TIMEOUT_MS });
  await expect(receipts).toContainText(serial);
  await expect(card.getByText(translate(locale, 'assets.receive.receivedOf', { received: '1', quantity: '2' }))).toBeVisible();
  await expect(card.getByText(translate(locale, 'assets.plans.status.building'))).toBeVisible();
  await card.scrollIntoViewIfNeeded();
  await card.screenshot({ path: screenshotsDir + 'plan-receipts-' + locale + '.png' });

  await page.getByLabel(translate(locale, 'assets.filter.text')).fill(tag);
  const row = page.getByTestId('asset-register').locator('[data-asset-tag="' + tag + '"]');
  await expect(row).toBeVisible({ timeout: PAINT_TIMEOUT_MS });
  await expect(row.getByLabel(translate(locale, 'assets.setStage', { tag }))).toHaveValue('in_stock');
});
