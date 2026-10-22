'use client';
// REQ-UI-003 — form controls shared by the console's editing screens: one place for the token classes of buttons,
// inputs, selects and labelled fields so views stay declarative. No colours, spacing or sizes beyond the tokens.
import { cx } from '@openmap/ui';
import type { ButtonHTMLAttributes, InputHTMLAttributes, ReactNode, SelectHTMLAttributes, TextareaHTMLAttributes } from 'react';

export type ButtonTone = 'primary' | 'quiet' | 'danger';

const buttonTone: Record<ButtonTone, string> = {
  primary: 'border-om-cyan/30 bg-om-cyan/10 text-om-cyan hover:bg-om-cyan/20',
  quiet: 'border-om-border-strong bg-om-surface3 text-om-primary hover:bg-om-surface2',
  danger: 'border-om-rose/30 bg-om-rose/10 text-om-rose hover:bg-om-rose/20',
};

export interface ButtonProps extends ButtonHTMLAttributes<HTMLButtonElement> {
  tone?: ButtonTone;
}

export function Button({ tone = 'primary', className, type = 'button', ...rest }: ButtonProps): ReactNode {
  return <button type={type} className={cx('rounded-om-control border px-om-12 py-om-6 text-om-xs font-medium transition-colors duration-om-base ease-om-standard disabled:cursor-not-allowed disabled:opacity-60', buttonTone[tone], className)} {...rest} />;
}

export const fieldClass = 'w-full rounded-om-control border border-om-border-strong bg-om-surface3 px-om-10 py-om-6 text-om-sm text-om-primary disabled:opacity-70';
export const labelClass = 'text-om-2xs font-semibold uppercase tracking-[0.08em] text-om-muted';

export function TextInput({ className, ...rest }: InputHTMLAttributes<HTMLInputElement>): ReactNode {
  return <input className={cx(fieldClass, className)} {...rest} />;
}

export function TextArea({ className, ...rest }: TextareaHTMLAttributes<HTMLTextAreaElement>): ReactNode {
  return <textarea className={cx(fieldClass, 'min-h-[4.5rem]', className)} {...rest} />;
}

export function Select({ className, children, ...rest }: SelectHTMLAttributes<HTMLSelectElement>): ReactNode {
  return (
    <select className={cx(fieldClass, className)} {...rest}>
      {children}
    </select>
  );
}

export interface FieldProps {
  id: string;
  label: ReactNode;
  children: ReactNode;
  hint?: ReactNode;
  className?: string;
}

/** A labelled control; the label is bound to the child by `id`, so screen readers and tests can address it. */
export function Field({ id, label, children, hint, className }: FieldProps): ReactNode {
  return (
    <div className={cx('flex flex-col gap-om-4', className)}>
      <label htmlFor={id} className={labelClass}>
        {label}
      </label>
      {children}
      {hint !== undefined ? <p className="text-om-2xs text-om-muted">{hint}</p> : null}
    </div>
  );
}

export const tableClass = 'w-full text-start text-om-xs';
export const theadClass = 'text-om-2xs font-semibold uppercase tracking-[0.08em] text-om-muted';
export const thClass = 'py-om-6 pe-om-10 text-start';
export const tdClass = 'py-om-8 pe-om-10 align-top';
export const rowClass = 'border-t border-om-border-glass';
