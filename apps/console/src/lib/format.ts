// REQ-UI-003 — locale-aware formatters (numbers and timestamps) shared by every view; Intl does the digits and calendars.
import type { Locale } from '@openmap/i18n';

export interface Formatters {
  number: (value: number) => string;
  integer: (value: number) => string;
  dateTime: (iso: string) => string;
  /** A calendar date (YYYY-MM-DD or ISO instant), shown without a time. */
  date: (iso: string) => string;
}

export function createFormatters(locale: Locale): Formatters {
  const number = new Intl.NumberFormat(locale);
  const integer = new Intl.NumberFormat(locale, { maximumFractionDigits: 0 });
  const dateTime = new Intl.DateTimeFormat(locale, { dateStyle: 'medium', timeStyle: 'short' });
  const date = new Intl.DateTimeFormat(locale, { dateStyle: 'medium', timeZone: 'UTC' });
  return {
    number: (value) => number.format(value),
    integer: (value) => integer.format(value),
    dateTime: (iso) => {
      const date = new Date(iso);
      return Number.isNaN(date.getTime()) ? iso : dateTime.format(date);
    },
    date: (iso) => {
      const value = new Date(iso);
      return Number.isNaN(value.getTime()) ? iso : date.format(value);
    },
  };
}
