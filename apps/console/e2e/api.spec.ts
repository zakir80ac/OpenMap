// T-486 REQ-CORE-019 REQ-UI-019 (ADR-049) — the API card on the real stack, per locale project:
// - Settings shows the REST, OpenAPI and GraphQL addresses;
// - the routes table is read from the API's live /api/v1/openapi.json, one row per route of the contract table;
// - the same document answers without a token.
import { fileURLToPath } from 'node:url';
import { expect, test } from '@playwright/test';
import { CONTRACT_VERSIONS, REST_ROUTES } from '@openmap/contracts';
import { isLocale, translate } from '@openmap/i18n';
import { signIn } from './auth';

const screenshotsDir = fileURLToPath(new URL('./screenshots/', import.meta.url));
const LOAD_TIMEOUT_MS = 60_000;

test('the API card lists every REST route from the live OpenAPI document', async ({ page }, testInfo) => {
  const locale = testInfo.project.name;
  if (!isLocale(locale)) throw new Error('project name must be a locale: ' + locale);
  test.setTimeout(LOAD_TIMEOUT_MS * 2);

  await page.goto('/' + locale + '/settings');
  await signIn(page, locale);
  const card = page.getByRole('region', { name: translate(locale, 'settings.api.title') });
  await expect(card).toBeVisible({ timeout: LOAD_TIMEOUT_MS });
  const routes = card.getByRole('table', { name: translate(locale, 'settings.api.routes', { version: CONTRACT_VERSIONS.rest }) });
  await expect(routes.getByRole('row')).toHaveCount(Object.keys(REST_ROUTES).length + 1, { timeout: LOAD_TIMEOUT_MS });
  await expect(routes.getByText('/api/v1/cis/{id}/impact')).toBeVisible();

  const openapi = (await card.getByText(/\/api\/v1\/openapi\.json$/).textContent()) ?? '';
  const res = await page.request.get(openapi);
  expect(res.status()).toBe(200);
  expect(((await res.json()) as { openapi: string }).openapi).toBe('3.1.0');

  await card.scrollIntoViewIfNeeded();
  await page.screenshot({ path: screenshotsDir + 'api-' + locale + '.png', fullPage: true });
});
