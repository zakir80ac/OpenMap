'use client';
// REQ-SEC-001 REQ-UI-003 — the full-page frame every signed-out state uses (sign-in, restoring, callback): deep ground
// with the two accent glows, a glass panel with the OpenMap mark, and a slot for the state-specific content.
import { GlassPanel, accents, type HexColor } from '@openmap/ui';
import type { ReactNode } from 'react';
import { Icon } from '@/components/icons';
import { useT } from '@/providers';

export interface AuthScreenProps {
  /** Heading of the panel (already translated). */
  title: string;
  /** One line under the heading (already translated). */
  description?: string;
  children?: ReactNode;
  /** Accent for the panel edge and the mark; rose for error states. */
  accent?: HexColor;
}

export function AuthScreen({ title, description, children, accent = accents.cyan }: AuthScreenProps): ReactNode {
  const t = useT();
  return (
    <main aria-labelledby="auth-title" className="grid min-h-dvh place-items-center px-om-24 py-om-32">
      <GlassPanel as="section" accent={accent} padding="32" className="w-full max-w-md shadow-om-card">
        <div className="flex flex-col gap-om-24">
          <div className="flex items-center gap-om-12">
            <span
              aria-hidden="true"
              className="grid size-11 place-items-center rounded-om-control-lg border border-om-border-strong bg-om-surface3 text-om-cyan shadow-om-glow-bar-cyan"
              style={{ color: accent }}
            >
              <Icon name="dependencies" className="size-6" />
            </span>
            <div className="flex flex-col">
              <span className="font-om-display text-om-lg font-bold tracking-tight text-om-primary">{t('app.name')}</span>
              <span className="text-om-xs text-om-muted">{t('app.tagline')}</span>
            </div>
          </div>

          <div className="flex flex-col gap-om-6">
            <h1 id="auth-title" className="font-om-display text-om-xl font-semibold leading-snug text-om-primary">
              {title}
            </h1>
            {description !== undefined ? <p className="text-om-sm leading-normal text-om-secondary">{description}</p> : null}
          </div>

          {children}

          <p className="flex items-center gap-om-6 border-t border-om-border-glass pt-om-16 text-om-2xs text-om-muted">
            <Icon name="shield" className="size-3.5 shrink-0" />
            <span>{t('auth.securedBy')}</span>
          </p>
        </div>
      </GlassPanel>
    </main>
  );
}
