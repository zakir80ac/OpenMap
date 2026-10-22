'use client';
// REQ-SEC-001 — the callback route's body: hands the code and state from the URL to the AuthProvider, then replaces
// the history entry with the route the user originally asked for. Any failure is shown with a retry that starts
// the flow again from the beginning.
import { useRouter } from 'next/navigation';
import { Dot, accents } from '@openmap/ui';
import type { Locale, MessageKey } from '@openmap/i18n';
import { useEffect, useRef, useState, type ReactNode } from 'react';
import { Icon } from '@/components/icons';
import { CallbackError, parseCallbackParams, useAuth, type CallbackErrorCode } from '@/lib/auth';
import { localizedHref } from '@/lib/locale-path';
import { useT } from '@/providers';
import { AuthScreen } from './AuthScreen';

export interface AuthCallbackViewProps {
  locale: Locale;
  /** Query string to parse; defaults to the current location (a prop so the view is testable without navigation). */
  search?: string;
}

const errorKey = {
  denied: 'auth.callback.denied',
  state_mismatch: 'auth.callback.stateMismatch',
  missing_code: 'auth.callback.missingCode',
  nonce_mismatch: 'auth.callback.nonceMismatch',
  exchange_failed: 'auth.callback.exchangeFailed',
  unavailable: 'auth.reason.unavailable',
} as const satisfies Record<CallbackErrorCode, MessageKey>;

type Phase = { kind: 'working' } | { kind: 'done' } | { kind: 'failed'; code: CallbackErrorCode };

export function AuthCallbackView({ locale, search }: AuthCallbackViewProps): ReactNode {
  const t = useT();
  const auth = useAuth();
  const router = useRouter();
  const [phase, setPhase] = useState<Phase>({ kind: 'working' });
  const started = useRef(false);

  useEffect(() => {
    // The exchange consumes the one-time code and the pending record, so it must run exactly once (StrictMode included).
    if (started.current) return;
    started.current = true;
    const query = search ?? window.location.search;
    auth
      .completeSignIn(parseCallbackParams(query))
      .then((returnTo) => {
        setPhase({ kind: 'done' });
        router.replace(returnTo);
      })
      .catch((error: unknown) => {
        setPhase({ kind: 'failed', code: error instanceof CallbackError ? error.code : 'exchange_failed' });
      });
  }, [auth, router, search]);

  if (phase.kind === 'failed') {
    return (
      <AuthScreen title={t('auth.callback.failedTitle')} accent={accents.rose}>
        <p role="alert" className="flex items-start gap-om-8 rounded-om-control-lg border bg-om-surface3 px-om-12 py-om-10 text-om-sm" style={{ borderColor: accents.rose, color: accents.rose }}>
          <Icon name="impact" className="mt-0.5 size-4 shrink-0" />
          <span>{t(errorKey[phase.code])}</span>
        </p>
        <button
          type="button"
          onClick={() => {
            void auth.signIn(localizedHref(locale, '/'));
          }}
          className="flex h-11 w-full items-center justify-center gap-om-8 rounded-om-control-lg border border-om-cyan/40 bg-om-cyan/15 font-om-display text-om-sm font-semibold text-om-cyan shadow-om-glow-bar-cyan transition-[background-color,box-shadow] duration-om-base ease-om-standard hover:bg-om-cyan/25"
        >
          <span>{t('common.retry')}</span>
          <Icon name="arrowRight" className="size-4 rtl:-scale-x-100" />
        </button>
      </AuthScreen>
    );
  }
  return (
    <AuthScreen title={t('auth.callback.completing')}>
      <p role="status" aria-live="polite" className="flex items-center gap-om-10 text-om-sm text-om-secondary">
        <Dot state={phase.kind === 'done' ? 'healthy' : 'unknown'} pulse={phase.kind === 'working'} />
        <span>{phase.kind === 'done' ? t('auth.callback.done') : t('common.loading')}</span>
      </p>
    </AuthScreen>
  );
}
