// REQ-CMDB-026 REQ-CMDB-027 REQ-CMDB-028 (ADR-035) — small helpers the commercial tabs share: money as text, and the
// optional fields of a form read as a number or text, or null when left blank.
import type { Money } from '@/lib/estate-queries';
import type { Formatters } from '@/lib/format';

export function moneyText(format: Formatters, money: Money | null): string {
  return money === null ? '' : format.number(money.amount) + ' ' + money.currency;
}

export function numberOrNull(value: string): number | null {
  if (value.trim() === '') return null;
  const n = Number(value);
  return Number.isFinite(n) ? n : null;
}

export function textOrNull(value: string): string | null {
  const trimmed = value.trim();
  return trimmed === '' ? null : trimmed;
}

/** A number for a form field: empty when absent. */
export function fieldText(value: number | null | undefined): string {
  return value === null || value === undefined ? '' : String(value);
}
