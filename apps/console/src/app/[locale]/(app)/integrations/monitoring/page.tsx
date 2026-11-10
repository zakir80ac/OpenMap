// REQ-INT-012 (ADR-073) — Monitoring events route: alerts from the monitoring integrations, matched to CIs.
import type { Metadata } from 'next';
import type { ReactNode } from 'react';
import { MonitoringEventsView } from '@/components/integrations/MonitoringEventsView';
import { getT, requireLocale } from '@/lib/i18n';

interface PageProps {
  params: Promise<{ locale: string }>;
}

export async function generateMetadata({ params }: PageProps): Promise<Metadata> {
  const t = getT(await requireLocale(params));
  return { title: t('monitoring.title') };
}

export default async function MonitoringEventsPage({ params }: PageProps): Promise<ReactNode> {
  await requireLocale(params);
  return <MonitoringEventsView />;
}
