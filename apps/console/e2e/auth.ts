// REQ-SEC-001 — e2e sign-in helper: signs in through the Keycloak realm as the seeded administrator from
// deploy/compose/keycloak/realm-openmap.json (the compose stack imports that file, so the e2e never carries a
// credential of its own) and handles the first-use password update Keycloak asks for on a temporary password.
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { expect, type Page } from '@playwright/test';
import { translate, type Locale } from '@openmap/i18n';

const realmFile = fileURLToPath(new URL('../../../deploy/compose/keycloak/realm-openmap.json', import.meta.url));

interface RealmUser {
  username: string;
  realmRoles?: string[];
  credentials?: Array<{ type: string; value: string; temporary?: boolean }>;
}

export interface SeededUser {
  username: string;
  password: string;
  roles: string[];
}

/** A password user from the realm the compose stack imports (default: the first one, the administrator). */
export function seededUser(username?: string): SeededUser {
  const realm = JSON.parse(readFileSync(realmFile, 'utf8')) as { users?: RealmUser[] };
  for (const user of realm.users ?? []) {
    if (username !== undefined && user.username !== username) continue;
    const credential = user.credentials?.find((c) => c.type === 'password');
    if (credential !== undefined) return { username: user.username, password: credential.value, roles: user.realmRoles ?? [] };
  }
  throw new Error('realm export has no password user' + (username === undefined ? '' : ' named ' + username));
}

/** From the sign-in screen through Keycloak and back to the console; resolves once the primary navigation is visible. */
export async function signIn(page: Page, locale: Locale, username?: string): Promise<void> {
  await page.getByRole('button', { name: translate(locale, 'auth.signIn') }).click();
  const user = seededUser(username);
  await page.locator('#username').fill(user.username);
  await page.locator('#password').fill(user.password);
  await page.locator('#kc-login').click();
  // A seeded temporary password makes Keycloak ask for a new one on first use; keep the seeded value.
  const newPassword = page.locator('#password-new');
  if (await newPassword.isVisible({ timeout: 2_000 }).catch(() => false)) {
    await newPassword.fill(user.password);
    await page.locator('#password-confirm').fill(user.password);
    await page.locator('#kc-form-buttons input[type=submit], #kc-form-buttons button[type=submit]').first().click();
  }
  await expect(page.getByRole('navigation', { name: translate(locale, 'nav.primary') })).toBeVisible();
}
