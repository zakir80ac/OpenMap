// REQ-CMDB-001 — domain records served by the CMDB module. Shapes mirror the frozen contract and the
// GraphQL Ci / Relationship types; nested fields (health, relationships, asset) are field resolvers.
import type { CiLayer, CiType, Provenance, RelationshipType, UserLabel } from '@openmap/contracts';
import type { GraphCi } from '@openmap/graph';

export type Lifecycle = 'discovered' | 'managed' | 'planned' | 'retired';
export type HealthState = GraphCi['health'];
export type RelationshipDirection = 'upstream' | 'downstream' | 'both';

export interface ExternalIdRecord {
  source: string;
  id: string;
}

export interface CiRecord {
  id: string;
  tenantId: string;
  type: CiType;
  layer: CiLayer;
  name: string;
  displayName: string;
  /** Short code (ADR-014): stored value, or ciCode() of the row for rows written before the column was filled. */
  code: string;
  identity: Record<string, string>;
  attributes: Record<string, unknown>;
  tags: string[];
  externalIds: ExternalIdRecord[];
  lifecycle: Lifecycle;
  userLabel: UserLabel | null;
  source: Provenance;
  observedAt: string;
  validFrom: string;
  validTo: string | null;
  checksum: string;
}

export interface RelationshipRecord {
  id: string;
  tenantId: string;
  type: RelationshipType;
  fromCiId: string;
  toCiId: string;
  attributes: Record<string, unknown>;
  source: Provenance;
  observedAt: string;
  validFrom: string;
  validTo: string | null;
}

export interface CiVersionRecord {
  validFrom: string;
  validTo: string | null;
  attributes: Record<string, unknown>;
  lifecycle: Lifecycle;
  source: Provenance;
}

export interface VulnerabilityRecord {
  ci: CiRecord;
  cveId: string;
  cvss: number;
  severity: string;
  fixedIn: string | null;
  exploited: boolean;
  internetFacing: boolean;
}

export interface SearchHitRecord {
  ci: CiRecord;
  score: number;
  highlight: string | null;
}

export interface Connection<T> {
  edges: Array<{ cursor: string; node: T }>;
  pageInfo: { endCursor: string | null; hasNextPage: boolean };
  totalCount: number;
}
