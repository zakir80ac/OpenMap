// REQ-CMDB-032 — Certificates: the inventory with expiry, weak keys and the endpoints each secures (ADR-036).
import type { Metadata } from 'next';
import type { ReactNode } from 'react';
import { CertificatesView } from '@/components/certificates/CertificatesView';
import { getT, requireLocale } from '@/lib/i18n';

interface PageProps {
  params: Promise<{ locale: string }>;
}

export async function generateMetadata({ params }: PageProps): Promise<Metadata> {
  const t = getT(await requireLocale(params));
  return { title: t('nav.certificates') };
}

export default async function CertificatesPage({ params }: PageProps): Promise<ReactNode> {
  const locale = await requireLocale(params);
  return <CertificatesView locale={locale} />;
}
