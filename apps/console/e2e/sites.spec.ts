// T-482 REQ-BSM-007 REQ-UI-012 (ADR-025) — Sites and connectivity on the real stack, per locale project:
// - the screen lists the readiness rules, the synthetic estate's sites (with the DR site) and its inter-site links;
// - within a few probe rounds every link carries a last probe from a Discovery Node (scheduler → Node → link_probe →
//   reconciler → ClickHouse → API), so the probing loop runs end to end;
// - the dev stack cannot reach the far gateways, so the links read down and the rules report breaches with incidents;
// - no error card appears.
import { fileURLToPath } from 'node:url';
import { expect, test } from '@playwright/test';
import { isLocale, translate } from '@openmap/i18n';
import { signIn } from './auth';

const screenshotsDir = fileURLToPath(new URL('./screenshots/', import.meta.url));
const PROBE_WAIT_MS = 240_000;
const POLL_MS = 15_000;

test('sites, links and readiness rules show live probe results', async ({ page }, testInfo) => {
  const locale = testInfo.project.name;
  if (!isLocale(locale)) throw new Error('project name must be a locale: ' + locale);
  test.setTimeout(PROBE_WAIT_MS * 2);

  await page.goto('/' + locale + '/sites');
  await signIn(page, locale);
  const readiness = page.getByRole('region', { name: translate(locale, 'sites.readiness') });
  await expect(readiness).toBeVisible({ timeout: PROBE_WAIT_MS });
  for (const key of ['sites.rule.diverse_paths', 'sites.rule.dr_reachable', 'sites.rule.replication_healthy'] as const) {
    await expect(readiness.getByText(translate(locale, key), { exact: true }).first()).toBeVisible();
  }
  const sites = page.getByRole('table', { name: translate(locale, 'sites.sites') });
  await expect(sites.getByText(translate(locale, 'sites.drRole.dr'), { exact: true })).toBeVisible();
  const links = page.getByRole('table', { name: translate(locale, 'sites.links') });
  await expect(links.getByRole('row').nth(1)).toBeVisible();

  // Every link has been probed: no "—" left in the last-probe column (the screen refreshes on the probe interval).
  const lastProbe = translate(locale, 'sites.table.probed');
  await expect
    .poll(
      async () => {
        await page.reload();
        const table = page.getByRole('table', { name: translate(locale, 'sites.links') });
        await table.getByRole('row').nth(1).waitFor();
        const headers = await table.getByRole('columnheader').allTextContents();
        const column = headers.indexOf(lastProbe);
        const cells = await table.locator('tbody tr').evaluateAll((rows, i) => rows.map((r) => r.children[i]?.textContent ?? ''), column);
        return cells.length > 0 && cells.every((c) => c.trim() !== translate(locale, 'sites.none'));
      },
      { timeout: PROBE_WAIT_MS, intervals: [POLL_MS] },
    )
    .toBe(true);
  // The far gateways are out of the dev stack's reach: links are down and readiness is breached, with incidents.
  await expect(page.getByRole('table', { name: translate(locale, 'sites.links') }).getByText(translate(locale, 'health.down')).first()).toBeVisible({ timeout: PROBE_WAIT_MS });
  await expect(page.getByRole('region', { name: translate(locale, 'sites.readiness') }).getByText(translate(locale, 'sites.finding.open')).first()).toBeVisible({ timeout: PROBE_WAIT_MS });
  await expect(page.getByRole('alert').filter({ hasText: translate(locale, 'common.error') })).toHaveCount(0);
  await page.screenshot({ path: screenshotsDir + 'sites-' + locale + '.png', fullPage: true });
});
