// T-172 REQ-CMDB-033 REQ-CMDB-036 — export and import against the live stack, per locale project: the CMDB narrowed to
// hosts exports a CSV whose header names the import targets; the import screen reads a ServiceNow `cmdb_ci` export,
// recognises it, refuses the row of an unknown class, imports the rest, and the new host appears in the CMDB once the
// reconciler has taken it. Each run leaves one `srv-e2e-import-*` host in the dev estate, as the setup spec leaves its
// sites. Screenshots are the evidence (docs/evidence/import-export.md).
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { expect, test } from '@playwright/test';
import { isLocale, translate, type Locale } from '@openmap/i18n';
import { signIn } from './auth';

const PAINT_TIMEOUT_MS = 60_000;
const RECONCILE_TIMEOUT_MS = 120_000;
/** The byte-order mark the CSV export starts with, so Excel reads it as UTF-8. */
const BOM = new RegExp('^' + String.fromCharCode(0xfeff));
const screenshotsDir = fileURLToPath(new URL('./screenshots/', import.meta.url));

function localeOf(name: string): Locale {
  if (!isLocale(name)) throw new Error('project name must be a locale: ' + name);
  return name;
}

test('CMDB: export a CSV and import a ServiceNow export (REQ-CMDB-033, REQ-CMDB-036)', async ({ page }, testInfo) => {
  const locale = localeOf(testInfo.project.name);
  test.setTimeout(RECONCILE_TIMEOUT_MS * 3);
  const stamp = locale + String(Date.now());
  const name = 'srv-e2e-import-' + stamp;

  await page.goto('/' + locale + '/cmdb');
  await signIn(page, locale);
  const more = page.getByRole('group', { name: translate(locale, 'cmdb.filter.more') });
  await more.getByRole('combobox', { name: translate(locale, 'cmdb.filter.type') }).selectOption('host');
  await expect(page.getByRole('table').getByRole('link').first()).toBeVisible({ timeout: PAINT_TIMEOUT_MS });
  const transfer = page.getByRole('group', { name: translate(locale, 'cmdb.transfer') });
  const [download] = await Promise.all([page.waitForEvent('download'), transfer.getByRole('button', { name: translate(locale, 'cmdb.export.csv') }).click()]);
  expect(download.suggestedFilename()).toMatch(/^openmap-cis-.*\.csv$/);
  const path = await download.path();
  const header = readFileSync(path, 'utf8').replace(BOM, '').split('\r\n')[0] ?? '';
  expect(header.startsWith('type,name,tags,identity.serialNumber')).toBe(true);

  await transfer.getByRole('link', { name: translate(locale, 'cmdb.import') }).click();
  await expect(page).toHaveURL(/\/cmdb\/import/);
  const csv = [
    'sys_id,sys_class_name,name,serial_number,os,manufacturer',
    'e2e-' + stamp + ',cmdb_ci_linux_server,' + name + ',SN-E2E-' + stamp + ',Red Hat Enterprise Linux 9,Dell Inc.',
    'e2e-' + stamp + '-p,cmdb_ci_printer,Printer ' + stamp + ',PR-' + stamp + ',,',
  ].join('\r\n');
  await page.getByLabel(translate(locale, 'import.file')).setInputFiles({ name: 'servicenow-' + stamp + '.csv', mimeType: 'text/csv', buffer: Buffer.from(csv, 'utf8') });
  const previewCard = page.getByTestId('import-preview');
  await expect(previewCard).toBeVisible({ timeout: PAINT_TIMEOUT_MS });
  await expect(previewCard.getByText(translate(locale, 'import.recognised'))).toBeVisible();
  await expect(page.getByTestId('import-summary')).toContainText(translate(locale, 'import.summary', { rows: '2', accepted: '1', rejected: '1' }));
  await expect(page.getByTestId('import-rejected')).toContainText('cmdb_ci_printer');
  await page.screenshot({ path: screenshotsDir + 'import-preview-' + locale + '.png', fullPage: true });
  await previewCard.getByRole('button', { name: translate(locale, 'import.run', { count: '1' }) }).click();
  await expect(page.getByTestId('import-job').filter({ hasText: 'servicenow-' + stamp })).toBeVisible({ timeout: PAINT_TIMEOUT_MS });

  // The reconciler takes the queued observation; the job counts the CI it created and the CMDB finds it.
  await expect
    .poll(
      async () => {
        await page.reload();
        return (await page.getByTestId('import-job').filter({ hasText: 'servicenow-' + stamp }).getByTestId('import-job-created').textContent()) ?? '';
      },
      { timeout: RECONCILE_TIMEOUT_MS, intervals: [2_000] },
    )
    .toBe('1');
  await page.screenshot({ path: screenshotsDir + 'import-jobs-' + locale + '.png', fullPage: true });
  await page.goto('/' + locale + '/cmdb?q=' + encodeURIComponent(name));
  await expect(page.getByRole('table').getByRole('link', { name })).toBeVisible({ timeout: PAINT_TIMEOUT_MS });
});
