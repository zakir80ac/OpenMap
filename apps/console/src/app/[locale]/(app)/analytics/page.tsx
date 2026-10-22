// REQ-UI-017 — Analytics: embedded Superset with tenant row-level security route.
import type { Metadata } from 'next';
import type { ReactNode } from 'react';
import { AnalyticsView } from '@/components/analytics/AnalyticsView';
import { getT, requireLocale } from '@/lib/i18n';

interface PageProps {
  params: Promise<{ locale: string }>;
}

export async function generateMetadata({ params }: PageProps): Promise<Metadata> {
  const t = getT(await requireLocale(params));
  return { title: t('nav.analytics') };
}

export default async function AnalyticsPage({ params }: PageProps): Promise<ReactNode> {
  const locale = await requireLocale(params);
  return <AnalyticsView locale={locale} />;
}
