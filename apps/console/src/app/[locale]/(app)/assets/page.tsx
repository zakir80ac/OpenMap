// REQ-UI-009 REQ-CMDB-030 — Assets: lifecycle, attention table, warranty horizon, vendor support, plans with BOM route.
import type { Metadata } from 'next';
import type { ReactNode } from 'react';
import { AssetsView } from '@/components/assets/AssetsView';
import { getT, requireLocale } from '@/lib/i18n';

interface PageProps {
  params: Promise<{ locale: string }>;
}

export async function generateMetadata({ params }: PageProps): Promise<Metadata> {
  const t = getT(await requireLocale(params));
  return { title: t('nav.assets') };
}

export default async function AssetsPage({ params }: PageProps): Promise<ReactNode> {
  const locale = await requireLocale(params);
  return <AssetsView locale={locale} />;
}
