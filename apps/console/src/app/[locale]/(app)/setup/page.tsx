// REQ-UI-020 REQ-UI-024 — Setup route: the six-step initial setup wizard (ADR-017).
import type { Metadata } from 'next';
import type { ReactNode } from 'react';
import { SetupView } from '@/components/setup/SetupView';
import { getT, requireLocale } from '@/lib/i18n';

interface PageProps {
  params: Promise<{ locale: string }>;
}

export async function generateMetadata({ params }: PageProps): Promise<Metadata> {
  const t = getT(await requireLocale(params));
  return { title: t('nav.setup') };
}

export default async function SetupPage({ params }: PageProps): Promise<ReactNode> {
  const locale = await requireLocale(params);
  return <SetupView locale={locale} />;
}
