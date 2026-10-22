// REQ-UI-018 REQ-AI-001 — Assistant: chat over the graph with the generated Cypher shown route.
import type { Metadata } from 'next';
import type { ReactNode } from 'react';
import { AssistantView } from '@/components/assistant/AssistantView';
import { getT, requireLocale } from '@/lib/i18n';

interface PageProps {
  params: Promise<{ locale: string }>;
}

export async function generateMetadata({ params }: PageProps): Promise<Metadata> {
  const t = getT(await requireLocale(params));
  return { title: t('nav.assistant') };
}

export default async function AssistantPage({ params }: PageProps): Promise<ReactNode> {
  const locale = await requireLocale(params);
  return <AssistantView locale={locale} />;
}
