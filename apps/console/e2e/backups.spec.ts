// T-571 REQ-INT-019 (ADR-066) — backups on the live stack, per locale project: an administrator's Settings screen shows
// the Backups card with its freshness and the sets the backup service wrote to the backup volume (the compose `backup`
// service is run before this suite; with no set yet the card says so).
import { fileURLToPath } from 'node:url';
import { expect, test } from '@playwright/test';
import { isLocale, translate } from '@openmap/i18n';
import { signIn } from './auth';

const screenshotsDir = fileURLToPath(new URL('./screenshots/', import.meta.url));

test('an administrator sees the backup sets and whether the newest is recent enough', async ({
  page,
}, testInfo) => {
  const locale = testInfo.project.name;
  if (!isLocale(locale)) throw new Error('project name must be a locale: ' + locale);
  await page.goto('/' + locale + '/settings');
  await signIn(page, locale);
  const freshness = page.getByTestId('backup-freshness');
  await expect(freshness).toBeVisible();
  await expect(
    freshness
      .getByText(translate(locale, 'settings.backups.fresh'))
      .or(
        freshness.getByText(
          translate(locale, 'settings.backups.stale', { hours: new Intl.NumberFormat(locale).format(26) }),
        ),
      )
      .first(),
  ).toBeVisible();
  const table = page.getByRole('table', { name: translate(locale, 'settings.backups.title') });
  await expect(
    table
      .getByRole('row')
      .nth(1)
      .or(page.getByText(translate(locale, 'settings.backups.none')))
      .first(),
  ).toBeVisible();
  await table.scrollIntoViewIfNeeded().catch(() => undefined);
  await page.screenshot({ path: screenshotsDir + 'settings-backups-' + locale + '.png', fullPage: true });
});
