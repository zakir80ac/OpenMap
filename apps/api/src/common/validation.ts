// REQ-CORE-012 — zod-validated GraphQL inputs. A failed parse becomes a BadRequestException, which the
// Nest GraphQL layer renders as a GraphQL error carrying the field paths.
import { BadRequestException } from '@nestjs/common';
import type { z } from 'zod';

export function parseInput<T extends z.ZodType>(schema: T, value: unknown, what: string): z.infer<T> {
  const result = schema.safeParse(value);
  if (!result.success) {
    const issues = result.error.issues.map(
      (i) => (i.path.length ? i.path.map(String).join('.') + ': ' : '') + i.message,
    );
    throw new BadRequestException({ message: 'invalid ' + what, issues });
  }
  return result.data;
}

/** Narrow a JSON value to a plain object; anything else yields an empty object. */
export function asRecord(value: unknown): Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}

export function stringAttribute(attributes: Record<string, unknown>, key: string): string | null {
  const v = attributes[key];
  return typeof v === 'string' && v.length > 0 ? v : null;
}

export function numberAttribute(attributes: Record<string, unknown>, key: string): number | null {
  const v = attributes[key];
  if (typeof v === 'number' && Number.isFinite(v)) return v;
  if (typeof v === 'string' && v.trim().length > 0 && Number.isFinite(Number(v))) return Number(v);
  return null;
}

/** A date or instant attribute as an ISO 8601 instant; calendar dates ('2027-01-01') become midnight UTC, junk is null. */
export function isoAttribute(attributes: Record<string, unknown>, key: string): string | null {
  const v = attributes[key];
  const date = v instanceof Date ? v : typeof v === 'string' && v.trim().length > 0 ? new Date(v) : null;
  return date !== null && !Number.isNaN(date.getTime()) ? date.toISOString() : null;
}

export function booleanAttribute(attributes: Record<string, unknown>, key: string): boolean | null {
  const v = attributes[key];
  return typeof v === 'boolean' ? v : null;
}

export function stringArrayAttribute(attributes: Record<string, unknown>, key: string): string[] {
  const v = attributes[key];
  return Array.isArray(v) ? v.filter((x): x is string => typeof x === 'string') : [];
}
