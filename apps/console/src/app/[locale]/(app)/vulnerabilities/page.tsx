// REQ-UI-016 REQ-CMDB-035 REQ-SEC-008 — Vulnerabilities: CVEs ranked by CVSS with their blast radius through the graph.
import type { Metadata } from 'next';
import type { ReactNode } from 'react';
import { VulnerabilitiesView } from '@/components/vulnerabilities/VulnerabilitiesView';
import { getT, requireLocale } from '@/lib/i18n';

interface PageProps {
  params: Promise<{ locale: string }>;
}

export async function generateMetadata({ params }: PageProps): Promise<Metadata> {
  const t = getT(await requireLocale(params));
  return { title: t('nav.vulnerabilities') };
}

export default async function VulnerabilitiesPage({ params }: PageProps): Promise<ReactNode> {
  const locale = await requireLocale(params);
  return <VulnerabilitiesView locale={locale} />;
}
