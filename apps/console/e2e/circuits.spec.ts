// T-594 REQ-IPAM-007 (ADR-069) — the network circuit register on the real stack, per locale project (en and ar):
// - a carrier circuit is recorded (as the DCIM Cabling tab would) under the E2E- prefix;
// - on the Sites screen an operator opens the first link's circuit details, sets a carrier contract, a physical route
//   and a committed latency, puts the link on the new circuit and saves;
// - the link row shows the contract, the route and the circuit, the readiness rules list path diversity and
//   redundancy, and no error is shown;
// - the link's register entry is restored and the circuit removed through the API, so each run leaves the estate as it
//   found it (a run cut short is swept by the next one).
import { fileURLToPath } from 'node:url';
import { expect, test, type Page, type Response } from '@playwright/test';
import { loadEnv } from '@openmap/config';
import { isLocale, translate } from '@openmap/i18n';
import { signIn } from './auth';

const screenshotsDir = fileURLToPath(new URL('./screenshots/', import.meta.url));
const GRAPHQL_PATH = '/graphql';
const ACTION_MS = 30_000;
const STEPS_BUDGET = 8;
const PREFIX = 'E2E-';
const COMMITTED_MS = '9';
/** The screen's error line (Next.js also renders a route announcer with role alert). */
const ERROR_ALERT = 'p[role="alert"]';

type Gql = (query: string, variables?: Record<string, unknown>) => Promise<Record<string, unknown>>;

interface Link {
  ci: { id: string; displayName: string };
  kind: string | null;
  provider: string | null;
  role: string | null;
  diversePaths: number;
  capacityMbps: number | null;
  slaLatencyMs: number | null;
  carrierContractRef: string | null;
  pathRef: string | null;
  circuits: Array<{ ci: { id: string }; circuitId: string | null }>;
}
const LINK_FIELDS =
  'ci { id displayName } kind provider role diversePaths capacityMbps slaLatencyMs carrierContractRef pathRef circuits { ci { id } circuitId }';
const SAVE =
  'mutation S($linkId: UUID!, $input: LinkCircuitInput!) { saveLinkCircuit(linkId: $linkId, input: $input) { ci { id } } }';

async function api(page: Page, tokenExchange: Promise<Response>): Promise<Gql> {
  const tokens = (await (await tokenExchange).json()) as { access_token: string };
  const url = loadEnv().PUBLIC_API_URL + GRAPHQL_PATH;
  return async (query, variables) => {
    const res = await page.request.post(url, {
      headers: { authorization: 'Bearer ' + tokens.access_token, 'content-type': 'application/json' },
      data: { query, variables },
    });
    const body = (await res.json()) as {
      data?: Record<string, unknown>;
      errors?: Array<{ message: string }>;
    };
    if (body.errors !== undefined) throw new Error(body.errors.map((e) => e.message).join('; '));
    return body.data ?? {};
  };
}

async function links(gql: Gql): Promise<Link[]> {
  return (
    (await gql('query { connectivity { links { ' + LINK_FIELDS + ' } } }'))['connectivity'] as {
      links: Link[];
    }
  ).links;
}

/** The register entry a link had, as saveLinkCircuit takes it, without the circuits `drop` names. */
function entryOf(link: Link, drop: ReadonlySet<string> = new Set()): Record<string, unknown> {
  return {
    kind: link.kind,
    provider: link.provider,
    carrierContractRef: link.carrierContractRef,
    bandwidthMbps: link.capacityMbps,
    slaLatencyMs: link.slaLatencyMs,
    diversePaths: link.diversePaths,
    role: link.role,
    pathRef: link.pathRef,
    circuitCiIds: link.circuits.map((c) => c.ci.id).filter((id) => !drop.has(id)),
  };
}

/** Takes the E2E circuits off every link and removes them, with any E2E contract or route an interrupted run left. */
async function sweepLeftovers(gql: Gql): Promise<void> {
  const circuits = (
    (await gql('query { cabling { circuits { ci { id } circuitId } } }'))['cabling'] as {
      circuits: Array<{ ci: { id: string }; circuitId: string }>;
    }
  ).circuits;
  const mine = new Set(circuits.filter((c) => c.circuitId.startsWith(PREFIX)).map((c) => c.ci.id));
  for (const link of await links(gql)) {
    const stale =
      link.circuits.some((c) => mine.has(c.ci.id)) ||
      (link.carrierContractRef ?? '').startsWith(PREFIX) ||
      (link.pathRef ?? '').startsWith(PREFIX);
    if (!stale) continue;
    const entry = entryOf(link, mine);
    if ((link.carrierContractRef ?? '').startsWith(PREFIX)) entry['carrierContractRef'] = null;
    if ((link.pathRef ?? '').startsWith(PREFIX)) entry['pathRef'] = null;
    await gql(SAVE, { linkId: link.ci.id, input: entry });
  }
  for (const id of mine) await gql('mutation { removeCircuit(id: "' + id + '") }');
}

