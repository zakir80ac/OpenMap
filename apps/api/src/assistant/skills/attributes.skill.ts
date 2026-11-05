// REQ-AI-007 (ADR-028) — `cmdb.attributes`: counts, breakdowns and numeric aggregates over CI attributes in
// Postgres, and fan-out density over relationships ("VMs per hypervisor"), computed in SQL where aggregates belong.
// The attribute key comes from the tenant's own catalogue, never from the question verbatim, and every value is a
// bound parameter. "OS per server" and "VMs per host in VMware" are this skill.
import { Injectable } from '@nestjs/common';
import { ASSISTANT } from '@openmap/constants';
import { ATTRIBUTE_FAMILIES, KNOWN_DIRECTIONS, type GroupCount, type SkillParams, type Summary } from '@openmap/assistant';
import type { CiType, RelationshipType } from '@openmap/contracts';
import { Prisma } from '@openmap/db';
import { typeLabel } from '@openmap/graph';
import { PrismaService } from '../../db/prisma.service.js';
import { AssistantCatalogueService, type ResolvedFilter } from '../catalogue.service.js';
import { failed, paramsOf, result, startTimer, type SkillContext, type SkillOutcome } from './skill.js';

type Params = Extract<SkillParams, { skill: 'cmdb.attributes' }>;

/** Only values that are plain numbers are cast; a stray "n/a" must not fail the whole aggregate. */
const NUMERIC_PATTERN = '^-?[0-9]+(\\.[0-9]+)?$';

interface GroupRow {
  label: string | null;
  count: number;
  value: number | null;
}

interface DensityRow {
  avg: number | null;
  max: number | null;
  groups: number;
  total: number;
}

function aggregateSql(aggregate: 'avg' | 'sum' | 'min' | 'max', key: string): Prisma.Sql {
  const value = Prisma.sql`CASE WHEN c.attributes->>${key} ~ ${NUMERIC_PATTERN} THEN (c.attributes->>${key})::numeric END`;
  switch (aggregate) {
    case 'avg':
      return Prisma.sql`avg(${value})::float`;
    case 'sum':
      return Prisma.sql`sum(${value})::float`;
    case 'min':
      return Prisma.sql`min(${value})::float`;
    case 'max':
      return Prisma.sql`max(${value})::float`;
  }
}

function filterSql(filters: readonly ResolvedFilter[], alias: Prisma.Sql): Prisma.Sql {
  if (filters.length === 0) return Prisma.empty;
  return Prisma.sql` AND ${Prisma.join(
    filters.map((f) => Prisma.sql`${alias}.attributes->>${f.key} = ${f.value}`),
    ' AND ',
  )}`;
}

/** The stored direction and type linking two CI types, from the contract catalogue the NL→Cypher validator uses. */
export function relationshipBetween(subject: CiType, counterpart: CiType): { type: RelationshipType; subjectIsFrom: boolean } | null {
  const s = typeLabel(subject);
  const c = typeLabel(counterpart);
  for (const [from, rel, to] of KNOWN_DIRECTIONS) {
    if (from === s && to === c) return { type: rel.toLowerCase() as RelationshipType, subjectIsFrom: true };
    if (from === c && to === s) return { type: rel.toLowerCase() as RelationshipType, subjectIsFrom: false };
  }
  return null;
}

@Injectable()
export class AttributesSkill {
  constructor(
    private readonly prisma: PrismaService,
    private readonly catalogue: AssistantCatalogueService,
  ) {}

