// REQ-QA-001 — deterministic clock. The estate is observed at a fixed instant so two runs with the
// same seed produce identical bytes; perf harnesses re-stamp observedAt on replay if they need "now".

/** 2026-10-01T00:00:00Z as epoch milliseconds (Date.UTC avoids any locale dependence). */
export const ESTATE_EPOCH_MS = Date.UTC(2026, 9, 1, 0, 0, 0);
export const MS_PER_SECOND = 1000;
export const MS_PER_MINUTE = 60 * MS_PER_SECOND;
export const MS_PER_HOUR = 60 * MS_PER_MINUTE;
export const MS_PER_DAY = 24 * MS_PER_HOUR;

export function isoAt(offsetMs: number): string {
  return new Date(ESTATE_EPOCH_MS + offsetMs).toISOString();
}

/** ISO calendar date (YYYY-MM-DD) offset by whole days from the estate epoch. */
export function dateAt(offsetDays: number): string {
  return new Date(ESTATE_EPOCH_MS + offsetDays * MS_PER_DAY).toISOString().slice(0, 10);
}
