// REQ-UI-008 REQ-CMDB-037 — CI detail route: header, Overview / Relationships / Impact / History tabs over `ci(id, asOf)`.
import type { Metadata } from 'next';
import type { ReactNode } from 'react';
import { CiDetailView } from '@/components/cmdb/CiDetailView';
import { getT, requireLocale } from '@/lib/i18n';

interface PageProps {
  params: Promise<{ locale: string; id: string }>;
}

export async function generateMetadata({ params }: PageProps): Promise<Metadata> {
  const t = getT(await requireLocale(params));
  return { title: t('nav.cmdb') };
}

export default async function CiDetailPage({ params }: PageProps): Promise<ReactNode> {
  const locale = await requireLocale(params);
  const { id } = await params;
  return <CiDetailView locale={locale} id={decodeURIComponent(id)} />;
}
