'use client';
// REQ-UI-003 REQ-SEC-001 — 64px top bar: global search with the `/` shortcut, time-travel state, site scope, locale
// switcher and the account menu (identity, tenant, roles, sign out).
import type { Locale } from '@openmap/i18n';
import { Pill } from '@openmap/ui';
import type { ReactNode } from 'react';
import { Icon } from '@/components/icons';
import { useT } from '@/providers';
import { GlobalSearch } from './GlobalSearch';
import { LocaleSwitcher } from './LocaleSwitcher';
import { UserMenu } from './UserMenu';

export interface TopBarProps {
  locale: Locale;
}

export function TopBar({ locale }: TopBarProps): ReactNode {
  const t = useT();
  return (
    <header className="sticky top-0 z-10 flex h-(--om-topbar-height) shrink-0 items-center gap-om-12 border-b border-om-border-glass bg-om-ground/70 px-om-24 backdrop-blur-md after:pointer-events-none after:absolute after:inset-x-0 after:bottom-0 after:h-px after:bg-linear-to-r after:from-transparent after:via-om-cyan/50 after:to-transparent">
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
        <UserMenu />
      </div>
    </header>
  );
}
