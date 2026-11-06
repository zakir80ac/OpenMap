// REQ-CMDB-023 REQ-CMDB-025 — Lifecycle: OS, platform and hardware end of support against the catalogue (ADR-039).
import type { Metadata } from 'next';
import type { ReactNode } from 'react';
import { LifecycleView } from '@/components/lifecycle/LifecycleView';
import { getT, requireLocale } from '@/lib/i18n';

interface PageProps {
  params: Promise<{ locale: string }>;
}

export async function generateMetadata({ params }: PageProps): Promise<Metadata> {
  const t = getT(await requireLocale(params));
  return { title: t('nav.lifecycle') };
}

export default async function LifecyclePage({ params }: PageProps): Promise<ReactNode> {
  const locale = await requireLocale(params);
  return <LifecycleView locale={locale} />;
}