  async run(step: Params, context: SkillContext): Promise<SkillOutcome> {
    const elapsed = startTimer();
    const scope = await this.catalogue.resolveFilters(context.tenantId, step.filters);
    const notes: Summary[] = scope.unresolved.map((value) => ({ kind: 'unresolvedFilter', value }));
    const filters = scope.resolved;
    const filterTerms = filters.map((f) => f.term);
    const base = Prisma.sql`c."tenantId" = ${context.tenantId}::uuid AND c."validTo" IS NULL AND c.type = ${step.type}::"CiType"${filterSql(filters, Prisma.sql`c`)}`;
    let statement: Prisma.Sql;
    let summary: Summary;
    try {
      if (step.groupBy?.kind === 'type') {
        const link = relationshipBetween(step.type, step.groupBy.type);
        const subjectSide = link === null || link.subjectIsFrom ? Prisma.sql`r."fromCiId"` : Prisma.sql`r."toCiId"`;
        const groupSide = link === null || link.subjectIsFrom ? Prisma.sql`r."toCiId"` : Prisma.sql`r."fromCiId"`;
        const relFilter = link === null ? Prisma.empty : Prisma.sql` AND r.type = ${link.type}::"RelationshipType"`;
        statement = Prisma.sql`
          WITH per AS (
            SELECT ${groupSide} AS gid, count(*)::int AS n
            FROM relationships r
            JOIN cis c ON c.id = ${subjectSide}
            JOIN cis g ON g.id = ${groupSide}
            WHERE r."tenantId" = ${context.tenantId}::uuid AND r."validTo" IS NULL${relFilter}
              AND ${base}
              AND g."validTo" IS NULL AND g.type = ${step.groupBy.type}::"CiType"
            GROUP BY 1)
          SELECT avg(n)::float AS "avg", max(n)::int AS "max", count(*)::int AS "groups", coalesce(sum(n), 0)::int AS "total" FROM per`;
        const [row] = await this.prisma.client.$queryRaw<DensityRow[]>(statement);
        summary = { kind: 'density', type: step.type, counterpart: step.groupBy.type, relationship: link?.type ?? 'any', avg: row?.avg ?? 0, max: row?.max ?? 0, groups: row?.groups ?? 0, total: row?.total ?? 0, filters: filterTerms };
        return { results: [result(step, 'postgres', statement.sql, paramsOf(statement.values), row === undefined ? [] : [row as unknown as Record<string, unknown>], elapsed(), summary), ...notes.map((n) => result(step, 'catalogue', 'resolveFilters', { filters: step.filters }, [], 0, n))], clarification: null };
      }

      const familyKey = step.family === null ? null : await this.catalogue.keyFor(context.tenantId, step.type, step.family);
      const groupKey = step.groupBy?.kind === 'attribute' ? await this.catalogue.keyFor(context.tenantId, step.type, step.groupBy.family) : null;
      const groupFamily = step.groupBy?.kind === 'attribute' ? step.groupBy.family : null;

      if (step.family !== null && familyKey === null) {
        return { results: [failed(step, 'postgres', 'catalogue.keyFor', { type: step.type, family: step.family }, elapsed(), 'the ' + step.type + ' CIs of this estate carry no ' + step.family + ' attribute')], clarification: null };
      }

      if (step.aggregate === 'count' || step.aggregate === 'distribution') {
        // A breakdown groups by the asked grouping, else by the attribute itself; a plain count has neither.
        const key = groupKey ?? (step.aggregate === 'distribution' ? familyKey : null);
        if (key === null) {
          statement = Prisma.sql`SELECT count(*)::int AS "count" FROM cis c WHERE ${base}`;
          const [row] = await this.prisma.client.$queryRaw<Array<{ count: number }>>(statement);
          summary = { kind: 'count', type: step.type, count: row?.count ?? 0, filters: filterTerms, health: step.health };
        } else {
          statement = Prisma.sql`SELECT c.attributes->>${key} AS "label", count(*)::int AS "count", NULL::float AS "value" FROM cis c WHERE ${base} GROUP BY 1 ORDER BY 2 DESC LIMIT ${ASSISTANT.skillRowLimit}`;
          const rows = await this.prisma.client.$queryRaw<GroupRow[]>(statement);
          const groups = rows.map((r) => this.group(r));
          const family = groupFamily ?? step.family;
          summary = {
            kind: 'groups',
            type: step.type,
            dimension: { kind: 'attribute', family: family ?? 'status', key },
            groups,
            total: groups.reduce((n, g) => n + g.count, 0),
            filters: filterTerms,
            unit: '',
          };
        }
      } else {
        const key = familyKey ?? '';
        const family = step.family ?? 'memory';
        const unit = ATTRIBUTE_FAMILIES[family].unit;
        if (groupKey !== null) {
          statement = Prisma.sql`SELECT c.attributes->>${groupKey} AS "label", count(*)::int AS "count", ${aggregateSql(step.aggregate, key)} AS "value" FROM cis c WHERE ${base} GROUP BY 1 ORDER BY 3 DESC NULLS LAST LIMIT ${ASSISTANT.skillRowLimit}`;
          const rows = await this.prisma.client.$queryRaw<GroupRow[]>(statement);
          const groups = rows.map((r) => this.group(r));
          summary = { kind: 'groups', type: step.type, dimension: { kind: 'attribute', family: groupFamily ?? family, key: groupKey }, groups, total: groups.reduce((n, g) => n + g.count, 0), filters: filterTerms, unit };
        } else {
          statement = Prisma.sql`SELECT ${aggregateSql(step.aggregate, key)} AS "value", count(*) FILTER (WHERE c.attributes->>${key} ~ ${NUMERIC_PATTERN})::int AS "count" FROM cis c WHERE ${base}`;
          const [row] = await this.prisma.client.$queryRaw<Array<{ value: number | null; count: number }>>(statement);
          summary = { kind: 'aggregate', type: step.type, family, key, aggregate: step.aggregate, value: row?.value ?? 0, unit, count: row?.count ?? 0, filters: filterTerms };
        }
      }
    } catch (err) {
      return { results: [failed(step, 'postgres', 'cmdb.attributes', { type: step.type, family: step.family }, elapsed(), err instanceof Error ? err.message : String(err))], clarification: null };
    }
    const rows = summary.kind === 'groups' ? summary.groups.map((g) => ({ label: g.label, count: g.count, value: g.value })) : summary.kind === 'count' ? [{ count: summary.count }] : [{ value: summary.value, count: summary.count }];
    return { results: [result(step, 'postgres', statement.sql, paramsOf(statement.values), rows, elapsed(), summary), ...notes.map((n) => result(step, 'catalogue', 'resolveFilters', { filters: step.filters }, [], 0, n))], clarification: null };
  }

  private group(row: GroupRow): GroupCount {
    return { label: row.label ?? '', count: row.count, value: row.value };
  }
}
