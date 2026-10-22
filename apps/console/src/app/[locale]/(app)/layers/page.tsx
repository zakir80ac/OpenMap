// REQ-UI-005 — Layers route: the twelve-layer model with counts, per-device visibility toggles and the isometric stack.
import type { Metadata } from 'next';
import type { ReactNode } from 'react';
import { LayersView } from '@/components/layers/LayersView';
import { getT, requireLocale } from '@/lib/i18n';

interface PageProps {
  params: Promise<{ locale: string }>;
}

export async function generateMetadata({ params }: PageProps): Promise<Metadata> {
  const t = getT(await requireLocale(params));
  return { title: t('nav.layers') };
}

export default function LayersPage(): ReactNode {
  return <LayersView />;
}
