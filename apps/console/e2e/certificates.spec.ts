// T-191 REQ-CMDB-032 — the certificate inventory on the real stack, per locale project (ADR-036): two certificates
// arrive through the import pipeline as a spreadsheet would bring them (the reconciler merges them like a sweep), and the
// Certificates screen lists them soonest expiry first with days left, the expired one, and the weak signature. Each run
// leaves two `cert-e2e-*` certificate CIs in the dev estate. Screenshots are the evidence (docs/evidence/certificates.md).
import { fileURLToPath } from 'node:url';
import { expect, test } from '@playwright/test';
import { isLocale, translate } from '@openmap/i18n';
import { signIn } from './auth';

const screenshotsDir = fileURLToPath(new URL('./screenshots/', import.meta.url));
const PAINT_TIMEOUT_MS = 30_000;
const RECONCILE_TIMEOUT_MS = 90_000;
const DAY_MS = 86_400_000;
const SOON_DAYS = 20;
const GONE_DAYS = 3;

test('imported certificates are listed with expiry and weaknesses (REQ-CMDB-032)', async ({ page }, testInfo) => {
  const locale = testInfo.project.name;
  if (!isLocale(locale)) throw new Error('project name must be a locale: ' + locale);
  test.setTimeout(RECONCILE_TIMEOUT_MS * 2);
  const stamp = locale + '-' + String(Date.now());
  const soon = 'cert-e2e-' + stamp + '.bank.example';
  const gone = 'cert-e2e-old-' + stamp + '.bank.example';
  const at = (days: number): string => new Date(Date.now() + days * DAY_MS + DAY_MS / 2).toISOString();
  const csv = [
    'type,name,identity.fingerprintSha256,attribute.subject,attribute.issuer,attribute.notAfter,attribute.signatureAlgorithm',
    'certificate,' + soon + ',fp-' + stamp + ',CN=' + soon + ',CN=Bank Issuing CA,' + at(SOON_DAYS) + ',SHA1-RSA',
    'certificate,' + gone + ',fp-old-' + stamp + ',CN=' + gone + ',CN=Bank Issuing CA,' + at(-GONE_DAYS - 1) + ',SHA256-RSA',
  ].join('\r\n');

  await page.goto('/' + locale + '/cmdb/import');
  await signIn(page, locale);
  await page.getByLabel(translate(locale, 'import.file')).setInputFiles({ name: 'certificates-' + stamp + '.csv', mimeType: 'text/csv', buffer: Buffer.from(csv, 'utf8') });
  const preview = page.getByTestId('import-preview');
  await expect(preview).toBeVisible({ timeout: PAINT_TIMEOUT_MS });
  await preview.getByRole('button', { name: translate(locale, 'import.run', { count: '2' }) }).click();
  await expect(page.getByTestId('import-job').filter({ hasText: 'certificates-' + stamp })).toBeVisible({ timeout: PAINT_TIMEOUT_MS });

  await page.goto('/' + locale + '/certificates');
  const search = page.getByLabel(translate(locale, 'certificates.filter.text'));
  await search.fill(stamp);
  const register = page.getByTestId('certificate-register');
  await expect
    .poll(
      async () => {
        await page.reload();
        await search.fill(stamp);
        return register.locator('tr[data-certificate]').count();
      },
      { timeout: RECONCILE_TIMEOUT_MS, intervals: [2_000] },
    )
    .toBe(2);
  const soonRow = register.locator('[data-certificate="' + soon + '"]');
  await expect(soonRow).toContainText(translate(locale, 'certificates.weakness.weak_signature'));
  await expect(soonRow).toContainText(/(20|٢٠)/);
  const goneRow = register.locator('[data-certificate="' + gone + '"]');
  await expect(goneRow).toBeVisible();
  // Soonest expiry first: the expired certificate leads.
  await expect(register.locator('tr[data-certificate]').first()).toHaveAttribute('data-certificate', gone);
  await page.screenshot({ path: screenshotsDir + 'certificates-' + locale + '.png', fullPage: false });

  await page.getByLabel(translate(locale, 'certificates.filter.weak')).selectOption('yes');
  await expect(register.locator('tr[data-certificate]')).toHaveCount(1, { timeout: PAINT_TIMEOUT_MS });
  await expect(register.locator('tr[data-certificate]').first()).toHaveAttribute('data-certificate', soon);
});
