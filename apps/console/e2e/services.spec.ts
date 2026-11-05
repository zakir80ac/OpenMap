// T-138 REQ-BSM-006 REQ-BSM-008 REQ-UI-012 — SLA assignment, uptime by period and incident response on the real stack,
// per locale project: the Business services screen shows the uptime table and switches to quarters, an operator
// creates an SLA, holds a service to it and sees the window label follow, records an RCA on a resolved incident, and
// the service detail route shows the same uptime per period. Screenshots are the RTL/LTR evidence.
import { fileURLToPath } from 'node:url';
import { expect, test } from '@playwright/test';
import { isLocale, translate } from '@openmap/i18n';
import { signIn } from './auth';

const screenshotsDir = fileURLToPath(new URL('./screenshots/', import.meta.url));
const PAINT_TIMEOUT_MS = 30_000;

test('SLAs are assigned, uptime is reported by month and quarter, and incidents carry an RCA', async ({
  page,
}, testInfo) => {
  const locale = testInfo.project.name;
  if (!isLocale(locale)) throw new Error('project name must be a locale: ' + locale);
  test.setTimeout(PAINT_TIMEOUT_MS * 5);
  const stamp = Date.now().toString(36);
  const slaName = 'E2E Gold ' + stamp;

  await page.goto('/' + locale + '/services');
  await signIn(page, locale);
  await expect(
    page.getByRole('heading', { level: 1, name: translate(locale, 'nav.services') }),
  ).toBeVisible();

  // Uptime by month, then by quarter: the table carries one row per service and one column per period.
  const uptime = page.getByTestId('uptime-table');
  await expect(uptime).toBeVisible({ timeout: PAINT_TIMEOUT_MS });
  await expect(uptime).toHaveAttribute('data-granularity', 'month');
  expect(await uptime.getByRole('row').count()).toBeGreaterThan(1);
  await page.getByRole('radio', { name: translate(locale, 'services.uptime.quarter') }).click();
  await expect(page.getByTestId('uptime-table')).toHaveAttribute('data-granularity', 'quarter', {
    timeout: PAINT_TIMEOUT_MS,
  });
  await expect(page.getByTestId('uptime-table').getByRole('row').nth(1)).toBeVisible();

  // Create an SLA and hold the first listed service to it; its window label follows the SLA.
  await page.getByRole('button', { name: translate(locale, 'services.sla.new') }).click();
  const form = page.getByRole('form', { name: translate(locale, 'services.sla.create') });
  await form.getByLabel(translate(locale, 'services.sla.name')).fill(slaName);
  // A target the replayed history meets, so the engine's next tick does not open a breach incident on the dev estate.
  await form.getByLabel(translate(locale, 'services.sla.target')).fill('90');
  await form.getByLabel(translate(locale, 'services.sla.window')).selectOption('calendar_quarter');
  await form.getByRole('button', { name: translate(locale, 'services.sla.create') }).click();
  const slaRow = page.getByTestId('sla-list').locator('[data-sla-name="' + slaName + '"]');
  await expect(slaRow).toBeVisible({ timeout: PAINT_TIMEOUT_MS });

  // A service with figures in the current quarter (one without history reads "No data" whatever its SLA).
  const measured = page
    .getByTestId('uptime-table')
    .locator('tbody tr')
    .filter({ hasNotText: translate(locale, 'services.uptime.noData') })
    .first();
  const serviceId = await measured.getAttribute('data-service-id');
  if (serviceId === null) throw new Error('uptime rows carry their service id');
  const firstService = page.locator('li[data-service-id="' + serviceId + '"]');
  await expect(firstService).toBeVisible();
  const select = firstService.getByLabel(translate(locale, 'services.sla.assign'));
  await select.selectOption({ label: slaName });
  await expect(firstService.getByText(translate(locale, 'services.window.calendar_quarter'))).toBeVisible({
    timeout: PAINT_TIMEOUT_MS,
  });
  await page.screenshot({ path: screenshotsDir + 'services-sla-' + locale + '.png', fullPage: false });

  // Incident response: the resolved incidents of the replayed history take an RCA.
  await page.getByRole('button', { name: translate(locale, 'services.incidents.showAll') }).click();
  const incident = page.getByRole('complementary').locator('[data-incident-id]').first();
  await expect(incident).toBeVisible({ timeout: PAINT_TIMEOUT_MS });
  await incident.getByRole('button', { name: translate(locale, 'services.rca.open') }).click();
  const rca = incident.getByRole('region', { name: translate(locale, 'services.rca.title') });
  await rca
    .getByLabel(translate(locale, 'services.rca.summary'), { exact: true })
    .fill('E2E ' + stamp + ': single feed, breaker tripped');
  await rca
    .getByLabel(translate(locale, 'services.rca.factors'), { exact: true })
    .fill('no redundant feed\nbreaker undersized');
  await rca.getByRole('button', { name: translate(locale, 'services.rca.addAction') }).click();
  // The row just added is the last one; an earlier run of the other locale may have left actions on this incident.
  await rca
    .getByLabel(translate(locale, 'services.rca.action.description'), { exact: true })
    .last()
    .fill('Add B-side feed');
  await rca.getByRole('button', { name: translate(locale, 'services.rca.save') }).click();
  // The refreshed incident carries the RCA (the empty-state line goes away) and the audited mutation on its timeline.
  await expect(incident.getByText(translate(locale, 'services.rca.empty'))).toHaveCount(0, {
    timeout: PAINT_TIMEOUT_MS,
  });
  await incident.getByRole('button', { name: translate(locale, 'services.timeline.title') }).click();
  await expect(incident.getByText('updateIncidentRca').first()).toBeVisible({ timeout: PAINT_TIMEOUT_MS });
  await page.screenshot({
    path: screenshotsDir + 'services-incident-rca-' + locale + '.png',
    fullPage: false,
  });

  // The service detail route: the same uptime per period and the service's incidents.
  await firstService.getByRole('link').first().click();
  await expect(page.getByTestId('service-detail')).toBeVisible({ timeout: PAINT_TIMEOUT_MS });
  await expect(page.getByTestId('uptime-table')).toBeVisible({ timeout: PAINT_TIMEOUT_MS });
  await expect(
    page.getByRole('heading', { level: 2, name: translate(locale, 'services.detail.incidents') }),
  ).toBeVisible();
  await page.screenshot({ path: screenshotsDir + 'services-detail-' + locale + '.png', fullPage: false });

  // Leave the estate as found: clear the assignment and remove the SLA.
  await page.goBack();
  await expect(
    page.getByRole('heading', { level: 1, name: translate(locale, 'nav.services') }),
  ).toBeVisible();
  const again = page.locator('li[data-service-id="' + serviceId + '"]');
  await again.getByLabel(translate(locale, 'services.sla.assign')).selectOption('');
  await expect(again.getByText(translate(locale, 'services.window.calendar_quarter'))).toHaveCount(0, {
    timeout: PAINT_TIMEOUT_MS,
  });
  await page
    .getByTestId('sla-list')
    .locator('[data-sla-name="' + slaName + '"]')
    .getByRole('button', { name: translate(locale, 'services.sla.delete') })
    .click();
  await expect(page.getByTestId('sla-list').locator('[data-sla-name="' + slaName + '"]')).toHaveCount(0, {
    timeout: PAINT_TIMEOUT_MS,
  });
});
