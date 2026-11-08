// T-510 REQ-AI-005 — cloud recommendations on the Utilisation screen against the real stack, per locale project:
// - the estate's stopped-but-billed cloud resources (the generator stops about one in fourteen) are advised to be
//   released, each with its saving, cost and owner, and the total monthly saving is shown;
// - no error card appears.
import { fileURLToPath } from 'node:url';
import { expect, test } from '@playwright/test';
import { isLocale, translate } from '@openmap/i18n';
import { signIn } from './auth';

const screenshotsDir = fileURLToPath(new URL('./screenshots/', import.meta.url));
const LOAD_MS = 60_000;

test('the Utilisation screen recommends what to do with cloud resources', async ({ page }, testInfo) => {
  const locale = testInfo.project.name;
  if (!isLocale(locale)) throw new Error('project name must be a locale: ' + locale);
  test.setTimeout(LOAD_MS * 2);

  await page.goto('/' + locale + '/utilisation');
  await signIn(page, locale);
  const panel = page.getByRole('region', { name: translate(locale, 'cloudAdvice.title') });
  const table = panel.getByRole('table', { name: translate(locale, 'cloudAdvice.table') });
  await expect(table.getByRole('row').nth(1)).toBeVisible({ timeout: LOAD_MS });
  const release = table.getByRole('row').filter({ hasText: translate(locale, 'cloudAdvice.kind.release_stopped') }).first();
  await expect(release).toBeVisible();
  await expect(release.getByRole('link')).toBeVisible();
  const summary = panel.getByRole('group', { name: translate(locale, 'cloudAdvice.summary') });
  await expect(summary.getByText(translate(locale, 'cloudAdvice.summary.saving'))).toBeVisible();
  await expect(page.getByRole('alert').filter({ hasText: translate(locale, 'common.error') })).toHaveCount(0);
  await panel.screenshot({ path: screenshotsDir + 'cloud-advice-' + locale + '.png' });
});
