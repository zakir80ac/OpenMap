'use client';
// REQ-UI-006 REQ-DISC-029 REQ-DISC-031 — Discovery: Nodes (status, site, last heartbeat, certificate, the collectors
// seen in their jobs), recent jobs with status and counts, the current sweep's progress against its budget, and
// "Run discovery" calling the runDiscovery mutation. Live queries poll on CONSOLE.livePollMs.
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import Link from 'next/link';
import { BSM, CONSOLE, TIME } from '@openmap/constants';
import type { Locale } from '@openmap/i18n';
import { Bar, Card, Dot, Kpi, Pill, SectionTitle, Tag, accents, cx, type UiState } from '@openmap/ui';
import { useMemo, type ReactNode } from 'react';
import { QueryState } from '@/components/common/QueryState';
import { Icon } from '@/components/icons';
import { localizedHref } from '@/lib/locale-path';
import { currentSweepQuery, discoveryJobsQuery, discoveryNodesQuery, runDiscovery, type DiscoveryJob, type DiscoveryNode, type Sweep } from '@/lib/queries';
import { useFormatters, useT, type Translate } from '@/providers';

export interface DiscoveryViewProps {
  locale: Locale;
}

const NODE_STATUS_KEYS = { online: 'discovery.nodes.status.online', offline: 'discovery.nodes.status.offline', degraded: 'discovery.nodes.status.degraded' } as const;
const JOB_STATUS_KEYS = {
  queued: 'discovery.jobs.status.queued',
  running: 'discovery.jobs.status.running',
  succeeded: 'discovery.jobs.status.succeeded',
  failed: 'discovery.jobs.status.failed',
  cancelled: 'discovery.jobs.status.cancelled',
} as const;

/** Node status to the UI state palette; unknown vocabularies from older Nodes render as unknown. */
export function nodeState(status: string): UiState {
  switch (status) {
    case 'online':
      return 'healthy';
    case 'degraded':
      return 'degraded';
    case 'offline':
      return 'down';
    default:
      return 'unknown';
  }
}

export function jobState(status: string): UiState {
  switch (status) {
    case 'succeeded':
      return 'healthy';
    case 'running':
    case 'queued':
      return 'at_risk';
    case 'failed':
      return 'down';
    case 'cancelled':
      return 'degraded';
    default:
      return 'unknown';
  }
}

function nodeStatusLabel(t: Translate, status: string): string {
  return Object.hasOwn(NODE_STATUS_KEYS, status) ? t(NODE_STATUS_KEYS[status as keyof typeof NODE_STATUS_KEYS]) : t('discovery.nodes.status.other', { status });
}

function jobStatusLabel(t: Translate, status: string): string {
  return Object.hasOwn(JOB_STATUS_KEYS, status) ? t(JOB_STATUS_KEYS[status as keyof typeof JOB_STATUS_KEYS]) : t('discovery.jobs.status.other', { status });
}

/** Collector ids seen per Node across the recent jobs, sorted; the contract carries collectors on jobs, not Nodes. */
export function collectorsByNode(jobs: ReadonlyArray<DiscoveryJob>): Map<string, string[]> {
  const map = new Map<string, Set<string>>();
  for (const job of jobs) {
    const set = map.get(job.node.id) ?? new Set<string>();
    set.add(job.collectorId);
    map.set(job.node.id, set);
  }
  return new Map([...map.entries()].map(([node, set]) => [node, [...set].sort()]));
}

/** Whole seconds between two instants, or undefined when the job has not started. */
export function jobDurationSeconds(job: Pick<DiscoveryJob, 'startedAt' | 'finishedAt'>, now: number): number | undefined {
  if (job.startedAt === null) return undefined;
  const end = job.finishedAt === null ? now : new Date(job.finishedAt).getTime();
  return Math.max(0, Math.round((end - new Date(job.startedAt).getTime()) / TIME.msPerSecond));
}

export function sweepElapsedMinutes(sweep: Pick<Sweep, 'startedAt' | 'finishedAt'>, now: number): number {
  const end = sweep.finishedAt === null ? now : new Date(sweep.finishedAt).getTime();
  return Math.max(0, Math.round((end - new Date(sweep.startedAt).getTime()) / BSM.msPerMinute));
}

