// REQ-SEC-001 REQ-UI-003 — the signed-in half of the console: every route in this group renders inside the shell
// only once the AuthGate has a session; otherwise the gate shows the sign-in screen in place of the whole shell.
import type { ReactNode } from 'react';
import { AuthGate } from '@/components/auth/AuthGate';
import { Shell } from '@/components/shell/Shell';
import { requireLocale } from '@/lib/i18n';

interface AppLayoutProps {
  children: ReactNode;
  params: Promise<{ locale: string }>;
}

export default async function AppLayout({ children, params }: AppLayoutProps): Promise<ReactNode> {
  const locale = await requireLocale(params);
  return (
    <AuthGate>
      <Shell locale={locale}>{children}</Shell>
    </AuthGate>
  );
}
