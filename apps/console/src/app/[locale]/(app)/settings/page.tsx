// REQ-SEC-005 REQ-UI-003 — Settings route: the signed-in identity and the tenant's immutable audit log.
import type { Metadata } from 'next';
import type { ReactNode } from 'react';
import { SettingsView } from '@/components/settings/SettingsView';
import { getT, requireLocale } from '@/lib/i18n';

interface PageProps {
  params: Promise<{ locale: string }>;
}

export async function generateMetadata({ params }: PageProps): Promise<Metadata> {
  const t = getT(await requireLocale(params));
  return { title: t('nav.settings') };
}

export default async function SettingsPage({ params }: PageProps): Promise<ReactNode> {
  const locale = await requireLocale(params);
  return <SettingsView locale={locale} />;
}
