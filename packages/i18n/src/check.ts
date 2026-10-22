// REQ-UI-001 — build-time parity check: every key must exist, non-empty, in every locale,
// and placeholders must match across locales.
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { LOCALES } from '@openmap/constants';

const here = dirname(fileURLToPath(import.meta.url));
const localesDir = join(here, '..', 'locales');

type Flat = Record<string, string>;

function load(locale: string): Flat {
  return JSON.parse(readFileSync(join(localesDir, locale + '.json'), 'utf8')) as Flat;
}

function placeholders(s: string): string[] {
  return [...s.matchAll(/\{(\w+)\}/g)].map((m) => m[1] ?? '').sort();
}

export function checkCatalogues(): string[] {
  const problems: string[] = [];
  const loaded = Object.fromEntries(LOCALES.map((l) => [l, load(l)])) as Record<string, Flat>;
  const allKeys = new Set<string>();
  for (const flat of Object.values(loaded)) for (const k of Object.keys(flat)) allKeys.add(k);
  const reference = loaded[LOCALES[0]] ?? {};
  for (const key of [...allKeys].sort()) {
    for (const locale of LOCALES) {
      const value = loaded[locale]?.[key];
      if (value === undefined) problems.push(locale + ': missing key "' + key + '"');
      else if (value.trim() === '') problems.push(locale + ': empty value for "' + key + '"');
    }
    const refPh = placeholders(reference[key] ?? '').join(',');
    for (const locale of LOCALES) {
      const ph = placeholders(loaded[locale]?.[key] ?? '').join(',');
      if (ph !== refPh) problems.push(locale + ': placeholders differ for "' + key + '" (' + ph + ' vs ' + refPh + ')');
    }
  }
  return problems;
}

const problems = checkCatalogues();
if (problems.length > 0) {
  for (const p of problems) console.error('i18n: ' + p);
  process.exit(1);
}
console.log('i18n: ' + LOCALES.join(', ') + ' catalogues in sync');
