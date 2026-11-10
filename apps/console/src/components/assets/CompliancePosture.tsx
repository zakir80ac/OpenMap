'use client';
// REQ-SEC-012 (ADR-070) — the Assets screen's compliance posture tab: the latest evaluation's CVE risk, one card per
// framework (audit pass rate, control results, high-risk CIs), the selected framework's controls with their tallies,
// and a control's decisions with the CI, the reason and the facts that decided each, high-risk CIs first. Operators
// and auditors run a new evaluation; everyone else reads the last one.
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { COMPLIANCE, ROLES, TIME } from '@openmap/constants';
import { COMPLIANCE_RESULTS, type ComplianceFramework, type ComplianceResult } from '@openmap/contracts';
import { isMessageKey, type Locale, type MessageKey } from '@openmap/i18n';
import { Bar, Card, Kpi, SectionTitle, StateBadge, Tag, cx, stateColor, type UiState } from '@openmap/ui';
import Link from 'next/link';
import { useState, type ReactNode } from 'react';
import { Button, Select, rowClass, tableClass, tdClass, thClass, theadClass } from '@/components/common/controls';
import { QueryState } from '@/components/common/QueryState';
import { useCan } from '@/lib/auth';
import {
  complianceControlQuery,
  compliancePostureKey,
  compliancePostureQuery,
  evaluateCompliance,
  type ComplianceFinding,
  type ComplianceFrameworkPosture,
} from '@/lib/compliance-queries';
import { localizedHref } from '@/lib/locale-path';
import { useFormatters, useT } from '@/providers';

const RESULT_STATE: Record<ComplianceResult, UiState> = { pass: 'healthy', fail: 'down', not_applicable: 'unknown' };
const ISO_INSTANT = /^\d+-\d+-\d+(T[\d:.]+Z?)?$/;

/** The tone of a pass rate: healthy at or above COMPLIANCE.passRateHealthy, down below passRateAtRisk. */
export function passRateState(rate: number | null): UiState {
  if (rate === null) return 'unknown';
  if (rate >= COMPLIANCE.passRateHealthy) return 'healthy';
  return rate >= COMPLIANCE.passRateAtRisk ? 'at_risk' : 'down';
}

function frameworkKey(framework: ComplianceFramework): MessageKey {
  return ('assets.compliance.framework.' + framework) as MessageKey;
}

function controlKey(framework: ComplianceFramework, controlId: string): MessageKey | null {
  const key = 'assets.compliance.control.' + framework + '.' + controlId;
  return isMessageKey(key) ? key : null;
}

export interface CompliancePostureProps {
  locale: Locale;
}

