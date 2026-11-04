// T-124 REQ-UI-030 — the dashboard wizard and customisation on the real stack, per locale project: create a Finance
// dashboard from its template (or start a second one when the user already has a dashboard), see its widgets paint
// from live data, customise it (remove a widget, save), and capture both the wizard and the result as evidence.
import { fileURLToPath } from 'node:url';
import { expect, test } from '@playwright/test';
import { DASHBOARD_TEMPLATES } from '@openmap/contracts';
import { isLocale, translate } from '@openmap/i18n';
import { signIn } from './auth';

const screenshotsDir = fileURLToPath(new URL('./screenshots/', import.meta.url));
const PAINT_TIMEOUT_MS = 30_000;

test('the wizard creates a Finance dashboard whose widgets paint from live data and can be customised', async ({ page }, testInfo) => {
  const locale = testInfo.project.name;
  if (!isLocale(locale)) throw new Error('project name must be a locale: ' + locale);
  test.setTimeout(PAINT_TIMEOUT_MS * 4);

  await page.goto('/' + locale + '/dashboard');
  await signIn(page, locale);
  await expect(page.getByRole('heading', { level: 1, name: translate(locale, 'nav.dashboard') })).toBeVisible();
  // A user without a dashboard lands in the wizard; one with dashboards lands on one and the wizard is a click away.
  const wizard = page.getByRole('region', { name: translate(locale, 'dashboard.wizard.title') });
  const newButton = page.getByRole('button', { name: translate(locale, 'dashboard.new') });
  await expect(wizard.or(newButton)).toBeVisible({ timeout: PAINT_TIMEOUT_MS });
  if (await newButton.isVisible()) await newButton.click();
  await expect(wizard).toBeVisible({ timeout: PAINT_TIMEOUT_MS });
  await page.screenshot({ path: screenshotsDir + 'dashboard-wizard-' + locale + '.png', fullPage: false });

  await wizard.getByRole('radio', { name: new RegExp(translate(locale, 'dashboard.persona.finance.title')) }).click();
  await wizard.getByRole('button', { name: translate(locale, 'common.next') }).click();
  await expect(wizard.getByRole('checkbox', { checked: true })).toHaveCount(DASHBOARD_TEMPLATES.finance.length);
  await wizard.getByRole('button', { name: translate(locale, 'common.next') }).click();
  const name = translate(locale, 'dashboard.persona.finance.title') + ' ' + String(Date.now());
  await wizard.getByLabel(translate(locale, 'dashboard.wizard.name')).fill(name);
  await wizard.getByRole('button', { name: translate(locale, 'dashboard.wizard.create') }).click();

  const grid = page.getByRole('region', { name: translate(locale, 'dashboard.widgets') });
  await expect(grid).toBeVisible({ timeout: PAINT_TIMEOUT_MS });
  await expect(grid.getByRole('article')).toHaveCount(DASHBOARD_TEMPLATES.finance.length);
  // Live figures: the register donut shows the asset total and the plan budgets list every status.
  const stages = grid.getByRole('article').filter({ hasText: translate(locale, 'dashboard.widget.assets.stages.title') });
  await expect(stages.getByText(translate(locale, 'dashboard.widget.assetsTotal'), { exact: true })).toBeVisible({ timeout: PAINT_TIMEOUT_MS });
  await expect(grid.getByText(translate(locale, 'assets.plans.status.live'))).toBeVisible({ timeout: PAINT_TIMEOUT_MS });
  await expect(page.getByRole('alert').filter({ hasText: translate(locale, 'common.error') })).toHaveCount(0);
  await page.screenshot({ path: screenshotsDir + 'dashboard-finance-' + locale + '.png', fullPage: true });

  // Customise: drop the first widget and save; the grid keeps one fewer after the round trip.
  await page.getByRole('button', { name: translate(locale, 'dashboard.customize') }).click();
  await grid.getByRole('button', { name: translate(locale, 'dashboard.removeWidget') }).first().click();
  await page.getByRole('button', { name: translate(locale, 'common.save') }).click();
  await expect(page.getByRole('region', { name: translate(locale, 'dashboard.editing') })).toHaveCount(0, { timeout: PAINT_TIMEOUT_MS });
  await expect(grid.getByRole('article')).toHaveCount(DASHBOARD_TEMPLATES.finance.length - 1, { timeout: PAINT_TIMEOUT_MS });

  // Leave the estate as found: delete the dashboard this run created (the delete asks for confirmation).
  page.on('dialog', (dialog) => void dialog.accept());
  await page.getByRole('button', { name: translate(locale, 'dashboard.customize') }).click();
  await page.getByRole('button', { name: translate(locale, 'common.delete') }).click();
  await expect(page.getByRole('radio', { name })).toHaveCount(0, { timeout: PAINT_TIMEOUT_MS });
});
