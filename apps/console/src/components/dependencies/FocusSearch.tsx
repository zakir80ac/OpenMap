'use client';
// REQ-UI-007 — focus picker: an incremental search over the `search` query (debounced) whose chosen hit becomes the
// map's root CI. The listbox is keyboard-navigable (arrows, Enter, Escape) and announces its result count.
import { useQuery } from '@tanstack/react-query';
import { CONSOLE } from '@openmap/constants';
import { LayerBadge, cx } from '@openmap/ui';
import { useEffect, useId, useRef, useState, type KeyboardEvent, type ReactNode } from 'react';
import { Icon } from '@/components/icons';
import { layerKey } from '@/lib/keys';
import { searchQuery, type CiSummary } from '@/lib/queries';
import { useT } from '@/providers';

export interface FocusSearchProps {
  /** Currently focused CI, shown in the field when the user is not typing. */
  current: CiSummary | undefined;
  onPick: (ci: CiSummary) => void;
  className?: string;
}

/** Debounce a changing string so one request is sent per typing pause. */
function useDebounced(value: string, delayMs: number): string {
  const [debounced, setDebounced] = useState(value);
  useEffect(() => {
    const handle = window.setTimeout(() => {
      setDebounced(value);
    }, delayMs);
    return () => {
      window.clearTimeout(handle);
    };
  }, [value, delayMs]);
  return debounced;
}

export function FocusSearch({ current, onPick, className }: FocusSearchProps): ReactNode {
  const t = useT();
  const listId = useId();
  const [text, setText] = useState('');
  const [open, setOpen] = useState(false);
  const [active, setActive] = useState(0);
  const inputRef = useRef<HTMLInputElement>(null);
  const debounced = useDebounced(text.trim(), CONSOLE.searchDebounceMs);
  const results = useQuery(searchQuery({ text: debounced }));
  const hits = results.data ?? [];

  const pick = (ci: CiSummary): void => {
    onPick(ci);
    setText('');
    setOpen(false);
    inputRef.current?.blur();
  };

  const onKeyDown = (event: KeyboardEvent<HTMLInputElement>): void => {
    if (event.key === 'ArrowDown') {
      event.preventDefault();
      setOpen(true);
      setActive((index) => Math.min(index + 1, Math.max(hits.length - 1, 0)));
    } else if (event.key === 'ArrowUp') {
      event.preventDefault();
      setActive((index) => Math.max(index - 1, 0));
    } else if (event.key === 'Enter') {
      const hit = hits[active];
      if (hit !== undefined && open) {
        event.preventDefault();
        pick(hit.ci);
      }
    } else if (event.key === 'Escape') {
      setOpen(false);
    }
  };

  const showList = open && debounced !== '';

  return (
    <div className={cx('relative', className)}>
      <label className="flex flex-col gap-om-4">
        <span className="text-om-2xs font-semibold uppercase tracking-[0.08em] text-om-muted">
          {t('dependencies.focus.label')}
        </span>
        <span className="relative flex items-center">
          <Icon name="search" className="pointer-events-none absolute start-3 size-4 text-om-muted" />
          <input
            ref={inputRef}
            type="search"
            role="combobox"
            aria-expanded={showList}
            aria-controls={listId}
            aria-autocomplete="list"
            aria-activedescendant={
              showList && hits[active] !== undefined ? listId + '-' + String(active) : undefined
            }
            value={text}
            autoComplete="off"
            spellCheck={false}
            onChange={(event) => {
              setText(event.target.value);
              setOpen(true);
              setActive(0);
            }}
            onFocus={() => {
              setOpen(true);
            }}
            onBlur={() => {
              // Delay so a click on an option registers before the list closes.
              window.setTimeout(() => {
                setOpen(false);
              }, CONSOLE.searchDebounceMs);
            }}
            onKeyDown={onKeyDown}
            className="h-10 w-full rounded-om-control-lg border border-om-border-glass bg-om-surface1/80 ps-9 pe-3 text-om-sm text-om-primary outline-none transition-[border-color,box-shadow] duration-om-base ease-om-standard focus:border-om-cyan/40 focus:shadow-om-glow-bar-cyan"
          />
          {text === '' ? (
            <span
              aria-hidden="true"
              className="pointer-events-none absolute start-9 truncate text-om-sm text-om-muted"
            >
              {current === undefined ? t('dependencies.focus.hint') : current.displayName}
            </span>
          ) : null}
        </span>
      </label>

      {showList ? (
        <ul
          id={listId}
          role="listbox"
          aria-label={t('dependencies.focus.results')}
          className="absolute inset-x-0 top-full z-20 mt-om-6 max-h-80 overflow-y-auto rounded-om-panel border border-om-border-strong bg-om-surface2 p-om-6 shadow-om-card"
        >
          {results.isPending ? (
            <li role="option" aria-selected={false} className="px-om-10 py-om-8 text-om-sm text-om-secondary">
              {t('common.loading')}
            </li>
          ) : hits.length === 0 ? (
            <li role="option" aria-selected={false} className="px-om-10 py-om-8 text-om-sm text-om-secondary">
              {t('dependencies.focus.noResults')}
            </li>
          ) : (
            hits.map((hit, index) => (
              <li
                key={hit.ci.id}
                id={listId + '-' + String(index)}
                role="option"
                aria-selected={index === active}
                onMouseDown={(event) => {
                  event.preventDefault();
                  pick(hit.ci);
                }}
                onMouseEnter={() => {
                  setActive(index);
                }}
                className={cx(
                  'flex cursor-pointer items-center gap-om-10 rounded-om-control px-om-10 py-om-8 text-om-sm',
                  index === active ? 'bg-om-cyan/10 text-om-primary' : 'text-om-secondary',
                )}
              >
                <span className="min-w-0 flex-1">
                  <span className="block truncate font-medium text-om-primary">{hit.ci.displayName}</span>
                  <span className="block truncate font-om-mono text-om-2xs text-om-muted">{hit.ci.code}</span>
                  <span className="block truncate font-om-mono text-om-2xs text-om-muted">{hit.ci.type}</span>
                </span>
                <LayerBadge layer={hit.ci.layer} label={t(layerKey(hit.ci.layer))} />
              </li>
            ))
          )}
        </ul>
      ) : null}
    </div>
  );
}
