// REQ-AI-007 (ADR-028) — `services.availability` and `incidents`: the BSM facts the Services screen shows, read
// through the same services module (ADR-024) so the assistant's uptime figure is the one on the report. A named
// service narrows both; a name that matches nothing or several services comes back as a clarification.
import { Inject, Injectable } from '@nestjs/common';
import { ASSISTANT, SLA } from '@openmap/constants';
import type { AvailabilityLine, IncidentLine, SkillParams, Summary } from '@openmap/assistant';
import { CI_REPOSITORY, type CiRepository } from '../../ci/ci.repository.js';
import type { CiRecord } from '../../ci/ci.types.js';
import { ServicesService } from '../../services/services.service.js';
import { EntityResolver } from '../entity.resolver.js';
import { failed, nameClarification, result, settled, startTimer, type SkillContext, type SkillOutcome } from './skill.js';

type AvailabilityParams = Extract<SkillParams, { skill: 'services.availability' }>;
type IncidentsParams = Extract<SkillParams, { skill: 'incidents' }>;

const SERVICE_TYPE = 'business_service' as const;

@Injectable()
export class ServicesSkill {
  constructor(
    private readonly services: ServicesService,
    private readonly resolver: EntityResolver,
    @Inject(CI_REPOSITORY) private readonly cis: CiRepository,
  ) {}

  /** The named services, or null with the clarification when a name is not settled. */
  private async namedServices(step: { names: string[] }, context: SkillContext): Promise<{ services: CiRecord[] | null; clarification: SkillOutcome['clarification'] }> {
    if (step.names.length === 0) return { services: null, clarification: null };
    const resolutions = await this.resolver.resolveAll(context.tenantId, step.names, [SERVICE_TYPE]);
    const services: CiRecord[] = [];
    for (const r of resolutions) {
      const ci = settled(r);
      if (ci === null) return { services: null, clarification: nameClarification(r, context.question) };
      services.push(ci);
    }
    return { services, clarification: null };
  }

  async availability(step: AvailabilityParams, context: SkillContext): Promise<SkillOutcome> {
    const elapsed = startTimer();
    const named = await this.namedServices(step, context);
    if (named.clarification !== null) return { results: [], clarification: named.clarification };
    const query = 'availabilityReport(granularity=' + step.granularity + ', periods=' + String(step.back + 1) + ')';
    const params = { granularity: step.granularity, back: step.back, services: step.names };
    try {
      const report = await this.services.report(context.tenantId, step.granularity, step.back + 1);
      const wanted = named.services === null ? null : new Set(named.services.map((s) => s.id));
      const lines: AvailabilityLine[] = [];
      let periodStart = '';
      let weighted = 0;
      let observed = 0;
      let downtime = 0;
      let below = 0;
      for (const row of report) {
        if (wanted !== null && !wanted.has(row.service.id)) continue;
        // The report lists periods oldest first and ends with the current one: `back` counts from the end.
        const period = row.periods[row.periods.length - 1 - step.back];
        if (period === undefined) continue;
        periodStart = period.periodStart;
        lines.push({ ciId: row.service.id, name: row.service.displayName, availabilityPercent: period.availabilityPercent, downtimeMinutes: period.downtimeMinutes, targetPercent: period.targetPercent, met: period.met });
        downtime += period.downtimeMinutes;
        if (period.met === false) below += 1;
        const measured = period.elapsedMinutes - period.unknownMinutes;
        if (period.availabilityPercent !== null && measured > 0) {
          weighted += period.availabilityPercent * measured;
          observed += measured;
        }
      }
      const estatePercent = observed > 0 ? Number((weighted / observed).toFixed(SLA.percentDecimals)) : null;
      const summary: Summary = { kind: 'availability', granularity: step.granularity, back: step.back, periodStart, lines, estatePercent, belowTarget: below, downtimeMinutes: downtime };
      const rows = lines.map((l) => ({ service: l.name, availabilityPercent: l.availabilityPercent, downtimeMinutes: l.downtimeMinutes, targetPercent: l.targetPercent, met: l.met }));
      return { results: [result(step, 'clickhouse', query, params, rows, elapsed(), summary, lines.map((l) => l.ciId))], clarification: null };
    } catch (err) {
      return { results: [failed(step, 'clickhouse', query, params, elapsed(), err instanceof Error ? err.message : String(err))], clarification: null };
    }
  }

  async incidents(step: IncidentsParams, context: SkillContext): Promise<SkillOutcome> {
    const elapsed = startTimer();
    const named = await this.namedServices(step, context);
    if (named.clarification !== null) return { results: [], clarification: named.clarification };
    const service = named.services?.[0] ?? null;
    const query = 'incidents(open=' + String(step.open) + (service === null ? '' : ', serviceId=' + service.id) + ')';
    const params = { open: step.open, service: service?.displayName ?? null };
    try {
      const incidents = await this.services.incidents(context.tenantId, step.open, service?.id ?? null);
      const serviceIds = [...new Set(incidents.map((i) => i.serviceCiId).filter((id): id is string => id !== null))];
      const names = new Map((await this.cis.findByIds(context.tenantId, serviceIds)).map((c) => [c.id, c.displayName]));
      const lines: IncidentLine[] = incidents.slice(0, ASSISTANT.skillRowLimit).map((i) => ({ id: i.id, title: i.title, severity: i.severity, state: i.state, serviceName: i.serviceCiId === null ? null : (names.get(i.serviceCiId) ?? null) }));
      const summary: Summary = { kind: 'incidents', open: step.open, lines, scopeName: service?.displayName ?? null };
      const rows = lines.map((l) => ({ title: l.title, severity: l.severity, state: l.state, service: l.serviceName }));
      return { results: [result(step, 'postgres', query, params, rows, elapsed(), summary, serviceIds)], clarification: null };
    } catch (err) {
      return { results: [failed(step, 'postgres', query, params, elapsed(), err instanceof Error ? err.message : String(err))], clarification: null };
    }
  }
}
