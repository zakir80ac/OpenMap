// REQ-UI-001 — DirectionProvider / useDirection: the single source of ltr|rtl for every component (CLAUDE.md §1.8).
import { RTL_LOCALES, type Locale } from '@openmap/constants';
import { createContext, useContext, useMemo, type ReactNode } from 'react';

export type Direction = 'ltr' | 'rtl';

export const DIRECTIONS = ['ltr', 'rtl'] as const satisfies readonly Direction[];

export function isDirection(value: string): value is Direction {
  return (DIRECTIONS as readonly string[]).includes(value);
}

/** Direction a locale renders in, from the shared constants so console and tokens never disagree. */
export function directionForLocale(locale: Locale): Direction {
  return RTL_LOCALES.includes(locale) ? 'rtl' : 'ltr';
}

/**
 * Default when no provider is mounted: `document.dir` (set by the console's root layout from the active
 * locale), falling back to ltr during server rendering where there is no document.
 */
export function documentDirection(): Direction {
  if (typeof document === 'undefined') return 'ltr';
  const dir = document.dir || document.documentElement.getAttribute('dir') || '';
  return isDirection(dir) ? dir : 'ltr';
}

const DirectionContext = createContext<Direction | undefined>(undefined);

export interface DirectionProviderProps {
  /** Explicit direction; wins over `locale`. */
  dir?: Direction;
  /** Derive the direction from a locale instead. */
  locale?: Locale;
  children: ReactNode;
}

export function DirectionProvider({ dir, locale, children }: DirectionProviderProps): ReactNode {
  const resolved = useMemo<Direction>(() => {
    if (dir !== undefined) return dir;
    if (locale !== undefined) return directionForLocale(locale);
    return documentDirection();
  }, [dir, locale]);
  return <DirectionContext.Provider value={resolved}>{children}</DirectionContext.Provider>;
}

/** Current direction: from the nearest provider, otherwise from the document. */
export function useDirection(): Direction {
  const fromContext = useContext(DirectionContext);
  return fromContext ?? documentDirection();
}

export function useIsRtl(): boolean {
  return useDirection() === 'rtl';
}
