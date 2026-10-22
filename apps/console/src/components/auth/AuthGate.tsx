'use client';
// REQ-SEC-001 — renders the protected tree only for a signed-in session; otherwise the restoring frame or the
// sign-in screen, which returns the user to the route they asked for once Keycloak sends them back.
import { usePathname } from 'next/navigation';
import { Dot } from '@openmap/ui';
import type { ReactNode } from 'react';
import { useAuth } from '@/lib/auth';
import { useT } from '@/providers';
import { AuthScreen } from './AuthScreen';
import { SignInScreen } from './SignInScreen';

export function AuthGate({ children }: { children: ReactNode }): ReactNode {
  const t = useT();
  const auth = useAuth();
  const pathname = usePathname();
  if (auth.status === 'signed-in') return children;
  if (auth.status === 'restoring') {
    return (
      <AuthScreen title={t('auth.restoring')}>
        <p role="status" aria-live="polite" className="flex items-center gap-om-10 text-om-sm text-om-secondary">
          <Dot state="unknown" pulse />
          <span>{t('common.loading')}</span>
        </p>
      </AuthScreen>
    );
  }
  const returnTo = (): string => pathname + (typeof window === 'undefined' ? '' : window.location.search);
  return <SignInScreen reason={auth.reason} detail={auth.reasonDetail} onSignIn={() => auth.signIn(returnTo())} />;
}
