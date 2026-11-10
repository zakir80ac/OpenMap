// REQ-SEC-012 (ADR-070) — compliance posture as the Assets screen's posture tab reads it: the latest evaluation per
// framework, one control's findings, and running a new evaluation (operators and auditors).
import { queryOptions } from '@tanstack/react-query';
import { COMPLIANCE } from '@openmap/constants';
import type { ComplianceCheck, ComplianceFramework, ComplianceReason, ComplianceResult } from '@openmap/contracts';
import { gql } from './graphql';
import { CI_SUMMARY_FIELDS, type CiSummary } from './queries';

export interface ComplianceTally {
  passed: number;
  failed: number;
  notApplicable: number;
}

export interface ComplianceControlPosture {
  controlId: string;
  checks: ComplianceCheck[];
  result: ComplianceResult;
  tally: ComplianceTally;
}

export interface ComplianceFrameworkPosture {
  framework: ComplianceFramework;
  edition: string;
  passRate: number | null;
  evaluations: ComplianceTally;
  controlsPassed: number;
  controlsFailed: number;
  controlsNotApplicable: number;
  controls: ComplianceControlPosture[];
  highRiskCis: number;
}

export interface ComplianceRun {
  id: string;
  catalogueVersion: string;
  startedAt: string;
  finishedAt: string;
  durationMs: number;
  triggeredBy: string;
}

export interface CompliancePosture {
  run: ComplianceRun | null;
  frameworks: ComplianceFrameworkPosture[];
  cveRisk: { critical: number; high: number; exploited: number; exposedCis: number } | null;
}

export interface ComplianceFinding {
  check: ComplianceCheck;
  result: ComplianceResult;
  reason: ComplianceReason;
  ci: CiSummary | null;
  facts: Array<{ key: string; value: string | null }>;
  highRisk: boolean;
}

export interface ComplianceControlDetail {
  framework: ComplianceFramework;
  controlId: string;
  checks: ComplianceCheck[];
  result: ComplianceResult;
  tally: ComplianceTally;
  findings: ComplianceFinding[];
  truncated: boolean;
}

const TALLY = 'passed failed notApplicable';
const POSTURE_FIELDS =
  'run { id catalogueVersion startedAt finishedAt durationMs triggeredBy } frameworks { framework edition passRate evaluations { ' +
  TALLY +
  ' } controlsPassed controlsFailed controlsNotApplicable controls { controlId checks result tally { ' +
  TALLY +
  ' } } highRiskCis } cveRisk { critical high exploited exposedCis }';

export const compliancePostureKey = ['compliancePosture'] as const;

export function compliancePostureQuery() {
  return queryOptions({
    queryKey: compliancePostureKey,
    queryFn: ({ signal }) =>
      gql<{ compliancePosture: CompliancePosture }>('query CompliancePosture { compliancePosture { ' + POSTURE_FIELDS + ' } }', undefined, signal).then(
        (d) => d.compliancePosture,
      ),
  });
}

export function complianceControlQuery(framework: ComplianceFramework, controlId: string, result: ComplianceResult, runId: string | null) {
  return queryOptions({
    queryKey: ['complianceControl', framework, controlId, result, runId] as const,
    queryFn: ({ signal }) =>
      gql<{ complianceControl: ComplianceControlDetail }>(
        'query ComplianceControl($framework: ComplianceFramework!, $controlId: String!, $result: ComplianceResult!, $first: Int!) { complianceControl(framework: $framework, controlId: $controlId, result: $result, first: $first) { framework controlId checks result tally { ' +
          TALLY +
          ' } findings { check result reason highRisk ci { ' +
          CI_SUMMARY_FIELDS +
          ' } facts { key value } } truncated } }',
        { framework, controlId, result, first: COMPLIANCE.findingsPageSize },
        signal,
      ).then((d) => d.complianceControl),
  });
}

export function evaluateCompliance(): Promise<CompliancePosture> {
  return gql<{ evaluateCompliance: CompliancePosture }>('mutation EvaluateCompliance { evaluateCompliance { ' + POSTURE_FIELDS + ' } }').then(
    (d) => d.evaluateCompliance,
  );
}
