'use client';
// REQ-DEP-001 (ADR-030) — the Dependencies screen's two maps: the impact map of one CI and the network topology. The
// choice is `view=topology` in the URL; switching keeps nothing else, each map owns its own parameters.
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
        router.push(localizedHref(locale, '/dependencies') + (next === 'topology' ? '?view=topology' : ''));
      }}
      className="self-start"
    />
  );
}
