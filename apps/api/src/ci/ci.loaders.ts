// REQ-CMDB-001 — per-request loaders for CIs, relationships and graph health, created once per
// GraphQL request so nested fields batch into single Postgres and Memgraph round trips.
import { Inject, Injectable } from '@nestjs/common';
import { BatchLoader } from '../common/batch-loader.js';
import { GraphService } from '../db/graph.service.js';
import { CI_REPOSITORY, type CiRepository } from './ci.repository.js';
import type { CiRecord, HealthState, RelationshipRecord } from './ci.types.js';

export interface CiLoaders {
  ci: BatchLoader<string, CiRecord>;
  relationship: BatchLoader<string, RelationshipRecord>;
  health: BatchLoader<string, HealthState>;
}

const HEALTH_QUERY = 'MATCH (c:Ci {tenantId: $tenantId}) WHERE c.id IN $ids RETURN c.id AS id, c.health AS health';

@Injectable()
export class CiLoaderFactory {
  constructor(
    @Inject(CI_REPOSITORY) private readonly cis: CiRepository,
    private readonly graph: GraphService,
  ) {}

  create(tenantId: string): CiLoaders {
    return {
      ci: new BatchLoader(async (ids) => new Map((await this.cis.findByIds(tenantId, ids)).map((c) => [c.id, c]))),
      relationship: new BatchLoader(async (ids) => new Map((await this.cis.relationshipsByIds(tenantId, ids)).map((r) => [r.id, r]))),
      health: new BatchLoader(async (ids) => {
        const rows = await this.graph.repo.readOnly<{ id: string; health: HealthState | null }>(HEALTH_QUERY, { tenantId, ids: [...ids] });
        return new Map(rows.map((r) => [r.id, r.health ?? 'unknown']));
      }),
    };
  }
}
