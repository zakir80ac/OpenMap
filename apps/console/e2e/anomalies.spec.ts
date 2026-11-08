// T-506 REQ-AI-003 — the known anomalies of the synthetic estate are flagged, on the real stack, per locale project:
// - an operator runs the rules; the findings include the anomalies tools/synth-estate plants (estate-summary.json and
//   health-history.json `anomalies`): the address a server and a scanned device both claim, the unidentified camera
//   in the primary data centre, and the flapping service;
// - each carries its facts, and the IP conflict is explained in the screen's language (by the model in English, from
//   the catalogue in Arabic);
// - no error card appears.
import { fileURLToPath } from 'node:url';
import { expect, test } from '@playwright/test';
import { isLocale, translate } from '@openmap/i18n';
import { signIn } from './auth';

const screenshotsDir = fileURLToPath(new URL('./screenshots/', import.meta.url));
const LOAD_MS = 60_000;
/** The local model on CPU can take a while to answer. */
const EXPLAIN_MS = 180_000;

test('the anomaly rules flag the estate’s planted anomalies and explain one', async ({ page }, testInfo) => {
  const locale = testInfo.project.name;
  if (!isLocale(locale)) throw new Error('project name must be a locale: ' + locale);
  test.setTimeout(LOAD_MS * 2 + EXPLAIN_MS);

  await page.goto('/' + locale + '/anomalies');
  await signIn(page, locale);
  await page.getByRole('button', { name: translate(locale, 'anomaly.detect') }).click();
  const list = page.getByRole('list', { name: translate(locale, 'anomaly.list') });
  await expect(list.getByRole('listitem').first()).toBeVisible({ timeout: LOAD_MS });

  for (const rule of ['ip_conflict', 'unmanaged_device_in_datacenter', 'flapping_service'] as const) {
    const finding = list.getByRole('listitem', { name: translate(locale, `anomaly.rule.${rule}`) }).filter({ hasText: translate(locale, 'anomaly.state.open') }).first();
    await expect(finding).toBeVisible();
    await expect(finding.getByLabel(translate(locale, 'anomaly.facts'))).toBeVisible();
  }
  const conflict = list.getByRole('listitem', { name: translate(locale, 'anomaly.rule.ip_conflict') }).first();
  await expect(conflict.getByText(translate(locale, 'anomaly.fact.claimants'))).toBeVisible();
  await expect(list.getByRole('listitem', { name: translate(locale, 'anomaly.rule.unmanaged_device_in_datacenter') }).getByText(/^camera-/u).first()).toBeVisible();

  const explain = conflict.getByRole('button', { name: translate(locale, 'anomaly.explain') });
  if (await explain.isVisible()) await explain.click();
  await expect(conflict.getByLabel(translate(locale, 'anomaly.explanation'))).toBeVisible({ timeout: EXPLAIN_MS });
  // Arabic is explained from the catalogue's template (ASSISTANT_PROSE_LOCALES keeps the CPU model to English, ADR-028).
  if (locale === 'ar') await expect(conflict.getByLabel(translate(locale, 'anomaly.explanation'))).toHaveText(/[؀-ۿ]/u);
  await expect(page.getByRole('alert').filter({ hasText: translate(locale, 'common.error') })).toHaveCount(0);
  await page.screenshot({ path: screenshotsDir + 'anomalies-' + locale + '.png', fullPage: true });
});
