'use client';
// REQ-UI-017 — Analytics: the tenant's Superset dashboard embedded through the Superset embedded SDK. The API hands
// the browser a short-lived guest token whose row-level-security clause pins tenant_id (`analyticsEmbed`); the SDK
// mounts the dashboard in a sandboxed iframe and asks for a fresh token before each one expires. Nothing of the
// warehouse is reachable from the browser except through that token.
import { embedDashboard, type EmbeddedDashboard } from '@superset-ui/embedded-sdk';
import { useQuery } from '@tanstack/react-query';
import type { Locale } from '@openmap/i18n';
import { Card, SectionTitle, Tag } from '@openmap/ui';
import { useEffect, useRef, useState, type ReactNode } from 'react';
import { Button } from '@/components/common/controls';
import { QueryState } from '@/components/common/QueryState';
import { Icon } from '@/components/icons';
import { analyticsEmbedQuery, fetchAnalyticsEmbed } from '@/lib/estate-queries';
import { useT } from '@/providers';

export interface AnalyticsViewProps {
  locale: Locale;
}

/** The SDK's embed call, injectable so the view is testable without an iframe handshake. */
export type EmbedFn = typeof embedDashboard;

export interface AnalyticsViewInternalProps extends AnalyticsViewProps {
  embed?: EmbedFn;
}

export function AnalyticsView({ locale, embed = embedDashboard }: AnalyticsViewInternalProps): ReactNode {
  const t = useT();
  const mount = useRef<HTMLDivElement | null>(null);
  const handshake = useQuery(analyticsEmbedQuery());
  const [embedError, setEmbedError] = useState<string | null>(null);
  const [mounted, setMounted] = useState(false);
  const data = handshake.data;

  useEffect(() => {
    const node = mount.current;
    if (data === undefined || node === null) return;
    let dashboard: EmbeddedDashboard | null = null;
    let cancelled = false;
    setEmbedError(null);
    // The shell paints first; Superset's bundle starts in the browser's next idle slot so the console stays responsive.
    const start = (): void => {
      if (cancelled) return;
      embed({
      id: data.dashboardId,
      supersetDomain: data.supersetUrl,
      mountPoint: node,
      // The first token came with the handshake; every later one is minted on demand, scoped to this tenant.
      fetchGuestToken: () => fetchAnalyticsEmbed().then((e) => e.token),
      dashboardUiConfig: { hideTitle: true, hideChartControls: false, filters: { visible: true, expanded: false } },
      iframeTitle: t('analytics.iframeTitle'),
    })
      .then((d) => {
        if (cancelled) {
          d.unmount();
          return;
        }
        dashboard = d;
        setMounted(true);
      })
      .catch((err: unknown) => {
        if (!cancelled) setEmbedError(err instanceof Error ? err.message : String(err));
      });
    };
    const idle = typeof window.requestIdleCallback === 'function' ? window.requestIdleCallback(start) : window.setTimeout(start, 0);
    return () => {
      cancelled = true;
      if (typeof window.cancelIdleCallback === 'function') window.cancelIdleCallback(idle);
      else window.clearTimeout(idle);
      dashboard?.unmount();
      setMounted(false);
    };
  }, [data, embed, t]);

  return (
    <div className="flex flex-col gap-om-24">
      <SectionTitle
        as="h1"
        size="lg"
        eyebrow={t('app.name')}
        description={t('analytics.subtitle')}
        action={
          data !== undefined ? (
            <a href={data.supersetUrl} target="_blank" rel="noreferrer" className="text-om-xs text-om-cyan hover:underline">
              {t('analytics.openSuperset')}
            </a>
          ) : undefined
        }
      >
        {t('analytics.title')}
      </SectionTitle>
      <Card padding="16" className="flex min-h-[70vh] flex-col gap-om-10">
        <div className="flex flex-wrap items-center gap-om-8 text-om-xs text-om-secondary">
          <Icon name="analytics" className="size-4 text-om-cyan" />
          <span>{t('analytics.scope')}</span>
          <Tag>{t('analytics.rls')}</Tag>
          {mounted ? <Tag>{t('analytics.live')}</Tag> : null}
          <span className="sr-only">{locale}</span>
        </div>
        {handshake.isPending ? (
          <QueryState status="pending" />
        ) : handshake.isError ? (
          <div className="flex flex-col gap-om-8">
            <QueryState status="error" />
            <p className="text-om-xs text-om-muted">{t('analytics.unavailable')}</p>
            <Button
              tone="quiet"
              className="self-start"
              onClick={() => {
                void handshake.refetch();
              }}
            >
              {t('common.retry')}
            </Button>
          </div>
        ) : embedError !== null ? (
          <p role="alert" className="text-om-sm text-om-rose">
            {t('analytics.embedFailed', { reason: embedError })}
          </p>
        ) : null}
        <div ref={mount} data-testid="analytics-mount" className="om-analytics-frame flex-1 overflow-hidden rounded-om-panel border border-om-border-glass bg-om-surface2 [&>iframe]:h-full [&>iframe]:min-h-[65vh] [&>iframe]:w-full [&>iframe]:border-0" />
      </Card>
    </div>
  );
}
