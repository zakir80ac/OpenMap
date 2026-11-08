// REQ-AI-002 (ADR-052) — classification suggestions for unknown CIs, as the Layers screen reads and decides them.
import { queryOptions } from '@tanstack/react-query';
import type { CiLayer } from '@openmap/contracts';
import { gql } from './graphql';
import { CI_SUMMARY_FIELDS, type CiSummary } from './queries';

export interface ClassificationEvidence {
  signal: 'sysDescr' | 'banner' | 'vendor' | 'ports';
  value: string;
  weight: number;
}

export interface ClassificationSuggestion {
  id: string;
  ci: CiSummary;
  deviceClass: string;
  layer: CiLayer;
  type: string | null;
  title: string;
  confidence: number;
  evidence: ClassificationEvidence[];
}

export interface ClassificationSummary {
  open: ClassificationSuggestion[];
  unrecognised: number;
  accepted: number;
  dismissed: number;
  acceptanceRate: number | null;
}

const FIELDS = 'id ci { ' + CI_SUMMARY_FIELDS + ' } deviceClass layer type title confidence evidence { signal value weight }';

export const classificationKey = ['classification-suggestions'] as const;

export function classificationQuery() {
  return queryOptions({
    queryKey: classificationKey,
    queryFn: ({ signal }) =>
      gql<{ classificationSuggestions: ClassificationSummary }>(
        'query Classification { classificationSuggestions { open { ' + FIELDS + ' } unrecognised accepted dismissed acceptanceRate } }',
        undefined,
        signal,
      ).then((d) => d.classificationSuggestions),
  });
}

export function decideClassification(id: string, decision: 'accept' | 'dismiss'): Promise<void> {
  const field = decision === 'accept' ? 'acceptClassificationSuggestion' : 'dismissClassificationSuggestion';
  return gql<Record<string, unknown>>('mutation Decide($id: UUID!) { ' + field + '(id: $id) { id state } }', { id }).then(() => undefined);
}
