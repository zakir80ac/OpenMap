// REQ-PERF-005 (ADR-071) — Platform health route: the platform's own SLOs, alerts, services, stores, backlogs and budgets.
import type { Metadata } from 'next';
import type { ReactNode } from 'react';
import { PlatformHealthView } from '@/components/platform/PlatformHealthView';
import { getT, requireLocale } from '@/lib/i18n';

interface PageProps {
  params: Promise<{ locale: string }>;
}

export async function generateMetadata({ params }: PageProps): Promise<Metadata> {
  const t = getT(await requireLocale(params));
  return { title: t('nav.platform') };
}

export default async function PlatformPage({ params }: PageProps): Promise<ReactNode> {
  await requireLocale(params);
  return <PlatformHealthView />;
}
