// REQ-SEC-001 — OIDC redirect target (`/<locale>/auth/callback`): public, outside the shell; the view exchanges the
// authorization code and returns the browser to the route that started the flow.
import type { Metadata } from 'next';
import type { ReactNode } from 'react';
import { AuthCallbackView } from '@/components/auth/AuthCallbackView';
import { getT, requireLocale } from '@/lib/i18n';

interface PageProps {
  params: Promise<{ locale: string }>;
}

export async function generateMetadata({ params }: PageProps): Promise<Metadata> {
  const t = getT(await requireLocale(params));
  return { title: t('auth.callback.completing') };
}

export default async function AuthCallbackPage({ params }: PageProps): Promise<ReactNode> {
  const locale = await requireLocale(params);
  return <AuthCallbackView locale={locale} />;
}
