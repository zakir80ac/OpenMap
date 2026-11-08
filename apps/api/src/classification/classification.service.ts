// REQ-AI-002 (ADR-052) — classification of unknown CIs: suggestions from the evidence a port scan leaves on a CI
// (classifyCi over DEVICE_FINGERPRINTS), kept in classification_suggestions until a person accepts one, which writes
// the CI's user label through CiService.labelCi (layer, type and the label's title and description), or dismisses it.
// - A sweep classifies the tenant's unknown, unlabelled CIs when the Layers screen asks; new evidence on a CI replaces
//   an open or dismissed suggestion, the same evidence leaves it as it was.
// - The acceptance rate is accepted / (accepted + dismissed), counted per tenant.
import { Injectable, NotFoundException } from '@nestjs/common';
import { classifyCi, type ClassificationEvidence } from '@openmap/assistant';
import { CLASSIFICATION } from '@openmap/constants';
import type { CiLayer, CiType } from '@openmap/contracts';
import { Prisma } from '@openmap/db';
import { withSpan } from '@openmap/telemetry';
import { CiService, type Actor } from '../ci/ci.service.js';
import { PrismaService } from '../db/prisma.service.js';
import { TRACER_NAME } from '../metrics/graphql-metrics.hook.js';
import { MetricsService } from '../metrics/metrics.service.js';

export interface ClassificationSuggestionView {
  id: string;
  ciId: string;
  deviceClass: string;
  layer: CiLayer;
  type: CiType | null;
  title: string;
  description: string;
  confidence: number;
  evidence: ClassificationEvidence[];
  state: 'open' | 'accepted' | 'dismissed';
  decidedBy: string | null;
  decidedAt: Date | null;
  createdAt: Date;
}

export interface ClassificationSummaryView {
  open: ClassificationSuggestionView[];
  /** Unknown CIs no fingerprint recognised: they stay for a person to label by hand. */
  unrecognised: number;
  accepted: number;
  dismissed: number;
  /** accepted / (accepted + dismissed); null before any decision. */
  acceptanceRate: number | null;
}

type Row = Prisma.ClassificationSuggestionGetPayload<object>;

function view(r: Row): ClassificationSuggestionView {
  return {
    id: r.id,
    ciId: r.ciId,
    deviceClass: r.deviceClass,
    layer: r.layer,
    type: r.type,
    title: r.title,
    description: r.description,
    confidence: r.confidence,
    evidence: r.evidence as unknown as ClassificationEvidence[],
    state: r.state,
    decidedBy: r.decidedBy,
    decidedAt: r.decidedAt,
    createdAt: r.createdAt,
  };
}

@Injectable()
export class ClassificationService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly cis: CiService,
    private readonly metrics: MetricsService,
  ) {}

  /** Classifies the tenant's unknown, unlabelled CIs; returns how many it could not recognise. */
  async sweep(tenantId: string): Promise<number> {
    return withSpan(TRACER_NAME, 'classification.sweep', { 'openmap.tenant': tenantId }, async () => {
      const db = this.prisma.client;
      const unknown = await db.ci.findMany({
        // A CI someone already labelled is theirs to describe; only unlabelled unknowns are classified.
        where: { tenantId, type: 'unknown', validTo: null, userLabel: { equals: Prisma.DbNull } },
        select: { id: true, name: true, attributes: true },
        orderBy: { name: 'asc' },
        take: CLASSIFICATION.sweepLimit,
      });
      const existing = new Map((await db.classificationSuggestion.findMany({ where: { tenantId, ciId: { in: unknown.map((c) => c.id) } } })).map((s) => [s.ciId, s]));
      let unrecognised = 0;
      for (const ci of unknown) {
        const c = classifyCi({ name: ci.name, attributes: (ci.attributes ?? {}) as Record<string, unknown> });
        if (c === null) {
          unrecognised++;
          continue;
        }
        const data = {
          deviceClass: c.deviceClass,
          layer: c.layer,
          type: c.type,
          title: c.title,
          description: c.description,
          confidence: c.confidence,
          evidence: c.evidence as unknown as Prisma.InputJsonValue,
          evidenceKey: c.description,
        };
        const before = existing.get(ci.id);
        if (before === undefined) {
          await db.classificationSuggestion.create({ data: { tenantId, ciId: ci.id, ...data } });
          this.metrics.classifications.inc({ outcome: 'suggested' });
        } else if (before.state !== 'accepted' && before.evidenceKey !== c.description) {
          await db.classificationSuggestion.update({ where: { id: before.id }, data: { ...data, state: 'open', decidedBy: null, decidedAt: null } });
          this.metrics.classifications.inc({ outcome: 'suggested' });
        }
      }
      return unrecognised;
    });
  }

  /** The open suggestions (highest confidence first) and the tenant's decisions so far, after a sweep. */
  async summary(tenantId: string): Promise<ClassificationSummaryView> {
    const unrecognised = await this.sweep(tenantId);
    const db = this.prisma.client;
    const [open, decided] = await Promise.all([
      db.classificationSuggestion.findMany({
        where: { tenantId, state: 'open', ci: { type: 'unknown', validTo: null } },
        orderBy: [{ confidence: 'desc' }, { createdAt: 'asc' }],
      }),
      db.classificationSuggestion.groupBy({ by: ['state'], where: { tenantId, state: { in: ['accepted', 'dismissed'] } }, _count: { _all: true } }),
    ]);
    const count = (state: 'accepted' | 'dismissed'): number => decided.find((d) => d.state === state)?._count._all ?? 0;
    const accepted = count('accepted');
    const dismissed = count('dismissed');
    return { open: open.map(view), unrecognised, accepted, dismissed, acceptanceRate: accepted + dismissed === 0 ? null : accepted / (accepted + dismissed) };
  }

  /** Writes the suggestion as the CI's user label and records the acceptance. */
  async accept(actor: Actor, id: string): Promise<ClassificationSuggestionView> {
    const s = await this.open(actor.tenantId, id);
    await this.cis.labelCi(actor, { ciId: s.ciId, title: s.title, description: s.description, layer: s.layer, ...(s.type === null ? {} : { type: s.type }) });
    const done = await this.prisma.client.classificationSuggestion.update({ where: { id }, data: { state: 'accepted', decidedBy: actor.username, decidedAt: new Date() } });
    this.metrics.classifications.inc({ outcome: 'accepted' });
    return view(done);
  }

  async dismiss(actor: Actor, id: string): Promise<ClassificationSuggestionView> {
    await this.open(actor.tenantId, id);
    const done = await this.prisma.client.classificationSuggestion.update({ where: { id }, data: { state: 'dismissed', decidedBy: actor.username, decidedAt: new Date() } });
    this.metrics.classifications.inc({ outcome: 'dismissed' });
    return view(done);
  }

  private async open(tenantId: string, id: string): Promise<Row> {
    const s = await this.prisma.client.classificationSuggestion.findFirst({ where: { id, tenantId, state: 'open' } });
    if (s === null) throw new NotFoundException('open classification suggestion ' + id + ' not found');
    return s;
  }
}
