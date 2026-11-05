// REQ-CORE-012 — opaque cursor encoding for Relay-style connections. A cursor is the base64url of
// the JSON sort key (name, id) so pages are stable under concurrent inserts.
import { z } from 'zod';
import { GRAPH } from '@openmap/constants';

export interface SortKey {
  name: string;
  id: string;
}

const sortKeySchema = z.object({ name: z.string(), id: z.string().min(1) });
/** Cursor over an id-ordered list: an (id) key, or a full (name, id) sort key whose name is ignored. */
const idKeySchema = z.object({ id: z.string().min(1), name: z.string().optional() });

export function encodeCursor(key: SortKey): string {
  return Buffer.from(JSON.stringify(key), 'utf8').toString('base64url');
}

export class InvalidCursorError extends Error {
  constructor(cursor: string) {
    super('invalid cursor: ' + cursor);
    this.name = 'InvalidCursorError';
  }
}

function parseCursor(cursor: string): unknown {
  try {
    return JSON.parse(Buffer.from(cursor, 'base64url').toString('utf8'));
  } catch {
    throw new InvalidCursorError(cursor);
  }
}

export function decodeCursor(cursor: string): SortKey {
  const result = sortKeySchema.safeParse(parseCursor(cursor));
  if (!result.success) throw new InvalidCursorError(cursor);
  return result.data;
}

/**
 * Cursor for lists ordered by id alone (assets, relationships): clients that only know the last row's id encode
 * `{ id }`; a full (name, id) cursor from a name-ordered connection is accepted too.
 */
export function decodeIdCursor(cursor: string): { id: string } {
  const result = idKeySchema.safeParse(parseCursor(cursor));
  if (!result.success) throw new InvalidCursorError(cursor);
  return { id: result.data.id };
}

/** Page size requested by a client, clamped to [1, GRAPH.maxPageSize]; null or 0 means the default. */
export function clampPageSize(first: number | null | undefined): number {
  if (first === null || first === undefined || !Number.isFinite(first) || first <= 0) return GRAPH.defaultPageSize;
  return Math.min(Math.floor(first), GRAPH.maxPageSize);
}

export interface Page<T> {
  items: T[];
  hasNextPage: boolean;
}

/** Splits a `first + 1` fetch into the page and the has-next flag. */
export function toPage<T>(rows: readonly T[], first: number): Page<T> {
  return { items: rows.slice(0, first), hasNextPage: rows.length > first };
}
