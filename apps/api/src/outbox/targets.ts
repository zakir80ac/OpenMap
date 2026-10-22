// REQ-CORE-012 — which stores must acknowledge an outbox event before it is delivered. The reconciler
// fans out to Memgraph, ClickHouse and Meilisearch; the API itself serves the websocket target.
import type { EventType } from '@openmap/contracts';

export type OutboxTarget = 'memgraph' | 'clickhouse' | 'meilisearch' | 'websocket' | 'bsm';

export function pendingTargets(type: EventType): OutboxTarget[] {
  if (type.startsWith('openmap.ci.') || type.startsWith('openmap.relationship.')) return ['memgraph', 'clickhouse', 'meilisearch', 'websocket', 'bsm'];
  if (type.startsWith('openmap.bsm.') || type.startsWith('openmap.incident.')) return ['clickhouse', 'websocket'];
  if (type.startsWith('openmap.discovery.')) return ['clickhouse', 'websocket'];
  return ['clickhouse', 'websocket'];
}
