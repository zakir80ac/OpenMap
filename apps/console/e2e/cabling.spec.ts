// T-523 REQ-DCIM-001 (ADR-056) — structured cabling on the real stack, per locale project, on the DCIM Cabling tab:
// - two patch panels are mounted in two racks of the estate;
// - a switch port (found by search) is patched to panel A's front, a trunk joins panel A's rear to panel B's rear, and
//   panel B's front is patched to a server port;
// - the trace from the switch port walks both panels to the server port and says the path is complete;
// - a carrier circuit is recorded on panel B's rear position 2;
// - then everything is taken down again from the screen (circuit, cables, panels), so each run leaves the estate as it
//   found it, and no error is shown.
import { fileURLToPath } from 'node:url';
import { expect, test, type Locator, type Page, type Response } from '@playwright/test';
import { loadEnv } from '@openmap/config';
import { isLocale, translate, type Locale } from '@openmap/i18n';
import { signIn } from './auth';

const screenshotsDir = fileURLToPath(new URL('./screenshots/', import.meta.url));
const GRAPHQL_PATH = '/graphql';
const ACTION_MS = 30_000;
const STEPS_BUDGET = 10;
const PORTS = '24';
const PREFIX = 'E2E-';
/** The screen's error line (Next.js also renders a route announcer with role alert). */
const ERROR_ALERT = 'p[role="alert"]';

async function api(
  page: Page,
  tokenExchange: Promise<Response>,
): Promise<(query: string) => Promise<Record<string, unknown>>> {
  const tokens = (await (await tokenExchange).json()) as { access_token: string };
  const url = loadEnv().PUBLIC_API_URL + GRAPHQL_PATH;
  return async (query) => {
    const res = await page.request.post(url, {
      headers: { authorization: 'Bearer ' + tokens.access_token, 'content-type': 'application/json' },
      data: { query },
    });
    const body = (await res.json()) as {
      data?: Record<string, unknown>;
      errors?: Array<{ message: string }>;
    };
    if (body.errors !== undefined) throw new Error(body.errors.map((e) => e.message).join('; '));
    return body.data ?? {};
  };
}

async function firstOf(gql: (q: string) => Promise<Record<string, unknown>>, type: string): Promise<string> {
  const data = (
    await gql('query { cis(filter: { types: ["' + type + '"] }, first: 1) { edges { node { name } } } }')
  )['cis'] as { edges: Array<{ node: { name: string } }> };
  const name = data.edges[0]?.node.name;
  if (name === undefined) throw new Error('the estate has no ' + type);
  return name;
}

/** Takes down what an earlier, interrupted run of this test left (its records carry the E2E- prefix). */
async function sweepLeftovers(gql: (q: string) => Promise<Record<string, unknown>>): Promise<void> {
  const data = (
    await gql(
      'query { cabling { patchPanels { ci { id } name } cables { ci { id } label } circuits { ci { id } circuitId } } }',
    )
  )['cabling'] as {
    patchPanels: Array<{ ci: { id: string }; name: string }>;
    cables: Array<{ ci: { id: string }; label: string }>;
    circuits: Array<{ ci: { id: string }; circuitId: string }>;
  };
  const mine = (text: string): boolean => text.startsWith(PREFIX);
  for (const c of data.circuits.filter((x) => mine(x.circuitId)))
    await gql('mutation { removeCircuit(id: "' + c.ci.id + '") }');
  for (const c of data.cables.filter((x) => mine(x.label)))
    await gql('mutation { disconnectCable(id: "' + c.ci.id + '") }');
  for (const p of data.patchPanels.filter((x) => mine(x.name)))
    await gql('mutation { removePatchPanel(id: "' + p.ci.id + '") }');
}

/** Chooses the option of a select whose text contains `text` (option labels carry the CI type too). */
async function chooseContaining(select: Locator, text: string): Promise<void> {
  const option = select.locator('option', { hasText: text }).first();
  await expect(option).toBeAttached({ timeout: ACTION_MS });
  const value = await option.getAttribute('value');
  if (value === null) throw new Error('option without a value: ' + text);
  await select.selectOption(value);
}

