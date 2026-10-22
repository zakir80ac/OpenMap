// REQ-UI-007 REQ-UI-008 — time-travel field helpers shared by the dependency map and the CI detail History tab:
// a `datetime-local` value (local wall clock) to the ISO instant the contract's `asOf` expects, and back.
import { BSM } from '@openmap/constants';

/** `datetime-local` value (local wall clock, no zone) to an ISO instant, or undefined when cleared or invalid. */
export function toAsOf(localValue: string): string | undefined {
  if (localValue === '') return undefined;
  const date = new Date(localValue);
  return Number.isNaN(date.getTime()) ? undefined : date.toISOString();
}

/** Length of a `datetime-local` value with minutes precision. */
const LOCAL_INPUT_LENGTH = 'YYYY-MM-DDTHH:mm'.length;

/** ISO instant to the `datetime-local` field value (local wall clock, minutes precision). */
export function toLocalInput(iso: string | undefined): string {
  if (iso === undefined) return '';
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return '';
  const offsetMs = date.getTimezoneOffset() * BSM.msPerMinute;
  return new Date(date.getTime() - offsetMs).toISOString().slice(0, LOCAL_INPUT_LENGTH);
}
