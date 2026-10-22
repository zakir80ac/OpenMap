// REQ-UI-010 REQ-IPAM-001 — IPAM: subnet tree, address table, DNS and DHCP route.
import type { Metadata } from 'next';
import type { ReactNode } from 'react';
import { IpamView } from '@/components/ipam/IpamView';
import { getT, requireLocale } from '@/lib/i18n';

interface PageProps {
  params: Promise<{ locale: string }>;
}

export async function generateMetadata({ params }: PageProps): Promise<Metadata> {
  const t = getT(await requireLocale(params));
  return { title: t('nav.ipam') };
}

export default async function IpamPage({ params }: PageProps): Promise<ReactNode> {
  const locale = await requireLocale(params);
  return <IpamView locale={locale} />;
}