test('a link is put on a carrier circuit with its contract and route from the Sites screen', async ({
  page,
}, testInfo) => {
  const locale = testInfo.project.name;
  if (!isLocale(locale)) throw new Error('project name must be a locale: ' + locale);
  test.setTimeout(ACTION_MS * STEPS_BUDGET);
  page.setDefaultTimeout(ACTION_MS);
  const t = (key: Parameters<typeof translate>[1], params?: Record<string, string>): string =>
    translate(locale, key, params);

  const tokenExchange = page.waitForResponse(
    (r) => r.request().method() === 'POST' && r.url().includes('/protocol/openid-connect/token'),
  );
  await page.goto('/' + locale + '/sites');
  await signIn(page, locale);
  const gql = await api(page, tokenExchange);
  await sweepLeftovers(gql);

  const stamp = locale.toUpperCase() + '-' + Date.now().toString(36).toUpperCase();
  const circuitId = PREFIX + 'CKT-' + stamp;
  const created = (
    await gql(
      'mutation C($input: CircuitInput!) { upsertCircuit(input: $input) { ci { id displayName } } }',
      {
        input: {
          provider: 'E2E Telco',
          circuitId,
          kind: 'mpls',
          status: 'active',
          bandwidthMbps: 1000,
          aEnd: null,
          zEnd: null,
          zEndDescription: 'E2E POP',
        },
      },
    )
  )['upsertCircuit'] as { ci: { id: string; displayName: string } };
  const [first] = await links(gql);
  if (first === undefined) throw new Error('the estate has no inter-site link');
  const contract = PREFIX + 'CTR-' + stamp;
  const route = PREFIX + 'ROUTE-' + stamp;

  try {
    await page.reload();
    const table = page.getByRole('table', { name: t('sites.links') });
    await expect(table.getByRole('row').nth(1)).toBeVisible();
    await page.getByRole('button', { name: t('sites.circuit.edit', { link: first.ci.displayName }) }).click();
    const form = page.getByRole('form', { name: t('sites.circuit.form', { link: first.ci.displayName }) });
    await form.getByRole('textbox', { name: t('setup.links.contract') }).fill(contract);
    await form.getByRole('textbox', { name: t('setup.links.pathRef') }).fill(route);
    await form.getByRole('textbox', { name: t('setup.links.slaLatency') }).fill(COMMITTED_MS);
    await form
      .getByRole('checkbox', {
        name: t('sites.circuit.option', { provider: 'E2E Telco', circuit: circuitId }),
      })
      .check();
    await form.getByRole('button', { name: t('sites.circuit.save') }).click();
    await expect(form).toHaveCount(0);

    const row = table
      .getByRole('row')
      .filter({ has: page.getByRole('link', { name: first.ci.displayName, exact: true }) });
    await expect(
      row.getByText(t('sites.circuit.contract', { ref: contract }), { exact: true }),
    ).toBeVisible();
    await expect(row.getByText(t('sites.circuit.route', { ref: route }), { exact: true })).toBeVisible();
    await expect(
      row.getByLabel(t('sites.circuit.carriers')).getByText(created.ci.displayName, { exact: true }),
    ).toBeVisible();
    const readiness = page.getByRole('region', { name: t('sites.readiness') });
    for (const key of ['sites.rule.path_diversity', 'sites.rule.redundancy_lost'] as const)
      await expect(readiness.getByText(t(key), { exact: true }).first()).toBeVisible();
    await expect(page.locator(ERROR_ALERT)).toHaveCount(0);
    const saved = (await links(gql)).find((l) => l.ci.id === first.ci.id);
    expect(saved).toMatchObject({
      carrierContractRef: contract,
      pathRef: route,
      slaLatencyMs: Number(COMMITTED_MS),
    });
    expect(saved?.circuits.map((c) => c.ci.id)).toContain(created.ci.id);
    await page.screenshot({ path: screenshotsDir + 'circuits-' + locale + '.png', fullPage: true });
  } finally {
    await gql(SAVE, { linkId: first.ci.id, input: entryOf(first) });
    await gql('mutation { removeCircuit(id: "' + created.ci.id + '") }');
  }
});
