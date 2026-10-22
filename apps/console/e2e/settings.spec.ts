// T-099 REQ-UI-019 — tenant settings end to end, per locale project: the administrator changes the stale threshold,
// sees the saved confirmation, the value survives a reload (it came back from `tenantSettings`), and the change is
// in the audit log; the original value is restored afterwards so the stack is left as found.
import { expect, test } from '@playwright/test';
import { isLocale, translate } from '@openmap/i18n';
import { signIn } from './auth';

test('an administrator changes a tenant setting, sees it persist and audited, then restores it', async ({ page }, testInfo) => {
  const locale = testInfo.project.name;
  if (!isLocale(locale)) throw new Error('project name must be a locale: ' + locale);
  await page.goto('/' + locale + '/settings');
  await signIn(page, locale);

  const field = page.getByLabel(translate(locale, 'settings.tenant.staleAfterDays'));
  await expect(field).toBeVisible();
  const original = await field.inputValue();
  const changed = String(Number(original) + 1);
  const save = page.getByRole('button', { name: translate(locale, 'settings.tenant.save') });
  await expect(save).toBeDisabled();

  await field.fill(changed);
  await expect(save).toBeEnabled();
  await save.click();
  await expect(page.getByRole('status').filter({ hasText: translate(locale, 'settings.tenant.saved') })).toBeVisible();

  await page.reload();
  await expect(page.getByLabel(translate(locale, 'settings.tenant.staleAfterDays'))).toHaveValue(changed);
  await expect(page.getByRole('row').filter({ hasText: 'updateTenantSettings' }).first()).toBeVisible();

  await page.getByLabel(translate(locale, 'settings.tenant.staleAfterDays')).fill(original);
  await page.getByRole('button', { name: translate(locale, 'settings.tenant.save') }).click();
  await expect(page.getByRole('status').filter({ hasText: translate(locale, 'settings.tenant.saved') })).toBeVisible();
});
