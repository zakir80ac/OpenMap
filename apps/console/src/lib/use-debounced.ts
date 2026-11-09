'use client';
// REQ-UI-013 — a value that follows its input once the input has been still for `delayMs` (search boxes).
import { useEffect, useState } from 'react';

export function useDebounced(value: string, delayMs: number): string {
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
