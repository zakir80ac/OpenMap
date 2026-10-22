'use client';
// REQ-SEC-001 REQ-UI-003 — branded sign-in screen shown to a signed-out visitor: why they are here (session ended,
// token rejected, provider unreachable) and one primary action that starts the Authorization Code flow.
import { accents } from '@openmap/ui';
import type { MessageKey } from '@openmap/i18n';
import { useState, type ReactNode } from 'react';
import { Icon } from '@/components/icons';
import type { AsyncAction, AuthReason } from '@/lib/auth';
import { useT } from '@/providers';
import { AuthScreen } from './AuthScreen';

export interface SignInScreenProps {
  reason: AuthReason | undefined;
  /** Server-provided wording behind a `rejected` reason, rendered verbatim beneath the translated sentence. */
  detail?: string | undefined;
  onSignIn: AsyncAction;
}

const reasonKey = {
  expired: 'auth.reason.expired',
  rejected: 'auth.reason.rejected',
  unavailable: 'auth.reason.unavailable',
  misconfigured: 'auth.reason.misconfigured',
} as const satisfies Record<AuthReason, MessageKey>;

export function SignInScreen({ reason, detail, onSignIn }: SignInScreenProps): ReactNode {
  const t = useT();
  const [busy, setBusy] = useState(false);
  const failed = reason === 'unavailable' || reason === 'misconfigured';
  const start = (): void => {
    setBusy(true);
    void onSignIn().finally(() => {
      setBusy(false);
    });
  };
  return (
    <AuthScreen title={t('auth.signInTitle')} description={t('auth.signInDescription')} accent={failed ? accents.rose : accents.cyan}>
      {reason !== undefined ? (
        <p
          role={failed ? 'alert' : 'status'}
          className="flex items-start gap-om-8 rounded-om-control-lg border border-om-border-strong bg-om-surface3 px-om-12 py-om-10 text-om-sm text-om-secondary"
          style={failed ? { borderColor: accents.rose, color: accents.rose } : undefined}
        >
          <Icon name={failed ? 'impact' : 'clock'} className="mt-0.5 size-4 shrink-0" />
          <span className="flex flex-col gap-om-4">
            <span>{t(reasonKey[reason])}</span>
            {detail !== undefined && detail !== '' ? <span className="font-om-mono text-om-xs text-om-tertiary">{detail}</span> : null}
          </span>
        </p>
      ) : null}
      <button
        type="button"
        onClick={start}
        disabled={busy}
        className="flex h-11 w-full items-center justify-center gap-om-8 rounded-om-control-lg border border-om-cyan/40 bg-om-cyan/15 font-om-display text-om-sm font-semibold text-om-cyan shadow-om-glow-bar-cyan transition-[background-color,box-shadow] duration-om-base ease-om-standard hover:bg-om-cyan/25 hover:shadow-om-glow-nav-cyan disabled:opacity-60"
      >
        <span>{busy ? t('auth.redirecting') : t('auth.signIn')}</span>
        <Icon name="arrowRight" className="size-4 rtl:-scale-x-100" />
      </button>
    </AuthScreen>
  );
}
