// T-160 REQ-DEP-004 (ADR-031) — the layered application map against the live stack, per locale project: the
// Dependencies screen switches to the application view, an application of the synthetic estate is chosen, its tiers
// are drawn left to right with every component placed in the virtualization layer, the dependency list shows the
// traffic observed inside the application, and hiding the virtualization layer removes its row. Screenshots are the
// evidence (docs/evidence/application-map.md).
import { fileURLToPath } from 'node:url';
import { expect, test } from '@playwright/test';
import { isLocale, translate, type Locale } from '@openmap/i18n';
import { signIn } from './auth';

const PAINT_TIMEOUT_MS = 60_000;
const screenshotsDir = fileURLToPath(new URL('./screenshots/', import.meta.url));
/** An application of the synthetic estate (seed 42) with web, api and db tiers that talk to each other. */
const APPLICATION = 'aml';

function localeOf(name: string): Locale {
  if (!isLocale(name)) throw new Error('project name must be a locale: ' + name);
  return name;
}

test('Dependencies: the layered application map (REQ-DEP-004)', async ({ page }, testInfo) => {
  const locale = localeOf(testInfo.project.name);
  test.setTimeout(PAINT_TIMEOUT_MS * 3);
  await page.goto('/' + locale + '/dependencies');
  await signIn(page, locale);
  await page.getByRole('radiogroup', { name: translate(locale, 'dependencies.view.label') }).getByRole('radio', { name: translate(locale, 'dependencies.view.application') }).click();
  await expect(page).toHaveURL(/view=application/);
  const view = page.getByTestId('application-map');
  const select = view.getByRole('combobox', { name: translate(locale, 'appmap.application') });
  await expect(select.locator('option', { hasText: APPLICATION })).toHaveCount(1, { timeout: PAINT_TIMEOUT_MS });
  await select.selectOption({ label: APPLICATION });
  await expect(page).toHaveURL(/[?&]app=[0-9a-f-]{36}/);
  const grid = view.getByRole('table', { name: translate(locale, 'appmap.grid') });
  await expect(grid).toBeVisible({ timeout: PAINT_TIMEOUT_MS });
  const headers = await grid.getByRole('columnheader').allTextContents();
  expect(headers.slice(1)).toEqual(expect.arrayContaining(['web', 'api', 'db']));
  expect(headers.indexOf('web')).toBeLessThan(headers.indexOf('db'));
  await expect(grid.getByTestId('appmap-component').first()).toBeVisible();
  await expect(view.getByTestId('appmap-layer-virtualization')).toBeVisible();
  const internal = view.getByTestId('appmap-deps-internal');
  await expect(internal.getByText(translate(locale, 'appmap.dep.derived', { type: 'depends_on' })).first()).toBeVisible();
  await page.screenshot({ path: screenshotsDir + 'application-map-' + locale + '.png', fullPage: true });

  await view.getByRole('group', { name: translate(locale, 'appmap.layers') }).getByRole('button', { name: translate(locale, 'layer.virtualization') }).click();
  await expect(page).toHaveURL(/hide=virtualization/);
  await expect(view.getByTestId('appmap-layer-virtualization')).toHaveCount(0);
});
