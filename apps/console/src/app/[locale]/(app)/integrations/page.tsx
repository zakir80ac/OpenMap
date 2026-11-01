// REQ-UI-014 REQ-INT-005 — Integrations: catalogue, configured integrations, detail with mappings and deliveries route.
import type { Metadata } from 'next';
import type { ReactNode } from 'react';
import { IntegrationsView } from '@/components/integrations/IntegrationsView';
import { getT, requireLocale } from '@/lib/i18n';

interface PageProps {
  params: Promise<{ locale: string }>;
}

export async function generateMetadata({ params }: PageProps): Promise<Metadata> {
  const t = getT(await requireLocale(params));
  return { title: t('nav.integrations') };
}

export default async function IntegrationsPage({ params }: PageProps): Promise<ReactNode> {
  await requireLocale(params);
  return <IntegrationsView />;
}
