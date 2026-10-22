'use client';
// REQ-UI-003 — app shell: sidebar on the inline start, top bar, and the routed content in a scrolling main region.
import type { Locale } from '@openmap/i18n';
import type { ReactNode } from 'react';
import { Sidebar } from './Sidebar';
import { TopBar } from './TopBar';

export interface ShellProps {
  locale: Locale;
  children: ReactNode;
}

export function Shell({ locale, children }: ShellProps): ReactNode {
  return (
    <div className="flex min-h-dvh">
      <Sidebar locale={locale} />
      <div className="flex min-w-0 flex-1 flex-col">
        <TopBar locale={locale} />
        <main className="flex-1 px-om-24 py-om-24">{children}</main>
      </div>
    </div>
  );
}
