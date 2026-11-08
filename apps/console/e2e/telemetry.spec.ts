// T-497 REQ-UI-027 — Health and telemetry on the real stack, per locale project:
// - the fleet table lists the tenant's measured CIs with the health pills' counts and a total;
// - the hardware category shows hosts with a CPU figure, sorted by CPU highest first;
// - the network category shows throughput, and a text filter narrows to rows whose name, address or site match;
// - no error card appears.
import { fileURLToPath } from 'node:url';
import { expect, test, type Locator } from '@playwright/test';
import { isLocale, translate } from '@openmap/i18n';
import { signIn } from './auth';

const screenshotsDir = fileURLToPath(new URL('./screenshots/', import.meta.url));
const LOAD_MS = 60_000;
/** A site code every synthetic estate has (tools/synth-estate): the primary data centre. */
const SITE = 'RYD';
const ARABIC_ZERO = 0x0660;

/** The number a localised figure such as "88.5%", "٨٨٫٥٪" or "6.3 Gb/s" carries, or NaN. */
function figure(text: string): number {
  const western = text.replace(/[٠-٩]/gu, (d) => String(d.charCodeAt(0) - ARABIC_ZERO)).replace('٫', '.');
  const match = /[0-9]+(?:\.[0-9]+)?/u.exec(western.replace(/[,٬]/gu, ''));
  return match === null ? Number.NaN : Number(match[0]);
}

async function columnTexts(table: Locator, header: string): Promise<string[]> {
  const headers = await table.getByRole('columnheader').allTextContents();
  const i = headers.findIndex((h) => h.trim() === header);
  if (i < 0) throw new Error('no column ' + header);
  return table.locator('[role="rowgroup"] [role="row"]').evaluateAll((rows, index) => rows.map((r) => (r.children[index]?.textContent ?? '').trim()), i);
}

test('the telemetry fleet lists measured CIs with filters and sorting', async ({ page }, testInfo) => {
  const locale = testInfo.project.name;
  if (!isLocale(locale)) throw new Error('project name must be a locale: ' + locale);
  test.setTimeout(LOAD_MS * 4);

  await page.goto('/' + locale + '/telemetry');
  await signIn(page, locale);
  const table = page.getByRole('table', { name: translate(locale, 'telemetry.table') });
  await expect(table.locator('[role="rowgroup"] [role="row"]').first()).toBeVisible({ timeout: LOAD_MS });
  await expect(page.getByText(new RegExp('^' + translate(locale, 'telemetry.total', { count: 'X' }).replace('X', '[0-9٠-٩.,٬]+') + '$', 'u'))).toBeVisible();

  const categories = page.getByRole('group', { name: translate(locale, 'telemetry.filter.category') });
  await categories.getByText(translate(locale, 'layer.hardware'), { exact: true }).click();
  await table.getByRole('button', { name: translate(locale, 'telemetry.column.cpu'), exact: true }).click();
  await expect(table.getByRole('columnheader', { name: translate(locale, 'telemetry.column.cpu') })).toHaveAttribute('aria-sort', 'descending');
  await expect
    .poll(async () => {
      const cpu = (await columnTexts(table, translate(locale, 'telemetry.column.cpu'))).slice(0, 10).map(figure);
      return cpu.length > 1 && cpu.every((v) => !Number.isNaN(v)) && cpu.every((v, i) => i === 0 || v <= (cpu[i - 1] ?? v));
    }, { timeout: LOAD_MS })
    .toBe(true);
  await page.screenshot({ path: screenshotsDir + 'telemetry-' + locale + '.png', fullPage: true });

  await categories.getByText(translate(locale, 'layer.network_security'), { exact: true }).click();
  await expect
    .poll(async () => (await columnTexts(table, translate(locale, 'telemetry.column.throughput'))).slice(0, 5).some((c) => !Number.isNaN(figure(c))), { timeout: LOAD_MS })
    .toBe(true);
  await page.getByLabel(translate(locale, 'telemetry.filter.text')).fill(SITE.toLowerCase());
  // The filter matches the name, address or site: every row left carries the text somewhere.
  await expect
    .poll(async () => {
      const rows = await table.locator('[role="rowgroup"] [role="row"]').allTextContents();
      return rows.length > 0 && rows.every((r) => r.toLowerCase().includes(SITE.toLowerCase()));
    }, { timeout: LOAD_MS })
    .toBe(true);
  await expect(page.getByRole('alert').filter({ hasText: translate(locale, 'common.error') })).toHaveCount(0);
});
