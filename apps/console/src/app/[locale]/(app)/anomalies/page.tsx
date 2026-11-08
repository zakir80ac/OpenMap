// REQ-AI-003 (ADR-053) — Anomalies route: the findings of the rules over discovery and health events.
import type { Metadata } from 'next';
import type { ReactNode } from 'react';
import { AnomaliesView } from '@/components/anomalies/AnomaliesView';
import { getT, requireLocale } from '@/lib/i18n';

interface PageProps {
  params: Promise<{ locale: string }>;
}

export async function generateMetadata({ params }: PageProps): Promise<Metadata> {
  const t = getT(await requireLocale(params));
  return { title: t('nav.anomalies') };
}

export default async function AnomaliesPage({ params }: PageProps): Promise<ReactNode> {
  const locale = await requireLocale(params);
  return <AnomaliesView locale={locale} />;
}