async function setEnd(
  page: Page,
  locale: Locale,
  form: Locator,
  legend: string,
  end: { search?: string; pick: string; port: string; side?: 'front' | 'rear' },
): Promise<void> {
  const group = form.getByRole('group', { name: legend });
  if (end.search !== undefined)
    await group
      .getByRole('searchbox', { name: translate(locale, 'dcim.cabling.endpoint.search') })
      .fill(end.search);
  await chooseContaining(
    group.getByRole('combobox', { name: translate(locale, 'dcim.cabling.endpoint.ci') }),
    end.pick,
  );
  const portLabel = end.side === undefined ? 'dcim.cabling.endpoint.port' : 'dcim.cabling.endpoint.position';
  await group.getByRole('textbox', { name: translate(locale, portLabel) }).fill(end.port);
  if (end.side !== undefined)
    await group
      .getByRole('combobox', { name: translate(locale, 'dcim.cabling.endpoint.side') })
      .selectOption(end.side);
  await expect(page.locator(ERROR_ALERT)).toHaveCount(0);
}

test('patch panels, cables, a trace and a circuit are recorded and taken down from the Cabling tab', async ({
  page,
}, testInfo) => {
  const locale = testInfo.project.name;
  if (!isLocale(locale)) throw new Error('project name must be a locale: ' + locale);
  // About twenty form steps, each a mutation and a re-read of the cabling.
  test.setTimeout(ACTION_MS * STEPS_BUDGET);
  page.setDefaultTimeout(ACTION_MS);
  const t = (key: Parameters<typeof translate>[1], params?: Record<string, string>): string =>
    translate(locale, key, params);

  const tokenExchange = page.waitForResponse(
    (r) => r.request().method() === 'POST' && r.url().includes('/protocol/openid-connect/token'),
  );
  await page.goto('/' + locale + '/dcim');
  await signIn(page, locale);
  const gql = await api(page, tokenExchange);
  await sweepLeftovers(gql);
  const switchName = await firstOf(gql, 'network_device');
  const serverName = await firstOf(gql, 'host');

  await page
    .getByRole('group', { name: t('dcim.views') })
    .getByText(t('dcim.view.cabling'), { exact: true })
    .click();
  const stamp = locale.toUpperCase() + '-' + Date.now().toString(36).toUpperCase();
  const panelA = PREFIX + stamp + '-A';
  const panelB = PREFIX + stamp + '-B';

  // Mount two panels in two racks.
  const panelForm = page.getByRole('form', { name: t('dcim.cabling.panelForm') });
  for (const [name, rackIndex] of [
    [panelA, 1],
    [panelB, 2],
  ] as const) {
    await panelForm
      .getByRole('combobox', { name: t('dcim.cabling.rack') })
      .selectOption({ index: rackIndex });
    await panelForm.getByRole('textbox', { name: t('dcim.cabling.panelName') }).fill(name);
    await panelForm.getByRole('spinbutton', { name: t('dcim.cabling.ports') }).fill(PORTS);
    await panelForm.getByRole('button', { name: t('dcim.cabling.panelForm') }).click();
    await expect(
      page.getByRole('table', { name: t('dcim.cabling.panels.title') }).getByText(name, { exact: true }),
    ).toBeVisible();
  }

  // Switch → A front 1; A rear 1 → B rear 1 (trunk); B front 1 → server.
  const cableForm = page.getByRole('form', { name: t('dcim.cabling.cableForm') });
  const switchPort = 'e2e-' + stamp.toLowerCase();
  const cables = [
    {
      label: PREFIX + stamp + '-1',
      kind: 'patch',
      a: { search: switchName, pick: switchName, port: switchPort },
      b: { pick: panelA, port: '1', side: 'front' as const },
    },
    {
      label: PREFIX + stamp + '-2',
      kind: 'trunk',
      a: { pick: panelA, port: '1', side: 'rear' as const },
      b: { pick: panelB, port: '1', side: 'rear' as const },
    },
    {
      label: PREFIX + stamp + '-3',
      kind: 'patch',
      a: { pick: panelB, port: '1', side: 'front' as const },
      b: { search: serverName, pick: serverName, port: 'eth-' + stamp.toLowerCase() },
    },
  ];
  for (const c of cables) {
    await cableForm.getByRole('textbox', { name: t('dcim.cabling.label') }).fill(c.label);
    await cableForm.getByRole('combobox', { name: t('dcim.cabling.kind') }).selectOption(c.kind);
    await setEnd(page, locale, cableForm, t('dcim.cabling.endA'), c.a);
    await setEnd(page, locale, cableForm, t('dcim.cabling.endB'), c.b);
    await cableForm.getByRole('button', { name: t('dcim.cabling.cableForm') }).click();
    await expect(
      page.getByRole('table', { name: t('dcim.cabling.cables.title') }).getByText(c.label, { exact: true }),
    ).toBeVisible();
  }

  // The trace from the switch port reaches the server port through both panels.
  await page
    .getByRole('button', {
      name: t('dcim.cabling.trace.from', {
        end: t('dcim.cabling.endPort', { ci: switchName, port: switchPort }),
      }),
    })
    .click();
  const path = page.getByRole('list', { name: t('dcim.cabling.trace.title') });
  await expect(path.getByRole('listitem')).toHaveCount(cables.length);
  await expect(
    path.getByText(t('dcim.cabling.endPort', { ci: serverName, port: 'eth-' + stamp.toLowerCase() })),
  ).toBeVisible();
  await expect(page.getByText(t('dcim.cabling.trace.complete'), { exact: true })).toBeVisible();

  // A circuit terminated on panel B's rear position 2.
  const circuitForm = page.getByRole('form', { name: t('dcim.cabling.circuitForm') });
  const circuitId = PREFIX + 'CKT-' + stamp;
  await circuitForm.getByRole('textbox', { name: t('dcim.cabling.provider') }).fill('E2E Telco');
  await circuitForm.getByRole('textbox', { name: t('dcim.cabling.circuitId') }).fill(circuitId);
  await circuitForm.getByRole('combobox', { name: t('dcim.cabling.kind') }).selectOption('mpls');
  await circuitForm.getByRole('textbox', { name: t('dcim.cabling.zEndDescription') }).fill('E2E POP');
  await setEnd(page, locale, circuitForm, t('dcim.cabling.endA'), { pick: panelB, port: '2', side: 'rear' });
  await circuitForm.getByRole('button', { name: t('dcim.cabling.circuitForm') }).click();
  await expect(
    page.getByRole('table', { name: t('dcim.cabling.circuits.title') }).getByText(circuitId, { exact: true }),
  ).toBeVisible();
  await page.screenshot({ path: screenshotsDir + 'cabling-' + locale + '.png', fullPage: true });

  // Take it all down again.
  await page.getByRole('button', { name: t('dcim.cabling.removeCircuit', { circuit: circuitId }) }).click();
  await expect(
    page.getByRole('table', { name: t('dcim.cabling.circuits.title') }).getByText(circuitId, { exact: true }),
  ).toHaveCount(0);
  for (const c of cables) {
    await page.getByRole('button', { name: t('dcim.cabling.disconnectCable', { label: c.label }) }).click();
    await expect(page.getByText(c.label, { exact: true })).toHaveCount(0);
  }
  const panels = page.getByRole('table', { name: t('dcim.cabling.panels.title') });
  for (const name of [panelA, panelB]) {
    const row = panels.getByRole('row').filter({ hasText: name });
    await row.getByRole('button', { name: new RegExp(t('dcim.cabling.remove')) }).click();
    await expect(panels.getByText(name, { exact: true })).toHaveCount(0);
  }
  await expect(page.locator(ERROR_ALERT)).toHaveCount(0);
});
