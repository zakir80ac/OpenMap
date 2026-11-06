// T-207 REQ-CMDB-034 — utilisation on the real stack, per locale project: the register lists the dev estate's servers
// and VMs (14 days of samples replayed through the pipeline by synth-estate `utilisation-history`) hottest first, the
// idle filter keeps idle CIs only, and a server's Utilisation tab charts CPU, memory, disk and power over the window.
// Screenshots are the evidence (docs/evidence/utilisation.md).
import { fileURLToPath } from 'node:url';
import { expect, test } from '@playwright/test';
import { isLocale, translate } from '@openmap/i18n';
import { signIn } from './auth';

const screenshotsDir = fileURLToPath(new URL('./screenshots/', import.meta.url));
const PAINT_TIMEOUT_MS = 30_000;

test('the utilisation register ranks CIs and a server charts its utilisation (REQ-CMDB-034)', async ({ page }, testInfo) => {
  const locale = testInfo.project.name;
  if (!isLocale(locale)) throw new Error('project name must be a locale: ' + locale);
  await page.goto('/' + locale + '/utilisation');
  await signIn(page, locale);
  const register = page.getByTestId('utilisation-register');
  const rows = register.locator('tr[data-utilisation]');
  await expect(rows.first()).toBeVisible({ timeout: PAINT_TIMEOUT_MS });
  await expect(rows.first()).toHaveAttribute('data-state', 'hot');
  await page.screenshot({ path: screenshotsDir + 'utilisation-' + locale + '.png', fullPage: false });

  await page.getByRole('combobox', { name: translate(locale, 'utilisation.filter.state'), exact: true }).selectOption('idle');
  await expect(rows.first()).toHaveAttribute('data-state', 'idle', { timeout: PAINT_TIMEOUT_MS });
  const states = await rows.evaluateAll((els) => els.map((e) => e.getAttribute('data-state')));
  expect(states.every((s) => s === 'idle')).toBe(true);

  await page.getByRole('combobox', { name: translate(locale, 'utilisation.filter.state'), exact: true }).selectOption('');
  await page.getByRole('combobox', { name: translate(locale, 'utilisation.filter.type'), exact: true }).selectOption('host');
  await expect(rows.first()).toBeVisible({ timeout: PAINT_TIMEOUT_MS });
  await rows.first().getByRole('link').click();
  await page.getByRole('tab', { name: translate(locale, 'cmdb.detail.tab.utilisation') }).click();
  const panel = page.getByTestId('ci-utilisation');
  for (const measure of ['cpu', 'memory', 'disk', 'power'] as const)
    await expect(panel.locator('[data-measure="' + measure + '"] svg').first()).toBeVisible({ timeout: PAINT_TIMEOUT_MS });
  await page.screenshot({ path: screenshotsDir + 'utilisation-ci-' + locale + '.png', fullPage: false });
});
