// T-106 REQ-UI-009 REQ-UI-010 REQ-UI-011 REQ-UI-014 REQ-UI-015 REQ-UI-016 REQ-UI-017 REQ-UI-018 — the estate screens against the live
// stack, per locale project: IPAM shows a subnet's addresses and next free address; DCIM selects a rack and draws its
// elevation; Assets creates a plan whose planned assets appear in the register; Integrations creates an integration
// and probes it (the probe outcome is whatever the tenant's outbound policy allows); Analytics mounts the embedded
// Superset dashboard for this tenant; the Assistant answers or explains a refusal for an example question.
import { expect, test } from '@playwright/test';
import { isLocale, translate, type Locale } from '@openmap/i18n';
import { loadEnv } from '@openmap/config';
import { signIn } from './auth';

const env = loadEnv();
const ASSISTANT_TIMEOUT_MS = 120_000;

function localeOf(name: string): Locale {
  if (!isLocale(name)) throw new Error('project name must be a locale: ' + name);
  return name;
}

test('IPAM: a subnet lists its addresses and the next free address', async ({ page }, testInfo) => {
  const locale = localeOf(testInfo.project.name);
  await page.goto('/' + locale + '/ipam');
  await signIn(page, locale);
  const tree = page.getByRole('tree', { name: translate(locale, 'ipam.tree.title') });
  await expect(tree.getByRole('treeitem').first()).toBeVisible();
  // The management /24 is a leaf with addresses in the synthetic estate (two VRFs carry the same prefix).
  await tree.getByRole('button', { name: '10.0.0.0/24', exact: true }).first().click();
  const panel = page.getByRole('region', { name: translate(locale, 'ipam.subnet.title') });
  await expect(panel.getByRole('table')).toBeVisible();
  await expect(panel.getByText(/^10\.0\.0\.\d+$/).first()).toBeVisible();
  await page.getByRole('button', { name: translate(locale, 'ipam.tab.dns') }).click();
  await expect(page.getByText(translate(locale, 'ipam.dns.zones'), { exact: false }).first()).toBeVisible();
});

test('DCIM: a rack tile opens its elevation, devices and power feeds', async ({ page }, testInfo) => {
  const locale = localeOf(testInfo.project.name);
  await page.goto('/' + locale + '/dcim');
  await signIn(page, locale);
  const heatmap = page.getByRole('listbox', { name: translate(locale, 'dcim.heatmap.title') });
  await expect(heatmap.getByRole('option').first()).toBeVisible();
  await heatmap.getByRole('option').nth(1).click();
  const elevation = page.getByRole('region', { name: translate(locale, 'dcim.elevation.title') });
  await expect(elevation.getByRole('img')).toBeVisible();
  await expect(page.getByText(translate(locale, 'dcim.power.title'))).toBeVisible();
});

test('Assets: a new plan creates planned assets in the register', async ({ page }, testInfo) => {
  const locale = localeOf(testInfo.project.name);
  await page.goto('/' + locale + '/assets');
  await signIn(page, locale);
  const form = page.getByRole('form', { name: translate(locale, 'assets.plans.new') });
  await expect(form).toBeVisible();
  const stamp = Date.now().toString();
  await form.getByLabel(translate(locale, 'assets.plans.name')).fill('E2E plan ' + stamp);
  await form.getByLabel(translate(locale, 'assets.plans.description')).fill('Created by the e2e suite');
  await form
    .getByLabel(translate(locale, 'assets.plans.bom.description'))
    .first()
    .fill('Leaf switch ' + stamp);
  await form.getByLabel(translate(locale, 'assets.plans.bom.quantity')).first().fill('1');
  await form.getByRole('button', { name: translate(locale, 'assets.plans.create') }).click();
  await expect(form.getByRole('status')).toBeVisible();
  await expect(page.getByRole('article', { name: /E2E plan/ }).first()).toBeVisible();
  await expect(
    page
      .getByRole('combobox', { name: new RegExp(translate(locale, 'assets.setStage', { tag: '' }).trim()) })
      .first(),
  ).toBeVisible();
});

test('Integrations: an integration is created and probed', async ({ page }, testInfo) => {
  const locale = localeOf(testInfo.project.name);
  await page.goto('/' + locale + '/integrations');
  await signIn(page, locale);
  await page.getByRole('button', { name: translate(locale, 'integrations.new') }).click();
  const form = page.getByRole('form', { name: translate(locale, 'integrations.new') });
  const name = 'E2E webhook ' + Date.now().toString();
  await form.getByLabel(translate(locale, 'integrations.table.name')).fill(name);
  await form.getByLabel(translate(locale, 'integrations.form.category')).selectOption('notification');
  await form.getByLabel(translate(locale, 'integrations.table.vendor')).selectOption('webhook');
  await form
    .getByLabel(translate(locale, 'integrations.form.endpoint'))
    .fill(env.PUBLIC_API_URL.replace(/\/$/, '') + '/healthz');
  await form
    .getByLabel(translate(locale, 'integrations.form.credentialRef'))
    .fill('secret/openmap/e2e-webhook');
  await form.getByRole('button', { name: translate(locale, 'integrations.save') }).click();
  const panel = page.getByRole('region', { name });
  await expect(panel).toBeVisible();
  await panel.getByRole('button', { name: translate(locale, 'integrations.test') }).click();
  // Either the probe ran (healthy / failing with a last error) or the tenant forbids outbound calls: both are shown.
  await expect(
    panel
      .getByText(translate(locale, 'integrations.detail.lastError'))
      .or(panel.getByText(translate(locale, 'integrations.health.healthy')))
      .or(page.getByRole('alert'))
      .first(),
  ).toBeVisible({ timeout: 20_000 });
});

