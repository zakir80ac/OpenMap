// REQ-UI-029 — Digital twin route: the estate in real 3D with the focus CI's dependency layers (ADR-018).
import type { Metadata } from 'next';
import { Suspense, type ReactNode } from 'react';
import { QueryState } from '@/components/common/QueryState';
import { TwinView } from '@/components/twin/TwinView';
import { getT, requireLocale } from '@/lib/i18n';

interface PageProps {
  params: Promise<{ locale: string }>;
}

export async function generateMetadata({ params }: PageProps): Promise<Metadata> {
  const t = getT(await requireLocale(params));
  return { title: t('nav.twin') };
}

export default async function TwinPage({ params }: PageProps): Promise<ReactNode> {
  const locale = await requireLocale(params);
  return (
    <Suspense fallback={<QueryState status="pending" />}>
      <TwinView locale={locale} />
    </Suspense>
  );
}
