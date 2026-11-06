// REQ-CMDB-034 — Utilisation: CPU, memory, disk and power across the estate, hot and idle CIs.
import type { Metadata } from 'next';
import type { ReactNode } from 'react';
import { UtilisationView } from '@/components/utilisation/UtilisationView';
import { getT, requireLocale } from '@/lib/i18n';

interface PageProps {
  params: Promise<{ locale: string }>;
}

export async function generateMetadata({ params }: PageProps): Promise<Metadata> {
  const t = getT(await requireLocale(params));
  return { title: t('nav.utilisation') };
}

export default async function UtilisationPage({ params }: PageProps): Promise<ReactNode> {
  const locale = await requireLocale(params);
  return <UtilisationView locale={locale} />;
}
