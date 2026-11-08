// T-519 REQ-IPAM-003 (ADR-055) — two-way DNS sync on the real stack, per locale project, against the lab's BIND 9
// server (compose service dns-lab, profile lab, TSIG key from DNS_LAB_TSIG_SECRET):
// - set-up through the API with the signed-in administrator's token: the TSIG secret as a credential set, and the lab
//   zone kept in sync on the compose Node's site (LOCAL);
// - on the IPAM DNS tab a person requests an A record; the scheduler pushes it with the zone's next job, the Node
//   updates BIND (RFC 2136) and transfers the zone, and the change turns Applied; the record then shows among the DNS
//   records (reconciled from the transfer);
// - deleting it the same way turns Applied too, and the record leaves the DNS records (the transfer no longer holds
//   it, so the reconciler retires it);
// - no error card appears.
import { fileURLToPath } from 'node:url';
import { expect, test, type Page, type Response } from '@playwright/test';
import { loadEnv } from '@openmap/config';
import { isLocale, translate, type Locale } from '@openmap/i18n';
import { signIn } from './auth';

const GRAPHQL_PATH = '/graphql';
const screenshotsDir = fileURLToPath(new URL('./screenshots/', import.meta.url));
const ZONE = 'lab.openmap.test';
const SERVER = 'dns-lab';
const KEY = 'openmap-sync';
const CREDENTIAL = 'dns/lab-openmap-sync';
const NODE_SITE = 'LOCAL';
/** A sync round (30 s by default), the Node's pull, the update and the transfer, then reconciliation. */
const SETTLE_MS = 240_000;
const POLL_MS = 5_000;
const ACTION_MS = 30_000;

/** GraphQL as the signed-in administrator: the bearer token from the console's own token exchange with Keycloak. */
async function api(page: Page, tokenExchange: Promise<Response>): Promise<(query: string, variables?: Record<string, unknown>) => Promise<Record<string, unknown>>> {
  const tokens = (await (await tokenExchange).json()) as { access_token: string };
  const authorization = 'Bearer ' + tokens.access_token;
  const url = loadEnv().PUBLIC_API_URL + GRAPHQL_PATH;
  return async (query, variables) => {
    const res = await page.request.post(url, { headers: { authorization, 'content-type': 'application/json' }, data: { query, variables } });
    const body = (await res.json()) as { data?: Record<string, unknown>; errors?: Array<{ message: string }> };
    if (body.errors !== undefined) throw new Error(body.errors.map((e) => e.message).join('; '));
    return body.data ?? {};
  };
}

async function requestChange(page: Page, locale: Locale, op: 'add' | 'delete', name: string, value: string): Promise<void> {
  const form = page.getByRole('form', { name: translate(locale, 'ipam.dnsSync.request') });
  await form.getByRole('combobox', { name: translate(locale, 'ipam.dnsSync.zone'), exact: true }).selectOption(ZONE);
  await form.getByRole('combobox', { name: translate(locale, 'ipam.dnsSync.opLabel'), exact: true }).selectOption(op);
  await form.getByRole('textbox', { name: translate(locale, 'ipam.dnsSync.name'), exact: true }).fill(name);
  await form.getByRole('combobox', { name: translate(locale, 'ipam.dnsSync.type'), exact: true }).selectOption('A');
  await form.getByRole('textbox', { name: translate(locale, 'ipam.dnsSync.value'), exact: true }).fill(value);
  await form.getByRole('spinbutton', { name: translate(locale, 'ipam.dnsSync.ttl'), exact: true }).fill('300');
  await form.getByRole('button', { name: translate(locale, 'ipam.dnsSync.request') }).click();
}

async function expectApplied(page: Page, locale: Locale, record: string, opLabel: string): Promise<void> {
  const changes = page.getByRole('table', { name: translate(locale, 'ipam.dnsSync.changes') });
  const row = changes.getByRole('row').filter({ hasText: record }).filter({ hasText: opLabel }).first();
  await expect(row).toBeVisible();
  await expect(row.getByText(translate(locale, 'ipam.dnsSync.state.applied'))).toBeVisible({ timeout: SETTLE_MS });
}