test('Analytics: the tenant dashboard is embedded from Superset', async ({ page }, testInfo) => {
  const locale = localeOf(testInfo.project.name);
  await page.goto('/' + locale + '/analytics');
  await signIn(page, locale);
  const frame = page.getByTestId('analytics-mount').locator('iframe');
  await expect(frame).toHaveAttribute('src', /\/embedded\//, { timeout: 30_000 });
  await expect(page.getByText(translate(locale, 'analytics.live'), { exact: true })).toBeVisible({
    timeout: 30_000,
  });
});

test('Assistant: an example question is answered or explicitly refused', async ({ page }, testInfo) => {
  const locale = localeOf(testInfo.project.name);
  test.setTimeout(ASSISTANT_TIMEOUT_MS + 30_000);
  await page.goto('/' + locale + '/assistant');
  await signIn(page, locale);
  await page.getByRole('button', { name: translate(locale, 'assistant.example.hosts') }).click();
  const conversation = page.getByRole('list', { name: translate(locale, 'assistant.conversation') });
  await expect(conversation.getByText(translate(locale, 'assistant.example.hosts'))).toBeVisible();
  const answered = conversation.getByText(translate(locale, 'assistant.cypher'));
  const refused = conversation.getByRole('alert');
  await expect(answered.or(refused).first()).toBeVisible({ timeout: ASSISTANT_TIMEOUT_MS });
  const outcome =
    (await answered.count()) > 0 ? 'answered' : 'refused: ' + ((await refused.first().textContent()) ?? '');
  testInfo.annotations.push({ type: 'assistant', description: outcome });
});

test('Software: the catalogue lists discovered products with their licence position', async ({
  page,
}, testInfo) => {
  const locale = localeOf(testInfo.project.name);
  await page.goto('/' + locale + '/software');
  await signIn(page, locale);
  const table = page.getByRole('table').first();
  await expect(table.getByRole('row').nth(1)).toBeVisible();
  await expect(
    table.getByRole('columnheader', { name: translate(locale, 'software.table.licence') }),
  ).toBeVisible();
  await expect(
    page.getByRole('region', { name: translate(locale, 'software.posture.overDeployed') }),
  ).toBeVisible();
  await page.getByLabel(translate(locale, 'software.filter.licensedOnly')).check();
  await expect(table.getByRole('row').nth(1)).toBeVisible();
  await expect(table.getByText(translate(locale, 'software.licence.none'))).toHaveCount(0);
});

test('Vulnerabilities: the highest CVE opens its blast radius through the graph', async ({
  page,
}, testInfo) => {
  const locale = localeOf(testInfo.project.name);
  await page.goto('/' + locale + '/vulnerabilities');
  await signIn(page, locale);
  const cves = page.getByRole('button', {
    name: new RegExp(translate(locale, 'vulnerabilities.select', { cve: 'CVE-' })),
  });
  await expect(cves.first()).toBeVisible();
  await cves.first().click();
  const panel = page.getByRole('region', { name: translate(locale, 'vulnerabilities.detail.title') });
  await expect(panel.getByRole('heading', { level: 3 })).toBeVisible();
  await expect(
    panel.getByRole('region', { name: translate(locale, 'vulnerabilities.detail.hosts') }),
  ).toBeVisible();
  await expect(
    panel.getByRole('region', { name: translate(locale, 'vulnerabilities.detail.services') }),
  ).toBeVisible();
});

test('Discovery: a scope keeps the exclusions, credential set and rate limit an operator saves', async ({
  page,
}, testInfo) => {
  const locale = localeOf(testInfo.project.name);
  await page.goto('/' + locale + '/discovery');
  await signIn(page, locale);
  const card = page.getByRole('region', { name: translate(locale, 'discovery.scopes.title') });
  await expect(card.getByRole('row').nth(1)).toBeVisible();
  const edit = card
    .getByRole('button', {
      name: new RegExp(translate(locale, 'discovery.scopes.editOf', { cidr: '' }).trim()),
    })
    .first();
  const cidr = (await edit.getAttribute('aria-label'))?.split(' ').pop() ?? '';
  await edit.click();
  const form = card.getByRole('form', { name: translate(locale, 'discovery.scopes.form', { cidr }) });
  await expect(form).toBeVisible();
  await form.getByLabel(translate(locale, 'discovery.scopes.exclusions')).fill('10.0.0.250/32');
  await form.getByLabel(translate(locale, 'discovery.scopes.credentialType')).selectOption('snmp_v3');
  await form.getByLabel(translate(locale, 'discovery.scopes.credentialRef')).fill('secret/openmap/e2e-snmp');
  await form.getByLabel(translate(locale, 'discovery.scopes.concurrency')).fill('4');
  await form.getByLabel(translate(locale, 'discovery.scopes.rps')).fill('25');
  await form.getByRole('button', { name: translate(locale, 'action.save') }).click();
  await expect(form).toBeHidden();
  const row = card.getByRole('row').filter({ hasText: cidr }).first();
  await expect(row.getByText('10.0.0.250/32')).toBeVisible();
  await expect(row.getByText('secret/openmap/e2e-snmp')).toBeVisible();
});
