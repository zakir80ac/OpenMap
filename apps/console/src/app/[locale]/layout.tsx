// REQ-UI-003 REQ-SEC-001 — locale layout: validates the segment, sets <html lang dir>, loads the four typefaces and
// mounts the client providers (TanStack Query, direction, i18n) and the browser session (AuthProvider). The console
// shell and the sign-in gate live in the (app) group; the auth callback and the not-found page render here, public.
import type { Metadata } from 'next';
import { LOCALES, direction } from '@openmap/i18n';
import type { ReactNode } from 'react';
import { AuthProvider } from '@/lib/auth';
import { fontClassNames } from '@/lib/fonts';
import { getT, requireLocale } from '@/lib/i18n';
import { Providers } from '@/providers';
import '../globals.css';

interface LocaleLayoutProps {
  children: ReactNode;
  params: Promise<{ locale: string }>;
}

export function generateStaticParams(): Array<{ locale: string }> {
  return LOCALES.map((locale) => ({ locale }));
}

export async function generateMetadata({ params }: Pick<LocaleLayoutProps, 'params'>): Promise<Metadata> {
  const locale = await requireLocale(params);
  const t = getT(locale);
  return {
    title: { default: t('app.name'), template: '%s · ' + t('app.name') },
    description: t('app.tagline'),
  };
}

export default async function LocaleLayout({ children, params }: LocaleLayoutProps): Promise<ReactNode> {
  const locale = await requireLocale(params);
  return (
    <html lang={locale} dir={direction(locale)} className={fontClassNames}>
      <body className="min-h-dvh bg-om-ground font-om-body text-om-primary">
        <Providers locale={locale}>
          <AuthProvider locale={locale}>{children}</AuthProvider>
        </Providers>
      </body>
    </html>
  );
}