test('a record added and deleted in OpenMap reaches the DNS server and comes back through the transfer', async ({ page }, testInfo) => {
  const locale = testInfo.project.name;
  if (!isLocale(locale)) throw new Error('project name must be a locale: ' + locale);
  const secret = process.env['DNS_LAB_TSIG_SECRET'] ?? '';
  test.skip(secret === '', 'the lab DNS server is not configured (DNS_LAB_TSIG_SECRET)');
  test.setTimeout(SETTLE_MS * 3);
  // The long test timeout is for the sync rounds only; a step on the screen that does not happen fails fast.
  page.setDefaultTimeout(ACTION_MS);

  const tokenExchange = page.waitForResponse((r) => r.request().method() === 'POST' && r.url().includes('/protocol/openid-connect/token'));
  await page.goto('/' + locale + '/ipam');
  await signIn(page, locale);
  const gql = await api(page, tokenExchange);
  await gql('mutation Cred($input: CredentialSetInput!) { saveCredentialSet(input: $input) { ref } }', { input: { ref: CREDENTIAL, type: 'api_token', fields: { token: secret } } });
  const onboarding = (await gql('query { onboarding { sites { id code } } }'))['onboarding'] as { sites: Array<{ id: string; code: string }> };
  const site = onboarding.sites.find((s) => s.code === NODE_SITE);
  if (site === undefined) throw new Error('no site ' + NODE_SITE + ' (the compose Node runs there)');
  await gql('mutation Zone($input: DnsZoneSyncInput!) { upsertDnsZoneSync(input: $input) { id } }', { input: { zone: ZONE, server: SERVER, port: 53, tsigKeyName: KEY, credentialRef: CREDENTIAL, siteId: site.id, enabled: true } });

  await page.reload();
  await page.getByRole('group', { name: translate(locale, 'ipam.title') }).getByText(translate(locale, 'ipam.tab.dns'), { exact: true }).click();
  const panel = page.getByRole('region', { name: translate(locale, 'ipam.dnsSync.title') });
  await expect(panel.getByRole('table', { name: translate(locale, 'ipam.dnsSync.zones') }).getByText(ZONE, { exact: true })).toBeVisible();

  const label = 'e2e-' + locale + '-' + Date.now().toString(36);
  const fqdn = label + '.' + ZONE;
  const address = '10.77.1.' + String(Date.now() % 200 + 20);
  await requestChange(page, locale, 'add', label, address);
  await expectApplied(page, locale, fqdn, translate(locale, 'ipam.dnsSync.op.add'));
  // The transfer that confirmed the change also reconciled the record into the CMDB.
  const inCmdb = async (): Promise<number> => ((await gql('query R($f: CiFilter) { cis(filter: $f, first: 5) { totalCount } }', { f: { types: ['dns_record'], text: label } }))['cis'] as { totalCount: number }).totalCount;
  await expect.poll(inCmdb, { timeout: SETTLE_MS, intervals: [POLL_MS] }).toBeGreaterThan(0);
  await page.getByLabel(translate(locale, 'ipam.dns.search')).fill(label);
  await expect(page.getByText(fqdn, { exact: false }).first()).toBeVisible();
  await page.screenshot({ path: screenshotsDir + 'dns-sync-' + locale + '.png', fullPage: true });

  await requestChange(page, locale, 'delete', label, address);
  await expectApplied(page, locale, fqdn, translate(locale, 'ipam.dnsSync.op.delete'));
  // The next transfer no longer holds it, so the reconciler retires it from the CMDB.
  await expect.poll(inCmdb, { timeout: SETTLE_MS, intervals: [POLL_MS] }).toBe(0);
  await expect(page.getByRole('alert').filter({ hasText: translate(locale, 'common.error') })).toHaveCount(0);
});
