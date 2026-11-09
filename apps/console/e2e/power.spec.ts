// T-531 REQ-DCIM-004 (ADR-058) — the DCIM Power view on the real stack, per locale project:
// - the first room's power chain shows its UPS units, circuits and PDUs, and the redundancy findings (or that there
//   are none);
// - an operator opens a PDU's outlets, plugs a host found by search into a free outlet, sees it on that outlet, and
//   unplugs it again, leaving the estate as it was; no error is shown.
import { fileURLToPath } from 'node:url';
import { expect, test, type Page, type Response } from '@playwright/test';
import { loadEnv } from '@openmap/config';
import { isLocale, translate } from '@openmap/i18n';
import { signIn } from './auth';

const screenshotsDir = fileURLToPath(new URL('./screenshots/', import.meta.url));
const GRAPHQL_PATH = '/graphql';
const ACTION_MS = 30_000;
const STEPS_BUDGET = 6;
/** The screen's error line (Next.js also renders a route announcer with role alert). */
const ERROR_ALERT = 'p[role="alert"]';

async function api(
  page: Page,
  tokenExchange: Promise<Response>,
): Promise<(query: string, variables?: Record<string, unknown>) => Promise<Record<string, unknown>>> {
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

test('the power chain and its findings show, and a device is plugged into a PDU outlet and unplugged', async ({
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
  await page.goto('/' + locale + '/dcim');
  await signIn(page, locale);
  const gql = await api(page, tokenExchange);

  // The room the view opens on (rooms sorted by name), a PDU of it with a free outlet, and a host to plug in.
  const racks = (await gql('query { racks { room { id displayName } } }'))['racks'] as Array<{
    room: { id: string; displayName: string } | null;
  }>;
  const room = racks
    .flatMap((r) => (r.room === null ? [] : [r.room]))
    .sort((a, b) => a.displayName.localeCompare(b.displayName))[0];
  if (room === undefined) throw new Error('the estate has no room with racks');
  const chain = (
    await gql('query P($r: UUID!) { powerChain(roomId: $r) { sources { ci { id name } kind outlets } } }', {
      r: room.id,
    })
  )['powerChain'] as {
    sources: Array<{ ci: { id: string; name: string }; kind: string; outlets: number | null }>;
  };
  const pdu = chain.sources.find((s) => s.kind === 'pdu' && s.outlets !== null);
  if (pdu === undefined || pdu.outlets === null)
    throw new Error('room ' + room.displayName + ' has no PDU with an outlet count');
  const cords = (await gql('query C($p: UUID!) { pduConnections(pduId: $p) { outlet } }', { p: pdu.ci.id }))[
    'pduConnections'
  ] as Array<{ outlet: number | null }>;
  const used = new Set(cords.map((c) => c.outlet));
  const count = pdu.outlets;
  const outlet = Array.from({ length: count }, (_, i) => count - i).find((o) => !used.has(o));
  if (outlet === undefined) throw new Error(pdu.ci.name + ' has no free outlet');
  const hosts = (
    await gql('query { cis(filter: { types: ["host"] }, first: 1) { edges { node { name } } } }')
  )['cis'] as { edges: Array<{ node: { name: string } }> };
  const host = hosts.edges[0]?.node.name;
  if (host === undefined) throw new Error('the estate has no host');

  await page
    .getByRole('group', { name: t('dcim.views') })
    .getByText(t('dcim.view.power'), { exact: true })
    .click();
  await expect(
    page.getByRole('group', { name: t('dcim.power.rooms') }).getByText(room.displayName, { exact: true }),
  ).toBeVisible();
  await expect(page.getByRole('table', { name: t('dcim.power.kind.ups') })).toBeVisible();
  await expect(page.getByRole('table', { name: t('dcim.power.kind.pdu') })).toBeVisible();
  await expect(
    page
      .getByRole('table', { name: t('dcim.power.findings.title') })
      .or(page.getByText(t('dcim.power.findings.none'))),
  ).toBeVisible();

  await page
    .getByRole('table', { name: t('dcim.power.kind.pdu') })
    .getByRole('button', { name: t('dcim.power.showOutlets', { pdu: pdu.ci.name }) })
    .click();
  const outlets = page.getByRole('table', { name: t('dcim.power.outletsTitle', { pdu: pdu.ci.name }) });
  await expect(outlets).toBeVisible();
  const form = page.getByRole('form', { name: t('dcim.power.plug') });
  await form.getByRole('searchbox', { name: t('dcim.power.findDevice') }).fill(host);
  const option = form
    .getByRole('combobox', { name: t('dcim.power.device') })
    .locator('option', { hasText: host })
    .first();
  await expect(option).toBeAttached({ timeout: ACTION_MS });
  await form
    .getByRole('combobox', { name: t('dcim.power.device') })
    .selectOption((await option.getAttribute('value')) ?? '');
  await form.getByRole('spinbutton', { name: t('dcim.power.outlet') }).fill(String(outlet));
  await form.getByRole('spinbutton', { name: t('dcim.power.psu') }).fill('1');
  await form.getByRole('button', { name: t('dcim.power.plug') }).click();
  const row = outlets
    .getByRole('row')
    .filter({ hasText: host })
    .filter({ has: page.getByRole('cell', { name: String(outlet), exact: true }) });
  await expect(row).toHaveCount(1);
  await page.screenshot({ path: screenshotsDir + 'power-' + locale + '.png', fullPage: true });

  await row.getByRole('button', { name: t('dcim.power.unplugDevice', { device: host }) }).click();
  await expect(row).toHaveCount(0);
  await expect(page.locator(ERROR_ALERT)).toHaveCount(0);
});
