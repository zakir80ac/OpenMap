// REQ-AI-007 (ADR-028) — the shapes the levels of a conversation hand each other: a plan of skill steps with
// validated parameters, the structured result each step returns (query, rows, duration, a typed summary), and the
// clarification the plan asks for instead of guessing. The API executes steps; this package decides and composes.
import type {
  AssistantAggregate,
  AssistantOption,
  AssistantSkill,
  AssistantStore,
  CiType,
  HealthState,
} from '@openmap/contracts';
import type { MessageKey, Params } from '@openmap/i18n';
import type { GroupBy } from './intent.js';
import type { AttributeFamilyId, MeasurementName, PeriodSpec } from './vocabulary.js';

export const HOWTO_TOPICS = [
  'cmdb',
  'ipam',
  'dcim',
  'assets',
  'services',
  'impact',
  'discovery',
  'dashboards',
  'settings',
  'assistant',
  'reports',
  'layers',
] as const;
export type HowtoTopic = (typeof HOWTO_TOPICS)[number];

export type ImpactDirection = 'upstream' | 'downstream';

export type SkillParams =
  | { skill: 'graph.query'; question: string }
  | {
      skill: 'cmdb.attributes';
      type: CiType;
      aggregate: AssistantAggregate;
      family: AttributeFamilyId | null;
      groupBy: GroupBy | null;
      filters: string[];
      health: HealthState | null;
      topN: number;
    }
  | {
      skill: 'metrics.latest';
      metric: MeasurementName;
      type: CiType;
      aggregate: AssistantAggregate;
      filters: string[];
      topN: number;
    }
  | { skill: 'services.availability'; granularity: PeriodSpec['granularity']; back: number; names: string[] }
  | { skill: 'incidents'; open: boolean; names: string[] }
  | { skill: 'impact'; names: string[]; direction: ImpactDirection }
  | { skill: 'history'; names: string[]; period: PeriodSpec | null }
  | { skill: 'howto'; topic: HowtoTopic };

export type PlanStep = SkillParams & { skill: AssistantSkill };

/** A choice offered back: a CI (label and id) or a suggested question given as an i18n key the API renders. */
export type ClarificationOption = AssistantOption | { key: MessageKey };

/** A question back to the person, as an i18n key with parameters so the API renders it in the answer's locale. */
export interface Clarification {
  key: MessageKey;
  params: Params;
  options: ClarificationOption[];
}

export interface Plan {
  steps: PlanStep[];
  clarification: Clarification | null;
}

export interface GroupCount {
  label: string;
  count: number;
  /** The aggregate within the group when the question asked for one ("average memory per site"), else null. */
  value: number | null;
}

export interface RankedCi {
  ciId: string;
  name: string;
  value: number;
}

export interface AvailabilityLine {
  ciId: string;
  name: string;
  availabilityPercent: number | null;
  downtimeMinutes: number;
  targetPercent: number | null;
  met: boolean | null;
}

export interface IncidentLine {
  id: string;
  title: string;
  severity: string;
  state: string;
  serviceName: string | null;
}

export interface ImpactLine {
  ciId: string;
  name: string;
  predicted: string;
}

/** What a skill found, typed so the composer can word it and the guard can check the model's prose against it. */
export type Summary =
  | { kind: 'count'; type: CiType; count: number; filters: string[]; health: HealthState | null }
  | {
      kind: 'groups';
      type: CiType;
      dimension:
        { kind: 'attribute'; family: AttributeFamilyId; key: string } | { kind: 'type'; type: CiType };
      groups: GroupCount[];
      total: number;
      filters: string[];
      /** Unit of `GroupCount.value` when the groups carry an aggregate. */ unit: string;
    }
  | {
      kind: 'aggregate';
      type: CiType;
      family: AttributeFamilyId;
      key: string;
      aggregate: Exclude<AssistantAggregate, 'count' | 'distribution'>;
      value: number;
      unit: string;
      count: number;
      filters: string[];
    }
  | {
      kind: 'density';
      type: CiType;
      counterpart: CiType;
      relationship: string;
      avg: number;
      max: number;
      groups: number;
      total: number;
      filters: string[];
    }
  | {
      kind: 'measurement';
      metric: MeasurementName;
      type: CiType;
      aggregate: AssistantAggregate;
      value: number | null;
      unit: string;
      count: number;
      asOf: string | null;
      ranked: RankedCi[];
      filters: string[];
    }
  | {
      kind: 'availability';
      granularity: PeriodSpec['granularity'];
      back: number;
      periodStart: string;
      lines: AvailabilityLine[];
      estatePercent: number | null;
      belowTarget: number;
      downtimeMinutes: number;
    }
  | { kind: 'incidents'; open: boolean; lines: IncidentLine[]; scopeName: string | null }
  | {
      kind: 'impact';
      root: { ciId: string; name: string };
      direction: ImpactDirection;
      services: ImpactLine[];
      down: number;
      degraded: number;
      nodes: number;
    }
  | {
      kind: 'history';
      ci: { ciId: string; name: string };
      versions: number;
      latestAt: string | null;
      changedKeys: string[];
    }
  | { kind: 'howto'; topic: HowtoTopic }
  | { kind: 'graph'; rows: Array<Record<string, unknown>>; truncated: boolean }
  | { kind: 'unresolvedFilter'; value: string };

export interface SkillResult {
  step: PlanStep;
  store: AssistantStore;
  /** The query as run (SQL, Cypher or the service call), for the evidence. */
  query: string;
  params: Record<string, unknown>;
  rows: Array<Record<string, unknown>>;
  durationMs: number;
  error: string | null;
  summary: Summary | null;
  /** CIs the answer names; the API resolves them for the console to link. */
  ciIds: string[];
}
