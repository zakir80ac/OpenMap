// REQ-AI-003 (ADR-053) — anomaly findings over discovery and health events, as the Anomalies screen reads them.
import { queryOptions } from '@tanstack/react-query';
import type { AnomalyRule } from '@openmap/contracts';
import type { Locale } from '@openmap/i18n';
import { gql } from './graphql';
import { CI_SUMMARY_FIELDS, type CiSummary } from './queries';

export interface AnomalyFinding {
  id: string;
  rule: AnomalyRule;
  subject: CiSummary | null;
  facts: Array<{ key: string; value: string }>;
  state: 'open' | 'cleared';
  detectedAt: string;
  lastSeenAt: string;
  clearedAt: string | null;
  explanation: string | null;
  explanationLocale: string | null;
}

export interface AnomalyReport {
  findings: AnomalyFinding[];
  open: number;
  lastSweepAt: string | null;
}

const FIELDS =
  'findings { id rule subject { ' + CI_SUMMARY_FIELDS + ' } facts { key value } state detectedAt lastSeenAt clearedAt explanation explanationLocale } open lastSweepAt';

export const anomaliesKey = ['anomalies'] as const;

export function anomaliesQuery(refetchMs: number) {
  return queryOptions({
    queryKey: anomaliesKey,
    queryFn: ({ signal }) => gql<{ anomalies: AnomalyReport }>('query Anomalies { anomalies { ' + FIELDS + ' } }', undefined, signal).then((d) => d.anomalies),
    refetchInterval: refetchMs,
  });
}

export function detectAnomalies(): Promise<AnomalyReport> {
  return gql<{ detectAnomalies: AnomalyReport }>('mutation Detect { detectAnomalies { ' + FIELDS + ' } }').then((d) => d.detectAnomalies);
}

export function explainAnomaly(id: string, locale: Locale): Promise<string | null> {
  return gql<{ explainAnomaly: { explanation: string | null } }>('mutation Explain($id: UUID!, $locale: String!) { explainAnomaly(id: $id, locale: $locale) { id explanation } }', { id, locale }).then(
    (d) => d.explainAnomaly.explanation,
  );
}
