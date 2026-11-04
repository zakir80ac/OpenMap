// T-121 REQ-UI-029 — the digital twin on the real stack, per locale project: the scene renders a WebGL canvas with
// the estate's rooms and racks, picking a focus CI through the search lays its dependency graph on the layer planes
// (the plane legend lists the layers), and the screen is captured as evidence.
import { fileURLToPath } from 'node:url';
import { expect, test } from '@playwright/test';
import { isLocale, translate } from '@openmap/i18n';
import { signIn } from './auth';

const screenshotsDir = fileURLToPath(new URL('./screenshots/', import.meta.url));
const SCENE_TIMEOUT_MS = 30_000;

test('the twin renders the estate in 3D and lays a focus CI dependencies on the layer planes', async ({ page }, testInfo) => {
  const locale = testInfo.project.name;
  if (!isLocale(locale)) throw new Error('project name must be a locale: ' + locale);
  test.setTimeout(SCENE_TIMEOUT_MS * 4);

  await page.goto('/' + locale + '/twin');
  await signIn(page, locale);
  await expect(page.getByRole('heading', { level: 1, name: translate(locale, 'nav.twin') })).toBeVisible({ timeout: SCENE_TIMEOUT_MS });
  const canvas = page.locator('[data-testid="twin-canvas"] canvas');
  await expect(canvas).toBeVisible({ timeout: SCENE_TIMEOUT_MS });
  const webgl = await canvas.evaluate((el) => {
    const c = el as HTMLCanvasElement;
    return c.width > 0 && c.height > 0;
  });
  expect(webgl).toBe(true);
  // The racks KPI is a positive count on the replayed estate.
  const racksKpi = page.locator('.om-kpi').filter({ hasText: translate(locale, 'twin.kpi.racks') }).first();
  await expect(racksKpi).toBeVisible();
  await expect(racksKpi.locator('[data-part="value"]')).not.toHaveText(new Intl.NumberFormat(locale).format(0));
  await page.screenshot({ path: screenshotsDir + 'twin-' + locale + '.png', fullPage: false });

  // Focus: a CI from the CMDB list (the search widget itself is covered by the dependency map tests).
  await page.goto('/' + locale + '/cmdb?q=srv-dmm-sas');
  // A host, not a software instance installed on one: its dependencies span power, hardware, OS and applications.
  const firstCi = page.locator('main a[href*="/cmdb/"]').filter({ hasText: /^srv-dmm-[a-z]+-\d+$/ }).first();
  await expect(firstCi).toBeVisible({ timeout: SCENE_TIMEOUT_MS });
  const href = await firstCi.getAttribute('href');
  const ciId = href?.split('/cmdb/')[1] ?? '';
  expect(ciId).not.toBe('');
  await page.goto('/' + locale + '/twin?ci=' + ciId);
  await expect(page.locator('[data-testid="twin-canvas"] canvas')).toBeVisible({ timeout: SCENE_TIMEOUT_MS });
  await expect(page.getByRole('list', { name: translate(locale, 'twin.planes.label') })).toBeVisible({ timeout: SCENE_TIMEOUT_MS });
  await expect(page.getByRole('list', { name: translate(locale, 'twin.planes.label') }).getByRole('listitem').first()).toBeVisible();
  await page.screenshot({ path: screenshotsDir + 'twin-focus-' + locale + '.png', fullPage: false });
});
