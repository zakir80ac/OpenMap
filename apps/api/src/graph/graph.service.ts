// REQ-DEP-001 — dependency graph use cases: impact closure with predicted states, shortest path, and
// the layer summary merged with the caller's visibility preferences.
import { Inject, Injectable, NotFoundException } from '@nestjs/common';
import { CI_LAYERS, type CiLayer } from '@openmap/contracts';
import type { GraphRelationship, ImpactDirection, ImpactNode } from '@openmap/graph';
import { CI_REPOSITORY, type CiRepository } from '../ci/ci.repository.js';
import { CiService } from '../ci/ci.service.js';
import type { CiRecord, RelationshipRecord } from '../ci/ci.types.js';
import { GraphService as GraphClient } from '../db/graph.service.js';
import { BsmFactsService } from '../services/bsm-facts.service.js';
import { LAYER_PREFERENCES, type LayerPreferenceRepository } from './graph.repository.js';
import type { ImpactNodeView, ImpactResultView, LayerSummaryView, PredictedState } from './graph.types.js';

/** Provenance for relationships known to the graph but not (yet) to Postgres. */
const GRAPH_SOURCE = { collectorId: 'graph', nodeId: 'memgraph', runId: 'memgraph', confidence: 1 } as const;

/**
 * Node prediction when the root is assumed failed: upstream nodes depend on the root and are predicted
 * down; downstream nodes are what the root depends on and are unaffected; a bidirectional walk cannot
 * tell the two apart, so its nodes are at risk. Business services are predicted through their models.
 */
export function predictNode(direction: ImpactDirection, node: ImpactNode, rootId: string): PredictedState {
  if (node.ci.id === rootId) return 'down';
  if (direction === 'upstream') return 'down';
  if (direction === 'downstream') return 'unaffected';
  return 'at_risk';
}

@Injectable()
export class GraphQueryService {
  constructor(
    private readonly graph: GraphClient,
    private readonly cis: CiService,
    @Inject(CI_REPOSITORY) private readonly ciRepo: CiRepository,
    private readonly facts: BsmFactsService,
    @Inject(LAYER_PREFERENCES) private readonly preferences: LayerPreferenceRepository,
  ) {}

  async impact(tenantId: string, ciId: string, direction: ImpactDirection, maxDepth: number, asOf: string | null): Promise<ImpactResultView> {
    const root = await this.cis.ci(tenantId, ciId, asOf);
    if (!root) throw new NotFoundException('CI ' + ciId + ' not found');
    const result = await this.graph.repo.impact(tenantId, ciId, { direction, maxDepth, asOf, edgeTypes: [] });
    const ids = [...new Set([...result.nodes.map((n) => n.ci.id), ...result.services.map((s) => s.ci.id)])];
    const byId = new Map((await this.cis.byIds(tenantId, ids)).map((c) => [c.id, c]));
    const nodes: ImpactNodeView[] = [];
    for (const n of result.nodes) {
      const ci = byId.get(n.ci.id);
      if (ci) nodes.push({ ci, depth: n.depth, predicted: predictNode(direction, n, ciId), path: n.path });
    }
    // Every component in the upstream closure depends on the root, so it fails with it; redundant
    // members outside the closure stay healthy and the service models decide the service state.
    const failed = direction === 'downstream' ? [ciId] : [ciId, ...result.nodes.filter((n) => n.ci.type !== 'business_service').map((n) => n.ci.id)];
    const services = await this.facts.predictServices(tenantId, result.services, byId, failed, 'down');
    return { root, nodes, services, durationMs: result.durationMs };
  }

  async path(tenantId: string, fromCiId: string, toCiId: string): Promise<RelationshipRecord[]> {
    const rels = await this.graph.repo.shortestPath(tenantId, fromCiId, toCiId, null);
    if (rels.length === 0) return [];
    const stored = new Map((await this.ciRepo.relationshipsByIds(tenantId, rels.map((r) => r.id))).map((r) => [r.id, r]));
    return rels.map((r) => stored.get(r.id) ?? fromGraph(r));
  }

  async layers(tenantId: string, userId: string): Promise<LayerSummaryView[]> {
    const [counts, visible] = await Promise.all([this.graph.repo.layerCounts(tenantId, null), this.preferences.visibleLayers(tenantId, userId)]);
    const byLayer = new Map(counts.map((c) => [c.layer, c]));
    return CI_LAYERS.map((layer) => {
      const c = byLayer.get(layer);
      return { layer, count: c?.count ?? 0, healthy: c?.healthy ?? 0, degraded: c?.degraded ?? 0, down: c?.down ?? 0, visible: visible === null || visible.includes(layer) };
    });
  }

  async setLayerVisibility(tenantId: string, userId: string, layer: CiLayer, visible: boolean): Promise<LayerSummaryView[]> {
    await this.preferences.setVisible(tenantId, userId, layer, visible);
    return this.layers(tenantId, userId);
  }
}

function fromGraph(r: GraphRelationship): RelationshipRecord {
  return { id: r.id, tenantId: r.tenantId, type: r.type, fromCiId: r.fromCiId, toCiId: r.toCiId, attributes: {}, source: GRAPH_SOURCE, observedAt: r.validFrom, validFrom: r.validFrom, validTo: r.validTo };
}

export type { CiRecord };
