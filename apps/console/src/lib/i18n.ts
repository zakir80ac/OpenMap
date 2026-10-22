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

/**
 * Default locale. Only the middleware needs it, and the middleware runs on the server, so the deployment's own
 * DEFAULT_LOCALE is read at run time first (one console image serves every deployment); the value next.config.mjs
 * inlined at build time is the fallback for development builds that run without that variable.
 */
export function defaultLocale(): Locale {
  const runtime = process.env.DEFAULT_LOCALE ?? '';
  if (isLocale(runtime)) return runtime;
  const built = process.env.NEXT_PUBLIC_DEFAULT_LOCALE ?? '';
  return isLocale(built) ? built : LOCALES[0];
}
