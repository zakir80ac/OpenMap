'use client';
// REQ-UI-003 — loading / error / empty presentation for TanStack Query results, worded from the shared catalogue.
import { Dot, cx } from '@openmap/ui';
import type { ReactNode } from 'react';
import { useT } from '@/providers';

export type QueryStatus = 'pending' | 'error' | 'empty';

export interface QueryStateProps {
  status: QueryStatus;
  /** Shown as a retry button for the error state. */
  onRetry?: () => void;
  className?: string;
}

export function QueryState({ status, onRetry, className }: QueryStateProps): ReactNode {
  const t = useT();
  const message = status === 'pending' ? t('common.loading') : status === 'error' ? t('common.error') : t('common.empty');
  return (
    <div
      role={status === 'error' ? 'alert' : 'status'}
      aria-live="polite"
      data-status={status}
      className={cx(
        'flex items-center gap-om-10 rounded-om-panel border border-dashed border-om-border-strong px-om-16 py-om-14 text-om-sm text-om-secondary',
        className,
      )}
    >
      <Dot state={status === 'error' ? 'down' : 'unknown'} pulse={status === 'pending'} />
      <span>{message}</span>
      {status === 'error' && onRetry !== undefined ? (
        <button
          type="button"
          onClick={onRetry}
          className="ms-auto rounded-om-control border border-om-cyan/30 bg-om-cyan/10 px-om-10 py-om-4 text-om-xs font-medium text-om-cyan transition-colors duration-om-base ease-om-standard hover:bg-om-cyan/20"
        >
          {t('common.retry')}
        </button>
      ) : null}
    </div>
  );
}
