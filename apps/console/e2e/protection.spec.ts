// T-659 REQ-INT-017 (ADR-075) — backup protection on the real stack, per locale project:
// - the Protection screen shows the critical-service totals and either the gap table (each row linking to its CI with a
//   protection state) or the statement that every supporting CI is protected;
// - choosing another tier keeps the screen working;
// - opening a gap's CI (or a VM from the CMDB when there is no gap) shows the Protection card on its overview with a
//   state badge.
// The backup data comes from the backup collector's results (simulated mode on the dev stack, ADR-042); screenshots are
// the evidence (docs/evidence/int-backup-awareness.md).
import { fileURLToPath } from 'node:url';
import { expect, test } from '@playwright/test';
import { ITSM } from '@openmap/constants';
import { isLocale, translate } from '@openmap/i18n';
import { signIn } from './auth';

const screenshotsDir = fileURLToPath(new URL('./screenshots/', import.meta.url));
const LOAD_MS = 60_000;
const STATES = ['protected', 'rpo_breached', 'unprotected'] as const;

test('the Protection screen lists critical CIs a backup does not protect, and the CI detail shows its protection', async ({ page }, testInfo) => {
  const locale = testInfo.project.name;
  if (!isLocale(locale)) throw new Error('project name must be a locale: ' + locale);
  test.setTimeout(LOAD_MS * 4);

  await page.goto('/' + locale + '/protection');
  await signIn(page, locale);
  await expect(page.getByRole('heading', { level: 1, name: translate(locale, 'protection.title') })).toBeVisible({ timeout: LOAD_MS });
  for (const key of ['protection.kpi.services', 'protection.kpi.cis', 'protection.kpi.rpoBreached'] as const)
    await expect(page.getByText(translate(locale, key), { exact: true }).first()).toBeVisible();

  const rows = page.locator('[role="row"][data-ci]');
  const empty = page.getByTestId('protection-empty');
  await expect(rows.first().or(empty)).toBeVisible({ timeout: LOAD_MS });
  await page.screenshot({ path: screenshotsDir + 'protection-' + locale + '.png', fullPage: true });

  let detailHref: string | null = null;
  if ((await rows.count()) > 0) {
    const state = await rows.first().getAttribute('data-state');
    expect(STATES).toContain(state);
    expect(state).not.toBe('protected');
    detailHref = await rows.first().getByRole('link').first().getAttribute('href');
  }

  await page.getByRole('radio', { name: translate(locale, 'protection.tierOrAbove', { tier: String(ITSM.priorityHighest) }) }).click();
  await expect(rows.first().or(empty)).toBeVisible({ timeout: LOAD_MS });

  if (detailHref === null) {
    // No gap: open any VM from the CMDB; every VM gets the card, protected or not.
    await page.goto('/' + locale + '/cmdb');
    const more = page.getByRole('group', { name: translate(locale, 'cmdb.filter.more') });
    await more.getByRole('combobox', { name: translate(locale, 'cmdb.filter.type') }).selectOption('vm');
    const link = page.getByRole('table').getByRole('link').first();
    await expect(link).toBeVisible({ timeout: LOAD_MS });
    detailHref = await link.getAttribute('href');
  }
  if (detailHref === null) throw new Error('no CI to open');
  await page.goto(detailHref);
  const card = page.getByTestId('protection-card');
  await expect(card.getByRole('heading', { name: translate(locale, 'protection.card.title') })).toBeVisible({ timeout: LOAD_MS });
  await expect(card.locator('[data-state]').first()).toBeVisible({ timeout: LOAD_MS });
  await page.screenshot({ path: screenshotsDir + 'protection-card-' + locale + '.png', fullPage: true });
});
