'use client';
// REQ-UI-003 — 64px top bar: global search with the `/` shortcut, time-travel state, site scope, locale switcher, avatar.
import type { Locale } from '@openmap/i18n';
import { Pill } from '@openmap/ui';
import type { ReactNode } from 'react';
import { Icon } from '@/components/icons';
import { useT } from '@/providers';
import { GlobalSearch } from './GlobalSearch';
import { LocaleSwitcher } from './LocaleSwitcher';

export interface TopBarProps {
  locale: Locale;
}

export function TopBar({ locale }: TopBarProps): ReactNode {
  const t = useT();
  const user = t('topbar.user');
  return (
    <header className="sticky top-0 z-10 flex h-(--om-topbar-height) shrink-0 items-center gap-om-12 border-b border-om-border-glass bg-om-ground/70 px-om-24 backdrop-blur-md">
      <GlobalSearch locale={locale} />

      <div className="ms-auto flex items-center gap-om-10">
        <span role="status" aria-label={t('topbar.timeTravel')}>
          <Pill variant="time-travel" icon={<Icon name="clock" className="size-3.5" />}>
            {t('topbar.now')}
          </Pill>
        </span>
        <span role="status" aria-label={t('topbar.siteSwitcher')}>
          <Pill icon={<Icon name="site" className="size-3.5" />}>{t('topbar.allSites')}</Pill>
        </span>
        <LocaleSwitcher locale={locale} />
        <span
          role="img"
          aria-label={t('topbar.account')}
          className="grid size-8 place-items-center rounded-om-pill border border-om-border-strong bg-om-surface2 font-om-display text-om-xs font-bold text-om-primary"
        >
          {user.charAt(0)}
        </span>
      </div>
    </header>
  );
}
