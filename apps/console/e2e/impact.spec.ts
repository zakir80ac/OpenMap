// T-122 REQ-BSM-003 REQ-UI-013 — the what-if model on the real stack, per locale project: pick a component, pick the
// Failed condition, run; the API accepts the scenario (its kind is the condition), the result section shows the
// service totals, the scenario is saved and can be re-run, and no error card appears. Guards the regression where
// every run ended in "Something went wrong" because the console's condition ids were not scenario kinds (ADR-019).
import { fileURLToPath } from 'node:url';
import { expect, test } from '@playwright/test';
import { isLocale, translate } from '@openmap/i18n';
import { signIn } from './auth';

const screenshotsDir = fileURLToPath(new URL('./screenshots/', import.meta.url));
const MODEL_TIMEOUT_MS = 60_000;

test('a what-if scenario runs end to end and is saved for re-running', async ({ page }, testInfo) => {
  const locale = testInfo.project.name;
  if (!isLocale(locale)) throw new Error('project name must be a locale: ' + locale);
  test.setTimeout(MODEL_TIMEOUT_MS * 3);

  await page.goto('/' + locale + '/impact');
  await signIn(page, locale);
  // A core-banking database component: its application is part of business services in the synthetic estate.
  await page.getByRole('searchbox', { name: translate(locale, 'impact.explorer.search') }).fill('cbs-db');
  const explorer = page.getByRole('list', { name: translate(locale, 'impact.explorer.list') });
  await expect(explorer.getByRole('button', { name: /^cbs-db / }).first()).toBeVisible({ timeout: MODEL_TIMEOUT_MS });
  await explorer.getByRole('button', { name: /^cbs-db / }).first().click();

  const conditions = page.getByRole('radiogroup', { name: translate(locale, 'impact.condition.list') });
  await conditions.getByRole('radio', { name: new RegExp(translate(locale, 'impact.condition.failed.label')) }).click();
  const run = page.getByRole('button', { name: translate(locale, 'impact.run') });
  await expect(run).toBeEnabled();
  await run.click();

  const result = page.getByRole('region', { name: translate(locale, 'impact.step.result') });
  await expect(result).toBeVisible({ timeout: MODEL_TIMEOUT_MS });
  // No error card (the route announcer is an alert too, so match the card by its text).
  await expect(page.getByRole('alert').filter({ hasText: translate(locale, 'common.error') })).toHaveCount(0);
  // The failure propagates through the application to its business services: a non-zero services-down figure.
  await expect(result.getByText(translate(locale, 'impact.result.noServices'))).toHaveCount(0);
  await expect(page.getByText(translate(locale, 'impact.result.noServices'))).toHaveCount(0);
  await expect(page.getByRole('table').getByRole('row').nth(1)).toBeVisible();
  // The run saved its scenario: the saved list offers a re-run.
  await expect(page.getByRole('button', { name: translate(locale, 'impact.saved.run') }).first()).toBeVisible({ timeout: MODEL_TIMEOUT_MS });
  await page.screenshot({ path: screenshotsDir + 'impact-run-' + locale + '.png', fullPage: false });
});
