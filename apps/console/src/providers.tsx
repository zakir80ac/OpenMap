'use client';
// REQ-UI-003 — client providers: TanStack Query, the design-system direction context and the i18n context behind useT().
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { TIME } from '@openmap/constants';
import { createTranslator, type Locale, type MessageKey, type Params } from '@openmap/i18n';
import { DirectionProvider } from '@openmap/ui';
import { createContext, useContext, useMemo, useState, type ReactNode } from 'react';
import { createFormatters, type Formatters } from '@/lib/format';

export type Translate = (key: MessageKey, params?: Params) => string;

interface I18nValue {
  locale: Locale;
  t: Translate;
  format: Formatters;
}

const I18nContext = createContext<I18nValue | undefined>(undefined);

export function I18nProvider({ locale, children }: { locale: Locale; children: ReactNode }): ReactNode {
  const value = useMemo<I18nValue>(
    () => ({ locale, t: createTranslator(locale), format: createFormatters(locale) }),
    [locale],
  );
  return <I18nContext.Provider value={value}>{children}</I18nContext.Provider>;
}

export function useI18n(): I18nValue {
  const value = useContext(I18nContext);
  if (value === undefined) throw new Error('useI18n must be used inside I18nProvider');
  return value;
}

export function useT(): Translate {
  return useI18n().t;
}

export function useLocale(): Locale {
  return useI18n().locale;
}

export function useFormatters(): Formatters {
  return useI18n().format;
}

/** Query results stay fresh for a minute: discovery sweeps run far slower than that, so refetching sooner only costs requests. */
const STALE_MS = TIME.msPerSecond * TIME.secondsPerMinute;

export function Providers({ locale, children }: { locale: Locale; children: ReactNode }): ReactNode {
  const [client] = useState(
    () =>
      new QueryClient({
        defaultOptions: {
          queries: { staleTime: STALE_MS, retry: 1, refetchOnWindowFocus: false },
        },
      }),
  );
  return (
    <QueryClientProvider client={client}>
      <DirectionProvider locale={locale}>
        <I18nProvider locale={locale}>{children}</I18nProvider>
      </DirectionProvider>
    </QueryClientProvider>
  );
}
