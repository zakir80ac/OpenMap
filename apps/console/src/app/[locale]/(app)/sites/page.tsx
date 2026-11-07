// REQ-UI-012 REQ-BSM-007 (ADR-025) — Sites and connectivity route: sites, inter-site links with live probe figures, and
// the HA / DR readiness rules with their findings.
import type { Metadata } from 'next';
import type { ReactNode } from 'react';
import { SitesView } from '@/components/sites/SitesView';
import { getT, requireLocale } from '@/lib/i18n';

interface PageProps {
  params: Promise<{ locale: string }>;
}

export async function generateMetadata({ params }: PageProps): Promise<Metadata> {
  const t = getT(await requireLocale(params));
  return { title: t('nav.sites') };
}

export default async function SitesPage({ params }: PageProps): Promise<ReactNode> {
  const locale = await requireLocale(params);
  return <SitesView locale={locale} />;
}
