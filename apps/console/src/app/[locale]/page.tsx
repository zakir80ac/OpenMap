// REQ-UI-003 — `/<locale>` is the dashboard.
import { redirect } from 'next/navigation';
import { requireLocale } from '@/lib/i18n';
import { localizedHref } from '@/lib/locale-path';

export default async function LocaleIndexPage({ params }: { params: Promise<{ locale: string }> }): Promise<never> {
  const locale = await requireLocale(params);
  redirect(localizedHref(locale, '/dashboard'));
}
