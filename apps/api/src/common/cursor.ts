// REQ-CORE-012 — opaque cursor encoding for Relay-style connections. A cursor is the base64url of
// the JSON sort key (name, id) so pages are stable under concurrent inserts.
import { z } from 'zod';
import { GRAPH } from '@openmap/constants';

export interface SortKey {
  name: string;
  id: string;
}

const sortKeySchema = z.object({ name: z.string(), id: z.string().min(1) });

export function encodeCursor(key: SortKey): string {
  return Buffer.from(JSON.stringify(key), 'utf8').toString('base64url');
}

export class InvalidCursorError extends Error {
  constructor(cursor: string) {
    super('invalid cursor: ' + cursor);
    this.name = 'InvalidCursorError';
  }
}

export function decodeCursor(cursor: string): SortKey {
  let parsed: unknown;
  try {
    parsed = JSON.parse(Buffer.from(cursor, 'base64url').toString('utf8'));
  } catch {
    throw new InvalidCursorError(cursor);
  }
  const result = sortKeySchema.safeParse(parsed);
  if (!result.success) throw new InvalidCursorError(cursor);
  return result.data;
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
