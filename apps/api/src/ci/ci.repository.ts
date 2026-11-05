// REQ-CMDB-001 — CMDB repository interface. Every method takes the tenant id first; the Prisma
// implementation lives in ci.prisma-repository.ts and writes always receive the outbox transaction.
import type { CiLayer, CiType, RelationshipType, UserLabel } from '@openmap/contracts';
import type { Prisma } from '@openmap/db';
import type { SortKey } from '../common/cursor.js';
import type { CiFilterInput } from './ci.schemas.js';
import type { CiRecord, Lifecycle, RelationshipDirection, RelationshipRecord } from './ci.types.js';

export const CI_REPOSITORY = Symbol('CI_REPOSITORY');

export interface ListResult<T> {
  items: T[];
  hasNextPage: boolean;
  totalCount: number;
}

export interface RelationshipQuery {
  ciId: string;
  direction: RelationshipDirection;
  types: readonly RelationshipType[];
  first: number;
  /** Relationship id cursor; relationships page by id. */
  afterId: string | null;
  asOf: string | null;
}

export interface NewRelationship {
  type: RelationshipType;
  fromCiId: string;
  toCiId: string;
  attributes: Record<string, unknown>;
  runId: string;
  confidence: number;
}

/** A CI the API creates itself (setup wizard, ADR-017): identity as the collectors would observe it. */
export interface NewCi {
  id?: string;
  type: CiType;
  identity: Record<string, string>;
  name: string;
  attributes: Record<string, unknown>;
  tags: string[];
  lifecycle: Lifecycle;
  runId: string;
  confidence: number;
}

export interface CiRepository {
  findById(tenantId: string, id: string, asOf: string | null): Promise<CiRecord | null>;
  /** The current CI with this type and identity, by the reconciler's identity key, if any. */
  findCurrentByIdentity(tenantId: string, type: CiType, identity: Record<string, string>): Promise<CiRecord | null>;
  /** Inserts a current CI; the code comes from ciCode() and the database keeps it unique (ADR-014). */
  create(tx: Prisma.TransactionClient, tenantId: string, input: NewCi): Promise<CiRecord>;
  /** Closes the current version (validTo = now) and its current relationships. */
  retire(tx: Prisma.TransactionClient, tenantId: string, id: string): Promise<CiRecord>;
  findByIds(tenantId: string, ids: readonly string[]): Promise<CiRecord[]>;
  list(
    tenantId: string,
    filter: CiFilterInput,
    healthIds: readonly string[] | null,
    first: number,
    after: SortKey | null,
  ): Promise<ListResult<CiRecord>>;
  search(tenantId: string, text: string, layers: readonly CiLayer[], first: number): Promise<CiRecord[]>;
  byType(tenantId: string, type: CiType): Promise<CiRecord[]>;
  relationships(tenantId: string, query: RelationshipQuery): Promise<ListResult<RelationshipRecord>>;
  relationshipById(tenantId: string, id: string): Promise<RelationshipRecord | null>;
  relationshipsByIds(tenantId: string, ids: readonly string[]): Promise<RelationshipRecord[]>;
  /** Current relationships of the given types touching any of `ciIds` in the stated direction. */
  relationshipsOfMany(
    tenantId: string,
    ciIds: readonly string[],
    types: readonly RelationshipType[],
    direction: Exclude<RelationshipDirection, 'both'>,
  ): Promise<RelationshipRecord[]>;
  /** Current relationships of a type anywhere in the tenant (for tree and vulnerability views). */
  relationshipsByType(tenantId: string, type: RelationshipType): Promise<RelationshipRecord[]>;
  /** Versions of a CI overlapping [from, to]; Postgres holds the current version, history is appended elsewhere. */
  versions(tenantId: string, id: string, from: string | null, to: string | null): Promise<CiRecord[]>;

  label(
    tx: Prisma.TransactionClient,
    tenantId: string,
    id: string,
    label: UserLabel,
    layer: CiLayer,
    type: CiType | null,
  ): Promise<CiRecord>;
  updateAttributes(
    tx: Prisma.TransactionClient,
    tenantId: string,
    id: string,
    attributes: Record<string, unknown>,
    checksum: string,
  ): Promise<CiRecord>;
  /** The current CI of the tenant carrying this short code, if any (ADR-014). */
  findCurrentByCode(tenantId: string, code: string): Promise<CiRecord | null>;
  updateCode(tx: Prisma.TransactionClient, tenantId: string, id: string, code: string): Promise<CiRecord>;
  /** REQ-CMDB-013: a lifecycle set by hand. */
  updateLifecycle(tx: Prisma.TransactionClient, tenantId: string, id: string, lifecycle: Lifecycle): Promise<CiRecord>;
  /** REQ-CMDB-016: the CI's tags replaced. */
  updateTags(tx: Prisma.TransactionClient, tenantId: string, id: string, tags: readonly string[]): Promise<CiRecord>;
  /** REQ-CMDB-016: the tenant's tags on current CIs, most used first. */
  tagCounts(tenantId: string, limit: number): Promise<Array<{ tag: string; count: number }>>;
  createRelationship(
    tx: Prisma.TransactionClient,
    tenantId: string,
    input: NewRelationship,
  ): Promise<RelationshipRecord>;
  retireRelationship(
    tx: Prisma.TransactionClient,
    tenantId: string,
    id: string,
    at: string,
  ): Promise<RelationshipRecord>;
}
