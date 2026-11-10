// T-627 REQ-INT-011 (ADR-072) — the configuration-management inventory card on the Integrations screen, per locale
// project: the preview reads the live Ansible inventory with the signed-in token (and the card shows its size), the
// table lists the four tools' endpoints on this deployment, and the salt-ssh roster downloads as a YAML document.
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { expect, test } from '@playwright/test';
import { isLocale, translate } from '@openmap/i18n';
import { signIn } from './auth';

const screenshotsDir = fileURLToPath(new URL('./screenshots/', import.meta.url));
const LOAD_TIMEOUT_MS = 60_000;
const TOOLS = 4;

test('the inventory card reads the live inventory, lists every endpoint and downloads the roster', async ({ page }, testInfo) => {
  const locale = testInfo.project.name;
  if (!isLocale(locale)) throw new Error('project name must be a locale: ' + locale);
  test.setTimeout(LOAD_TIMEOUT_MS * 2);
  const preview = page.waitForResponse((r) => r.url().includes('/api/v1/inventory/ansible'), { timeout: LOAD_TIMEOUT_MS * 2 });
  await page.goto('/' + locale + '/integrations');
  await signIn(page, locale);

  const res = await preview;
  expect(res.status()).toBe(200);
  const inventory = (await res.json()) as { _meta: { hostvars: Record<string, unknown> } };
  const card = page.getByRole('region', { name: translate(locale, 'integrations.inventory.title') });
  await expect(card).toBeVisible({ timeout: LOAD_TIMEOUT_MS });
  await expect(card.getByText(translate(locale, 'integrations.inventory.nodes'))).toBeVisible();
  expect(typeof inventory._meta.hostvars).toBe('object');

  const table = card.getByRole('table', { name: translate(locale, 'integrations.inventory.endpoints') });
  await expect(table.getByRole('row')).toHaveCount(TOOLS + 1);
  await expect(table.getByText(/\/api\/v1\/inventory\/puppet\/nodes\/\{certname\}$/)).toBeVisible();

  const tool = translate(locale, 'integrations.inventory.tool.salt');
  const download = page.waitForEvent('download', { timeout: LOAD_TIMEOUT_MS * 2 });
  await table.getByRole('button', { name: translate(locale, 'integrations.inventory.downloadTool', { tool }) }).click();
  const file = await download;
  expect(file.suggestedFilename()).toBe('openmap-roster.yaml');
  const path = await file.path();
  expect((await readFile(path, 'utf8')).startsWith('---\n')).toBe(true);

  await card.scrollIntoViewIfNeeded();
  await page.screenshot({ path: screenshotsDir + 'inventory-' + locale + '.png', fullPage: true });
});
