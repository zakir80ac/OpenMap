// T-185 REQ-CMDB-026 REQ-CMDB-027 REQ-CMDB-028 REQ-CMDB-029 — vendors and contracts on the real stack, per locale
// project (ADR-035): an operator adds a vendor and its first-line contact, a department, and a support contract with a
// signed document billed to the department; the contract register shows it with its days left, cost and document link;
// an asset recorded by hand is then covered by the contract from its details panel, and the register counts it. Each
// run leaves one `Vendor e2e *` vendor, contract, department and host in the dev estate. Screenshots are the evidence
// (docs/evidence/commercial.md).
import { fileURLToPath } from 'node:url';
import { expect, test } from '@playwright/test';
import { isLocale, translate } from '@openmap/i18n';
import { signIn } from './auth';

const screenshotsDir = fileURLToPath(new URL('./screenshots/', import.meta.url));
const PAINT_TIMEOUT_MS = 30_000;
const DAY_MS = 86_400_000;
const CONTRACT_DAYS = 45;

test('a vendor, a department and a contract are recorded and the contract covers an asset (REQ-CMDB-026..029)', async ({ page }, testInfo) => {
  const locale = testInfo.project.name;
  if (!isLocale(locale)) throw new Error('project name must be a locale: ' + locale);
  test.setTimeout(PAINT_TIMEOUT_MS * 6);
  const stamp = locale + '-' + String(Date.now());
  const vendor = 'Vendor e2e ' + stamp;
  const number = 'SUP-' + stamp;
  const today = new Date().toISOString().slice(0, 'YYYY-MM-DD'.length);
  const ends = new Date(Date.now() + CONTRACT_DAYS * DAY_MS).toISOString().slice(0, 'YYYY-MM-DD'.length);

  await page.goto('/' + locale + '/commercial');
  await signIn(page, locale);
  await expect(page.getByTestId('contract-register')).toBeVisible({ timeout: PAINT_TIMEOUT_MS });

  // A vendor and its first-line contact.
  await page.getByTestId('commercial-tab-vendors').getByRole('button').click();
  await page.getByRole('button', { name: translate(locale, 'commercial.vendor.new') }).click();
  const vendorForm = page.getByRole('form', { name: translate(locale, 'commercial.vendor.new') });
  await vendorForm.getByLabel(translate(locale, 'commercial.vendor.name')).fill(vendor);
  await vendorForm.getByLabel(translate(locale, 'commercial.vendor.category')).fill('hardware');
  await vendorForm.getByRole('button', { name: translate(locale, 'common.save') }).click();
  await page.getByLabel(translate(locale, 'commercial.filter.vendors')).fill(stamp);
  await page.getByRole('button', { name: translate(locale, 'commercial.vendor.open', { name: vendor }) }).click();
  await page.getByRole('button', { name: translate(locale, 'commercial.contact.new') }).click();
  const contactForm = page.getByRole('form', { name: translate(locale, 'commercial.contact.new') });
  await contactForm.getByLabel(translate(locale, 'commercial.contact.name')).fill('Support desk');
  await contactForm.getByLabel(translate(locale, 'commercial.contact.role')).fill('First line');
  await contactForm.getByLabel(translate(locale, 'commercial.contact.email')).fill('desk@vendor.example');
  await contactForm.getByRole('button', { name: translate(locale, 'common.save') }).click();
  await expect(page.getByTestId('vendor-contacts')).toContainText('Support desk', { timeout: PAINT_TIMEOUT_MS });

  // A department to bill the contract to.
  await page.getByTestId('commercial-tab-costCentres').getByRole('button').click();
  await page.getByRole('button', { name: translate(locale, 'commercial.costCentre.new') }).click();
  const centreForm = page.getByRole('form', { name: translate(locale, 'commercial.costCentre.new') });
  await centreForm.getByLabel(translate(locale, 'commercial.costCentre.code')).fill('CC-' + stamp);
  await centreForm.getByLabel(translate(locale, 'commercial.costCentre.name')).fill('Payments ' + stamp);
  await centreForm.getByLabel(translate(locale, 'commercial.costCentre.kindLabel')).selectOption('department');
  await centreForm.getByRole('button', { name: translate(locale, 'common.save') }).click();
  await expect(page.getByTestId('cost-centre-register').locator('[data-cost-centre="CC-' + stamp + '"]')).toBeVisible({ timeout: PAINT_TIMEOUT_MS });

  // The contract, with a signed document.
  await page.getByTestId('commercial-tab-contracts').getByRole('button').click();
  await page.getByRole('button', { name: translate(locale, 'commercial.contract.new') }).click();
  const form = page.getByRole('form', { name: translate(locale, 'commercial.contract.new') });
  const vendorSelect = form.getByLabel(translate(locale, 'commercial.contract.vendor'));
  await expect(vendorSelect.getByRole('option', { name: vendor })).toHaveCount(1, { timeout: PAINT_TIMEOUT_MS });
  await vendorSelect.selectOption({ label: vendor });
  await form.getByLabel(translate(locale, 'commercial.contract.number')).fill(number);
  await form.getByLabel(translate(locale, 'commercial.contract.title'), { exact: true }).fill('Premium support ' + stamp);
  await form.getByLabel(translate(locale, 'commercial.contract.level')).selectOption('four_hour');
  await form.getByLabel(translate(locale, 'commercial.contract.startsAt')).fill(today);
  await form.getByLabel(translate(locale, 'commercial.contract.endsAt')).fill(ends);
  await form.getByLabel(translate(locale, 'commercial.contract.noticeDays')).fill('15');
  await form.getByLabel(translate(locale, 'commercial.contract.annualCost')).fill('50000');
  await form.getByLabel(translate(locale, 'commercial.contract.currency')).fill('SAR');
  await form.getByLabel(translate(locale, 'commercial.contract.costCentre')).selectOption({ label: 'CC-' + stamp + ' · Payments ' + stamp });
  await form.getByRole('button', { name: translate(locale, 'commercial.contract.addDocument') }).click();
  await form.getByLabel(translate(locale, 'commercial.contract.documentTitle', { n: '1' })).fill('Signed agreement');
  await form.getByLabel(translate(locale, 'commercial.contract.documentLocation', { n: '1' })).fill('https://dms.bank.example/' + number + '.pdf');
  await form.getByRole('button', { name: translate(locale, 'common.save') }).click();
  await expect(form).toHaveCount(0, { timeout: PAINT_TIMEOUT_MS });

  await page.getByLabel(translate(locale, 'commercial.filter.contracts')).fill(stamp);
  const row = page.getByTestId('contract-register').locator('[data-contract-number="' + number + '"]');
  await expect(row).toBeVisible({ timeout: PAINT_TIMEOUT_MS });
  await expect(row).toContainText(vendor);
  await expect(row.getByRole('link', { name: 'Signed agreement' })).toHaveAttribute('href', 'https://dms.bank.example/' + number + '.pdf');
  await expect(row).toContainText(/SAR/);
  await page.screenshot({ path: screenshotsDir + 'commercial-contracts-' + locale + '.png', fullPage: false });

  // An asset recorded by hand, then covered by the contract from its details panel.
  await page.goto('/' + locale + '/assets');
  await expect(page.getByTestId('asset-register')).toBeVisible({ timeout: PAINT_TIMEOUT_MS });
  const host = 'Covered host ' + stamp;
  const manual = page.getByRole('form', { name: translate(locale, 'assets.manual.title') });
  await manual.getByLabel(translate(locale, 'assets.manual.name')).fill(host);
  await manual.getByRole('button', { name: translate(locale, 'assets.manual.create') }).click();
  await expect(manual.getByRole('status')).toBeVisible({ timeout: PAINT_TIMEOUT_MS });
  await page.getByLabel(translate(locale, 'assets.filter.text')).fill(host);
  const assetRow = page.getByTestId('asset-register').getByRole('row').filter({ hasText: host });
  await expect(assetRow).toBeVisible({ timeout: PAINT_TIMEOUT_MS });
  const tag = await assetRow.getAttribute('data-asset-tag');
  if (tag === null) throw new Error('register rows carry their tag');
  await assetRow.getByRole('button', { name: translate(locale, 'assets.table.edit', { tag }), exact: true }).click();
  const links = page.getByTestId('asset-commercial');
  const contractSelect = links.getByLabel(translate(locale, 'commercial.asset.contract'));
  await expect(contractSelect.getByRole('option', { name: number + ' · Premium support ' + stamp })).toHaveCount(1, { timeout: PAINT_TIMEOUT_MS });
  await contractSelect.selectOption({ label: number + ' · Premium support ' + stamp });
  await expect(links).toContainText(translate(locale, 'commercial.asset.coveredBy', { number, vendor }), { timeout: PAINT_TIMEOUT_MS });
  await expect(links).toContainText('Support desk');
  await links.scrollIntoViewIfNeeded();
  await page.screenshot({ path: screenshotsDir + 'commercial-asset-' + locale + '.png', fullPage: false });

  await page.goto('/' + locale + '/commercial');
  await page.getByLabel(translate(locale, 'commercial.filter.contracts')).fill(stamp);
  const covered = page.getByTestId('contract-register').locator('[data-contract-number="' + number + '"]');
  await expect(covered.locator('td').nth(5)).toHaveText(/^[1١]$/, { timeout: PAINT_TIMEOUT_MS });
});
