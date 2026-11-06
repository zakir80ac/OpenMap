// T-129 REQ-CMDB-039 REQ-CMDB-040 — the asset register on the real stack, per locale project: the register lists
// discovered assets across layers with their cover dates, the layer strip and the data-gap filter narrow it, the
// details panel saves warranty cover for a row missing it (audited), unknown devices show a diagnosis, and an
// unmanaged asset is recorded by hand together with its CI. Screenshots are the RTL/LTR evidence.
import { fileURLToPath } from 'node:url';
import { expect, test } from '@playwright/test';
import { isLocale, translate } from '@openmap/i18n';
import { signIn } from './auth';

const screenshotsDir = fileURLToPath(new URL('./screenshots/', import.meta.url));
const PAINT_TIMEOUT_MS = 30_000;

test('the register covers every layer, flags missing cover, saves details and records unmanaged assets', async ({
  page,
}, testInfo) => {
  const locale = testInfo.project.name;
  if (!isLocale(locale)) throw new Error('project name must be a locale: ' + locale);
  test.setTimeout(PAINT_TIMEOUT_MS * 4);

  await page.goto('/' + locale + '/assets');
  await signIn(page, locale);
  await expect(
    page.getByRole('heading', { level: 1, name: translate(locale, 'assets.title') }),
  ).toBeVisible();
  const register = page.getByTestId('asset-register');
  await expect(register).toBeVisible({ timeout: PAINT_TIMEOUT_MS });
  await expect(register.getByRole('row').nth(1)).toBeVisible();

  // The layer strip carries the per-layer totals; hardware alone lists thousands of discovered rows.
  const strip = page.getByRole('group', { name: translate(locale, 'assets.register.layers') });
  const hardware = strip.getByRole('button', { name: new RegExp(translate(locale, 'layer.hardware')) });
  await expect(hardware).toContainText(/[1-9]/);
  await hardware.click();
  await expect(register.getByRole('row').nth(1)).toBeVisible({ timeout: PAINT_TIMEOUT_MS });
  await page.screenshot({ path: screenshotsDir + 'assets-register-' + locale + '.png', fullPage: false });

  // The register pages by number: the second page replaces the rows and the page survives in the URL.
  const firstTag = await register.getByRole('row').nth(1).getAttribute('data-asset-tag');
  const pager = page.getByRole('navigation', { name: translate(locale, 'assets.table.pager') });
  await expect(pager.getByRole('button', { name: translate(locale, 'common.previous') })).toBeDisabled();
  await pager.getByRole('button', { name: translate(locale, 'common.next') }).click();
  await expect(page).toHaveURL(/page=2/);
  await expect(page.getByTestId('asset-pager')).toHaveAttribute('data-page', '2', {
    timeout: PAINT_TIMEOUT_MS,
  });
  await expect(page.getByTestId('asset-register').getByRole('row').nth(1)).toBeVisible({
    timeout: PAINT_TIMEOUT_MS,
  });
  expect(
    await page.getByTestId('asset-register').getByRole('row').nth(1).getAttribute('data-asset-tag'),
  ).not.toBe(firstTag);
  await pager.getByRole('button', { name: translate(locale, 'common.first') }).click();
  await expect(page.getByTestId('asset-pager')).toHaveAttribute('data-page', '1', {
    timeout: PAINT_TIMEOUT_MS,
  });

  // Rows missing an end-of-life date, then the details panel saves one for the first row.
  await page.getByTestId('asset-data-filter').selectOption('end_of_life');
  const firstRow = register.getByRole('row').nth(1);
  await expect(firstRow).toBeVisible({ timeout: PAINT_TIMEOUT_MS });
  const tag = await firstRow.getAttribute('data-asset-tag');
  if (tag === null) throw new Error('register rows carry their tag');
  await firstRow.getByRole('button', { name: translate(locale, 'assets.table.edit', { tag }), exact: true }).click();
  const panel = page.getByTestId('asset-details-panel');
  await expect(panel).toBeVisible();
  const form = panel.getByRole('form', { name: translate(locale, 'assets.details.title') });
  await form.getByLabel(translate(locale, 'assets.details.eol.endOfSupport')).fill('2031-12-31');
  await form.getByLabel(translate(locale, 'assets.details.note')).fill('e2e ' + String(Date.now()));
  await form.getByRole('button', { name: translate(locale, 'assets.details.save') }).click();
  await expect(panel.getByRole('status')).toBeVisible({ timeout: PAINT_TIMEOUT_MS });
  await expect(panel.getByText(translate(locale, 'assets.details.source.manual')).first()).toBeVisible();
  await page.screenshot({ path: screenshotsDir + 'assets-details-' + locale + '.png', fullPage: false });

  // Unknown devices carry a diagnosis each.
  const unknown = page.getByTestId('unknown-devices');
  await expect(unknown).toBeVisible({ timeout: PAINT_TIMEOUT_MS });
  const device = page.getByTestId('unknown-device').first();
  await expect(device).toHaveAttribute(
    'data-kind',
    /snmp_power|snmp_device|unknown_service|no_management|endpoint/,
  );
  await device.scrollIntoViewIfNeeded();
  await page.screenshot({ path: screenshotsDir + 'assets-unknown-' + locale + '.png', fullPage: false });

  // REQ-CMDB-042: a software row asks for a subscription, not a warranty; the panel saves term and credits (audited).
  await strip.getByRole('button', { name: new RegExp(translate(locale, 'layer.applications')) }).click();
  await page.getByTestId('asset-data-filter').selectOption('subscription');
  await expect(register.getByRole('row').nth(1)).toBeVisible({ timeout: PAINT_TIMEOUT_MS });
  const subscriptionTag = await register.getByRole('row').nth(1).getAttribute('data-asset-tag');
  if (subscriptionTag === null) throw new Error('register rows carry their tag');
  await register
    .getByRole('button', { name: translate(locale, 'assets.table.edit', { tag: subscriptionTag }), exact: true })
    .click();
  const subscriptionPanel = page.getByTestId('asset-details-panel');
  await expect(
    subscriptionPanel.getByLabel(translate(locale, 'assets.details.subscription.provider')),
  ).toBeVisible();
  await expect(
    subscriptionPanel.getByLabel(translate(locale, 'assets.details.warranty.provider')),
  ).toHaveCount(0);
  await subscriptionPanel
    .getByLabel(translate(locale, 'assets.details.subscription.provider'))
    .fill('Red Hat');
  await subscriptionPanel
    .getByLabel(translate(locale, 'assets.details.subscription.endsAt'))
    .fill('2027-09-30');
  await subscriptionPanel
    .getByLabel(translate(locale, 'assets.details.subscription.creditsRemaining'))
    .fill('120');
  await subscriptionPanel
    .getByLabel(translate(locale, 'assets.details.subscription.creditsUnit'))
    .fill('cores');
  await subscriptionPanel.getByRole('button', { name: translate(locale, 'assets.details.save') }).click();
  await expect(subscriptionPanel.getByRole('status')).toBeVisible({ timeout: PAINT_TIMEOUT_MS });
  await page.screenshot({ path: screenshotsDir + 'assets-subscription-' + locale + '.png', fullPage: false });
  await subscriptionPanel.getByRole('button', { name: translate(locale, 'assets.details.close') }).click();
  await page.getByTestId('asset-data-filter').selectOption('');

  // An unmetered PDU recorded by hand: its CI and asset appear in the register under the data centre layer.
  const manual = page.getByRole('form', { name: translate(locale, 'assets.manual.title') });
  const name = 'PDU e2e ' + String(Date.now());
  await manual.getByLabel(translate(locale, 'assets.manual.name')).fill(name);
  await manual.getByLabel(translate(locale, 'assets.details.manufacturer')).fill('APC');
  await manual.getByLabel(translate(locale, 'assets.details.model')).fill('AP7921');
  await manual.getByRole('button', { name: translate(locale, 'assets.manual.create') }).click();
  await expect(manual.getByRole('status')).toBeVisible({ timeout: PAINT_TIMEOUT_MS });
  await page.getByTestId('asset-data-filter').selectOption('');
  await strip.getByRole('button', { name: new RegExp(translate(locale, 'layer.dc')) }).click();
  await page.getByLabel(translate(locale, 'assets.filter.text')).fill(name);
  await expect(register.getByRole('row').filter({ hasText: name })).toBeVisible({
    timeout: PAINT_TIMEOUT_MS,
  });
});