export function DiscoveryView({ locale }: DiscoveryViewProps): ReactNode {
  const t = useT();
  const format = useFormatters();
  const queryClient = useQueryClient();
  const nodes = useQuery(discoveryNodesQuery());
  const jobs = useQuery(discoveryJobsQuery());
  const sweep = useQuery(currentSweepQuery());

  const run = useMutation({
    mutationFn: () => runDiscovery(),
    onSuccess: async () => {
      await queryClient.invalidateQueries({ queryKey: ['current-sweep'] });
      await queryClient.invalidateQueries({ queryKey: ['discovery-jobs'] });
    },
  });

  const collectors = useMemo(() => collectorsByNode(jobs.data ?? []), [jobs.data]);
  const now = Date.now();
  const kpis = useMemo(() => {
    const nodeList = nodes.data ?? [];
    const jobList = jobs.data ?? [];
    return {
      online: nodeList.filter((n) => n.status === 'online').length,
      running: jobList.filter((j) => j.status === 'running').length,
      cis: jobList.reduce((sum, j) => sum + j.cisEmitted, 0),
      errors: jobList.reduce((sum, j) => sum + j.errors, 0),
    };
  }, [nodes.data, jobs.data]);

  const current = sweep.data ?? null;
  const sweepRunning = current !== null && current.finishedAt === null;

  return (
    <div className="flex flex-col gap-om-20">
      <SectionTitle
        as="h1"
        size="lg"
        eyebrow={t('app.name')}
        description={t('discovery.subtitle')}
        action={
          <span className="flex items-center gap-om-8">
            {run.isSuccess ? <Pill variant="primary">{t('discovery.runStarted', { id: run.data.id })}</Pill> : null}
            {run.isError ? (
              <span role="alert">
                <Tag variant="state" state="down">
                  {t('discovery.runError')}
                </Tag>
              </span>
            ) : null}
            <button
              type="button"
              disabled={run.isPending || sweepRunning}
              onClick={() => {
                run.mutate();
              }}
              className="flex items-center gap-om-6 rounded-om-control-lg bg-om-cyan px-om-14 py-om-8 text-om-sm font-semibold text-om-ground shadow-om-glow-button-cyan transition-opacity duration-om-base hover:opacity-90 disabled:opacity-50 disabled:shadow-none"
            >
              <Icon name="play" className="size-3.5" />
              {run.isPending ? t('discovery.running') : t('discovery.run')}
            </button>
          </span>
        }
      >
        {t('nav.discovery')}
      </SectionTitle>

      <section className="grid grid-cols-2 gap-om-12 xl:grid-cols-4" aria-busy={nodes.isPending || jobs.isPending}>
        <Card padding="16">
          <Kpi label={t('discovery.kpi.nodes')} value={nodes.isSuccess ? format.integer(kpis.online) : '…'} accent={accents.emerald} />
        </Card>
        <Card padding="16">
          <Kpi label={t('discovery.kpi.jobs')} value={jobs.isSuccess ? format.integer(kpis.running) : '…'} accent={accents.cyan} />
        </Card>
        <Card padding="16">
          <Kpi label={t('discovery.kpi.cis')} value={jobs.isSuccess ? format.integer(kpis.cis) : '…'} />
        </Card>
        <Card padding="16">
          <Kpi label={t('discovery.kpi.errors')} value={jobs.isSuccess ? format.integer(kpis.errors) : '…'} {...(kpis.errors > 0 ? { accent: accents.rose } : {})} />
        </Card>
      </section>

      <Card as="section" className="flex flex-col gap-om-12" aria-busy={sweep.isPending}>
        <SectionTitle as="h2" size="sm" action={sweepRunning ? <Pill variant="primary" icon={<Dot state="healthy" pulse />}>{t('topbar.now')}</Pill> : undefined}>
          {t('discovery.sweep.title')}
        </SectionTitle>
        {sweep.isPending ? (
          <QueryState status="pending" />
        ) : sweep.isError ? (
          <QueryState
            status="error"
            onRetry={() => {
              void sweep.refetch();
            }}
          />
        ) : current === null ? (
          <p className="text-om-sm text-om-secondary">{t('discovery.sweep.none')}</p>
        ) : (
          <div className="flex flex-col gap-om-10">
            <div className="flex flex-wrap items-center gap-om-10 text-om-sm">
              <span className="font-om-display text-om-xl font-extrabold text-om-primary">
                {t('discovery.sweep.progress', { done: format.integer(current.targetsDone), total: format.integer(current.targetsTotal) })}
              </span>
              <Tag>{t('discovery.sweep.devices', { count: format.integer(current.devicesDiscovered) })}</Tag>
              <Tag>{t('discovery.sweep.budget', { minutes: format.integer(current.budgetMinutes) })}</Tag>
              <Tag variant="state" state={sweepElapsedMinutes(current, now) > current.budgetMinutes ? 'down' : 'healthy'}>
                {t('discovery.sweep.elapsed', { minutes: format.integer(sweepElapsedMinutes(current, now)) })}
              </Tag>
            </div>
            <Bar value={current.targetsDone} max={Math.max(current.targetsTotal, 1)} label={t('discovery.sweep.label')} accent={sweepRunning ? accents.cyan : accents.emerald} />
            <p className="text-om-2xs text-om-muted">
              {t('discovery.sweep.started', { when: format.dateTime(current.startedAt) })}
              {current.finishedAt !== null ? ' · ' + t('discovery.sweep.finished', { when: format.dateTime(current.finishedAt) }) : ''}
            </p>
          </div>
        )}
      </Card>

      <div className="grid grid-cols-1 gap-om-16 xl:grid-cols-[minmax(0,2fr)_minmax(0,3fr)]">
        <Card as="section" className="flex flex-col gap-om-12">
          <SectionTitle as="h2" size="sm" description={t('discovery.nodes.subtitle')}>
            {t('discovery.nodes.title')}
          </SectionTitle>
          {nodes.isPending ? (
            <QueryState status="pending" />
          ) : nodes.isError ? (
            <QueryState
              status="error"
              onRetry={() => {
                void nodes.refetch();
              }}
            />
          ) : nodes.data.length === 0 ? (
            <p className="text-om-sm text-om-secondary">{t('discovery.nodes.empty')}</p>
          ) : (
            <ul className="flex flex-col gap-om-8">
              {nodes.data.map((node: DiscoveryNode) => (
                <li key={node.id} className="flex flex-col gap-om-6 rounded-om-panel border border-om-border-glass bg-om-surface2/60 p-om-12">
                  <div className="flex items-center gap-om-10">
                    <Dot state={nodeState(node.status)} pulse={node.status === 'online'} />
                    <span className="min-w-0 flex-1 truncate font-om-mono text-om-sm font-medium text-om-primary">{node.id}</span>
                    <Tag variant="state" state={nodeState(node.status)}>
                      {nodeStatusLabel(t, node.status)}
                    </Tag>
                  </div>
                  <div className="flex flex-wrap items-center gap-x-om-12 gap-y-om-4 text-om-2xs text-om-secondary">
                    <span className="flex items-center gap-om-4">
                      <Icon name="site" className="size-3" />
                      {node.site === null ? (
                        t('discovery.nodes.noSite')
                      ) : (
                        <Link href={localizedHref(locale, '/cmdb/' + encodeURIComponent(node.site.id))} className="text-om-primary hover:text-om-cyan">
                          {node.site.displayName}
                        </Link>
                      )}
                    </span>
                    <span>{t('discovery.nodes.heartbeat', { when: format.dateTime(node.lastHeartbeat) })}</span>
                    <span>{t('discovery.nodes.activeJobs', { count: format.integer(node.activeJobs) })}</span>
                    <span>{t('discovery.nodes.certificate', { when: format.dateTime(node.certificateExpiresAt) })}</span>
                  </div>
                  <div className="flex flex-wrap items-center gap-om-4">
                    <span className="text-om-2xs font-semibold uppercase tracking-[0.08em] text-om-muted">{t('discovery.nodes.collectors')}</span>
                    {(collectors.get(node.id) ?? []).length === 0 ? (
                      <span className="text-om-2xs text-om-secondary">{t('discovery.nodes.noCollectors')}</span>
                    ) : (
                      (collectors.get(node.id) ?? []).map((collector) => <Tag key={collector}>{collector}</Tag>)
                    )}
                  </div>
                </li>
              ))}
            </ul>
          )}
        </Card>

        <Card as="section" className="flex flex-col gap-om-12">
          <SectionTitle as="h2" size="sm" description={t('discovery.jobs.subtitle', { count: format.integer(CONSOLE.discoveryJobsLimit) })}>
            {t('discovery.jobs.title')}
          </SectionTitle>
          {jobs.isPending ? (
            <QueryState status="pending" />
          ) : jobs.isError ? (
            <QueryState
              status="error"
              onRetry={() => {
                void jobs.refetch();
              }}
            />
          ) : jobs.data.length === 0 ? (
            <p className="text-om-sm text-om-secondary">{t('discovery.jobs.empty')}</p>
          ) : (
            <div className="overflow-x-auto">
              <table className="w-full border-collapse text-om-sm">
                <thead>
                  <tr className="border-b border-om-border-glass text-om-2xs font-semibold uppercase tracking-[0.08em] text-om-muted">
                    <th scope="col" className="py-om-6 pe-om-10 text-start">
                      {t('discovery.jobs.column.collector')}
                    </th>
                    <th scope="col" className="py-om-6 pe-om-10 text-start">
                      {t('discovery.jobs.column.node')}
                    </th>
                    <th scope="col" className="py-om-6 pe-om-10 text-start">
                      {t('discovery.jobs.column.status')}
                    </th>
                    <th scope="col" className="py-om-6 pe-om-10 text-end">
                      {t('discovery.jobs.column.targets')}
                    </th>
                    <th scope="col" className="py-om-6 pe-om-10 text-end">
                      {t('discovery.jobs.column.cis')}
                    </th>
                    <th scope="col" className="py-om-6 pe-om-10 text-end">
                      {t('discovery.jobs.column.errors')}
                    </th>
                    <th scope="col" className="py-om-6 pe-om-10 text-start">
                      {t('discovery.jobs.column.scheduled')}
                    </th>
                    <th scope="col" className="py-om-6 text-end">
                      {t('discovery.jobs.column.duration')}
                    </th>
                  </tr>
                </thead>
                <tbody>
                  {jobs.data.map((job) => {
                    const seconds = jobDurationSeconds(job, now);
                    return (
                      <tr key={job.id} className="border-b border-om-border-glass last:border-b-0">
                        <td className="py-om-8 pe-om-10 font-om-mono text-om-xs text-om-primary">{job.collectorId}</td>
                        <td className="py-om-8 pe-om-10 font-om-mono text-om-2xs text-om-secondary">{job.node.id}</td>
                        <td className="py-om-8 pe-om-10">
                          <Tag variant="state" state={jobState(job.status)} icon={<Dot state={jobState(job.status)} pulse={job.status === 'running'} />}>
                            {jobStatusLabel(t, job.status)}
                          </Tag>
                        </td>
                        <td className="py-om-8 pe-om-10 text-end font-om-mono text-om-xs tabular-nums text-om-secondary">{format.integer(job.targets)}</td>
                        <td className="py-om-8 pe-om-10 text-end font-om-mono text-om-xs tabular-nums text-om-primary">{format.integer(job.cisEmitted)}</td>
                        <td className={cx('py-om-8 pe-om-10 text-end font-om-mono text-om-xs tabular-nums', job.errors > 0 ? 'text-om-rose' : 'text-om-secondary')}>{format.integer(job.errors)}</td>
                        <td className="py-om-8 pe-om-10 text-om-xs text-om-secondary">{format.dateTime(job.scheduledAt)}</td>
                        <td className="py-om-8 text-end font-om-mono text-om-xs tabular-nums text-om-secondary">
                          {seconds === undefined ? t('discovery.jobs.notStarted') : t('discovery.jobs.duration', { seconds: format.integer(seconds) })}
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
          )}
        </Card>
      </div>
    </div>
  );
}
