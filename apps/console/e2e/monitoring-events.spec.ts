// T-636 REQ-INT-012 (ADR-073) — monitoring events on the real stack, per locale project:
// - an Alertmanager integration (inbound) with its bearer token in OpenBao is set up through the API (saveCredentialSet,
//   upsertIntegration; reused across runs by name);
// - an Alertmanager webhook payload naming a host no CI matches is posted to the integration's ingest address;
// - from Integrations, "Monitoring events" opens the screen: the integration's address is listed, the alert shows under
//   "No CI found", is mapped from the screen to a host found by search, then shows that CI "by mapping";
// - the alert is cleared, nothing shows an error, and a screenshot is kept (the Arabic one is the RTL evidence).
import { randomUUID } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { expect, test, type Page, type Response } from '@playwright/test';
import { loadEnv } from '@openmap/config';
import { MONITORING } from '@openmap/constants';
import { isLocale, translate } from '@openmap/i18n';
import { signIn } from './auth';

const screenshotsDir = fileURLToPath(new URL('./screenshots/', import.meta.url));
const GRAPHQL_PATH = '/graphql';
const ACTION_MS = 30_000;
const STEPS_BUDGET = 8;
const INTEGRATION_NAME = 'E2E Alertmanager';
const CREDENTIAL_REF = 'openmap/e2e/monitoring-alertmanager';
const ERROR_ALERT = 'p[role="alert"]';

type Gql = (query: string, variables?: Record<string, unknown>) => Promise<Record<string, unknown>>;

async function api(page: Page, tokenExchange: Promise<Response>): Promise<Gql> {
  const tokens = (await (await tokenExchange).json()) as { access_token: string };
  const url = loadEnv().PUBLIC_API_URL + GRAPHQL_PATH;
  return async (query, variables = {}) => {
    const res = await page.request.post(url, { headers: { authorization: 'Bearer ' + tokens.access_token, 'content-type': 'application/json' }, data: { query, variables } });
    const body = (await res.json()) as { data?: Record<string, unknown>; errors?: Array<{ message: string }> };
    if (body.errors !== undefined) throw new Error(body.errors.map((e) => e.message).join('; '));
    return body.data ?? {};
  };
}

/** The e2e Alertmanager integration, created on the first run; its token is replaced on every run. */
async function integration(gql: Gql, token: string): Promise<string> {
  await gql('mutation S($input: CredentialSetInput!) { saveCredentialSet(input: $input) { ref } }', { input: { ref: CREDENTIAL_REF, type: 'api_token', fields: { token } } });
  const list = (await gql('query { integrations(category: "monitoring") { id name } }'))['integrations'] as Array<{ id: string; name: string }>;
  const existing = list.find((i) => i.name === INTEGRATION_NAME);
  const input = { category: 'monitoring', vendor: 'prometheus_alertmanager', name: INTEGRATION_NAME, endpoint: loadEnv().PUBLIC_API_URL, credentialRef: CREDENTIAL_REF, direction: 'inbound' };
  const saved = (await gql('mutation U($id: UUID, $input: IntegrationInput!) { upsertIntegration(id: $id, input: $input) { id } }', { id: existing?.id ?? null, input }))['upsertIntegration'] as { id: string };
  return saved.id;
}

async function firstHost(gql: Gql): Promise<string> {
  const data = (await gql('query { cis(filter: { types: ["host"] }, first: 1) { edges { node { displayName } } } }'))['cis'] as { edges: Array<{ node: { displayName: string } }> };
  const name = data.edges[0]?.node.displayName;
  if (name === undefined) throw new Error('the estate has no host');
  return name;
}

test('an Alertmanager alert no CI matches is listed, mapped to a host and cleared', async ({ page }, testInfo) => {
  const locale = testInfo.project.name;
  if (!isLocale(locale)) throw new Error('project name must be a locale: ' + locale);
  test.setTimeout(ACTION_MS * STEPS_BUDGET);
  page.setDefaultTimeout(ACTION_MS);
  const t = (key: Parameters<typeof translate>[1], params?: Record<string, string>): string => translate(locale, key, params);

  const tokenExchange = page.waitForResponse((r) => r.request().method() === 'POST' && r.url().includes('/protocol/openid-connect/token'));
  await page.goto('/' + locale + '/integrations');
  await signIn(page, locale);
  const gql = await api(page, tokenExchange);
  const token = 'e2e-' + randomUUID();
  const integrationId = await integration(gql, token);
  const host = 'e2e-unmapped-' + randomUUID().slice(0, 8) + '.lab.test';
  const title = 'E2EHostDown: ' + host;
  const posted = await page.request.post(loadEnv().PUBLIC_API_URL + '/' + MONITORING.ingestPath + '/' + integrationId, {
    headers: { authorization: 'Bearer ' + token, 'content-type': 'application/json' },
    data: {
      version: '4',
      status: 'firing',
      receiver: 'openmap',
      groupLabels: {},
      commonLabels: {},
      commonAnnotations: {},
      externalURL: '',
      alerts: [{ status: 'firing', labels: { alertname: 'E2EHostDown', instance: host + ':9100', severity: 'critical' }, annotations: {}, startsAt: new Date().toISOString(), endsAt: '0001-01-01T00:00:00Z', fingerprint: randomUUID() }],
    },
  });
  expect(posted.status()).toBe(202);
  const hostName = await firstHost(gql);

  await page.getByRole('link', { name: t('integrations.monitoringEvents') }).click();
  await expect(page).toHaveURL(new RegExp('/' + locale + '/integrations/monitoring'));
  await expect(page.getByRole('heading', { level: 1, name: t('monitoring.title') })).toBeVisible();
  await expect(page.getByRole('table', { name: t('monitoring.endpoints.title') }).getByText(integrationId, { exact: false })).toBeVisible();

  await page.getByRole('radiogroup', { name: t('monitoring.filter.label') }).getByText(t('monitoring.filter.unresolved'), { exact: true }).click();
  const list = page.getByRole('list', { name: t('monitoring.list') });
  const item = list.getByRole('listitem', { name: title });
  await expect(item.getByText(t('monitoring.unresolved'))).toBeVisible();
  await item.getByRole('button', { name: t('monitoring.map') }).click();
  const form = item.getByRole('form', { name: t('monitoring.map') });
  await form.getByLabel(t('monitoring.map.search')).fill(hostName);
  await form.getByRole('button', { name: t('monitoring.map.to', { name: hostName }) }).first().click();

  await page.getByRole('radiogroup', { name: t('monitoring.filter.label') }).getByText(t('monitoring.filter.all'), { exact: true }).click();
  const mapped = list.getByRole('listitem', { name: title });
  await expect(mapped.getByRole('link', { name: hostName })).toBeVisible();
  await expect(mapped.getByText(t('monitoring.resolution.mapping'))).toBeVisible();
  await expect(page.getByRole('table', { name: t('monitoring.mappings.title') }).getByText(host)).toBeVisible();
  await page.screenshot({ path: screenshotsDir + 'monitoring-events-' + locale + '.png', fullPage: true });

  await mapped.getByRole('button', { name: t('monitoring.clear') }).click();
  await expect(mapped.getByText(t('monitoring.status.resolved'))).toBeVisible();
  await expect(page.locator(ERROR_ALERT)).toHaveCount(0);
});
