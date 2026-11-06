// REQ-CMDB-022 — SaaS: tenants, subscriptions with seats and renewals, and the data flows to them.
import type { Metadata } from 'next';
import type { ReactNode } from 'react';
import { SaasView } from '@/components/saas/SaasView';
import { getT, requireLocale } from '@/lib/i18n';

interface PageProps {
  params: Promise<{ locale: string }>;
}

export async function generateMetadata({ params }: PageProps): Promise<Metadata> {
  const t = getT(await requireLocale(params));
  return { title: t('nav.saas') };
}

export default async function SaasPage({ params }: PageProps): Promise<ReactNode> {
  const locale = await requireLocale(params);
  return <SaasView locale={locale} />;
}
