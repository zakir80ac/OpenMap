// REQ-SEC-005 — the immutable audit log (ADR-010): every successful mutation becomes an audit_logs row and an
// `openmap.audit.action` event in one outbox transaction; reads page newest-first with a stable (at, id) cursor.
import { Injectable } from '@nestjs/common';
import type { Prisma } from '@openmap/db';
import { PrismaService } from '../db/prisma.service.js';
import { OutboxService } from '../outbox/outbox.service.js';
import { clampPageSize, decodeCursor, encodeCursor, toPage } from '../common/cursor.js';

export interface AuditActor {
  tenantId: string;
  username: string;
  requestId: string;
}

export interface AuditEntry {
  id: string;
  at: Date;
  actor: string;
  action: string;
  subjectType: string;
  subjectId: string;
  details: Record<string, unknown>;
  traceparent: string | null;
}

export interface AuditFilter {
  subjectType?: string | null | undefined;
  subjectId?: string | null | undefined;
  actor?: string | null | undefined;
  action?: string | null | undefined;
}

export interface AuditPage {
  entries: AuditEntry[];
  endCursor: string | null;
  hasNextPage: boolean;
  totalCount: number;
}

/** Argument names whose values must never reach the log; matched case-insensitively as substrings. */
const REDACTED_FRAGMENTS = ['password', 'secret', 'token', 'credential', 'privatekey', 'apikey'] as const;
const REDACTED = '[redacted]';

/** Returns a copy of the mutation arguments with credential-like fields replaced, recursively. */
export function redact(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(redact);
  if (value !== null && typeof value === 'object') {
    const out: Record<string, unknown> = {};
    for (const [key, inner] of Object.entries(value as Record<string, unknown>)) {
      const lower = key.toLowerCase();
      out[key] = REDACTED_FRAGMENTS.some((fragment) => lower.includes(fragment)) ? REDACTED : redact(inner);
    }
    return out;
  }
  return value;
}

function toEntry(row: { id: string; at: Date; actor: string; action: string; subjectType: string; subjectId: string; details: Prisma.JsonValue; traceparent: string | null }): AuditEntry {
  return { id: row.id, at: row.at, actor: row.actor, action: row.action, subjectType: row.subjectType, subjectId: row.subjectId, details: (row.details ?? {}) as Record<string, unknown>, traceparent: row.traceparent };
}

@Injectable()
export class AuditService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly outbox: OutboxService,
  ) {}

  /** Appends one entry and publishes the matching event; both or neither are committed. */
  async record(actor: AuditActor, action: string, subjectType: string, subjectId: string, details: Record<string, unknown>): Promise<AuditEntry> {
    const at = new Date();
    const safeDetails = redact(details) as Record<string, unknown>;
    return this.outbox.transaction(actor.tenantId, async ({ tx, emit }) => {
      const row = await tx.auditLog.create({
        data: { tenantId: actor.tenantId, actor: actor.username, action, subjectType, subjectId, details: safeDetails as Prisma.InputJsonObject, at },
      });
      const envelope = await emit({ type: 'openmap.audit.action', subject: subjectType + '/' + subjectId, data: { auditId: row.id, actor: actor.username, action, subjectType, subjectId, details: safeDetails, at: at.toISOString(), requestId: actor.requestId } });
      if (envelope.traceparent !== undefined) {
        await tx.auditLog.update({ where: { id: row.id }, data: { traceparent: envelope.traceparent } }).catch(() => undefined);
      }
      return toEntry({ ...row, traceparent: envelope.traceparent ?? null });
    });
  }

  /** Newest first; the cursor encodes (at, id) so pages stay stable while new entries arrive. */
  async list(tenantId: string, filter: AuditFilter, first: number | null | undefined, after: string | null | undefined): Promise<AuditPage> {
    const size = clampPageSize(first);
    const where: Prisma.AuditLogWhereInput = { tenantId };
    if (filter.subjectType) where.subjectType = filter.subjectType;
    if (filter.subjectId) where.subjectId = filter.subjectId;
    if (filter.actor) where.actor = filter.actor;
    if (filter.action) where.action = filter.action;
    if (after) {
      const key = decodeCursor(after);
      const at = new Date(key.name);
      where.OR = [{ at: { lt: at } }, { at, id: { lt: key.id } }];
    }
    const [rows, totalCount] = await Promise.all([
      this.prisma.client.auditLog.findMany({ where, orderBy: [{ at: 'desc' }, { id: 'desc' }], take: size + 1 }),
      this.prisma.client.auditLog.count({ where: { tenantId, ...(filter.subjectType ? { subjectType: filter.subjectType } : {}), ...(filter.subjectId ? { subjectId: filter.subjectId } : {}), ...(filter.actor ? { actor: filter.actor } : {}), ...(filter.action ? { action: filter.action } : {}) } }),
    ]);
    const page = toPage(rows, size);
    const entries = page.items.map(toEntry);
    const last = entries[entries.length - 1];
    return { entries, endCursor: last === undefined ? null : encodeCursor({ name: last.at.toISOString(), id: last.id }), hasNextPage: page.hasNextPage, totalCount };
  }
}
