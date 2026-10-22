// REQ-UI-003 — pathname helpers for locale-prefixed routes (`/en/cmdb`): split, swap and build.
import { isLocale, type Locale } from '@openmap/i18n';

export interface SplitPath {
  locale: Locale | undefined;
  /** Path after the locale segment, always starting with `/` (`/` when empty). */
  rest: string;
}

export function splitLocale(pathname: string): SplitPath {
  const segments = pathname.split('/').filter((s) => s !== '');
  const first = segments[0];
  if (first !== undefined && isLocale(first)) {
    return { locale: first, rest: '/' + segments.slice(1).join('/') };
  }
  return { locale: undefined, rest: '/' + segments.join('/') };
}

/** Same route in another locale: swaps the first segment, or prepends one when missing. */
export function withLocale(pathname: string, locale: Locale): string {
  const { rest } = splitLocale(pathname);
  return '/' + locale + (rest === '/' ? '' : rest);
}

export function localizedHref(locale: Locale, route: string): string {
  return '/' + locale + (route === '/' ? '' : route);
}
