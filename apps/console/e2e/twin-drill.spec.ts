// T-662 REQ-UI-037 — the twin's drill-down on the real stack, per locale project: a rack is opened (from the picker, as
// a keyboard user would) and a server in it is drilled into. Its sections come from the replayed estate: hardware
// components, its operating system and software, network, the business services it supports through the graph and its
// place. One more level down follows the operating system, the breadcrumb comes back to the rack, and both levels are
// captured as evidence. Not every racked host supports a business service, so the test tries hosts until one does.
import { fileURLToPath } from 'node:url';
import { expect, test, type Locator, type Page } from '@playwright/test';
import { isLocale, translate, type Locale } from '@openmap/i18n';
import { signIn } from './auth';

const screenshotsDir = fileURLToPath(new URL('./screenshots/', import.meta.url));
const PAINT_TIMEOUT_MS = 30_000;
/** Racks and hosts per rack tried before giving up on a server that supports a business service. */
const RACKS_TRIED = 12;
const HOSTS_PER_RACK = 4;
/** A rack's device row names the device's CI type; a server is a host. */
const SERVER_TYPE = /^host$/u;

function panelOf(page: Page, locale: Locale): Locator {
  return page.getByRole('complementary', { name: translate(locale, 'twin.panel.title') });
}

/** Drills into racked hosts until one lists the business services it supports; leaves that host drilled. */
async function drillIntoServiceHost(page: Page, locale: Locale): Promise<string> {
  const panel = panelOf(page, locale);
  const picker = panel.getByLabel(translate(locale, 'twin.drill.pickRack'));
  await expect(picker).toBeVisible({ timeout: PAINT_TIMEOUT_MS });
  const racks = (await picker.locator('option').evaluateAll((options) => options.map((o) => (o as HTMLOptionElement).value))).filter((v) => v !== '');
  expect(racks.length).toBeGreaterThan(0);
  const trail = panel.getByRole('navigation', { name: translate(locale, 'twin.drill.trail') });
  for (const rack of racks.slice(0, RACKS_TRIED)) {
    await picker.selectOption(rack);
    const devices = panel.getByRole('list', { name: translate(locale, 'twin.rack.devices') });
    await expect(devices).toBeVisible();
    const hosts = devices.getByRole('button').filter({ has: page.locator('span', { hasText: SERVER_TYPE }) });
    const count = Math.min(await hosts.count(), HOSTS_PER_RACK);
    for (let i = 0; i < count; i += 1) {
      const host = hosts.nth(i);
      const name = (await host.locator('span').nth(1).textContent()) ?? '';
      await host.click();
      const level = panel.getByTestId('twin-drill-level');
      await expect(level).toHaveAttribute('aria-busy', 'false', { timeout: PAINT_TIMEOUT_MS });
      if ((await level.getByRole('region', { name: translate(locale, 'twin.drill.section.services') }).count()) > 0) return name;
      // Back to the rack for the next host.
      await trail.getByRole('button').first().click();
      await expect(devices).toBeVisible();
    }
    // Close the rack: the picker shows again once nothing is selected.
    await page.goto('/' + locale + '/twin');
    await expect(picker).toBeVisible({ timeout: PAINT_TIMEOUT_MS });
  }
  throw new Error('no racked host among those tried supports a business service');
}

test('a rack drills down to a server and on through what it runs, serves and connects to', async ({ page }, testInfo) => {
  const locale = testInfo.project.name;
  if (!isLocale(locale)) throw new Error('project name must be a locale: ' + locale);
  test.setTimeout(PAINT_TIMEOUT_MS * (RACKS_TRIED + 4));

  await page.goto('/' + locale + '/twin');
  await signIn(page, locale);
  const serverName = await drillIntoServiceHost(page, locale);

  const panel = panelOf(page, locale);
  const level = panel.getByTestId('twin-drill-level');
  await expect(level.getByText(serverName, { exact: true }).first()).toBeVisible();
  // A racked host of the replayed estate: its BMC, OS and installed software, listening services, cabled interfaces and
  // an address, the services it supports, and its power and rack (a hypervisor host also lists its VMs under compute).
  for (const key of ['components', 'os', 'applications', 'services', 'network', 'place'] as const) {
    await expect(level.getByRole('region', { name: translate(locale, `twin.drill.section.${key}`) }), key).toBeVisible();
  }
  const trail = panel.getByRole('navigation', { name: translate(locale, 'twin.drill.trail') });
  await expect(trail.getByRole('listitem')).toHaveCount(2);
  await expect(page.getByRole('alert').filter({ hasText: translate(locale, 'common.error') })).toHaveCount(0);
  await page.screenshot({ path: screenshotsDir + 'twin-drill-server-' + locale + '.png', fullPage: false });

  // One level further: the operating system, with what is installed on it.
  const os = level.getByRole('region', { name: translate(locale, 'twin.drill.section.os') });
  await os.getByRole('button').first().click();
  await expect(trail.getByRole('listitem')).toHaveCount(3);
  const next = panel.getByTestId('twin-drill-level');
  await expect(next).toHaveAttribute('aria-busy', 'false', { timeout: PAINT_TIMEOUT_MS });
  await expect(next.getByRole('region').first()).toBeVisible();
  await page.screenshot({ path: screenshotsDir + 'twin-drill-os-' + locale + '.png', fullPage: false });

  // The breadcrumb returns to the rack.
  await trail.getByRole('button').first().click();
  await expect(panel.getByRole('list', { name: translate(locale, 'twin.rack.devices') })).toBeVisible();
});
