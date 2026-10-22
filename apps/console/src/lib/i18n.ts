// REQ-UI-003 — server-side i18n helpers: a bound translator for layouts, pages and metadata, and locale validation
// for the [locale] segment. Client components use useT() from src/providers.tsx instead.
import { notFound } from 'next/navigation';
import { LOCALES, createTranslator, isLocale, type Locale, type MessageKey, type Params } from '@openmap/i18n';

export type Translate = (key: MessageKey, params?: Params) => string;

export function getT(locale: Locale): Translate {
  return createTranslator(locale);
}

/** Resolve the locale segment of a route; unknown values render the not-found page. */
export async function requireLocale(params: Promise<{ locale: string }>): Promise<Locale> {
  const { locale } = await params;
  if (!isLocale(locale)) notFound();
  return locale;
}

/** Default locale as exposed to every runtime by next.config.ts from loadEnv().DEFAULT_LOCALE. */
export function defaultLocale(): Locale {
  const configured = process.env.NEXT_PUBLIC_DEFAULT_LOCALE ?? '';
  return isLocale(configured) ? configured : LOCALES[0];
}
