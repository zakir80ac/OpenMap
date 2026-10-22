// REQ-UI-012 REQ-BSM-002 — Business services route: propagated health, SLA budgets, root causes and open incidents.
import type { Metadata } from 'next';
import type { ReactNode } from 'react';
import { ServicesView } from '@/components/services/ServicesView';
import { getT, requireLocale } from '@/lib/i18n';

interface PageProps {
  params: Promise<{ locale: string }>;
}

export async function generateMetadata({ params }: PageProps): Promise<Metadata> {
  const t = getT(await requireLocale(params));
  return { title: t('nav.services') };
}

export default async function ServicesPage({ params }: PageProps): Promise<ReactNode> {
  const locale = await requireLocale(params);
  return <ServicesView locale={locale} />;
}
