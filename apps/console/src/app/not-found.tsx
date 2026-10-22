// REQ-UI-003 — global not-found, reached only when the locale segment itself is invalid. The root layout renders no
// <html>, so this page renders its own document in the configured default locale.
import { loadEnv } from '@openmap/config';
import { direction } from '@openmap/i18n';
import type { ReactNode } from 'react';
import { getT } from '@/lib/i18n';
import { localizedHref } from '@/lib/locale-path';
import './globals.css';

export default function GlobalNotFound(): ReactNode {
  const locale = loadEnv().DEFAULT_LOCALE;
  const t = getT(locale);
  return (
    <html lang={locale} dir={direction(locale)}>
      <body className="flex min-h-dvh items-center justify-center bg-om-ground text-om-primary">
        <main className="flex flex-col items-center gap-om-16 p-om-32 text-center">
          <h1 className="font-om-display text-om-xl font-semibold">{t('common.notFound')}</h1>
          <a href={localizedHref(locale, '/dashboard')} className="text-om-cyan underline-offset-4 hover:underline">
            {t('common.backToDashboard')}
          </a>
        </main>
      </body>
    </html>
  );
}
