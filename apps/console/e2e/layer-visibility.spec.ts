// T-201 REQ-CMDB-021 — per-device layer visibility across the estate-wide screens on the real stack, per locale project:
// switching the Applications layer off on Layers makes CMDB, Assets, Impact and the Dashboard name it as hidden and leave
// its CIs out (the CMDB list holds no application-layer row), and Show all brings everything back. Screenshots are the
// evidence (docs/evidence/layer-visibility.md).
import { fileURLToPath } from 'node:url';
import { expect, test } from '@playwright/test';
import { isLocale, translate } from '@openmap/i18n';
import { signIn } from './auth';

const screenshotsDir = fileURLToPath(new URL('./screenshots/', import.meta.url));
const PAINT_TIMEOUT_MS = 30_000;
const SCREENS_VISITED = 8;

test('a layer hidden on this device is left out of every estate-wide list until shown again (REQ-CMDB-021)', async ({ page }, testInfo) => {
  const locale = testInfo.project.name;
  if (!isLocale(locale)) throw new Error('project name must be a locale: ' + locale);
  // The wizard, Layers, four estate-wide screens, the delete and the way back, each allowed PAINT_TIMEOUT_MS on a cold stack.
  test.setTimeout(PAINT_TIMEOUT_MS * SCREENS_VISITED);
  const applications = translate(locale, 'layer.applications');
  // The Dashboard leg needs a dashboard with the layer breakdown (estate.layers): this run makes one from the CTO/CIO
  // template and deletes it at the end. A user with no dashboard (a fresh stack) lands in the wizard; one with
  // dashboards opens it from New dashboard.
  await page.goto('/' + locale + '/dashboard');
  await signIn(page, locale);
  const wizard = page.getByRole('region', { name: translate(locale, 'dashboard.wizard.title') });
  const newButton = page.getByRole('button', { name: translate(locale, 'dashboard.new') });
  await expect(wizard.or(newButton)).toBeVisible({ timeout: PAINT_TIMEOUT_MS });
  if (await newButton.isVisible()) await newButton.click();
  await wizard.getByRole('radio', { name: new RegExp(translate(locale, 'dashboard.persona.cto_cio.title')) }).click();
  await wizard.getByRole('button', { name: translate(locale, 'common.next') }).click();
  await wizard.getByRole('button', { name: translate(locale, 'common.next') }).click();
  const dashboardName = translate(locale, 'dashboard.persona.cto_cio.title') + ' ' + String(Date.now());
  await wizard.getByLabel(translate(locale, 'dashboard.wizard.name')).fill(dashboardName);
  await wizard.getByRole('button', { name: translate(locale, 'dashboard.wizard.create') }).click();
  await expect(page.getByRole('region', { name: translate(locale, 'dashboard.widgets') })).toBeVisible({ timeout: PAINT_TIMEOUT_MS });
  await expect(page).toHaveURL(/[?&]d=/u, { timeout: PAINT_TIMEOUT_MS });
  const created = new URL(page.url());
  const dashboardPath = created.pathname + created.search;

  await page.goto('/' + locale + '/layers');
  const toggle = page.getByRole('switch', { name: translate(locale, 'layers.toggle', { layer: applications }) });
  await expect(toggle).toHaveAttribute('aria-checked', 'true', { timeout: PAINT_TIMEOUT_MS });
  await toggle.click();
  await expect(toggle).toHaveAttribute('aria-checked', 'false');

  for (const route of ['/cmdb', '/assets', '/impact', '/dashboard']) {
    await page.goto(route === '/dashboard' ? dashboardPath : '/' + locale + route);
    const notice = page.getByTestId('hidden-layers').first();
    await expect(notice, route).toBeVisible({ timeout: PAINT_TIMEOUT_MS });
    await expect(notice).toContainText(applications);
    if (route === '/cmdb') {
      // No row of the hidden layer in the list (rows carry their layer badge).
      const list = page.getByTestId('ci-list');
      await expect(list.locator('[data-layer]').first()).toBeVisible({ timeout: PAINT_TIMEOUT_MS });
      await expect(list.locator('[data-layer="applications"]')).toHaveCount(0);
      await page.screenshot({ path: screenshotsDir + 'layer-visibility-cmdb-' + locale + '.png', fullPage: false });
    }
    if (route === '/assets') await page.screenshot({ path: screenshotsDir + 'layer-visibility-assets-' + locale + '.png', fullPage: false });
  }

  await page.getByTestId('hidden-layers').first().getByRole('button', { name: translate(locale, 'layers.hidden.showAll') }).click();
  await expect(page.getByTestId('hidden-layers')).toHaveCount(0);
  // Leave the estate as found: delete this run's dashboard (the delete asks for confirmation).
  page.on('dialog', (dialog) => void dialog.accept());
  await page.getByRole('button', { name: translate(locale, 'dashboard.customize') }).click();
  await page.getByRole('button', { name: translate(locale, 'common.delete') }).click();
  await expect(page.getByRole('radio', { name: dashboardName })).toHaveCount(0, { timeout: PAINT_TIMEOUT_MS });
  await page.goto('/' + locale + '/layers');
  await expect(page.getByRole('switch', { name: translate(locale, 'layers.toggle', { layer: applications }) })).toHaveAttribute('aria-checked', 'true', { timeout: PAINT_TIMEOUT_MS });
});
