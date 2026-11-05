// REQ-UI-007 REQ-DEP-003 REQ-DEP-005 REQ-DEP-001 — Dependency map route. The map's state (focus CI, direction, depth,
// as-of instant, layout mode) is carried in the query string so a map can be linked from the CI detail, services and
// impact screens; `view=topology` shows the network topology map instead (ADR-030).
import type { Metadata } from 'next';
import type { ReactNode } from 'react';
import { DependenciesView } from '@/components/dependencies/DependenciesView';
import { TopologyView } from '@/components/dependencies/TopologyView';
import { ViewSwitch } from '@/components/dependencies/ViewSwitch';
import { isImpactDirection, parseDepth, parseLayout, parseView } from '@/components/dependencies/params';
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
  const view = parseView(single(query['view']));
  const direction = single(query['direction']);
  return (
    <div className="flex flex-col gap-om-12">
      <ViewSwitch locale={locale} view={view} />
      {view === 'topology' ? (
        <TopologyView locale={locale} />
      ) : (
        <DependenciesView
          locale={locale}
          ciId={single(query['ci'])}
          direction={isImpactDirection(direction) ? direction : 'upstream'}
          depth={parseDepth(single(query['depth']))}
          asOf={single(query['asOf'])}
          layout={parseLayout(single(query['layout']))}
        />
      )}
    </div>
  );
}
