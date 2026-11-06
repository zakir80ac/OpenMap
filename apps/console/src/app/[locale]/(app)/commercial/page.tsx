// REQ-CMDB-026 REQ-CMDB-027 REQ-CMDB-028 REQ-CMDB-029 — Commercial: contracts, vendors and cost centres (ADR-035).
import type { Metadata } from 'next';
import type { ReactNode } from 'react';
import { CommercialView } from '@/components/commercial/CommercialView';
import { getT, requireLocale } from '@/lib/i18n';

interface PageProps {
  params: Promise<{ locale: string }>;
}

export async function generateMetadata({ params }: PageProps): Promise<Metadata> {
  const t = getT(await requireLocale(params));
  return { title: t('nav.commercial') };
}

export default async function CommercialPage({ params }: PageProps): Promise<ReactNode> {
  const locale = await requireLocale(params);
  return <CommercialView locale={locale} />;
}
