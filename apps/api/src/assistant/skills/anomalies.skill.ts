// REQ-AI-006 (ADR-053) — `anomalies`: the open findings of the anomaly rules (an address claimed twice, an unmanaged
// device in a data centre, a flapping service), of one rule when the question names it, with the facts each rule found,
// read from the same anomaly_findings the Anomalies screen shows.
import { Injectable } from '@nestjs/common';
import { ASSISTANT } from '@openmap/constants';
import type { AnomalyLine, SkillParams, Summary } from '@openmap/assistant';
import type { AnomalyFact, AnomalyRule } from '@openmap/contracts';
import { PrismaService } from '../../db/prisma.service.js';
import { failed, result, startTimer, type SkillContext, type SkillOutcome } from './skill.js';

type AnomaliesParams = Extract<SkillParams, { skill: 'anomalies' }>;

@Injectable()
export class AnomaliesSkill {
  constructor(private readonly prisma: PrismaService) {}

  async run(step: AnomaliesParams, context: SkillContext): Promise<SkillOutcome> {
    const elapsed = startTimer();
    const query = 'anomalies(state=open' + (step.rule === null ? '' : ', rule=' + step.rule) + ')';
    const params = { rule: step.rule };
    try {
      const db = this.prisma.client;
      const findings = await db.anomalyFinding.findMany({
        where: { tenantId: context.tenantId, state: 'open', ...(step.rule === null ? {} : { rule: step.rule }) },
        orderBy: [{ rule: 'asc' }, { detectedAt: 'desc' }],
        take: ASSISTANT.skillRowLimit,
      });
      const subjects = new Map((await db.ci.findMany({ where: { tenantId: context.tenantId, id: { in: findings.map((f) => f.subjectCiId) } }, select: { id: true, displayName: true } })).map((c) => [c.id, c.displayName]));
      const lines: AnomalyLine[] = findings.map((f) => ({
        id: f.id,
        rule: f.rule as AnomalyRule,
        subject: subjects.get(f.subjectCiId) ?? f.subjectCiId,
        facts: Object.fromEntries((f.facts as unknown as AnomalyFact[]).map((x) => [x.key, x.value])),
      }));
      const summary: Summary = { kind: 'anomalies', rule: step.rule, lines };
      const rows = lines.map((l) => ({ rule: l.rule, subject: l.subject, ...l.facts }));
      return { results: [result(step, 'postgres', query, params, rows, elapsed(), summary, findings.map((f) => f.subjectCiId))], clarification: null };
    } catch (err) {
      return { results: [failed(step, 'postgres', query, params, elapsed(), err instanceof Error ? err.message : String(err))], clarification: null };
    }
  }
}
