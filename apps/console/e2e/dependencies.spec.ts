// T-152 REQ-DEP-002 (ADR-029) — the dependency map against the live stack, per locale project: the focus search finds
// a host of the synthetic estate, the map draws its impact graph, and the side panel lists the observed traffic the
// reconciler derived from flows (protocol and ports, flows and bytes, the process, the confidence). Screenshots are
// the evidence (docs/evidence/dependency-mapping.md).
import { fileURLToPath } from 'node:url';
import { expect, test } from '@playwright/test';
import { isLocale, translate, type Locale } from '@openmap/i18n';
import { signIn } from './auth';

const PAINT_TIMEOUT_MS = 60_000;
const screenshotsDir = fileURLToPath(new URL('./screenshots/', import.meta.url));
/** A web host of the synthetic estate (seed 42): it talks to its application's API listeners over tcp/8443. */
const FOCUS_HOST = 'web-dmm-cards-02';

function localeOf(name: string): Locale {
  if (!isLocale(name)) throw new Error('project name must be a locale: ' + name);
  return name;
}

test('Dependencies: the side panel lists the traffic observed for the focus CI (REQ-DEP-002)', async ({ page }, testInfo) => {
  const locale = localeOf(testInfo.project.name);
  test.setTimeout(PAINT_TIMEOUT_MS * 3);
  await page.goto('/' + locale + '/dependencies');
  await signIn(page, locale);
  const search = page.getByRole('combobox', { name: translate(locale, 'dependencies.focus.label') });
  await search.fill(FOCUS_HOST);
  const results = page.getByRole('listbox', { name: translate(locale, 'dependencies.focus.results') });
  await results.getByRole('option', { name: new RegExp(FOCUS_HOST) }).first().click();
  await expect(page).toHaveURL(/[?&]ci=[0-9a-f-]{36}/, { timeout: PAINT_TIMEOUT_MS });
  await expect(page.getByText(translate(locale, 'dependencies.focusOn', { name: FOCUS_HOST }))).toBeVisible({ timeout: PAINT_TIMEOUT_MS });
  const traffic = page.getByTestId('observed-traffic');
  await expect(traffic).toBeVisible({ timeout: PAINT_TIMEOUT_MS });
  const rows = traffic.locator('li');
  await expect(rows.first()).toBeVisible();
  const count = await rows.count();
  expect(count).toBeGreaterThan(0);
  await expect(traffic.getByText(translate(locale, 'dependencies.panel.trafficTo')).first()).toBeVisible();
  await expect(traffic.getByText('tcp/8443').first()).toBeVisible();
  await expect(traffic.getByText(translate(locale, 'dependencies.panel.trafficProcess', { process: 'java' })).first()).toBeVisible();
  await expect(traffic.getByText(translate(locale, 'dependencies.panel.trafficConfidence', { percent: '90' })).first()).toBeVisible();
  testInfo.annotations.push({ type: 'observed-traffic', description: String(count) + ' rows' });
  await page.screenshot({ path: screenshotsDir + 'dependencies-traffic-' + locale + '.png', fullPage: true });
});
