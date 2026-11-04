'use client';
// REQ-UI-024 — form primitives of the setup wizard: labelled inputs and selects with the design-token classes the
// settings forms use, a step card frame with its actions, and the mutation error line.
import { Card, SectionTitle, cx } from '@openmap/ui';
import type { ReactNode, SelectHTMLAttributes, InputHTMLAttributes } from 'react';
import { useT } from '@/providers';

export const FIELD_CLASS = 'rounded-om-control border border-om-border-strong bg-om-surface3 px-om-10 py-om-6 text-om-sm text-om-primary disabled:opacity-70';
export const LABEL_CLASS = 'text-om-2xs font-semibold uppercase tracking-[0.08em] text-om-muted';
export const PRIMARY_BUTTON = 'rounded-om-control border border-om-cyan/30 bg-om-cyan/10 px-om-12 py-om-6 text-om-sm font-medium text-om-cyan transition-colors duration-om-base ease-om-standard hover:bg-om-cyan/20 disabled:opacity-60';
export const SECONDARY_BUTTON = 'rounded-om-control border border-om-border-strong bg-om-surface3 px-om-12 py-om-6 text-om-sm text-om-secondary transition-colors duration-om-base ease-om-standard hover:text-om-primary disabled:opacity-60';
export const DANGER_BUTTON = 'rounded-om-control border border-om-rose/30 bg-om-rose/10 px-om-10 py-om-4 text-om-xs text-om-rose transition-colors duration-om-base ease-om-standard hover:bg-om-rose/20 disabled:opacity-60';
export const TABLE_HEAD = 'text-om-2xs font-semibold uppercase tracking-[0.08em] text-om-muted';

interface FieldProps {
  id: string;
  label: string;
  hint?: string;
  children: ReactNode;
  className?: string;
}

export function Field({ id, label, hint, children, className }: FieldProps): ReactNode {
  return (
    <div className={cx('flex flex-col gap-om-4', className)}>
      <label htmlFor={id} className={LABEL_CLASS}>
        {label}
      </label>
      {children}
      {hint === undefined ? null : <span className="text-om-2xs text-om-muted">{hint}</span>}
    </div>
  );
}

export type TextInputProps = InputHTMLAttributes<HTMLInputElement> & { id: string; label: string; hint?: string; wrapperClassName?: string };

export function TextInput({ id, label, hint, wrapperClassName, className, ...rest }: TextInputProps): ReactNode {
  return (
    <Field id={id} label={label} {...(hint === undefined ? {} : { hint })} {...(wrapperClassName === undefined ? {} : { className: wrapperClassName })}>
      <input id={id} className={cx(FIELD_CLASS, className)} {...rest} />
    </Field>
  );
}

export type SelectInputProps = SelectHTMLAttributes<HTMLSelectElement> & { id: string; label: string; hint?: string; wrapperClassName?: string };

export function SelectInput({ id, label, hint, wrapperClassName, className, children, ...rest }: SelectInputProps): ReactNode {
  return (
    <Field id={id} label={label} {...(hint === undefined ? {} : { hint })} {...(wrapperClassName === undefined ? {} : { className: wrapperClassName })}>
      <select id={id} className={cx(FIELD_CLASS, className)} {...rest}>
        {children}
      </select>
    </Field>
  );
}

interface StepCardProps {
  title: string;
  description: string;
  children: ReactNode;
  /** Footer actions: back, continue. */
  actions?: ReactNode;
}

export function StepCard({ title, description, children, actions }: StepCardProps): ReactNode {
  return (
    <Card as="section" padding="24" className="flex flex-col gap-om-20">
      <SectionTitle as="h2" size="sm" description={description}>
        {title}
      </SectionTitle>
      {children}
      {actions === undefined ? null : <div className="flex flex-wrap items-center justify-between gap-om-12 border-t border-om-border-glass pt-om-16">{actions}</div>}
    </Card>
  );
}

export function MutationError({ error }: { error: unknown }): ReactNode {
  const t = useT();
  if (error === null || error === undefined) return null;
  const message = error instanceof Error ? error.message : typeof error === 'string' ? error : t('common.error');
  return (
    <p role="alert" className="text-om-xs text-om-rose">
      {t('setup.error', { message })}
    </p>
  );
}

/** Parses a numeric input; empty means null, anything unparsable also null so the API's validation speaks. */
export function numberOrNull(value: string): number | null {
  const trimmed = value.trim();
  if (trimmed === '') return null;
  const n = Number(trimmed);
  return Number.isFinite(n) ? n : null;
}
