// REQ-AI-005 (ADR-054) — cloud recommendations as the Utilisation screen reads them.
import { queryOptions } from '@tanstack/react-query';
import type { CloudRecommendationKind } from '@openmap/contracts';
import { gql } from './graphql';
import { CI_SUMMARY_FIELDS, type CiSummary } from './queries';

export interface CloudRecommendation {
  ci: CiSummary;
  kind: CloudRecommendationKind;
  savingUsd: number;
  averageLoad: number | null;
  peakLoad: number | null;
  samples: number;
  loadAt: string | null;
  sku: string | null;
  state: string | null;
  monthlyCostUsd: number | null;
  owner: string | null;
  environment: string | null;
}

export interface CloudAdvice {
  items: CloudRecommendation[];
  resources: number;
  monthlySavingUsd: number;
  asOf: string;
}

export function cloudAdviceQuery() {
  return queryOptions({
    queryKey: ['cloud-advice'] as const,
    queryFn: ({ signal }) =>
      gql<{ cloudAdvice: CloudAdvice }>(
        'query CloudAdvice { cloudAdvice { resources monthlySavingUsd asOf items { ci { ' + CI_SUMMARY_FIELDS + ' } kind savingUsd averageLoad peakLoad samples loadAt sku state monthlyCostUsd owner environment } } }',
        undefined,
        signal,
      ).then((d) => d.cloudAdvice),
  });
}
