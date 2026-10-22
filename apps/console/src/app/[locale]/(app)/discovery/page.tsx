// REQ-UI-006 REQ-DISC-029 REQ-DISC-031 — Discovery route: Nodes, recent jobs, the current sweep and "Run discovery".
import type { Metadata } from 'next';
import type { ReactNode } from 'react';
import { DiscoveryView } from '@/components/discovery/DiscoveryView';
import { getT, requireLocale } from '@/lib/i18n';

interface PageProps {
  params: Promise<{ locale: string }>;
}

export async function generateMetadata({ params }: PageProps): Promise<Metadata> {
  const t = getT(await requireLocale(params));
  return { title: t('nav.discovery') };
}

export default async function DiscoveryPage({ params }: PageProps): Promise<ReactNode> {
  const locale = await requireLocale(params);
  return <DiscoveryView locale={locale} />;
}
