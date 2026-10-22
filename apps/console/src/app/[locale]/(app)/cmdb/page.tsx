// REQ-UI-008 — CMDB route: virtualised, cursor-paginated CI list over the `cis` query with layer filter chips. The
// optional `q` search parameter (from the global search) becomes the contract's text filter.
import type { Metadata } from 'next';
import type { ReactNode } from 'react';
import { CmdbView } from '@/components/cmdb/CmdbView';
import { getT, requireLocale } from '@/lib/i18n';

interface PageProps {
  params: Promise<{ locale: string }>;
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}

export async function generateMetadata({ params }: Pick<PageProps, 'params'>): Promise<Metadata> {
  const t = getT(await requireLocale(params));
  return { title: t('nav.cmdb') };
}

export default async function CmdbPage({ searchParams }: PageProps): Promise<ReactNode> {
  const { q } = await searchParams;
  const text = typeof q === 'string' ? q.trim() : '';
  return <CmdbView text={text} />;
}
