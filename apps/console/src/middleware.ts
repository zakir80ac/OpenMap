// REQ-UI-003 — adds the default locale to any path that lacks one, so `/cmdb` becomes `/<DEFAULT_LOCALE>/cmdb`.
// Runs on the edge runtime; the default locale is inlined by next.config.ts from loadEnv().DEFAULT_LOCALE.
import { NextResponse, type NextRequest } from 'next/server';
import { defaultLocale } from '@/lib/i18n';
import { splitLocale, withLocale } from '@/lib/locale-path';

export function middleware(request: NextRequest): NextResponse {
  const { pathname } = request.nextUrl;
  if (splitLocale(pathname).locale !== undefined) return NextResponse.next();
  const url = request.nextUrl.clone();
  url.pathname = withLocale(pathname, defaultLocale());
  return NextResponse.redirect(url);
}

export const config = {
  // Everything except Next internals, API routes and files with an extension (favicon, fonts, images).
  matcher: ['/((?!_next|api|.*\\..*).*)'],
};
