// T-618 REQ-PERF-005 (ADR-071) — Platform health on the live stack, per locale project: an administrator sees every SLO
// indicator from the stack's Prometheus, the OpenMap services scraped and up, the stores, the outbox and queues, and the
// perf budget section; switching the window reads the indicators again over the longer window.
import { fileURLToPath } from 'node:url';
import { expect, test } from '@playwright/test';
import { PLATFORM_HEALTH } from '@openmap/constants';
import { isLocale, translate } from '@openmap/i18n';
import { signIn } from './auth';

const screenshotsDir = fileURLToPath(new URL('./screenshots/', import.meta.url));
const SLI_COUNT = 10;

test('an administrator sees the platform watching itself', async ({ page }, testInfo) => {
  const locale = testInfo.project.name;
  if (!isLocale(locale)) throw new Error('project name must be a locale: ' + locale);
  await page.goto('/' + locale + '/platform');
  await signIn(page, locale);
  await expect(page.getByRole('heading', { level: 1, name: translate(locale, 'platform.title') })).toBeVisible();

  const slis = page.getByRole('table', { name: translate(locale, 'platform.slis.title') });
  await expect(slis.locator('tbody tr')).toHaveCount(SLI_COUNT);
  await expect(slis.locator('tr[data-sli="targets_down"]')).toHaveAttribute('data-status', 'ok');

  const targets = page.getByRole('table', { name: translate(locale, 'platform.targets.title') });
  for (const service of PLATFORM_HEALTH.services)
    await expect(targets.locator('tr[data-service="' + service + '"]').first()).toHaveAttribute('data-health', 'up');

  const stores = page.getByRole('list', { name: translate(locale, 'platform.stores.title') });
  await expect(stores.getByRole('listitem')).toHaveCount(PLATFORM_HEALTH.stores.length);
  await expect(page.getByTestId('platform-backlog')).toBeVisible();
  await expect(page.getByTestId('platform-budgets')).toBeVisible();

  const responded = page.waitForResponse((r) => r.url().includes('/graphql') && (r.request().postData() ?? '').includes('"w":60'));
  await page.getByRole('radio', { name: translate(locale, 'platform.window.60') }).click();
  await responded;
  await expect(slis.locator('tbody tr')).toHaveCount(SLI_COUNT);
  await page.screenshot({ path: screenshotsDir + 'platform-health-' + locale + '.png', fullPage: true });
});
