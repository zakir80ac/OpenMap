// REQ-UI-013 REQ-BSM-003 — Impact modeling route: component × condition scenarios run through saveScenario and runSimulation.
import type { Metadata } from 'next';
import type { ReactNode } from 'react';
import { ImpactView } from '@/components/impact/ImpactView';
import { getT, requireLocale } from '@/lib/i18n';

interface PageProps {
  params: Promise<{ locale: string }>;
}

export async function generateMetadata({ params }: PageProps): Promise<Metadata> {
  const t = getT(await requireLocale(params));
  return { title: t('nav.impact') };
}

export default async function ImpactPage({ params }: PageProps): Promise<ReactNode> {
  const locale = await requireLocale(params);
  return <ImpactView locale={locale} />;
}
