// T-501 REQ-AI-002 — suggested classifications on the Layers screen against the real stack, per locale project:
// - the synthetic estate's port-scan finds (cameras, printers, UPS cards …) are listed with a class, a layer and the
//   evidence behind it, and the summary shows the open count and the acceptance rate;
// - a UPS management card is suggested as type ups in the facilities layer;
// - no error card appears. Accepting and dismissing are covered against a tenant of their own (T-499), so this test
//   leaves the shared estate as it found it.
import { fileURLToPath } from 'node:url';
import { expect, test } from '@playwright/test';
import { isLocale, translate } from '@openmap/i18n';
import { signIn } from './auth';

const screenshotsDir = fileURLToPath(new URL('./screenshots/', import.meta.url));
const LOAD_MS = 60_000;

test('the Layers screen suggests classifications for unknown CIs', async ({ page }, testInfo) => {
  const locale = testInfo.project.name;
  if (!isLocale(locale)) throw new Error('project name must be a locale: ' + locale);
  test.setTimeout(LOAD_MS * 3);

  await page.goto('/' + locale + '/layers');
  await signIn(page, locale);
  const panel = page.getByRole('region', { name: translate(locale, 'classify.title') });
  const list = panel.getByRole('list', { name: translate(locale, 'classify.list') });
  await expect(list.getByRole('listitem').first()).toBeVisible({ timeout: LOAD_MS });
  const summary = panel.getByRole('group', { name: translate(locale, 'classify.summary') });
  await expect(summary.getByText(translate(locale, 'classify.summary.rate'))).toBeVisible();

  const ups = list.getByRole('listitem').filter({ hasText: translate(locale, 'classify.class.ups_management') }).first();
  await expect(ups).toBeVisible();
  await expect(ups.getByText(translate(locale, 'classify.type', { type: 'ups' }))).toBeVisible();
  await expect(ups.getByText(translate(locale, 'layer.dc'), { exact: true })).toBeVisible();
  await expect(ups.getByLabel(translate(locale, 'classify.evidence')).getByText(new RegExp('^' + translate(locale, 'classify.signal.sysDescr') + ': '))).toBeVisible();
  for (const deviceClass of ['network_camera', 'printer'] as const)
    await expect(list.getByText(translate(locale, ('classify.class.' + deviceClass) as `classify.class.${typeof deviceClass}`), { exact: true }).first()).toBeVisible();
  await expect(page.getByRole('alert').filter({ hasText: translate(locale, 'common.error') })).toHaveCount(0);
  await panel.screenshot({ path: screenshotsDir + 'classification-' + locale + '.png' });
});
