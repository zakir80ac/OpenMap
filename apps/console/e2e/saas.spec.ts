// T-215 REQ-CMDB-022 — the SaaS inventory on the real stack, per locale project: the synthetic estate's tenants
// (Microsoft, Google, Salesforce, ServiceNow, Workday, replayed through the pipeline as the SaaS collector reports them)
// with subscriptions, seats and renewals, a lapsed subscription, and data flows from internal applications.
// Screenshots are the evidence (docs/evidence/saas.md).
import { fileURLToPath } from 'node:url';
import { expect, test } from '@playwright/test';
import { isLocale } from '@openmap/i18n';
import { signIn } from './auth';

const screenshotsDir = fileURLToPath(new URL('./screenshots/', import.meta.url));
const PAINT_TIMEOUT_MS = 30_000;

test('the SaaS inventory lists tenants, seats, renewals and data flows (REQ-CMDB-022)', async ({ page }, testInfo) => {
  const locale = testInfo.project.name;
  if (!isLocale(locale)) throw new Error('project name must be a locale: ' + locale);
  await page.goto('/' + locale + '/saas');
  await signIn(page, locale);
  for (const vendor of ['Microsoft', 'Google', 'Salesforce', 'ServiceNow', 'Workday'])
    await expect(page.locator('[data-tenant="' + vendor + '"]')).toBeVisible({ timeout: PAINT_TIMEOUT_MS });
  await expect(page.locator('tr[data-state="lapsed"]').first()).toBeVisible();
  await expect(page.locator('tr[data-subscription="Microsoft 365 E3"]')).toBeVisible();
  // At least one subscription carries a data flow from an internal application.
  await expect(page.locator('tr[data-subscription] td:last-child a').first()).toBeVisible();
  await page.screenshot({ path: screenshotsDir + 'saas-' + locale + '.png', fullPage: false });
});
