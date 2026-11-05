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

test('the register covers every layer, flags missing cover, saves details and records unmanaged assets', async ({ page }, testInfo) => {
  const locale = testInfo.project.name;
  if (!isLocale(locale)) throw new Error('project name must be a locale: ' + locale);
  test.setTimeout(PAINT_TIMEOUT_MS * 4);

  await page.goto('/' + locale + '/assets');
  await signIn(page, locale);
  await expect(page.getByRole('heading', { level: 1, name: translate(locale, 'assets.title') })).toBeVisible();
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

  // Rows missing an end-of-life date, then the details panel saves one for the first row.
  await page.getByLabel(translate(locale, 'assets.filter.data')).selectOption('end_of_life');
  const firstRow = register.getByRole('row').nth(1);
  await expect(firstRow).toBeVisible({ timeout: PAINT_TIMEOUT_MS });
  const tag = await firstRow.getAttribute('data-asset-tag');
  if (tag === null) throw new Error('register rows carry their tag');
  await firstRow.getByRole('button', { name: translate(locale, 'assets.table.edit', { tag }) }).click();
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
  await expect(device).toHaveAttribute('data-kind', /snmp_power|snmp_device|unknown_service|no_management|endpoint/);
  await device.scrollIntoViewIfNeeded();
  await page.screenshot({ path: screenshotsDir + 'assets-unknown-' + locale + '.png', fullPage: false });

  // An unmetered PDU recorded by hand: its CI and asset appear in the register under the data centre layer.
  const manual = page.getByRole('form', { name: translate(locale, 'assets.manual.title') });
  const name = 'PDU e2e ' + String(Date.now());
  await manual.getByLabel(translate(locale, 'assets.manual.name')).fill(name);
  await manual.getByLabel(translate(locale, 'assets.details.manufacturer')).fill('APC');
  await manual.getByLabel(translate(locale, 'assets.details.model')).fill('AP7921');
  await manual.getByRole('button', { name: translate(locale, 'assets.manual.create') }).click();
  await expect(manual.getByRole('status')).toBeVisible({ timeout: PAINT_TIMEOUT_MS });
  await page.getByLabel(translate(locale, 'assets.filter.data')).selectOption('');
  await strip.getByRole('button', { name: new RegExp(translate(locale, 'layer.dc')) }).click();
  await page.getByLabel(translate(locale, 'assets.filter.text')).fill(name);
  await expect(register.getByRole('row').filter({ hasText: name })).toBeVisible({ timeout: PAINT_TIMEOUT_MS });
});
