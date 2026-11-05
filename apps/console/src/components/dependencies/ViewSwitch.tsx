'use client';
// REQ-DEP-001 REQ-DEP-004 (ADR-030, ADR-031) — the Dependencies screen's maps: the impact map of one CI, the layered
// application map and the network topology. The choice is `view=` in the URL; each map owns its own parameters.
import { useRouter } from 'next/navigation';
import type { Locale } from '@openmap/i18n';
import { Segmented } from '@openmap/ui';
import type { ReactNode } from 'react';
import { localizedHref } from '@/lib/locale-path';
import { useT } from '@/providers';
import { DEPENDENCY_VIEWS, type DependencyView } from './params';

export function ViewSwitch({ locale, view }: { locale: Locale; view: DependencyView }): ReactNode {
  const t = useT();
  const router = useRouter();
  return (
    <Segmented
      label={t('dependencies.view.label')}
      value={view}
      options={DEPENDENCY_VIEWS.map((value) => ({ value, label: t(`dependencies.view.${value}`) }))}
      onChange={(next) => {
        router.push(localizedHref(locale, '/dependencies') + (next === 'impact' ? '' : '?view=' + next));
      }}
      className="self-start"
    />
  );
}
