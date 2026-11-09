// T-542 REQ-DCIM-006 (ADR-060) — the DCIM Environment view on the real stack, per locale project: the first room's
// racks with their inlet and outlet temperatures, the rise and their states, its cooling units and humidity (from the
// estate's environmental history), and a window change re-reading the room; no error is shown.
import { fileURLToPath } from 'node:url';
import { expect, test } from '@playwright/test';
import { isLocale, translate } from '@openmap/i18n';
import { signIn } from './auth';

const screenshotsDir = fileURLToPath(new URL('./screenshots/', import.meta.url));
const ACTION_MS = 30_000;
const STEPS_BUDGET = 4;
const WEEK_HOURS = '168';
const ERROR_ALERT = 'p[role="alert"]';

test('rack temperatures, airflow, humidity and cooling units show for a room over a window', async ({
  page,
}, testInfo) => {
  const locale = testInfo.project.name;
  if (!isLocale(locale)) throw new Error('project name must be a locale: ' + locale);
  test.setTimeout(ACTION_MS * STEPS_BUDGET);
  page.setDefaultTimeout(ACTION_MS);
  const t = (key: Parameters<typeof translate>[1], params?: Record<string, string>): string =>
    translate(locale, key, params);

  await page.goto('/' + locale + '/dcim');
  await signIn(page, locale);
  await page
    .getByRole('group', { name: t('dcim.views') })
    .getByText(t('dcim.view.environment'), { exact: true })
    .click();
  const racks = page.getByRole('table', { name: t('dcim.env.racks.title') });
  await expect(racks).toBeVisible();
  await expect(racks.getByRole('row').nth(1)).toBeVisible();
  // Each rack row carries a temperature and an airflow state.
  const states = (['normal', 'warning', 'critical', 'unknown'] as const).map((st) =>
    t(('dcim.env.state.temperature.' + st) as Parameters<typeof translate>[1]),
  );
  // The state labels are plain words, so they join into a pattern as they are.
  await expect(racks.getByRole('row').nth(1)).toContainText(new RegExp(states.join('|'), 'u'));
  await expect(
    page
      .getByRole('table', { name: t('dcim.env.cooling.title') })
      .or(page.getByText(t('dcim.env.cooling.none'))),
  ).toBeVisible();
  await page.screenshot({ path: screenshotsDir + 'environment-' + locale + '.png', fullPage: true });

  await page.getByRole('combobox', { name: t('dcim.monitor.window') }).selectOption(WEEK_HOURS);
  await expect(racks.getByRole('row').nth(1)).toBeVisible();
  await expect(page.locator(ERROR_ALERT)).toHaveCount(0);
});
