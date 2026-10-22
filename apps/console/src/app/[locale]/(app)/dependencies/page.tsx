// REQ-UI-007 REQ-DEP-003 REQ-DEP-005 — Dependency map route. The map's state (focus CI, direction, depth, as-of
// instant) is carried in the query string so a map can be linked from the CI detail, services and impact screens.
import type { Metadata } from 'next';
import type { ReactNode } from 'react';
import { DependenciesView } from '@/components/dependencies/DependenciesView';
import { isImpactDirection, parseDepth } from '@/components/dependencies/params';
import { getT, requireLocale } from '@/lib/i18n';

interface PageProps {
  params: Promise<{ locale: string }>;
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}

function single(value: string | string[] | undefined): string | undefined {
  return typeof value === 'string' && value !== '' ? value : undefined;
}

export async function generateMetadata({ params }: Pick<PageProps, 'params'>): Promise<Metadata> {
  const t = getT(await requireLocale(params));
  return { title: t('nav.dependencies') };
}

export default async function DependenciesPage({ params, searchParams }: PageProps): Promise<ReactNode> {
  const locale = await requireLocale(params);
  const query = await searchParams;
  const direction = single(query['direction']);
  return (
    <DependenciesView
      locale={locale}
      ciId={single(query['ci'])}
      direction={isImpactDirection(direction) ? direction : 'upstream'}
      depth={parseDepth(single(query['depth']))}
      asOf={single(query['asOf'])}
    />
  );
}
