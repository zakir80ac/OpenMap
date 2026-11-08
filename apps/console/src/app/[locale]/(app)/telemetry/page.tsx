// REQ-UI-027 — Health and telemetry route: the fleet table over the telemetryFleet query.
import type { Metadata } from 'next';
import type { ReactNode } from 'react';
import { TelemetryView } from '@/components/telemetry/TelemetryView';
import { getT, requireLocale } from '@/lib/i18n';

interface PageProps {
  params: Promise<{ locale: string }>;
}

export async function generateMetadata({ params }: PageProps): Promise<Metadata> {
  const t = getT(await requireLocale(params));
  return { title: t('nav.telemetry') };
}

export default async function TelemetryPage({ params }: PageProps): Promise<ReactNode> {
  await requireLocale(params);
  return <TelemetryView />;
}
