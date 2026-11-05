// REQ-UI-001 — message catalogues for en and ar. The build fails on a missing key (see check.ts).
import { LOCALES, RTL_LOCALES, type Locale } from '@openmap/constants';
import en from '../locales/en.json' with { type: 'json' };
import ar from '../locales/ar.json' with { type: 'json' };

export type MessageKey = keyof typeof en;
export type Catalogue = Record<MessageKey, string>;

export const catalogues: Record<Locale, Catalogue> = { en, ar };

export type Params = Record<string, string | number>;

/** Whether a string names a catalogue key; lets a key assembled from an enum fall back when the enum grows first. */
export function isMessageKey(key: string): key is MessageKey {
  return Object.hasOwn(en, key);
}

const INTERPOLATION_TOKEN = /\{(\w+)\}/g;

/** Interpolate `{name}` tokens. Unknown tokens are left intact so they are visible in review. */
export function format(template: string, params: Params = {}): string {
  return template.replace(INTERPOLATION_TOKEN, (whole, name: string) => {
    const value = params[name];
    return value === undefined ? whole : String(value);
  });
}

export function translate(locale: Locale, key: MessageKey, params?: Params): string {
  return format(catalogues[locale][key], params);
}

/** Build a bound translator for one locale. */
export function createTranslator(locale: Locale): (key: MessageKey, params?: Params) => string {
  return (key, params) => translate(locale, key, params);
}

export function isRtl(locale: Locale): boolean {
  return RTL_LOCALES.includes(locale);
}

export function direction(locale: Locale): 'rtl' | 'ltr' {
  return isRtl(locale) ? 'rtl' : 'ltr';
}

export function isLocale(value: string): value is Locale {
  return (LOCALES as readonly string[]).includes(value);
}

export { LOCALES };
export type { Locale };
