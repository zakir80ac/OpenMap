// REQ-UI-015 REQ-CMDB-030 REQ-CMDB-031 — Software and licences: catalogue, footprint, licence position and posture.
import type { Metadata } from 'next';
import type { ReactNode } from 'react';
import { SoftwareView } from '@/components/software/SoftwareView';
import { getT, requireLocale } from '@/lib/i18n';

interface PageProps {
  params: Promise<{ locale: string }>;
}

export async function generateMetadata({ params }: PageProps): Promise<Metadata> {
  const t = getT(await requireLocale(params));
  return { title: t('nav.software') };
}

export default async function SoftwarePage({ params }: PageProps): Promise<ReactNode> {
  const locale = await requireLocale(params);
  return <SoftwareView locale={locale} />;
}
