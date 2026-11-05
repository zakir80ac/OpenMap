// REQ-UI-012 REQ-BSM-006 REQ-BSM-008 — Business service detail route: SLA, uptime by period and incidents of one service.
import type { Metadata } from 'next';
import type { ReactNode } from 'react';
import { ServiceDetailView } from '@/components/services/ServiceDetailView';
import { getT, requireLocale } from '@/lib/i18n';

interface PageProps {
  params: Promise<{ locale: string; id: string }>;
}

export async function generateMetadata({ params }: PageProps): Promise<Metadata> {
  const t = getT(await requireLocale(params));
  return { title: t('services.detail.title') };
}

export default async function ServiceDetailPage({ params }: PageProps): Promise<ReactNode> {
  const locale = await requireLocale(params);
  const { id } = await params;
  return <ServiceDetailView locale={locale} id={decodeURIComponent(id)} />;
}