export function CompliancePosture({ locale }: CompliancePostureProps): ReactNode {
  const t = useT();
  const format = useFormatters();
  const can = useCan();
  const queryClient = useQueryClient();
  const canEvaluate = can(ROLES.operator) || can(ROLES.auditor);
  const posture = useQuery(compliancePostureQuery());
  const [selected, setSelected] = useState<ComplianceFramework | null>(null);
  const [control, setControl] = useState<string | null>(null);
  const evaluate = useMutation({
    mutationFn: evaluateCompliance,
    onSuccess: (next) => {
      queryClient.setQueryData(compliancePostureKey, next);
      void queryClient.invalidateQueries({ queryKey: ['complianceControl'] });
    },
  });

  if (posture.isPending) return <QueryState status="pending" />;
  if (posture.isError)
    return (
      <QueryState
        status="error"
        onRetry={() => {
          void posture.refetch();
        }}
      />
    );
  const { run, frameworks, cveRisk } = posture.data;
  const current = frameworks.find((f) => f.framework === selected) ?? frameworks[0] ?? null;

  const evaluateButton = canEvaluate ? (
    <Button
      data-testid="compliance-evaluate"
      disabled={evaluate.isPending}
      onClick={() => {
        evaluate.mutate();
      }}
    >
      {evaluate.isPending ? t('assets.compliance.evaluating') : t('assets.compliance.evaluate')}
    </Button>
  ) : null;

  return (
    <div className="flex flex-col gap-om-16" data-testid="compliance-posture">
      <Card padding="24" as="section" className="flex flex-col gap-om-16">
        <SectionTitle as="h2" size="sm" description={t('assets.compliance.subtitle')} action={evaluateButton}>
          {t('assets.compliance.title')}
        </SectionTitle>
        {evaluate.isError ? (
          <p role="alert" className="text-om-xs text-om-rose">
            {t('assets.compliance.evaluateError')}
          </p>
        ) : null}
        {run === null ? (
          <p className="text-om-sm text-om-secondary" data-testid="compliance-never">
            {canEvaluate ? t('assets.compliance.never') : t('assets.compliance.neverReadOnly')}
          </p>
        ) : (
          <p className="font-om-mono text-om-xs text-om-muted" data-testid="compliance-last-run">
            {t('assets.compliance.lastRun', {
              when: format.dateTime(run.finishedAt),
              who: run.triggeredBy,
              seconds: format.number(run.durationMs / TIME.msPerSecond),
              version: run.catalogueVersion,
            })}
          </p>
        )}
        {cveRisk !== null ? (
          <div className="grid grid-cols-2 gap-om-12 md:grid-cols-4">
            <Kpi label={t('assets.compliance.kpi.critical')} value={format.integer(cveRisk.critical)} delta={cveRisk.critical} deltaLabel="" lowerIsBetter />
            <Kpi label={t('assets.compliance.kpi.high')} value={format.integer(cveRisk.high)} delta={cveRisk.high} deltaLabel="" lowerIsBetter />
            <Kpi label={t('assets.compliance.kpi.exploited')} value={format.integer(cveRisk.exploited)} delta={cveRisk.exploited} deltaLabel="" lowerIsBetter />
            <Kpi label={t('assets.compliance.kpi.exposed')} value={format.integer(cveRisk.exposedCis)} delta={cveRisk.exposedCis} deltaLabel="" lowerIsBetter />
          </div>
        ) : null}
      </Card>

      {frameworks.length > 0 ? (
        <div className="grid grid-cols-1 gap-om-12 md:grid-cols-2 xl:grid-cols-5" role="group" aria-label={t('assets.compliance.frameworks')}>
          {frameworks.map((f) => (
            <FrameworkCard
              key={f.framework}
              posture={f}
              selected={current?.framework === f.framework}
              onSelect={() => {
                setSelected(f.framework);
                setControl(null);
              }}
            />
          ))}
        </div>
      ) : null}

      {current !== null && run !== null ? (
        <Card padding="24" as="section" className="flex flex-col gap-om-12">
          <SectionTitle as="h3" size="sm" description={current.edition}>
            {t('assets.compliance.controls.title', { framework: t(frameworkKey(current.framework)) })}
          </SectionTitle>
          <div className="overflow-x-auto">
            <table className={tableClass} data-testid="compliance-controls" data-framework={current.framework}>
              <thead className={theadClass}>
                <tr>
                  <th scope="col" className={thClass}>
                    {t('assets.compliance.table.control')}
                  </th>
                  <th scope="col" className={thClass}>
                    {t('assets.compliance.table.checks')}
                  </th>
                  <th scope="col" className={thClass}>
                    {t('assets.compliance.table.result')}
                  </th>
                  <th scope="col" className={thClass}>
                    {t('assets.compliance.table.tally')}
                  </th>
                </tr>
              </thead>
              <tbody>
                {current.controls.map((c) => {
                  const title = controlKey(current.framework, c.controlId);
                  return (
                    <tr key={c.controlId} className={rowClass} data-control={c.controlId} data-result={c.result} data-selected={control === c.controlId ? 'true' : undefined}>
                      <td className={tdClass}>
                        <button
                          type="button"
                          className="flex flex-col items-start text-start"
                          aria-pressed={control === c.controlId}
                          aria-label={t('assets.compliance.table.open', { control: c.controlId })}
                          onClick={() => {
                            setControl(control === c.controlId ? null : c.controlId);
                          }}
                        >
                          <span className="font-om-mono text-om-xs text-om-cyan">{c.controlId}</span>
                          {title !== null ? <span className="text-om-sm text-om-primary">{t(title)}</span> : null}
                        </button>
                      </td>
                      <td className={tdClass}>
                        <span className="flex flex-wrap gap-om-4">
                          {c.checks.map((check) => (
                            <Tag key={check}>{t(('assets.compliance.check.' + check) as MessageKey)}</Tag>
                          ))}
                        </span>
                      </td>
                      <td className={tdClass}>
                        <StateBadge state={RESULT_STATE[c.result]} label={t(('assets.compliance.result.' + c.result) as MessageKey)} />
                      </td>
                      <td className={tdClass + ' font-om-mono tabular-nums text-om-secondary'}>
                        {format.integer(c.tally.passed)} · {format.integer(c.tally.failed)} · {format.integer(c.tally.notApplicable)}
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
          {control !== null ? <ControlFindings key={current.framework + control} locale={locale} framework={current.framework} controlId={control} runId={run.id} /> : null}
        </Card>
      ) : null}
    </div>
  );
}

interface FrameworkCardProps {
  posture: ComplianceFrameworkPosture;
  selected: boolean;
  onSelect: () => void;
}

function FrameworkCard({ posture, selected, onSelect }: FrameworkCardProps): ReactNode {
  const t = useT();
  const format = useFormatters();
  const state = passRateState(posture.passRate);
  const name = t(frameworkKey(posture.framework));
  const percent = posture.passRate === null ? null : Number((posture.passRate * COMPLIANCE.percentScale).toFixed(COMPLIANCE.percentDecimals));
  return (
    <button
      type="button"
      onClick={onSelect}
      aria-pressed={selected}
      aria-label={t('assets.compliance.select', { framework: name })}
      data-testid="compliance-framework"
      data-framework={posture.framework}
      data-state={state}
      className={cx(
        'flex flex-col gap-om-10 rounded-om-panel border bg-om-surface2 p-om-16 text-start transition-colors duration-om-base',
        selected ? 'border-om-cyan' : 'border-om-border-glass hover:border-om-border-strong',
      )}
    >
      <span className="flex items-baseline justify-between gap-om-8">
        <span className="font-om-display text-om-sm font-semibold text-om-primary">{name}</span>
        <StateBadge state={state} label={t('assets.compliance.passRate')} />
      </span>
      <span className="font-om-mono text-om-2xs text-om-muted">{posture.edition}</span>
      <span className="font-om-display text-om-2xl font-semibold tabular-nums text-om-primary" data-testid="compliance-pass-rate">
        {percent === null ? t('assets.compliance.noPassRate') : t('assets.compliance.percent', { value: format.number(percent) })}
      </span>
      <Bar value={percent ?? 0} max={COMPLIANCE.percentScale} accent={stateColor(state)} label={t('assets.compliance.passRate')} />
      <span className="text-om-xs text-om-secondary">
        {t('assets.compliance.controlCounts', {
          passed: format.integer(posture.controlsPassed),
          failed: format.integer(posture.controlsFailed),
          na: format.integer(posture.controlsNotApplicable),
        })}
      </span>
      <span className="flex items-center justify-between text-om-xs">
        <span className="text-om-secondary">{t('assets.compliance.highRisk')}</span>
        <span className={cx('font-om-mono tabular-nums', posture.highRiskCis > 0 ? 'text-om-rose' : 'text-om-emerald')} data-testid="compliance-high-risk">
          {format.integer(posture.highRiskCis)}
        </span>
      </span>
      <span className="text-om-2xs text-om-muted">
        {t('assets.compliance.evaluations', { count: format.integer(posture.evaluations.passed + posture.evaluations.failed + posture.evaluations.notApplicable) })}
      </span>
    </button>
  );
}

interface ControlFindingsProps {
  locale: Locale;
  framework: ComplianceFramework;
  controlId: string;
  runId: string;
}

function ControlFindings({ locale, framework, controlId, runId }: ControlFindingsProps): ReactNode {
  const t = useT();
  const [result, setResult] = useState<ComplianceResult>('fail');
  const detail = useQuery(complianceControlQuery(framework, controlId, result, runId));
  return (
    <section className="flex flex-col gap-om-10 rounded-om-panel border border-om-border-glass bg-om-surface2 p-om-16" data-testid="compliance-findings" aria-label={t('assets.compliance.findings.title', { control: controlId })}>
      <div className="flex flex-wrap items-end justify-between gap-om-10">
        <h4 className="font-om-display text-om-sm font-semibold text-om-primary">{t('assets.compliance.findings.title', { control: controlId })}</h4>
        <label className="flex items-center gap-om-8 text-om-xs text-om-secondary">
          <span>{t('assets.compliance.findings.filter')}</span>
          <Select
            data-testid="compliance-result-filter"
            value={result}
            onChange={(event) => {
              setResult(event.target.value as ComplianceResult);
            }}
            className="w-auto"
          >
            {COMPLIANCE_RESULTS.map((r) => (
              <option key={r} value={r}>
                {t(('assets.compliance.result.' + r) as MessageKey)}
              </option>
            ))}
          </Select>
        </label>
      </div>
      {detail.isPending ? (
        <QueryState status="pending" />
      ) : detail.isError ? (
        <QueryState
          status="error"
          onRetry={() => {
            void detail.refetch();
          }}
        />
      ) : detail.data.findings.length === 0 ? (
        <p className="text-om-sm text-om-secondary">{t('assets.compliance.findings.empty')}</p>
      ) : (
        <div className="max-h-[28rem] overflow-y-auto">
          <table className={tableClass}>
            <thead className={theadClass}>
              <tr>
                <th scope="col" className={thClass}>
                  {t('assets.compliance.findings.subject')}
                </th>
                <th scope="col" className={thClass}>
                  {t('assets.compliance.findings.reason')}
                </th>
                <th scope="col" className={thClass}>
                  {t('assets.compliance.findings.facts')}
                </th>
              </tr>
            </thead>
            <tbody>
              {detail.data.findings.map((f, i) => (
                <FindingRow key={i} finding={f} locale={locale} />
              ))}
            </tbody>
          </table>
          {detail.data.truncated ? (
            <p className="mt-om-8 text-om-xs text-om-muted">{t('assets.compliance.findings.truncated', { count: String(detail.data.findings.length) })}</p>
          ) : null}
        </div>
      )}
    </section>
  );
}

function FindingRow({ finding, locale }: { finding: ComplianceFinding; locale: Locale }): ReactNode {
  const t = useT();
  const format = useFormatters();
  const value = (raw: string | null): string => {
    if (raw === null) return t('common.none');
    if (raw === 'true') return t('common.yes');
    if (raw === 'false') return t('common.no');
    if (ISO_INSTANT.test(raw)) return format.date(raw);
    const n = Number(raw);
    return raw.trim() !== '' && Number.isFinite(n) ? format.number(n) : raw;
  };
  return (
    <tr className={rowClass} data-testid="compliance-finding" data-high-risk={finding.highRisk ? 'true' : 'false'} data-check={finding.check}>
      <td className={tdClass}>
        <span className="flex flex-col gap-om-4">
          {finding.ci === null ? (
            <span className="text-om-primary">{t('assets.compliance.findings.deployment')}</span>
          ) : (
            <Link href={localizedHref(locale, '/cmdb/' + encodeURIComponent(finding.ci.id))} className="text-om-cyan hover:underline">
              {finding.ci.displayName}
            </Link>
          )}
          <span className="text-om-2xs text-om-muted">{t(('assets.compliance.check.' + finding.check) as MessageKey)}</span>
          {finding.highRisk ? (
            <span>
              <Tag variant="state" state="down">
                {t('assets.compliance.findings.highRisk')}
              </Tag>
            </span>
          ) : null}
        </span>
      </td>
      <td className={tdClass + ' text-om-secondary'}>{t(('assets.compliance.reason.' + finding.reason) as MessageKey)}</td>
      <td className={tdClass}>
        <span className="flex flex-wrap gap-om-4">
          {finding.facts.map((fact) => {
            const label = 'assets.compliance.fact.' + fact.key;
            return (
              <Tag key={fact.key}>
                {isMessageKey(label) ? t(label) : fact.key}: <span className="font-om-mono">{value(fact.value)}</span>
              </Tag>
            );
          })}
        </span>
      </td>
    </tr>
  );
}
