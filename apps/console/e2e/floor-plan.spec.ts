// T-527 REQ-DCIM-003 (ADR-057) — the DCIM floor plan on the real stack, per locale project:
// - the Floor plan tab draws the chosen room's rows with their aisles and rack slots, coloured by power;
// - switching the measure to units in use re-labels the racks;
// - an operator picks a rack, picks a free slot of a row in its room on the plan and moves the rack there; the plan
//   shows it in the new slot; then it is moved back the same way, leaving the estate as it was; no error is shown.
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

interface RackRow {
  ci: { id: string; displayName: string; attributes: Record<string, unknown> };
  row: { id: string; displayName: string; attributes: Record<string, unknown> } | null;
  room: { id: string; displayName: string } | null;
}

async function racksOf(page: Page, tokenExchange: Promise<Response>): Promise<RackRow[]> {
  const tokens = (await (await tokenExchange).json()) as { access_token: string };
  const res = await page.request.post(loadEnv().PUBLIC_API_URL + GRAPHQL_PATH, {
    headers: { authorization: 'Bearer ' + tokens.access_token, 'content-type': 'application/json' },
    data: {
      query:
        'query { racks { ci { id displayName attributes } row { id displayName attributes } room { id displayName } } }',
    },
  });
  const body = (await res.json()) as { data?: { racks: RackRow[] }; errors?: Array<{ message: string }> };
  if (body.errors !== undefined) throw new Error(body.errors.map((e) => e.message).join('; '));
  return body.data?.racks ?? [];
}

/** A rack in a row of its room that has a free slot, with that slot. */
function pickMove(racks: RackRow[]): {
  rack: RackRow;
  room: string;
  rowName: string;
  from: number;
  to: number;
} {
  const byRow = new Map<string, RackRow[]>();
  for (const r of racks)
    if (r.row !== null && r.room !== null) byRow.set(r.row.id, [...(byRow.get(r.row.id) ?? []), r]);
  for (const list of byRow.values()) {
    const first = list[0];
    const capacity = first?.row?.attributes['rackCapacity'];
    if (first === undefined || first.row === null || first.room === null || typeof capacity !== 'number')
      continue;
    const used = new Set(list.map((r) => r.ci.attributes['position']));
    const free = Array.from({ length: capacity }, (_, i) => i + 1).find((p) => !used.has(p));
    const from = first.ci.attributes['position'];
    if (free !== undefined && typeof from === 'number')
      return { rack: first, room: first.room.displayName, rowName: first.row.displayName, from, to: free };
  }
  throw new Error('no row of the estate has a free slot to move a rack into');
}

test('the floor plan shows rows and heat, and a rack moves to a free slot and back', async ({
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
  const move = pickMove(await racksOf(page, tokenExchange));
  const name = move.rack.ci.displayName;
  const slotOf = (slot: number) =>
    new RegExp(
      '^' +
        t('dcim.floor.rackSlot', { row: move.rowName, slot: String(slot), rack: name, heat: '' })
          .replace(/[\s,،]+$/u, '')
          .replace(/[.*+?^${}()|[\]\\]/gu, '\\$&'),
    );

  await page
    .getByRole('group', { name: t('dcim.views') })
    .getByText(t('dcim.view.floor'), { exact: true })
    .click();
  await page
    .getByRole('group', { name: t('dcim.floor.rooms') })
    .getByText(move.room, { exact: true })
    .click();
  const plan = page.getByRole('region', { name: t('dcim.floor.plan', { room: move.room }) });
  await expect(plan.getByRole('list', { name: t('dcim.floor.row', { row: move.rowName }) })).toBeVisible();
  await expect(plan.getByRole('button', { name: slotOf(move.from) })).toBeVisible();

  await page.getByRole('radio', { name: t('dcim.floor.measures.occupancy') }).click();
  await expect(page.getByRole('radio', { name: t('dcim.floor.measures.occupancy') })).toBeChecked();
  await expect(plan.getByRole('button', { name: slotOf(move.from) })).toBeVisible();
  await page.screenshot({ path: screenshotsDir + 'floor-plan-' + locale + '.png', fullPage: true });

  const moveTo = async (from: number, to: number): Promise<void> => {
    await plan.getByRole('button', { name: slotOf(from) }).click();
    const form = page.getByRole('form', { name: t('dcim.floor.move') });
    await expect(form).toBeVisible();
    await plan
      .getByRole('button', { name: t('dcim.floor.freeSlot', { row: move.rowName, slot: String(to) }) })
      .click();
    await form.getByRole('button', { name: t('dcim.floor.move') }).click();
    await expect(plan.getByRole('button', { name: slotOf(to) })).toBeVisible();
    await expect(
      plan.getByRole('button', { name: t('dcim.floor.freeSlot', { row: move.rowName, slot: String(from) }) }),
    ).toBeVisible();
  };
  await moveTo(move.from, move.to);
  await moveTo(move.to, move.from);
  await expect(page.locator(ERROR_ALERT)).toHaveCount(0);
});
