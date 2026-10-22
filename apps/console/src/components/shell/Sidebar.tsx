'use client';
// REQ-UI-003 — 232px glass sidebar: brand, grouped navigation with active glow, live state at the foot.
import Link from 'next/link';
import { usePathname } from 'next/navigation';
import type { Locale } from '@openmap/i18n';
import { Dot, cx } from '@openmap/ui';
import type { ReactNode } from 'react';
import { Icon } from '@/components/icons';
import { localizedHref, splitLocale } from '@/lib/locale-path';
import { useT } from '@/providers';
import { NAV_GROUPS, isActiveRoute } from './nav';

export interface SidebarProps {
  locale: Locale;
}

const itemBase =
  'group flex items-center gap-om-10 rounded-om-control-md border border-transparent px-om-10 py-om-8 text-om-sm font-medium text-om-secondary transition-[color,background-color,box-shadow] duration-om-base ease-om-standard hover:bg-om-surface2 hover:text-om-primary';
const itemActive = 'border-om-cyan/30 bg-om-cyan/10 text-om-primary shadow-om-glow-nav-cyan';

export function Sidebar({ locale }: SidebarProps): ReactNode {
  const t = useT();
  const pathname = usePathname();
  const { rest } = splitLocale(pathname);
  return (
    <aside className="sticky top-0 flex h-dvh w-(--om-sidebar-width) shrink-0 flex-col border-e border-om-border-glass bg-om-surface1/70 shadow-om-inner-highlight backdrop-blur-md">
      <Link
        href={localizedHref(locale, '/dashboard')}
        className="flex h-(--om-topbar-height) items-center gap-om-10 border-b border-om-border-glass px-om-18"
      >
        <span
          aria-hidden="true"
          className="grid size-8 place-items-center rounded-om-control-lg bg-linear-to-br from-om-cyan to-om-violet text-om-ground shadow-om-glow-button-cyan"
        >
          <Icon name="layers" className="size-4" />
        </span>
        <span className="font-om-display text-om-md font-bold tracking-tight text-om-primary">{t('app.name')}</span>
      </Link>

      <nav aria-label={t('nav.primary')} className="flex flex-1 flex-col gap-om-16 overflow-y-auto px-om-12 py-om-16">
        {NAV_GROUPS.map((group, index) => (
          <div key={group.key ?? String(index)} className={cx('flex flex-col gap-om-4', group.key === undefined && index > 0 && 'mt-auto')}>
            {group.key !== undefined ? (
              <p className="px-om-10 pb-om-4 text-om-2xs font-semibold uppercase tracking-[0.08em] text-om-muted">{t(group.key)}</p>
            ) : null}
            {group.items.map((item) => {
              const active = isActiveRoute(rest, item.href);
              return (
                <Link
                  key={item.href}
                  href={localizedHref(locale, item.href)}
                  aria-current={active ? 'page' : undefined}
                  className={cx(itemBase, active && itemActive)}
                >
                  <Icon name={item.icon} className={cx('size-4 shrink-0', active ? 'text-om-cyan' : 'text-om-muted group-hover:text-om-secondary')} />
                  <span className="truncate">{t(item.key)}</span>
                </Link>
              );
            })}
          </div>
        ))}
      </nav>

      <div className="flex items-center gap-om-8 border-t border-om-border-glass px-om-18 py-om-12 text-om-xs text-om-secondary">
        <Dot state="healthy" pulse />
        <span>{t('topbar.now')}</span>
      </div>
    </aside>
  );
}
