// T-604 REQ-SEC-012 (ADR-070) — the compliance posture tab of the Assets screen on the real stack, per locale project:
// - the tab is reached from the register and lives in the URL;
// - an operator evaluates the synthetic estate; one card per framework shows an audit pass rate and the high-risk CI
//   count beside the estate's CVE risk;
// - ISO/IEC 27001's technical vulnerability control fails on the high CVEs tools/synth-estate correlates to installed
//   software, and its findings list a CI with the reason and the facts that decided it, high-risk CIs first;
// - no error card appears. Screenshots are the LTR/RTL evidence.
import { fileURLToPath } from 'node:url';
import { expect, test } from '@playwright/test';
import { isLocale, translate } from '@openmap/i18n';
import { signIn } from './auth';

const screenshotsDir = fileURLToPath(new URL('./screenshots/', import.meta.url));
const LOAD_MS = 60_000;
/** An evaluation reads the whole estate and stores a decision per check and CI. */
const EVALUATE_MS = 180_000;
const FRAMEWORKS = ['soc2', 'iso27001', 'pci_dss', 'sama_csf', 'nca_ecc'] as const;

test('the posture tab evaluates the estate per framework and shows the evidence behind a failing control', async ({ page }, testInfo) => {
  const locale = testInfo.project.name;
  if (!isLocale(locale)) throw new Error('project name must be a locale: ' + locale);
  test.setTimeout(LOAD_MS * 2 + EVALUATE_MS);

  await page.goto('/' + locale + '/assets');
  await signIn(page, locale);
  await expect(page.getByRole('heading', { level: 1, name: translate(locale, 'assets.title') })).toBeVisible();
  await page.getByRole('tab', { name: translate(locale, 'assets.tab.posture') }).click();
  await expect(page).toHaveURL(/tab=posture/);
  await expect(page.getByRole('tab', { name: translate(locale, 'assets.tab.posture') })).toHaveAttribute('aria-selected', 'true');
  const posture = page.getByTestId('compliance-posture');
  await expect(posture).toBeVisible({ timeout: LOAD_MS });

  await posture.getByRole('button', { name: translate(locale, 'assets.compliance.evaluate') }).click();
  await expect(posture.getByTestId('compliance-last-run')).toBeVisible({ timeout: EVALUATE_MS });
  const cards = posture.getByTestId('compliance-framework');
  await expect(cards).toHaveCount(FRAMEWORKS.length);
  for (const id of FRAMEWORKS) {
    const card = posture.locator('[data-testid="compliance-framework"][data-framework="' + id + '"]');
    await expect(card).toContainText(translate(locale, `assets.compliance.framework.${id}`));
    await expect(card.getByTestId('compliance-pass-rate')).not.toBeEmpty();
    await expect(card.getByTestId('compliance-high-risk')).not.toBeEmpty();
  }
  await expect(posture.getByText(translate(locale, 'assets.compliance.kpi.critical'))).toBeVisible();
  await page.screenshot({ path: screenshotsDir + 'compliance-posture-' + locale + '.png', fullPage: false });

  await posture.locator('[data-testid="compliance-framework"][data-framework="iso27001"]').click();
  const controls = posture.getByTestId('compliance-controls');
  await expect(controls).toHaveAttribute('data-framework', 'iso27001');
  const vulnerabilities = controls.locator('tr[data-control="A.8.8"]');
  await expect(vulnerabilities).toHaveAttribute('data-result', 'fail');
  await vulnerabilities.getByRole('button', { name: translate(locale, 'assets.compliance.table.open', { control: 'A.8.8' }) }).click();
  const findings = posture.getByTestId('compliance-findings');
  const first = findings.getByTestId('compliance-finding').first();
  await expect(first).toBeVisible({ timeout: LOAD_MS });
  await expect(first).toHaveAttribute('data-high-risk', 'true');
  await expect(first.getByText(translate(locale, 'assets.compliance.findings.highRisk'))).toBeVisible();
  await expect(first.getByRole('link')).toBeVisible();
  await page.screenshot({ path: screenshotsDir + 'compliance-findings-' + locale + '.png', fullPage: false });

  await expect(page.getByRole('alert')).toHaveCount(0);
});
