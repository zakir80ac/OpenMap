// T-476 REQ-BSM-005 REQ-UI-013 (ADR-048) — runbooks on the real stack, per locale project. On the Impact screen an
// operator writes a runbook of two manual steps (12 and 8 minutes):
// - the catalogue lists it with its 20-minute estimate;
// - attached to a saved scenario, the re-run simulation leads its recommendations with the runbook;
// - deleting it leaves the scenario without one.
// No error card appears.
import { randomUUID } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { expect, test } from '@playwright/test';
import { isLocale, translate } from '@openmap/i18n';
import { signIn } from './auth';

const screenshotsDir = fileURLToPath(new URL('./screenshots/', import.meta.url));
const MODEL_TIMEOUT_MS = 60_000;

test('a runbook is written, attached to a scenario and leads its recommendations', async ({ page }, testInfo) => {
  const locale = testInfo.project.name;
  if (!isLocale(locale)) throw new Error('project name must be a locale: ' + locale);
  test.setTimeout(MODEL_TIMEOUT_MS * 3);
  const code = 'E2E-RB-' + randomUUID().slice(0, 6).toUpperCase();
  const n = (value: number): string => new Intl.NumberFormat(locale).format(value);

  await page.goto('/' + locale + '/impact');
  await signIn(page, locale);
  const panel = page.getByRole('region', { name: translate(locale, 'impact.runbooks.title') });
  await expect(panel).toBeVisible({ timeout: MODEL_TIMEOUT_MS });
  await panel.getByRole('button', { name: translate(locale, 'impact.runbooks.new') }).click();
  const form = panel.getByRole('form', { name: translate(locale, 'impact.runbooks.editor') });
  await form.getByLabel(translate(locale, 'impact.runbooks.code')).fill(code);
  await form.getByLabel(translate(locale, 'impact.runbooks.name')).fill('Database failover');
  await form.getByLabel(translate(locale, 'impact.runbooks.owner')).fill('DBA');
  await form.getByLabel(translate(locale, 'impact.runbooks.step', { order: n(1) }), { exact: true }).fill('Promote the replica');
  await form.getByLabel(translate(locale, 'impact.runbooks.stepMinutes')).first().fill('12');
  await form.getByRole('button', { name: translate(locale, 'impact.runbooks.addStep') }).click();
  await form.getByLabel(translate(locale, 'impact.runbooks.step', { order: n(2) }), { exact: true }).fill('Confirm the application reconnects');
  await form.getByLabel(translate(locale, 'impact.runbooks.stepMinutes')).nth(1).fill('8');
  await form.getByRole('button', { name: translate(locale, 'impact.runbooks.save') }).click();

  const entry = panel.getByRole('list', { name: translate(locale, 'impact.runbooks.list') }).getByRole('listitem').filter({ hasText: code });
  await expect(entry).toBeVisible({ timeout: MODEL_TIMEOUT_MS });
  await expect(entry.getByText(translate(locale, 'services.runbook.minutes', { minutes: n(20) }), { exact: true })).toBeVisible();

  // Attach it to the first saved scenario and re-run that scenario.
  const prefix = translate(locale, 'impact.runbooks.forScenario', { name: '' });
  const scenario = page.getByRole('listitem').filter({ has: page.getByRole('combobox', { name: new RegExp('^' + prefix) }) }).first();
  await expect(scenario).toBeVisible({ timeout: MODEL_TIMEOUT_MS });
  const picker = scenario.getByRole('combobox');
  await expect(picker.getByRole('option', { name: code })).toHaveCount(1);
  await picker.selectOption({ label: code });
  await expect(picker).toHaveValue(/.+/);
  await scenario.getByRole('button', { name: translate(locale, 'impact.saved.run') }).click();
  const result = page.getByRole('region', { name: translate(locale, 'impact.step.result') });
  await expect(result).toBeVisible({ timeout: MODEL_TIMEOUT_MS });
  await expect(page.getByText('Follow runbook ' + code, { exact: false }).first()).toBeVisible({ timeout: MODEL_TIMEOUT_MS });
  await expect(page.getByRole('alert').filter({ hasText: translate(locale, 'common.error') })).toHaveCount(0);
  await panel.scrollIntoViewIfNeeded();
  await page.screenshot({ path: screenshotsDir + 'runbooks-' + locale + '.png', fullPage: true });

  // Clean up: the scenario keeps no runbook once it is deleted.
  await entry.getByRole('button', { name: translate(locale, 'impact.runbooks.delete') }).click();
  await expect(entry).toHaveCount(0, { timeout: MODEL_TIMEOUT_MS });
  await expect(picker).toHaveValue('');
});
