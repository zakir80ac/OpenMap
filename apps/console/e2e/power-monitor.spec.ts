// T-536 REQ-DCIM-005 (ADR-059) — power monitoring and billing on the real stack, per locale project:
// - the Power view's monitoring panel shows the room's PDUs with their measured draw and state, and energy billed by
//   device (the estate's outlets carry their devices and their draw over the last days);
// - switching the window to the last week re-reads the room;
// - an administrator sets a tariff: the room's cost appears in that currency; the tenant's previous lines and tariff
//   are restored afterwards; no error is shown.
import { fileURLToPath } from 'node:url';
import { expect, test, type Page, type Response } from '@playwright/test';
import { loadEnv } from '@openmap/config';
import { isLocale, translate } from '@openmap/i18n';
import { signIn } from './auth';

const screenshotsDir = fileURLToPath(new URL('./screenshots/', import.meta.url));
const GRAPHQL_PATH = '/graphql';
const ACTION_MS = 30_000;
const STEPS_BUDGET = 6;
const WEEK_HOURS = '168';
const TARIFF = '0.18';
const CURRENCY = 'SAR';
const ERROR_ALERT = 'p[role="alert"]';

interface Settings {
  warnPercent: number;
  criticalPercent: number;
  tariffPerKwh: number | null;
  currency: string | null;
}

async function api(page: Page, tokenExchange: Promise<Response>): Promise<(query: string, variables?: Record<string, unknown>) => Promise<Record<string, unknown>>> {
  const tokens = (await (await tokenExchange).json()) as { access_token: string };
  const url = loadEnv().PUBLIC_API_URL + GRAPHQL_PATH;
  return async (query, variables) => {
    const res = await page.request.post(url, { headers: { authorization: 'Bearer ' + tokens.access_token, 'content-type': 'application/json' }, data: { query, variables } });
    const body = (await res.json()) as { data?: Record<string, unknown>; errors?: Array<{ message: string }> };
    if (body.errors !== undefined) throw new Error(body.errors.map((e) => e.message).join('; '));
    return body.data ?? {};
  };
}

test('PDU draw, states and billing show, the window changes and a tariff prices the energy', async ({ page }, testInfo) => {
  const locale = testInfo.project.name;
  if (!isLocale(locale)) throw new Error('project name must be a locale: ' + locale);
  test.setTimeout(ACTION_MS * STEPS_BUDGET);
  page.setDefaultTimeout(ACTION_MS);
  const t = (key: Parameters<typeof translate>[1], params?: Record<string, string>): string => translate(locale, key, params);

  const tokenExchange = page.waitForResponse((r) => r.request().method() === 'POST' && r.url().includes('/protocol/openid-connect/token'));
  await page.goto('/' + locale + '/dcim');
  await signIn(page, locale);
  const gql = await api(page, tokenExchange);
  const previous = (await gql('query { powerSettings { warnPercent criticalPercent tariffPerKwh currency } }'))['powerSettings'] as Settings;

  try {
    await page.getByRole('group', { name: t('dcim.views') }).getByText(t('dcim.view.power'), { exact: true }).click();
    const pdus = page.getByRole('table', { name: t('dcim.monitor.pdus') });
    await expect(pdus).toBeVisible();
    await expect(pdus.getByRole('row').nth(1)).toBeVisible();
    await expect(page.getByRole('table', { name: t('dcim.monitor.billing.title') })).toBeVisible();

    await page.getByRole('combobox', { name: t('dcim.monitor.window') }).selectOption(WEEK_HOURS);
    await expect(pdus.getByRole('row').nth(1)).toBeVisible();

    const form = page.getByRole('form', { name: t('dcim.monitor.settings') });
    await form.getByRole('spinbutton', { name: t('dcim.monitor.tariff') }).fill(TARIFF);
    await form.getByRole('textbox', { name: t('dcim.monitor.currency') }).fill(CURRENCY);
    await form.getByRole('button', { name: t('dcim.monitor.saveSettings') }).click();
    const cost = page.locator('.om-kpi').filter({ hasText: t('dcim.monitor.kpi.cost') }).first();
    await expect(cost).toContainText(CURRENCY);
    await expect(page.locator(ERROR_ALERT)).toHaveCount(0);
    await page.screenshot({ path: screenshotsDir + 'power-monitor-' + locale + '.png', fullPage: true });
  } finally {
    await gql('mutation R($input: PowerSettingsInput!) { updatePowerSettings(input: $input) { warnPercent } }', { input: previous });
  }
});
