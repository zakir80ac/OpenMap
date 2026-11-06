// REQ-CMDB-014 — Parts: the components discovery found inside the estate's hardware (ADR-037).
import type { Metadata } from 'next';
import type { ReactNode } from 'react';
import { PartsView } from '@/components/parts/PartsView';
import { getT, requireLocale } from '@/lib/i18n';

interface PageProps {
  params: Promise<{ locale: string }>;
}

export async function generateMetadata({ params }: PageProps): Promise<Metadata> {
  const t = getT(await requireLocale(params));
  return { title: t('nav.parts') };
}

export default async function PartsPage({ params }: PageProps): Promise<ReactNode> {
  const locale = await requireLocale(params);
  return <PartsView locale={locale} />;
}
