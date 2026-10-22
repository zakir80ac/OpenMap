// REQ-UI-004 — Dashboard route: KPI tiles, service health and the layer summary from the `layers` and `services` queries.
import type { Metadata } from 'next';
import type { ReactNode } from 'react';
import { DashboardView } from '@/components/dashboard/DashboardView';
import { getT, requireLocale } from '@/lib/i18n';

interface PageProps {
  params: Promise<{ locale: string }>;
}

export async function generateMetadata({ params }: PageProps): Promise<Metadata> {
  const t = getT(await requireLocale(params));
  return { title: t('nav.dashboard') };
}

export default function DashboardPage(): ReactNode {
  return <DashboardView />;
}
