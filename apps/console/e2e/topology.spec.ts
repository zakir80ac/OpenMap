// T-156 REQ-DEP-001 (ADR-030) — the network topology map against the live stack, per locale project: the Dependencies
// screen switches to the topology view, the L2 map draws the synthetic estate's devices with their LLDP neighbour
// links, the host toggle adds the attached servers (the node count grows), and the
// L3 layer joins devices to subnets. Screenshots are the evidence (docs/evidence/network-topology.md).
import { fileURLToPath } from 'node:url';
import { expect, test } from '@playwright/test';
import { isLocale, translate, type Locale } from '@openmap/i18n';
import { signIn } from './auth';

const PAINT_TIMEOUT_MS = 60_000;
const screenshotsDir = fileURLToPath(new URL('./screenshots/', import.meta.url));

function localeOf(name: string): Locale {
  if (!isLocale(name)) throw new Error('project name must be a locale: ' + name);
  return name;
}

function count(text: string | null): number {
  const digits = (text ?? '').match(/[0-9٠-٩,٬]+/)?.[0] ?? '0';
  return Number(digits.replace(/[,٬]/g, '').replace(/[٠-٩]/g, (d) => String(d.charCodeAt(0) - 0x0660)));
}

test('Dependencies: the network topology map at layer 2 and layer 3 (REQ-DEP-001)', async ({ page }, testInfo) => {
  const locale = localeOf(testInfo.project.name);
  test.setTimeout(PAINT_TIMEOUT_MS * 4);
  await page.goto('/' + locale + '/dependencies');
  await signIn(page, locale);
  await page.getByRole('radiogroup', { name: translate(locale, 'dependencies.view.label') }).getByRole('radio', { name: translate(locale, 'dependencies.view.topology') }).click();
  await expect(page).toHaveURL(/view=topology/);
  const view = page.getByTestId('topology-view');
  const stats = view.getByRole('toolbar', { name: translate(locale, 'topology.toolbar') }).getByRole('status');
  await expect(stats).toBeVisible({ timeout: PAINT_TIMEOUT_MS });
  const l2Nodes = count(await stats.textContent());
  expect(l2Nodes).toBeGreaterThan(0);
  await expect(view.getByRole('img', { name: translate(locale, 'topology.canvas', { layer: translate(locale, 'topology.layer.l2') }) })).toBeVisible({ timeout: PAINT_TIMEOUT_MS });
  await page.screenshot({ path: screenshotsDir + 'topology-l2-' + locale + '.png', fullPage: true });

  // The checkbox follows the URL, so it flips once the navigation lands.
  await view.getByRole('checkbox', { name: translate(locale, 'topology.hosts') }).click();
  await expect(page).toHaveURL(/hosts=1/);
  await expect(view.getByRole('checkbox', { name: translate(locale, 'topology.hosts') })).toBeChecked();
  await expect.poll(async () => count(await stats.textContent()), { timeout: PAINT_TIMEOUT_MS }).toBeGreaterThan(l2Nodes);

  await view.getByRole('radiogroup', { name: translate(locale, 'topology.layer.label') }).getByRole('radio', { name: translate(locale, 'topology.layer.l3') }).click();
  await expect(page).toHaveURL(/tlayer=l3/);
  await expect(view.getByRole('img', { name: translate(locale, 'topology.canvas', { layer: translate(locale, 'topology.layer.l3') }) })).toBeVisible({ timeout: PAINT_TIMEOUT_MS });
  await expect.poll(async () => count(await stats.textContent()), { timeout: PAINT_TIMEOUT_MS }).toBeGreaterThan(0);
  await page.screenshot({ path: screenshotsDir + 'topology-l3-' + locale + '.png', fullPage: true });
});
