// REQ-INT-017 (ADR-075) — Protection: the CIs supporting critical business services that backups do not protect within
// their RPO.
import type { Metadata } from 'next';
import type { ReactNode } from 'react';
import { ProtectionView } from '@/components/protection/ProtectionView';
import { getT, requireLocale } from '@/lib/i18n';

interface PageProps {
  params: Promise<{ locale: string }>;
}

export async function generateMetadata({ params }: PageProps): Promise<Metadata> {
  const t = getT(await requireLocale(params));
  return { title: t('nav.protection') };
}

export default async function ProtectionPage({ params }: PageProps): Promise<ReactNode> {
  const locale = await requireLocale(params);
  return <ProtectionView locale={locale} />;
}
