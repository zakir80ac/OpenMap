'use client';
// REQ-UI-003 — locale-aware not-found rendered inside the shell for unknown routes under a valid locale.
import Link from 'next/link';
import type { ReactNode } from 'react';
import { localizedHref } from '@/lib/locale-path';
import { useLocale, useT } from '@/providers';

export default function LocaleNotFound(): ReactNode {
  const t = useT();
  const locale = useLocale();
  return (
    <section className="flex flex-col items-start gap-om-16 py-om-32">
      <h1 className="font-om-display text-om-xl font-semibold text-om-primary">{t('common.notFound')}</h1>
      <Link href={localizedHref(locale, '/dashboard')} className="text-om-cyan underline-offset-4 hover:underline">
        {t('common.backToDashboard')}
      </Link>
    </section>
  );
}
