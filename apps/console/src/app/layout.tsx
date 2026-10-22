// REQ-UI-003 — pass-through root layout. The locale layout (src/app/[locale]/layout.tsx) owns <html lang dir>; this
// file exists only so that the root redirect page and the global not-found route have a root layout.
import type { ReactNode } from 'react';

export default function RootLayout({ children }: { children: ReactNode }): ReactNode {
  return children;
}
