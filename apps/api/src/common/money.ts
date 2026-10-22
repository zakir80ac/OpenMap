// REQ-CORE-012 — Money mapping between Prisma Decimal columns and the GraphQL Money type.
import type { Prisma } from '@openmap/db';

export interface Money {
  amount: number;
  currency: string;
}

/** ISO 4217 codes are three letters, as long as the standard's own abbreviation. */
export const CURRENCY_CODE_LENGTH = 'ISO'.length;

/** The ISO 4217 "no currency" code (three X's), used while a plan or asset has no priced line yet. */
export const NO_CURRENCY = 'X'.repeat(CURRENCY_CODE_LENGTH);

export function toMoney(amount: Prisma.Decimal | number | null | undefined, currency: string | null | undefined): Money | null {
  if (amount === null || amount === undefined || currency === null || currency === undefined) return null;
  return { amount: typeof amount === 'number' ? amount : Number(amount.toString()), currency };
}
