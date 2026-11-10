// REQ-IPAM-007 (ADR-069) — the network circuit register on inter-site links. An operator records, on a site_link CI,
// its kind, carrier, carrier contract, committed bandwidth and latency, diverse paths, role, the physical route it takes
// and the carrier `circuit` CIs (ADR-056) it rides on. The attributes land on the CI and each carrier circuit becomes a
// `depends_on` relationship from the link, so the impact walk takes a circuit's outage to the link and on to whatever
// depends on the link; the setup record behind a set-up link follows, so the wizard shows what the CI says. Everything
// goes through the outbox (graph, search and history follow), is audited, counted and traced.
import { randomUUID } from 'node:crypto';
import { BadRequestException, Inject, Injectable, NotFoundException } from '@nestjs/common';
import { RECONCILIATION } from '@openmap/constants';
import {
  CONNECTIVITY_ATTRIBUTES as A,
  LINK_CIRCUIT_RELATIONSHIP,
  type LinkCircuitInput,
} from '@openmap/contracts';
import { withSpan } from '@openmap/telemetry';
import { checksumOf } from '../ci/checksum.js';
import { CI_REPOSITORY, type CiRepository } from '../ci/ci.repository.js';
import { nowIso } from '../common/time.js';
import { TRACER_NAME } from '../metrics/graphql-metrics.hook.js';
import { MetricsService } from '../metrics/metrics.service.js';
import { OnboardingRepository } from '../onboarding/onboarding.repository.js';
import { OutboxService } from '../outbox/outbox.service.js';
import { ConnectivityService, type ConnectivityLinkView } from './connectivity.service.js';

const LINK_TYPE = 'site_link';
const CIRCUIT_TYPE = 'circuit';
/** Relationship attribute naming what wrote the edge: the register, as against an import or a person in the CMDB. */
const REGISTER_SOURCE = 'circuit_register';

@Injectable()
export class LinkCircuitsService {
  constructor(
    @Inject(CI_REPOSITORY) private readonly cis: CiRepository,
    private readonly outbox: OutboxService,
    private readonly metrics: MetricsService,
    private readonly setup: OnboardingRepository,
    private readonly connectivity: ConnectivityService,
  ) {}

  async save(
    tenantId: string,
    actor: string,
    linkCiId: string,
    input: LinkCircuitInput,
  ): Promise<ConnectivityLinkView> {
    return withSpan(
      TRACER_NAME,
      'connectivity.link_circuit.save',
      {
        'openmap.tenant': tenantId,
        'connectivity.circuits': input.circuitCiIds.length,
        'connectivity.role': input.role,
      },
      async () => {
        const link = await this.cis.findById(tenantId, linkCiId, null);
        if (!link || link.validTo !== null || link.type !== LINK_TYPE)
          throw new NotFoundException('inter-site link ' + linkCiId + ' not found');
        const named = new Map((await this.cis.findByIds(tenantId, input.circuitCiIds)).map((c) => [c.id, c]));
        for (const id of input.circuitCiIds) {
          const circuit = named.get(id);
          if (!circuit || circuit.validTo !== null || circuit.type !== CIRCUIT_TYPE)
            throw new BadRequestException(id + ' is not a current carrier circuit');
        }
        // The register owns the link's depends_on edges to circuit CIs; edges to anything else are left alone.
        const current = await this.cis.relationshipsOfMany(
          tenantId,
          [linkCiId],
          [LINK_CIRCUIT_RELATIONSHIP],
          'downstream',
        );
        const targets = new Map(
          (
            await this.cis.findByIds(
              tenantId,
              current.map((r) => r.toCiId),
            )
          ).map((c) => [c.id, c]),
        );
        const onCircuits = current.filter((r) => targets.get(r.toCiId)?.type === CIRCUIT_TYPE);
        const wanted = new Set(input.circuitCiIds);
        const detach = onCircuits.filter((r) => !wanted.has(r.toCiId));
        const kept = new Set(onCircuits.filter((r) => wanted.has(r.toCiId)).map((r) => r.toCiId));
        const attach = input.circuitCiIds.filter((id) => !kept.has(id));
        const attributes: Record<string, unknown> = {
          [A.kind]: input.kind,
          [A.provider]: input.provider,
          [A.carrierContractRef]: input.carrierContractRef,
          [A.bandwidthMbps]: input.bandwidthMbps,
          [A.slaLatencyMs]: input.slaLatencyMs,
          [A.diversePaths]: input.diversePaths,
          [A.role]: input.role,
          [A.pathRef]: input.pathRef,
          [A.circuitCiIds]: input.circuitCiIds,
        };
        const organizationId = await this.setup.organizationIdOf(tenantId);
        const record = await this.setup.linkByCi(organizationId, linkCiId);
        await this.outbox.transaction(tenantId, async (ctx) => {
          const tx = ctx.tx;
          const merged = { ...link.attributes, ...attributes };
          const checksum = checksumOf(link.type, link.identity, merged);
          if (checksum !== link.checksum) {
            const ci = await this.cis.updateAttributes(tx, tenantId, link.id, merged, checksum);
            await ctx.emit({
              type: 'openmap.ci.updated',
              subject: ci.id,
              data: {
                ci,
                ciId: ci.id,
                changed: Object.keys(attributes),
                attributes: ci.attributes,
                checksum: ci.checksum,
                by: actor,
              },
            });
          }
          const at = nowIso();
          for (const rel of detach) {
            const retired = await this.cis.retireRelationship(tx, tenantId, rel.id, at);
            await ctx.emit({
              type: 'openmap.relationship.retired',
              subject: retired.id,
              data: { relationshipId: retired.id, validTo: retired.validTo, by: actor },
            });
          }
          for (const toCiId of attach) {
            const rel = await this.cis.createRelationship(tx, tenantId, {
              type: LINK_CIRCUIT_RELATIONSHIP,
              fromCiId: link.id,
              toCiId,
              attributes: { source: REGISTER_SOURCE },
              runId: randomUUID(),
              confidence: RECONCILIATION.userLabelConfidence,
            });
            await ctx.emit({
              type: 'openmap.relationship.created',
              subject: rel.id,
              data: { relationship: rel, by: actor },
            });
          }
          if (record !== null)
            await this.setup.updateLinkCircuit(tx, record.id, {
              kind: input.kind,
              provider: input.provider,
              carrierContractRef: input.carrierContractRef,
              bandwidthMbps: input.bandwidthMbps,
              slaLatencyMs: input.slaLatencyMs,
              diversePaths: input.diversePaths,
              role: input.role,
              pathRef: input.pathRef,
            });
          await ctx.emit({
            type: 'openmap.audit.action',
            subject: link.id,
            data: {
              action: 'connectivity.link_circuit.saved',
              provider: input.provider,
              carrierContractRef: input.carrierContractRef,
              pathRef: input.pathRef,
              attached: attach,
              detached: detach.map((r) => r.toCiId),
              by: actor,
            },
          });
        });
        this.metrics.linkCircuitChanges.inc({ op: 'saved' });
        if (attach.length > 0) this.metrics.linkCircuitChanges.inc({ op: 'attached' }, attach.length);
        if (detach.length > 0) this.metrics.linkCircuitChanges.inc({ op: 'detached' }, detach.length);
        const view = (await this.connectivity.connectivity(tenantId)).links.find((l) => l.ci.id === link.id);
        if (!view) throw new NotFoundException('inter-site link ' + linkCiId + ' not found');
        return view;
      },
    );
  }
}
