// T-106 REQ-UI-009 REQ-UI-010 REQ-UI-011 REQ-UI-014 REQ-UI-015 REQ-UI-016 REQ-UI-017 REQ-UI-018 — the estate screens against the live
// stack, per locale project: IPAM shows a subnet's addresses and next free address; DCIM selects a rack and draws its
// elevation; Assets creates a plan whose planned assets appear in the register; Integrations creates an integration
// and probes it (the probe outcome is whatever the tenant's outbound policy allows); Analytics mounts the embedded
// Superset dashboard for this tenant; the Assistant answers or explains a refusal for an example question.
import { fileURLToPath } from 'node:url';
import { expect, test } from '@playwright/test';
import { isLocale, translate, type Locale } from '@openmap/i18n';
import { loadEnv } from '@openmap/config';
import { signIn } from './auth';

const env = loadEnv();
const ASSISTANT_TIMEOUT_MS = 120_000;
const screenshotsDir = fileURLToPath(new URL('./screenshots/', import.meta.url));

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

  // REQ-IPAM-004 (T-557): a top-of-rack switch found by search lists its ports; a port opens its history; a MAC in Cisco
  // notation is looked up in canonical form and answered (sightings, or that it has not been seen).
  await page.getByRole('button', { name: translate(locale, 'ipam.tab.ports') }).click();
  const ports = page.getByTestId('switch-ports');
  await ports.getByRole('searchbox', { name: translate(locale, 'ipam.ports.search') }).fill('tor');
  const device = ports.getByRole('combobox', { name: translate(locale, 'ipam.ports.device'), exact: true });
  await expect(device.locator('option').nth(1)).toBeAttached();
  const firstSwitch = await device.locator('option').nth(1).getAttribute('value');
  await device.selectOption(firstSwitch ?? '');
  const table = ports.getByRole('table');
  await expect(table.getByRole('row').nth(1)).toBeVisible();
  await expect(
    ports.getByRole('group', {
      name: new RegExp(translate(locale, 'ipam.ports.summary', { device: '' }).trim()),
    }),
  ).toBeVisible();
  await table.getByRole('row').nth(1).getByRole('button').first().click();
  await expect(ports.getByTestId('port-history')).toBeVisible();
  const lookup = ports.getByRole('form', { name: translate(locale, 'ipam.ports.mac.title') });
  await lookup.getByLabel(translate(locale, 'ipam.ports.mac.label')).fill('0050.5600.0001');
  await lookup.getByRole('button', { name: translate(locale, 'ipam.ports.mac.find') }).click();
  await expect(
    ports
      .getByRole('list', { name: translate(locale, 'ipam.ports.mac.results', { mac: '00:50:56:00:00:01' }) })
      .or(ports.getByText(translate(locale, 'ipam.ports.mac.none', { mac: '00:50:56:00:00:01' }))),
  ).toBeVisible();
  await page.screenshot({ path: screenshotsDir + 'ipam-switch-ports-' + locale + '.png', fullPage: true });

  // REQ-IPAM-005 (T-561): a firewall's rules in order with their findings and policy objects; a connection checked
  // across every firewall answers per device with the deciding rule.
  await page.getByRole('button', { name: translate(locale, 'ipam.tab.firewall') }).click();
  const fw = page.getByTestId('firewall');
  const fwDevice = fw.getByRole('combobox', { name: translate(locale, 'ipam.fw.device'), exact: true });
  await expect(fwDevice.locator('option').nth(1)).toBeAttached();
  await fwDevice.selectOption((await fwDevice.locator('option').nth(1).getAttribute('value')) ?? '');
  await expect(
    fw.getByRole('group', { name: new RegExp(translate(locale, 'ipam.fw.summary', { device: '' }).trim()) }),
  ).toBeVisible();
  const rules = fw.getByRole('table', {
    name: new RegExp(translate(locale, 'ipam.fw.rules.title', { device: '' }).trim()),
  });
  await expect(rules.getByRole('row').nth(1)).toBeVisible();
  await expect(
    fw
      .getByRole('table', { name: translate(locale, 'ipam.fw.objects.title') })
      .getByRole('row')
      .nth(1),
  ).toBeVisible();
  const fwCheck = fw.getByRole('form', { name: translate(locale, 'ipam.fw.check.title') });
  await fwCheck.getByLabel(translate(locale, 'ipam.fw.check.source')).fill('10.1.0.5');
  await fwCheck.getByLabel(translate(locale, 'ipam.fw.check.destination')).fill('10.2.0.5');
  await fwCheck.getByLabel(translate(locale, 'ipam.fw.check.port')).fill('443');
  await fwCheck.getByLabel(translate(locale, 'ipam.fw.check.fromZone')).fill('trust');
  await fwCheck.getByLabel(translate(locale, 'ipam.fw.check.toZone')).fill('dmz');
  await fwCheck.getByRole('button', { name: translate(locale, 'ipam.fw.check.run') }).click();
  await expect(
    fw
      .getByRole('list', { name: translate(locale, 'ipam.fw.check.results') })
      .getByRole('listitem')
      .first(),
  ).toBeVisible();
  await page.screenshot({ path: screenshotsDir + 'ipam-firewall-' + locale + '.png', fullPage: true });
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
  // REQ-DCIM-007: the Capacity tab shows the room's four figures, the trend, the what-fits form and the rack table.
  await page
    .getByRole('group', { name: translate(locale, 'dcim.views') })
    .getByRole('button', { name: translate(locale, 'dcim.view.capacity') })
    .click();
  await expect(page.getByRole('group', { name: translate(locale, 'dcim.capacity.figures') })).toBeVisible({
    timeout: ASSISTANT_TIMEOUT_MS,
  });
  await expect(page.getByTestId('dcim-capacity-table').getByRole('row').nth(1)).toBeVisible();
  const fit = page.getByTestId('dcim-capacity-fit');
  await fit.getByLabel(translate(locale, 'dcim.capacity.fit.heightU')).fill('4');
  await expect(fit.getByRole('status')).toBeVisible();
  await page.screenshot({ path: screenshotsDir + 'dcim-capacity-' + locale + '.png', fullPage: true });
  // REQ-DCIM-008: the Cabling tab judges recorded cables against observed adjacencies and lists the undocumented links.
  await page
    .getByRole('group', { name: translate(locale, 'dcim.views') })
    .getByRole('button', { name: translate(locale, 'dcim.view.cabling') })
    .click();
  const verification = page.getByTestId('cable-verification');
  await expect(
    verification.getByRole('group', { name: translate(locale, 'dcim.cabling.verify.title') }),
  ).toBeVisible({ timeout: ASSISTANT_TIMEOUT_MS });
  await expect(
    verification
      .getByRole('table', { name: translate(locale, 'dcim.cabling.verify.undocumentedTitle') })
      .getByRole('row')
      .nth(1),
  ).toBeVisible();
  const download = page.waitForEvent('download');
  await verification.getByRole('button', { name: translate(locale, 'dcim.cabling.verify.labels') }).click();
  expect((await download).suggestedFilename()).toBe('openmap-cable-labels.csv');
  await page.screenshot({ path: screenshotsDir + 'dcim-cabling-verify-' + locale + '.png', fullPage: true });
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
  // REQ-INT-009 (T-566): a test message is queued for the BSM engine, or the deployment's outbound policy refuses it.
  await panel.getByRole('button', { name: translate(locale, 'integrations.notify.test') }).click();
  await expect(
    panel
      .getByText(translate(locale, 'integrations.notify.sent'))
      .or(panel.getByText(translate(locale, 'integrations.notify.failed')))
      .first(),
  ).toBeVisible({ timeout: 20_000 });
  await page.screenshot({ path: screenshotsDir + 'integrations-notify-' + locale + '.png', fullPage: true });
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
  // REQ-AI-008: exact, because "Conversation" is also a substring of the "Past conversations" list beside the thread.
  const conversation = page.getByRole('list', {
    name: translate(locale, 'assistant.conversation'),
    exact: true,
  });
  await expect(conversation.getByText(translate(locale, 'assistant.example.hosts'))).toBeVisible();
  // REQ-AI-007 (ADR-028): an answer carries its evidence and follow-ups; a count question also shows figures.
  const answered = conversation.getByTestId('assistant-evidence');
  const refused = conversation.getByRole('alert');
  await expect(answered.or(refused).first()).toBeVisible({ timeout: ASSISTANT_TIMEOUT_MS });
  const outcome =
    (await answered.count()) > 0 ? 'answered' : 'refused: ' + ((await refused.first().textContent()) ?? '');
  testInfo.annotations.push({ type: 'assistant', description: outcome });
  if ((await answered.count()) > 0) {
    await expect(
      conversation.getByRole('group', { name: translate(locale, 'assistant.figures') }),
    ).toBeVisible();
    await expect(conversation.getByTestId('assistant-followups')).toBeVisible();
    await conversation.getByTestId('assistant-evidence').locator('summary').click();
  }
  await page.screenshot({ path: screenshotsDir + 'assistant-answered-' + locale + '.png', fullPage: true });
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
