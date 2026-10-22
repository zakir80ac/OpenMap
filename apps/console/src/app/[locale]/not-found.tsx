'use client';
// REQ-UI-003 — locale-aware not-found for unknown routes under a valid locale. Public: it renders outside the shell
// and the sign-in gate, so a mistyped address never asks for credentials first.
import Link from 'next/link';
import type { ReactNode } from 'react';
import { localizedHref } from '@/lib/locale-path';
import { useLocale, useT } from '@/providers';

export default function LocaleNotFound(): ReactNode {
  const t = useT();
  const locale = useLocale();
  return (
    <main className="grid min-h-dvh place-items-center px-om-24 py-om-32">
      <section className="flex flex-col items-start gap-om-16">
        <h1 className="font-om-display text-om-xl font-semibold text-om-primary">{t('common.notFound')}</h1>
        <Link href={localizedHref(locale, '/dashboard')} className="text-om-cyan underline-offset-4 hover:underline">
          {t('common.backToDashboard')}
        </Link>
      </section>
    </main>
  );
}
