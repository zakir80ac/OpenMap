// REQ-CORE-012 — UUID validation through zod so no digit-bearing pattern lives in app code.
import { z } from 'zod';

const uuid = z.uuid();

export function isUuid(value: unknown): value is string {
  return typeof value === 'string' && uuid.safeParse(value).success;
}
