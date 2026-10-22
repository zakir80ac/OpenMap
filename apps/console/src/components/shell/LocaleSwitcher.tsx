'use client';
// REQ-UI-003 — locale switcher: swaps the first path segment so the same screen opens in the other language.
import Link from 'next/link';
import { usePathname } from 'next/navigation';
import { LOCALES, type Locale, type MessageKey } from '@openmap/i18n';
import { cx } from '@openmap/ui';
import type { ReactNode } from 'react';
import { Icon } from '@/components/icons';
import { withLocale } from '@/lib/locale-path';
import { useT } from '@/providers';

export interface LocaleSwitcherProps {
  locale: Locale;
}

const shortLabel = { en: 'locale.short.en', ar: 'locale.short.ar' } as const satisfies Record<Locale, MessageKey>;
const fullLabel = { en: 'locale.en', ar: 'locale.ar' } as const satisfies Record<Locale, MessageKey>;

export function LocaleSwitcher({ locale }: LocaleSwitcherProps): ReactNode {
  const t = useT();
  const pathname = usePathname();
  return (
    <nav aria-label={t('locale.switch')} className="flex items-center gap-om-4 rounded-om-pill border border-om-border-strong bg-om-surface3 p-om-4">
      <Icon name="globe" className="ms-om-4 size-3.5 text-om-muted" />
      {LOCALES.map((candidate) => {
        const current = candidate === locale;
        return (
          <Link
            key={candidate}
            href={withLocale(pathname, candidate)}
            hrefLang={candidate}
            lang={candidate}
            aria-current={current ? 'true' : undefined}
            aria-label={t(fullLabel[candidate])}
            className={cx(
              'rounded-om-pill px-om-8 py-om-4 text-om-2xs font-semibold leading-none transition-colors duration-om-base ease-om-standard',
              current ? 'bg-om-cyan/15 text-om-cyan' : 'text-om-secondary hover:text-om-primary',
            )}
          >
            {t(shortLabel[candidate])}
          </Link>
        );
      })}
    </nav>
  );
}
