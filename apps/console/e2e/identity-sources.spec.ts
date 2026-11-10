// T-647 REQ-INT-016 (ADR-074) — identity sources on the live stack, per locale project. An administrator opens Settings,
// stores a client secret as a credential set (OpenBao, through the API with the console's own token), and on the
// Identity sources card adds an OpenID Connect provider pointing at Keycloak's own `master` realm (Keycloak reads that
// discovery document from where it brokers). The provider is saved disabled, so the `openmap` login page never offers
// it; the row shows Applied with the redirect URI to register; Test reports that the connection works; removing it
// after the confirmation takes the row away, leaving realm `openmap` as it was.
import { fileURLToPath } from 'node:url';
import { randomUUID } from 'node:crypto';
import { expect, test, type Page, type Response } from '@playwright/test';
import { loadEnv } from '@openmap/config';
import { isLocale, translate } from '@openmap/i18n';
import { signIn } from './auth';

const GRAPHQL_PATH = '/graphql';
const screenshotsDir = fileURLToPath(new URL('./screenshots/', import.meta.url));
const ACTION_MS = 30_000;

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

test('an administrator adds, tests and removes an OpenID Connect identity source', async ({ page }, testInfo) => {
  const locale = testInfo.project.name;
  if (!isLocale(locale)) throw new Error('project name must be a locale: ' + locale);
  page.setDefaultTimeout(ACTION_MS);
  const t = (key: Parameters<typeof translate>[1], params?: Record<string, string>): string => translate(locale, key, params);
  const stamp = Date.now().toString(36) + '-' + locale;
  const name = 'E2E IdP ' + stamp;
  const secretRef = 'e2e/identity-' + stamp;
  const issuer = loadEnv().PUBLIC_KEYCLOAK_URL.replace(/\/$/u, '') + '/realms/master';

  const tokenExchange = page.waitForResponse((r) => r.request().method() === 'POST' && r.url().includes('/protocol/openid-connect/token'));
  await page.goto('/' + locale + '/settings');
  await signIn(page, locale);
  const gql = await api(page, tokenExchange);
  await gql('mutation Cred($input: CredentialSetInput!) { saveCredentialSet(input: $input) { ref } }', {
    input: { ref: secretRef, type: 'oauth_client', fields: { clientId: 'openmap-e2e', clientSecret: randomUUID() } },
  });

  const card = page.locator('section').filter({ has: page.getByRole('heading', { name: t('identitySources.title'), exact: true }) });
  await expect(card).toBeVisible();
  await card.getByRole('button', { name: t('identitySources.add') }).click();
  const form = page.getByRole('form', { name: t('identitySources.form') });
  await form.getByLabel(t('identitySources.field.vendor'), { exact: true }).selectOption('oidc');
  await form.getByLabel(t('identitySources.field.name'), { exact: true }).fill(name);
  await form.getByLabel(t('identitySources.field.secretRef'), { exact: true }).fill(secretRef);
  await form.getByLabel(t('identitySources.field.enabled')).uncheck();
  await form.getByLabel(t('identitySources.field.issuer'), { exact: true }).fill(issuer);
  await form.getByLabel(t('identitySources.field.clientId'), { exact: true }).fill('openmap-e2e');
  await form.getByLabel(t('identitySources.field.group'), { exact: true }).fill('e2e-operators');
  await form.getByLabel(t('identitySources.field.role'), { exact: true }).selectOption('operator');
  await form.getByRole('button', { name: t('identitySources.save') }).click();
  await expect(form).toBeHidden();

  const row = page.getByTestId('identity-source-row').filter({ hasText: name });
  await expect(row).toHaveAttribute('data-state', 'applied');
  await expect(row.getByText(t('identitySources.state.applied'))).toBeVisible();
  await expect(row.getByText(t('identitySources.disabled'))).toBeVisible();
  await expect(row.getByTestId('identity-redirect-uri')).toContainText('/broker/openmap-e2e-idp-');
  await expect(row.getByText(t('identitySources.mapping', { group: 'e2e-operators', role: t('identitySources.role.operator') }))).toBeVisible();

  await row.getByRole('button', { name: t('identitySources.test', { name }) }).click();
  await expect(row.getByTestId('identity-test-result')).toHaveAttribute('data-ok', 'true');
  await expect(row.getByText(t('identitySources.testOk'))).toBeVisible();
  await row.scrollIntoViewIfNeeded();
  await page.screenshot({ path: screenshotsDir + 'settings-identity-sources-' + locale + '.png', fullPage: true });

  await row.getByRole('button', { name: t('identitySources.remove', { name }) }).click();
  await row.getByRole('button', { name: t('identitySources.confirmRemove') }).click();
  await expect(row).toHaveCount(0);
});
