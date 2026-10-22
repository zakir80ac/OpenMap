// REQ-UI-011 REQ-DCIM-001 — DCIM: rack elevation, room heat map, power route.
import type { Metadata } from 'next';
import type { ReactNode } from 'react';
import { DcimView } from '@/components/dcim/DcimView';
import { getT, requireLocale } from '@/lib/i18n';

interface PageProps {
  params: Promise<{ locale: string }>;
}

export async function generateMetadata({ params }: PageProps): Promise<Metadata> {
  const t = getT(await requireLocale(params));
  return { title: t('nav.dcim') };
}

export default async function DcimPage({ params }: PageProps): Promise<ReactNode> {
  const locale = await requireLocale(params);
  return <DcimView locale={locale} />;
}
