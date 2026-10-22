// REQ-UI-003 — `/` sends the browser to the default locale's dashboard. The locale comes from validated config at
// request time, so a deployment that changes DEFAULT_LOCALE needs no rebuild.
import { loadEnv } from '@openmap/config';
import { redirect } from 'next/navigation';
import { localizedHref } from '@/lib/locale-path';

export const dynamic = 'force-dynamic';

export default function RootPage(): never {
  redirect(localizedHref(loadEnv().DEFAULT_LOCALE, '/dashboard'));
}
