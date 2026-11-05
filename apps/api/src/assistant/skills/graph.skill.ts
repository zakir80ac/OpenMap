// REQ-AI-001 REQ-AI-007 (ADR-028) — the graph-side skills: `impact` through the dependency graph's impact closure
// with predicted states, `history` from the bitemporal CI versions, and `graph.query`, the validated NL→Cypher path
// of REQ-AI-001 kept as the fallback for open-ended lookups. A name that is ambiguous or unknown is a
// clarification; an unanswerable question is a refusal with its reason, never a guess.
import { Inject, Injectable } from '@nestjs/common';
import { GRAPH } from '@openmap/constants';
import {
  ask,
  AssistantError,
  type ImpactLine,
  type LlmClient,
  type SkillParams,
  type Summary,
} from '@openmap/assistant';
import { CI_REPOSITORY, type CiRepository } from '../../ci/ci.repository.js';
import type { CiRecord } from '../../ci/ci.types.js';
import { isUuid } from '../../common/uuid.js';
import { GraphService } from '../../db/graph.service.js';
import { GraphQueryService } from '../../graph/graph.service.js';
import { EntityResolver } from '../entity.resolver.js';
import {
  failed,
  nameClarification,
  result,
  settled,
  startTimer,
  type SkillContext,
  type SkillOutcome,
} from './skill.js';

type ImpactParams = Extract<SkillParams, { skill: 'impact' }>;
type HistoryParams = Extract<SkillParams, { skill: 'history' }>;
type GraphParams = Extract<SkillParams, { skill: 'graph.query' }>;

/** UUIDs appearing anywhere in the result rows; they are resolved to CIs for the console to link. */
export function ciIdsIn(rows: ReadonlyArray<Record<string, unknown>>): string[] {
  const ids = new Set<string>();
  const visit = (v: unknown): void => {
    if (isUuid(v)) ids.add(v);
    else if (Array.isArray(v)) v.forEach(visit);
    else if (v !== null && typeof v === 'object') Object.values(v as Record<string, unknown>).forEach(visit);
  };
  rows.forEach(visit);
  return [...ids];
}

/** Attribute keys whose value differs between two versions of a CI. */
export function changedKeys(before: Record<string, unknown>, after: Record<string, unknown>): string[] {
  const keys = new Set([...Object.keys(before), ...Object.keys(after)]);
  return [...keys].filter((k) => JSON.stringify(before[k]) !== JSON.stringify(after[k])).sort();
}

@Injectable()
export class GraphSkill {
  constructor(
    private readonly impactService: GraphQueryService,
    private readonly graph: GraphService,
    private readonly resolver: EntityResolver,
    @Inject(CI_REPOSITORY) private readonly cis: CiRepository,
  ) {}

  private async one(
    step: { names: string[] },
    context: SkillContext,
  ): Promise<{ ci: CiRecord | null; clarification: SkillOutcome['clarification'] }> {
    const name = step.names[0];
    if (name === undefined)
      return { ci: null, clarification: { key: 'assistant.clarify.needName', params: {}, options: [] } };
    // "the host named X" narrows an ambiguous name to the types the question used before the person is asked.
    let resolution = await this.resolver.resolve(context.tenantId, name);
    if (resolution.exact.length > 1 && context.types.length > 0) {
      const narrowed = await this.resolver.resolve(context.tenantId, name, context.types);
      if (narrowed.exact.length > 0) resolution = narrowed;
    }
    const ci = settled(resolution);
    return ci === null
      ? { ci: null, clarification: nameClarification(resolution, context.question) }
      : { ci, clarification: null };
  }

  async impact(step: ImpactParams, context: SkillContext): Promise<SkillOutcome> {
    const elapsed = startTimer();
    const target = await this.one(step, context);
    if (target.ci === null) return { results: [], clarification: target.clarification };
    const query =
      'impact(ciId=' +
      target.ci.id +
      ', direction=' +
      step.direction +
      ', maxDepth=' +
      String(GRAPH.defaultImpactDepth) +
      ')';
    const params = { ci: target.ci.displayName, direction: step.direction };
    try {
      const view = await this.impactService.impact(
        context.tenantId,
        target.ci.id,
        step.direction,
        GRAPH.defaultImpactDepth,
        null,
      );
      const services: ImpactLine[] = view.services.map((s) => ({
        ciId: s.service.id,
        name: s.service.displayName,
        predicted: s.predicted,
      }));
      const summary: Summary = {
        kind: 'impact',
        root: { ciId: target.ci.id, name: target.ci.displayName },
        direction: step.direction,
        services,
        down: services.filter((s) => s.predicted === 'down').length,
        degraded: services.filter((s) => s.predicted === 'degraded').length,
        nodes: view.nodes.length,
      };
      const rows = services.map((s) => ({ service: s.name, predicted: s.predicted }));
      return {
        results: [
          result(step, 'memgraph', query, params, rows, elapsed(), summary, [
            target.ci.id,
            ...services.map((s) => s.ciId),
          ]),
        ],
        clarification: null,
      };
    } catch (err) {
      return {
        results: [
          failed(
            step,
            'memgraph',
            query,
            params,
            elapsed(),
            err instanceof Error ? err.message : String(err),
          ),
        ],
        clarification: null,
      };
    }
  }

  async history(step: HistoryParams, context: SkillContext): Promise<SkillOutcome> {
    const elapsed = startTimer();
    const target = await this.one(step, context);
    if (target.ci === null) return { results: [], clarification: target.clarification };
    const query = 'versions(ciId=' + target.ci.id + ')';
    const params = { ci: target.ci.displayName };
    try {
      const versions = [...(await this.cis.versions(context.tenantId, target.ci.id, null, null))].sort(
        (a, b) => a.validFrom.localeCompare(b.validFrom),
      );
      const latest = versions.at(-1);
      const previous = versions.slice(0, -1).at(-1);
      const summary: Summary = {
        kind: 'history',
        ci: { ciId: target.ci.id, name: target.ci.displayName },
        versions: versions.length,
        latestAt: latest?.validFrom ?? null,
        changedKeys:
          latest !== undefined && previous !== undefined
            ? changedKeys(previous.attributes, latest.attributes)
            : [],
      };
      const rows = versions.map((v) => ({
        validFrom: v.validFrom,
        validTo: v.validTo,
        observedAt: v.observedAt,
        checksum: v.checksum,
      }));
      return {
        results: [result(step, 'postgres', query, params, rows, elapsed(), summary, [target.ci.id])],
        clarification: null,
      };
    } catch (err) {
      return {
        results: [
          failed(
            step,
            'postgres',
            query,
            params,
            elapsed(),
            err instanceof Error ? err.message : String(err),
          ),
        ],
        clarification: null,
      };
    }
  }

  async query(step: GraphParams, context: SkillContext, llm: LlmClient): Promise<SkillOutcome> {
    const elapsed = startTimer();
    try {
      const answer = await ask(step.question, context.tenantId, llm, this.graph.repo);
      const summary: Summary = { kind: 'graph', rows: answer.rows, truncated: answer.truncated };
      return {
        results: [
          result(
            step,
            'memgraph',
            answer.cypher,
            { tenantId: context.tenantId },
            answer.rows,
            elapsed(),
            summary,
            ciIdsIn(answer.rows),
          ),
        ],
        clarification: null,
      };
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      const cypher = err instanceof AssistantError ? (err.cypher ?? '') : '';
      return {
        results: [failed(step, 'memgraph', cypher, { tenantId: context.tenantId }, elapsed(), message)],
        clarification: null,
      };
    }
  }
}
