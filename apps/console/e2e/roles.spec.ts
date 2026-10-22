// T-088 REQ-SEC-001 — the denied path end to end, per locale project: a read-only auditor signs in through Keycloak,
// the console disables the operator action and says which role it needs, the account menu shows the auditor role,
// and the same bearer token sent straight to the API's runDiscovery mutation is refused by the role guard.
import { expect, test } from '@playwright/test';
import { loadEnv } from '@openmap/config';
import { ROLES } from '@openmap/constants';
import { isLocale, translate } from '@openmap/i18n';
import { seededUser, signIn } from './auth';

const GRAPHQL_PATH = '/graphql';
const AUDITOR = 'auditor';

test('an auditor cannot run discovery: the console disables the action and the API refuses the mutation', async ({ page, request }, testInfo) => {
  const locale = testInfo.project.name;
  if (!isLocale(locale)) throw new Error('Playwright project must be named after a locale: ' + locale);
  const auditor = seededUser(AUDITOR);
  expect(auditor.roles).toEqual([ROLES.auditor]);

  const tokenExchange = page.waitForResponse((r) => r.request().method() === 'POST' && r.url().includes('/protocol/openid-connect/token'));
  await page.goto('/' + locale + '/discovery');
  await signIn(page, locale, AUDITOR);
  const tokens = (await (await tokenExchange).json()) as { access_token: string };

  const requires = translate(locale, 'auth.requiresRole', { role: ROLES.operator });
  await expect(page.getByRole('button', { name: translate(locale, 'discovery.run') })).toBeDisabled();
  await expect(page.getByText(requires)).toBeVisible();

  await page.getByRole('button', { name: translate(locale, 'auth.menu') }).click();
  const menu = page.getByRole('dialog', { name: translate(locale, 'auth.menu') });
  await expect(menu.getByText(auditor.username, { exact: true })).toBeVisible();
  await expect(menu.getByText(ROLES.auditor)).toBeVisible();

  const api = loadEnv().PUBLIC_API_URL + GRAPHQL_PATH;
  const response = await request.post(api, {
    headers: { authorization: 'Bearer ' + tokens.access_token, 'content-type': 'application/json' },
    data: { query: 'mutation Denied { runDiscovery { id } }' },
  });
  const body = (await response.json()) as { data?: { runDiscovery: unknown } | null; errors?: Array<{ message: string }> };
  expect(body.data?.runDiscovery ?? null).toBeNull();
  expect(body.errors?.[0]?.message).toContain('requires one of the roles');
  expect(body.errors?.[0]?.message).toContain(ROLES.operator);
});
