'use client';
// REQ-UI-003 — global search: `/` focuses the field from anywhere; submitting routes to the CMDB text filter.
import { useRouter } from 'next/navigation';
import type { Locale } from '@openmap/i18n';
import { useEffect, useRef, useState, type ReactNode, type SyntheticEvent } from 'react';
import { Icon } from '@/components/icons';
import { localizedHref } from '@/lib/locale-path';
import { useT } from '@/providers';

export interface GlobalSearchProps {
  locale: Locale;
}

const FOCUS_KEY = '/';

function isTypingTarget(target: EventTarget | null): boolean {
  if (!(target instanceof HTMLElement)) return false;
  return target.isContentEditable || target instanceof HTMLInputElement || target instanceof HTMLTextAreaElement || target instanceof HTMLSelectElement;
}

export function GlobalSearch({ locale }: GlobalSearchProps): ReactNode {
  const t = useT();
  const router = useRouter();
  const inputRef = useRef<HTMLInputElement>(null);
  const [value, setValue] = useState('');

  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent): void => {
      if (event.key !== FOCUS_KEY || event.ctrlKey || event.metaKey || event.altKey || isTypingTarget(event.target)) return;
      event.preventDefault();
      inputRef.current?.focus();
    };
    window.addEventListener('keydown', onKeyDown);
    return () => {
      window.removeEventListener('keydown', onKeyDown);
    };
  }, []);

  const onSubmit = (event: SyntheticEvent<HTMLFormElement>): void => {
    event.preventDefault();
    const text = value.trim();
    const search = text === '' ? '' : '?q=' + encodeURIComponent(text);
    router.push(localizedHref(locale, '/cmdb') + search);
  };

  return (
    <form role="search" onSubmit={onSubmit} className="relative flex w-full max-w-xl items-center">
      <Icon name="search" className="pointer-events-none absolute start-3 size-4 text-om-muted" />
      <input
        ref={inputRef}
        type="search"
        name="q"
        value={value}
        onChange={(event) => {
          setValue(event.target.value);
        }}
        aria-label={t('action.search')}
        autoComplete="off"
        spellCheck={false}
        className="h-9 w-full rounded-om-control-lg border border-om-border-glass bg-om-surface1/80 ps-9 pe-24 text-om-sm text-om-primary outline-none transition-[border-color,box-shadow] duration-om-base ease-om-standard focus:border-om-cyan/40 focus:shadow-om-glow-bar-cyan"
      />
      {value === '' ? (
        <span aria-hidden="true" className="pointer-events-none absolute start-9 flex items-center text-om-sm text-om-muted">
          {t('topbar.searchHint')}
        </span>
      ) : null}
      <span aria-hidden="true" className="pointer-events-none absolute end-3 flex items-center gap-om-6 text-om-2xs text-om-muted">
        <span className="hidden sm:inline">{t('topbar.shortcutHint')}</span>
        <kbd className="rounded-om-tag border border-om-border-strong bg-om-surface2 px-om-6 py-om-4 leading-none text-om-secondary">/</kbd>
      </span>
    </form>
  );
}
