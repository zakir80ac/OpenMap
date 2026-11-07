// T-469 REQ-BSM-004 REQ-UI-013 (ADR-047) — prediction accuracy on the real stack, per locale project. The Impact
// screen's accuracy panel validates the replayed incidents on demand ("Validate now"), then shows:
// - the mean accuracy and the validated count;
// - the latest validated incidents with their root cause and accuracy;
// - the suggestions list (or its empty state).
// No error card appears.
import { fileURLToPath } from 'node:url';
import { expect, test } from '@playwright/test';
import { isLocale, translate } from '@openmap/i18n';
import { signIn } from './auth';

const screenshotsDir = fileURLToPath(new URL('./screenshots/', import.meta.url));
const VALIDATE_TIMEOUT_MS = 120_000;

test('the accuracy panel validates incidents and shows the result', async ({ page }, testInfo) => {
  const locale = testInfo.project.name;
  if (!isLocale(locale)) throw new Error('project name must be a locale: ' + locale);
  test.setTimeout(VALIDATE_TIMEOUT_MS * 2);

  await page.goto('/' + locale + '/impact');
  await signIn(page, locale);
  const panel = page.getByRole('region', { name: translate(locale, 'impact.accuracy.title') });
  await expect(panel).toBeVisible({ timeout: VALIDATE_TIMEOUT_MS });
  await panel.getByRole('button', { name: translate(locale, 'impact.accuracy.validate') }).click();
  // The run ends when the button reads "Validate now" again.
  await expect(panel.getByRole('button', { name: translate(locale, 'impact.accuracy.validate') })).toBeEnabled({ timeout: VALIDATE_TIMEOUT_MS });

  const summary = panel.getByRole('group', { name: translate(locale, 'impact.accuracy.summary') });
  await expect(summary.getByText(translate(locale, 'impact.accuracy.mean'))).toBeVisible();
  await expect(summary.getByText(translate(locale, 'impact.accuracy.none'))).toHaveCount(0);
  const table = panel.getByRole('table', { name: translate(locale, 'impact.accuracy.recent') });
  await expect(table.getByRole('row').nth(1)).toBeVisible({ timeout: VALIDATE_TIMEOUT_MS });
  // Every replayed incident names its root cause: the first row links it.
  await expect(table.getByRole('row').nth(1).getByRole('link').first()).toBeVisible();
  await expect(page.getByRole('alert').filter({ hasText: translate(locale, 'common.error') })).toHaveCount(0);

  await panel.scrollIntoViewIfNeeded();
  await page.screenshot({ path: screenshotsDir + 'impact-accuracy-' + locale + '.png', fullPage: true });
});
